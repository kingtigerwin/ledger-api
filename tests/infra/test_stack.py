"""The LedgerApi stack's resources, synthesized without building the bundles."""

import pytest
from aws_cdk import App
from aws_cdk.assertions import Match, Template

from infra.ledger_stack import GoogleClient
from tests.infra.stacks import actions_of, as_text, function_named, policy_of, synth

PROTECTED = "CUSTOM"
PUBLIC = "NONE"


@pytest.fixture(scope="module")
def template() -> Template:
    return synth()


def route_keys(template: Template) -> list[str]:
    routes = template.find_resources("AWS::ApiGatewayV2::Route").values()
    return [route["Properties"]["RouteKey"] for route in routes]


class TestGivenTheTables:
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

    def test_lets_dynamodb_delete_expired_refresh_tokens(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::DynamoDB::GlobalTable", {"TimeToLiveSpecification": {"AttributeName": "ttl", "Enabled": True}}
        )

    def test_has_a_data_table_with_a_by_category_index_and_an_all_customers_index(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::DynamoDB::GlobalTable",
            {
                "BillingMode": "PAY_PER_REQUEST",
                "GlobalSecondaryIndexes": [
                    Match.object_like(
                        {
                            "IndexName": "byCategory",
                            "KeySchema": [
                                {"AttributeName": "gsi2pk", "KeyType": "HASH"},
                                {"AttributeName": "gsi2sk", "KeyType": "RANGE"},
                            ],
                        }
                    ),
                    Match.object_like(
                        {
                            "IndexName": "allByDate",
                            "KeySchema": [
                                {"AttributeName": "gsi3pk", "KeyType": "HASH"},
                                {"AttributeName": "gsi3sk", "KeyType": "RANGE"},
                            ],
                        }
                    ),
                ],
            },
        )


class TestGivenTheFunctions:
    @pytest.mark.parametrize(
        ("name", "module", "memory"),
        [
            ("Auth", "auth", 512),
            ("Authorizer", "authorizer", 256),
            # Hashes the admin's password with scrypt.
            ("Bootstrap", "bootstrap", 512),
            ("Data", "data", 256),
            ("Admin", "admin", 256),
            ("Mcp", "mcp", 256),
            ("Docs", "docs", 128),
        ],
        ids=["auth", "authorizer", "bootstrap", "data", "admin", "mcp", "docs"],
    )
    def test_runs_it_from_python(self, template: Template, name: str, module: str, memory: int) -> None:
        properties = function_named(template, name)["Properties"]

        assert properties["Handler"] == f"ledger_api.{module}.lambda_function.handler"
        assert properties["MemorySize"] == memory
        assert properties["Runtime"] == "python3.13"
        assert properties["Architectures"] == ["arm64"]
        assert properties["LoggingConfig"]["LogFormat"] == "JSON"

    def test_gives_the_auth_function_enough_memory_for_scrypt(self, template: Template) -> None:
        assert function_named(template, "Auth")["Properties"]["MemorySize"] >= 512

    def test_has_no_nodejs_functions_but_cdks_own(self, template: Template) -> None:
        node = [
            logical_id
            for logical_id, function in template.find_resources("AWS::Lambda::Function").items()
            if str(function["Properties"]["Runtime"]).startswith("nodejs")
        ]

        assert [logical_id for logical_id in node if not logical_id.startswith("BootstrapProviderframework")] == []

    def test_gives_the_data_function_the_tables_name_and_the_signing_secret(self, template: Template) -> None:
        data = function_named(template, "Data")

        assert data["Properties"]["Environment"]["Variables"]["DATA_TABLE"]["Ref"].startswith("DataTable")
        assert "ssm:GetParameter" in as_text(policy_of(template, data))

    def test_gives_the_admin_function_both_tables_since_deleting_a_user_takes_their_data(
        self, template: Template
    ) -> None:
        variables = function_named(template, "Admin")["Properties"]["Environment"]["Variables"]

        assert variables["USERS_TABLE"]["Ref"].startswith("UsersTable")
        assert variables["DATA_TABLE"]["Ref"].startswith("DataTable")

    def test_runs_the_bootstrap_on_deploy_allowed_to_create_both_ssm_parameters(self, template: Template) -> None:
        template.resource_count_is("AWS::CloudFormation::CustomResource", 1)
        statements = [
            statement
            for policy in template.find_resources("AWS::IAM::Policy").values()
            for statement in policy["Properties"]["PolicyDocument"]["Statement"]
        ]
        put = next(statement for statement in statements if "ssm:PutParameter" in actions_of(statement))

        assert "ledger-api/jwt-signing-secret" in as_text(put["Resource"])
        assert "ledger-api/admin-password" in as_text(put["Resource"])

    def test_lets_the_authorizer_read_the_users_table_but_not_write_to_it(self, template: Template) -> None:
        authorizer = function_named(template, "Authorizer")
        document = as_text(policy_of(template, authorizer))

        assert authorizer["Properties"]["Environment"]["Variables"]["USERS_TABLE"]["Ref"].startswith("UsersTable")
        assert "dynamodb:GetItem" in document
        assert "dynamodb:PutItem" not in document
        assert "dynamodb:DeleteItem" not in document

    def test_gives_mcp_the_data_table_and_the_signing_secret_for_list_cursors(self, template: Template) -> None:
        mcp = function_named(template, "Mcp")

        assert "DATA_TABLE" in mcp["Properties"]["Environment"]["Variables"]
        assert "ssm:GetParameter" in as_text(policy_of(template, mcp))

    def test_lets_mcp_read_usernames_from_the_users_table_but_not_write_to_it(self, template: Template) -> None:
        mcp = function_named(template, "Mcp")
        users_statements = [
            statement
            for statement in policy_of(template, mcp)["Statement"]
            if "UsersTable" in as_text(statement["Resource"])
        ]
        actions = [action for statement in users_statements for action in actions_of(statement)]

        assert "USERS_TABLE" in mcp["Properties"]["Environment"]["Variables"]
        assert "dynamodb:BatchGetItem" in actions
        assert [
            action for action in actions if any(word in action for word in ("Put", "Update", "Delete", "Write"))
        ] == []


