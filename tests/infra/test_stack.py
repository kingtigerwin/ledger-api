import json
from collections.abc import Mapping
from typing import Any

import pytest
from aws_cdk.assertions import Match, Template

from infra.ledger_stack import GoogleSignIn, LedgerStack
from tests.infra.support import REGION_ONLY, actions_of, found, function_policy, quick_app, synth


@pytest.fixture(scope="module")
def template() -> Template:
    return synth()


def has_protected_route(template: Template, route_key: str) -> None:
    template.has_resource_properties("AWS::ApiGatewayV2::Route", {"RouteKey": route_key, "AuthorizationType": "CUSTOM"})


def assert_runs_from_python(function: Mapping[str, Any], module: str, memory: int) -> None:
    properties = function["Properties"]
    assert properties["Runtime"] == "python3.13"
    assert properties["Handler"] == f"ledger_api.{module}.lambda_function.handler"
    assert properties["Architectures"] == ["arm64"]
    assert properties["LoggingConfig"]["LogFormat"] == "JSON"
    assert properties["MemorySize"] == memory


class TestLedgerStack:
    def test_has_an_on_demand_users_table_keyed_by_pk_and_sk(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::DynamoDB::GlobalTable",
            {
                "KeySchema": [
                    {"AttributeName": "pk", "KeyType": "HASH"},
                    {"AttributeName": "sk", "KeyType": "RANGE"},
                ],
                "BillingMode": "PAY_PER_REQUEST",
            },
        )

    @pytest.mark.parametrize("route_key", ["POST /api/v1/auth/register", "POST /api/v1/auth/login"])
    def test_routes_register_and_login_to_the_auth_function(self, template: Template, route_key: str) -> None:
        template.has_resource_properties("AWS::ApiGatewayV2::Route", {"RouteKey": route_key})

    @pytest.mark.parametrize(
        ("name", "module", "memory"),
        [
            pytest.param("Auth", "auth", 512, id="auth-with-enough-memory-for-scrypt"),
            pytest.param("Authorizer", "authorizer", 256, id="authorizer"),
            pytest.param("Bootstrap", "bootstrap", 512, id="bootstrap-hashes-the-admins-password"),
            pytest.param("Docs", "docs", 128, id="docs"),
        ],
    )
    def test_runs_the_function_from_python(self, template: Template, name: str, module: str, memory: int) -> None:
        assert_runs_from_python(found(template, "AWS::Lambda::Function", f"{name}Function"), module, memory)

    def test_has_no_nodejs_functions_but_cdks_own(self, template: Template) -> None:
        node = [
            id
            for id, function in template.find_resources("AWS::Lambda::Function").items()
            if str(function["Properties"]["Runtime"]).startswith("nodejs")
        ]

        assert [id for id in node if not id.startswith("BootstrapProviderframework")] == []

    def test_throttles_the_api_and_the_auth_routes_more_tightly(self, template: Template) -> None:
        tight = {"ThrottlingRateLimit": 5, "ThrottlingBurstLimit": 10}
        template.has_resource_properties(
            "AWS::ApiGatewayV2::Stage",
            {
                "DefaultRouteSettings": {"ThrottlingRateLimit": 50, "ThrottlingBurstLimit": 100},
                "RouteSettings": {
                    "POST /api/v1/auth/register": tight,
                    "POST /api/v1/auth/login": tight,
                    "POST /api/v1/auth/refresh": tight,
                    "POST /api/v1/auth/logout": tight,
                    "GET /api/v1/auth/google/start": tight,
                    "GET /api/v1/auth/google/callback": tight,
                },
            },
        )

    def test_lets_dynamodb_delete_expired_refresh_tokens(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::DynamoDB::GlobalTable", {"TimeToLiveSpecification": {"AttributeName": "ttl", "Enabled": True}}
        )

    def test_has_a_lambda_authorizer_that_caches_nothing_so_a_deleted_user_is_refused_at_once(
        self, template: Template
    ) -> None:
        template.has_resource_properties(
            "AWS::ApiGatewayV2::Authorizer",
            {
                "AuthorizerType": "REQUEST",
                "AuthorizerPayloadFormatVersion": "2.0",
                "EnableSimpleResponses": True,
                "IdentitySource": ["$request.header.Authorization"],
                "AuthorizerResultTtlInSeconds": 0,
            },
        )

    def test_lets_the_authorizer_read_the_users_table_but_not_write_to_it(self, template: Template) -> None:
        authorizer = found(template, "AWS::Lambda::Function", "AuthorizerFunction")

        assert authorizer["Properties"]["Environment"]["Variables"]["USERS_TABLE"]["Ref"].startswith("UsersTable")
        document = json.dumps(function_policy(template, authorizer))
        assert "dynamodb:GetItem" in document
        assert "dynamodb:PutItem" not in document
        assert "dynamodb:DeleteItem" not in document

    @pytest.mark.parametrize(
        "route_key",
        [
            "DELETE /api/v1/admin/users/{id}",
            "GET /api/v1/admin/users",
            "POST /api/v1/admin/users/{id}/enable",
            "POST /api/v1/admin/users/{id}/disable",
        ],
    )
    def test_puts_the_admin_routes_behind_the_authorizer(self, template: Template, route_key: str) -> None:
        has_protected_route(template, route_key)

    def test_serves_the_transaction_routes_from_python_with_the_data_table_and_signing_secret(
        self, template: Template
    ) -> None:
        data = found(template, "AWS::Lambda::Function", "DataFunction")

        assert_runs_from_python(data, "data", 256)
        assert data["Properties"]["Environment"]["Variables"]["DATA_TABLE"]["Ref"].startswith("DataTable")
        assert "ssm:GetParameter" in json.dumps(function_policy(template, data))

    def test_serves_the_admin_routes_with_both_tables_since_deleting_a_user_takes_their_data(
        self, template: Template
    ) -> None:
        admin = found(template, "AWS::Lambda::Function", "AdminFunction")

        assert_runs_from_python(admin, "admin", 256)
        variables = admin["Properties"]["Environment"]["Variables"]
        assert variables["USERS_TABLE"]["Ref"].startswith("UsersTable")
        assert variables["DATA_TABLE"]["Ref"].startswith("DataTable")

    def test_runs_the_bootstrap_on_deploy_allowed_to_create_both_ssm_parameters(self, template: Template) -> None:
        template.resource_count_is("AWS::CloudFormation::CustomResource", 1)
        statements = [
            s
            for p in template.find_resources("AWS::IAM::Policy").values()
            for s in p["Properties"]["PolicyDocument"]["Statement"]
        ]

        put = next(s for s in statements if "ssm:PutParameter" in actions_of(s))

        assert "ledger-api/jwt-signing-secret" in json.dumps(put["Resource"])
        assert "ledger-api/admin-password" in json.dumps(put["Resource"])

    def test_has_a_data_table_with_a_by_category_index_and_an_all_customers_index(self, template: Template) -> None:
        def index(name: str, partition_key: str, sort_key: str) -> Any:
            return Match.object_like(
                {
                    "IndexName": name,
                    "KeySchema": [
                        {"AttributeName": partition_key, "KeyType": "HASH"},
                        {"AttributeName": sort_key, "KeyType": "RANGE"},
                    ],
                }
            )

        template.has_resource_properties(
            "AWS::DynamoDB::GlobalTable",
            {
                "BillingMode": "PAY_PER_REQUEST",
                "GlobalSecondaryIndexes": [
                    index("byCategory", "gsi2pk", "gsi2sk"),
                    index("allByDate", "gsi3pk", "gsi3sk"),
                ],
            },
        )

    def test_has_no_member_routes(self, template: Template) -> None:
        routes = template.find_resources("AWS::ApiGatewayV2::Route").values()

        assert [r for r in routes if "/members" in r["Properties"]["RouteKey"]] == []

    @pytest.mark.parametrize(
        "route_key",
        [
            "POST /api/v1/transactions",
            "GET /api/v1/transactions",
            "GET /api/v1/transactions/summary",
            "GET /api/v1/transactions/{id}",
            "PATCH /api/v1/transactions/{id}",
            "DELETE /api/v1/transactions/{id}",
            "GET /api/v1/admin/users/{id}/transactions",
            "GET /api/v1/admin/transactions",
            "PATCH /api/v1/admin/users/{id}/transactions/{transactionId}",
            "DELETE /api/v1/admin/users/{id}/transactions/{transactionId}",
        ],
    )
    def test_puts_the_transaction_routes_behind_the_authorizer(self, template: Template, route_key: str) -> None:
        has_protected_route(template, route_key)

    def test_serves_mcp_behind_the_authorizer_from_a_python_function_that_can_use_the_data_table(
        self, template: Template
    ) -> None:
        has_protected_route(template, "POST /api/mcp")
        mcp = found(template, "AWS::Lambda::Function", "McpFunction")

        assert_runs_from_python(mcp, "mcp", 256)
        assert "DATA_TABLE" in mcp["Properties"]["Environment"]["Variables"]
        # It signs list cursors with a key derived from the signing secret, like the Data function.
        assert "ssm:GetParameter" in json.dumps(function_policy(template, mcp))

    def test_lets_the_mcp_function_read_usernames_from_the_users_table_but_not_write(self, template: Template) -> None:
        mcp = found(template, "AWS::Lambda::Function", "McpFunction")
        statements = function_policy(template, mcp)["Statement"]

        users = [s for s in statements if "UsersTable" in json.dumps(s["Resource"])]
        actions = [action for s in users for action in actions_of(s)]

        assert "USERS_TABLE" in mcp["Properties"]["Environment"]["Variables"]
        assert "dynamodb:BatchGetItem" in actions
        assert [a for a in actions if any(word in a for word in ("Put", "Update", "Delete", "Write"))] == []

    def test_protects_auth_me_and_leaves_the_sign_in_routes_public(self, template: Template) -> None:
        has_protected_route(template, "GET /api/v1/auth/me")
        public = [
            *[f"POST /api/v1/auth/{route}" for route in ("register", "login", "refresh", "logout")],
            *[f"GET /api/v1/auth/google/{route}" for route in ("start", "callback")],
        ]
        for route_key in public:
            template.has_resource_properties(
                "AWS::ApiGatewayV2::Route", {"RouteKey": route_key, "AuthorizationType": "NONE"}
            )

    def test_serves_api_paths_through_cloudfront_with_caching_off_and_auth_forwarded(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::CloudFront::Distribution",
            {
                "DistributionConfig": Match.object_like(
                    {
                        "CacheBehaviors": [
                            Match.object_like(
                                {
                                    "PathPattern": "/api/*",
                                    "ViewerProtocolPolicy": "redirect-to-https",
                                    # AWS managed policies: CachingDisabled and AllViewerExceptHostHeader.
                                    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
                                    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
                                    # array_with matches in order.
                                    "AllowedMethods": Match.array_with(["GET", "PATCH", "POST", "DELETE"]),
                                }
                            )
                        ]
                    }
                )
            },
        )

    def test_has_four_free_tier_alarms_that_notify_an_sns_topic(self, template: Template) -> None:
        alarms = template.find_resources("AWS::CloudWatch::Alarm").values()

        assert len(alarms) == 4
        assert all(len(alarm["Properties"]["AlarmActions"]) == 1 for alarm in alarms)
        template.has_resource_properties("AWS::Logs::MetricFilter", {"FilterPattern": '{ $.event = "login_failed" }'})

    def test_subscribes_no_email_when_alarm_email_isnt_set(self, template: Template) -> None:
        template.resource_count_is("AWS::SNS::Subscription", 0)

    def test_subscribes_the_alarm_email_context_value(self) -> None:
        app = quick_app(alarmEmail="me@example.com")

        with_email = Template.from_stack(LedgerStack(app, "LedgerApi", env=REGION_ONLY))

        with_email.has_resource_properties(
            "AWS::SNS::Subscription", {"Protocol": "email", "Endpoint": "me@example.com"}
        )


class TestGivenGoogleSignIn:
    def test_gives_auth_the_client_id_the_redirect_uri_and_only_the_client_secrets_parameter(self) -> None:
        stack = synth(google_sign_in=GoogleSignIn("client-1", "https://ledger.example.test/callback"))

        auth = found(stack, "AWS::Lambda::Function", "AuthFunction")

        variables = auth["Properties"]["Environment"]["Variables"]
        assert variables["GOOGLE_CLIENT_ID"] == "client-1"
        assert variables["GOOGLE_REDIRECT_URI"] == "https://ledger.example.test/callback"
        assert "ledger-api/google-client-secret" in json.dumps(function_policy(stack, auth))
        assert "GOOGLE_CLIENT_SECRET" not in json.dumps(stack.to_json())

    def test_leaves_all_of_that_out_when_it_isnt_configured(self, template: Template) -> None:
        auth = found(template, "AWS::Lambda::Function", "AuthFunction")

        assert "GOOGLE_CLIENT_ID" not in auth["Properties"]["Environment"]["Variables"]
        assert "google-client-secret" not in json.dumps(function_policy(template, auth))