class TestGivenTheRoutes:
    def test_routes_register_and_login_to_the_auth_function(self, template: Template) -> None:
        for route_key in ("POST /api/v1/auth/register", "POST /api/v1/auth/login"):
            template.has_resource_properties("AWS::ApiGatewayV2::Route", {"RouteKey": route_key})

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

    @pytest.mark.parametrize(
        "route_key",
        [
            "DELETE /api/v1/admin/users/{id}",
            "GET /api/v1/admin/users",
            "POST /api/v1/admin/users/{id}/enable",
            "POST /api/v1/admin/users/{id}/disable",
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
            "POST /api/mcp",
            "GET /api/v1/auth/me",
        ],
    )
    def test_puts_it_behind_the_authorizer(self, template: Template, route_key: str) -> None:
        template.has_resource_properties(
            "AWS::ApiGatewayV2::Route", {"RouteKey": route_key, "AuthorizationType": PROTECTED}
        )

    @pytest.mark.parametrize(
        "route_key",
        [
            "POST /api/v1/auth/register",
            "POST /api/v1/auth/login",
            "POST /api/v1/auth/refresh",
            "POST /api/v1/auth/logout",
            "GET /api/v1/auth/google/start",
            "GET /api/v1/auth/google/callback",
        ],
    )
    def test_leaves_the_sign_in_routes_public(self, template: Template, route_key: str) -> None:
        template.has_resource_properties(
            "AWS::ApiGatewayV2::Route", {"RouteKey": route_key, "AuthorizationType": PUBLIC}
        )

    def test_has_no_member_routes(self, template: Template) -> None:
        assert [key for key in route_keys(template) if "/members" in key] == []


class TestGivenGoogleSignIn:
    def test_gives_the_auth_function_the_client_id_the_redirect_uri_and_only_the_secrets_parameter(self) -> None:
        stack = synth(google_sign_in=GoogleClient("client-1", "https://ledger.example.test/callback"))

        auth = function_named(stack, "Auth")
        variables = auth["Properties"]["Environment"]["Variables"]

        assert variables["GOOGLE_CLIENT_ID"] == "client-1"
        assert variables["GOOGLE_REDIRECT_URI"] == "https://ledger.example.test/callback"
        assert "ledger-api/google-client-secret" in as_text(policy_of(stack, auth))
        assert "GOOGLE_CLIENT_SECRET" not in as_text(stack.to_json())

    def test_leaves_all_of_that_out_when_it_isnt_configured(self, template: Template) -> None:
        auth = function_named(template, "Auth")

        assert "GOOGLE_CLIENT_ID" not in auth["Properties"]["Environment"]["Variables"]
        assert "google-client-secret" not in as_text(policy_of(template, auth))


class TestGivenCloudFront:
    def test_serves_the_api_with_caching_off_and_auth_headers_and_cookies_forwarded(self, template: Template) -> None:
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


class TestGivenTheAlarms:
    def test_has_four_free_tier_alarms_that_notify_an_sns_topic(self, template: Template) -> None:
        alarms = template.find_resources("AWS::CloudWatch::Alarm").values()

        assert len(alarms) == 4
        assert all(len(alarm["Properties"]["AlarmActions"]) == 1 for alarm in alarms)
        template.has_resource_properties("AWS::Logs::MetricFilter", {"FilterPattern": '{ $.event = "login_failed" }'})

    def test_subscribes_no_email_when_alarm_email_isnt_set(self, template: Template) -> None:
        template.resource_count_is("AWS::SNS::Subscription", 0)

    def test_subscribes_the_alarm_email_context_value(self) -> None:
        with_email = synth(App(context={"alarmEmail": "me@example.com"}))

        with_email.has_resource_properties(
            "AWS::SNS::Subscription", {"Protocol": "email", "Endpoint": "me@example.com"}
        )
