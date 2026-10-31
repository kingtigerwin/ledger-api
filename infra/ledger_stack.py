# jsii generates CDK's classes with other parameter names than their interfaces, so pyright sees a `Function` as no
# `IFunction`, and so on for nearly every construct passed to another. At run time jsii checks these arguments itself.
# pyright: reportArgumentType=false

from dataclasses import dataclass
from typing import Any, cast

from aws_cdk import Arn, ArnComponents, CfnOutput, CustomResource, Duration, Stack
from aws_cdk import aws_apigatewayv2 as apigw
from aws_cdk import aws_certificatemanager as acm
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_cloudwatch as cloudwatch
from aws_cdk import aws_cloudwatch_actions as cloudwatch_actions
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_lambda_event_sources as event_sources
from aws_cdk import aws_logs as logs
from aws_cdk import aws_route53 as route53
from aws_cdk import aws_route53_targets as targets
from aws_cdk import aws_ses as ses
from aws_cdk import aws_sns as sns
from aws_cdk import aws_sns_subscriptions as subscriptions
from aws_cdk import aws_sqs as sqs
from aws_cdk import custom_resources as cr
from aws_cdk.aws_apigatewayv2_authorizers import HttpLambdaAuthorizer, HttpLambdaResponseType
from aws_cdk.aws_apigatewayv2_integrations import HttpLambdaIntegration
from constructs import Construct

from infra.certificate_stack import CustomDomain
from infra.python_code import python_code
from infra.tables import DATA_INDEXES, PARTITION_KEY, SORT_KEY
from ledger_api.config import ADMIN_PASSWORD_PARAM, GOOGLE_CLIENT_SECRET_PARAM, SIGNING_SECRET_PARAM

# Unauthenticated routes that anyone on the internet can call, so they get tighter throttling.
PUBLIC_AUTH_ROUTES = [f"/api/v1/auth/{name}" for name in ("register", "login", "refresh", "logout")]
GOOGLE_AUTH_ROUTES = [f"/api/v1/auth/google/{name}" for name in ("start", "callback")]


@dataclass(frozen=True)
class CertifiedDomain(CustomDomain):
    """The custom domain, with its certificate from CertificateStack."""

    certificate: acm.ICertificate


@dataclass(frozen=True)
class GoogleClient:
    """The client ID is public; its secret goes in SSM by hand (see README)."""

    client_id: str
    redirect_uri: str


class LedgerStack(Stack):
    """The API: its tables, its Lambdas, the HTTP API, CloudFront in front, alarms and, optionally, emails.

    `custom_domain` serves the API on that name as well as the CloudFront domain. `email_from` emails customers from
    this address when they register and when first approved; it must be in the custom domain's zone, which is where
    SES's DKIM records go. `admin_email` is where to send each sign-up (the admin's own address), and needs
    `email_from`. `admin_page_url` is ledger-ui's admin page, linked from the admin's sign-up email; without it the
    email gives the API calls. Without `google_sign_in` the Google routes still exist, and send the browser back to the
    login page.
    """

    def __init__(
        self,
        scope: Construct,
        id: str,
        *,
        custom_domain: CertifiedDomain | None = None,
        email_from: str | None = None,
        admin_email: str | None = None,
        admin_page_url: str | None = None,
        google_sign_in: GoogleClient | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(scope, id, **kwargs)

        if email_from and not custom_domain:
            raise ValueError("email_from needs custom_domain: SES verifies the sender's domain through its hosted zone")
        if email_from and custom_domain and email_from.split("@")[1] != custom_domain.zone_name:
            raise ValueError(f"email_from must be an address at {custom_domain.zone_name}, the custom domain's zone")

        table_key = dynamodb.Attribute(name=PARTITION_KEY, type=dynamodb.AttributeType.STRING)
        table_sort_key = dynamodb.Attribute(name=SORT_KEY, type=dynamodb.AttributeType.STRING)
        users_table = dynamodb.TableV2(
            self,
            "UsersTable",
            partition_key=table_key,
            sort_key=table_sort_key,
            billing=dynamodb.Billing.on_demand(),
            time_to_live_attribute="ttl",
            # Feeds the notify Lambda; reading a stream from Lambda is free.
            dynamo_stream=dynamodb.StreamViewType.NEW_AND_OLD_IMAGES if email_from else None,
        )

        data_table = dynamodb.TableV2(
            self,
            "DataTable",
            partition_key=table_key,
            sort_key=table_sort_key,
            billing=dynamodb.Billing.on_demand(),
            global_secondary_indexes=[
                dynamodb.GlobalSecondaryIndexPropsV2(
                    index_name=index.name,
                    partition_key=dynamodb.Attribute(name=index.partition_key, type=dynamodb.AttributeType.STRING),
                    sort_key=dynamodb.Attribute(name=index.sort_key, type=dynamodb.AttributeType.STRING),
                )
                for index in DATA_INDEXES
            ],
        )

        def parameter_arn(name: str) -> str:
            return Arn.format(ArnComponents(service="ssm", resource="parameter", resource_name=name[1:]), self)

        def make_python_function(
            name: str,
            module: str,
            *,
            memory_size: int,
            environment: dict[str, str] | None = None,
            timeout: Duration | None = None,
        ) -> lambda_.Function:
            """Every Lambda is Python, from one bundle, or for MCP one with the SDK too (infra/python_code.py)."""
            return lambda_.Function(
                self,
                f"{name}Function",
                code=python_code(with_mcp=module == "mcp"),
                handler=f"ledger_api.{module}.lambda_function.handler",
                runtime=lambda_.Runtime.PYTHON_3_13,
                architecture=lambda_.Architecture.ARM_64,
                timeout=timeout or Duration.seconds(10),
                logging_format=lambda_.LoggingFormat.JSON,
                log_group=logs.LogGroup(self, f"{name}Logs", retention=logs.RetentionDays.TWO_WEEKS),
                memory_size=memory_size,
                environment=environment,
            )

        def can_read_signing_secret(function: lambda_.Function) -> None:
            function.add_to_role_policy(
                iam.PolicyStatement(actions=["ssm:GetParameter"], resources=[parameter_arn(SIGNING_SECRET_PARAM)])
            )

        google_environment = (
            {"GOOGLE_CLIENT_ID": google_sign_in.client_id, "GOOGLE_REDIRECT_URI": google_sign_in.redirect_uri}
            if google_sign_in
            else {}
        )
        auth_function = make_python_function(
            "Auth",
            "auth",
            # scrypt needs about 128 MB per hash; more memory also means more CPU, so hashing is faster.
            memory_size=512,
            environment={"USERS_TABLE": users_table.table_name, **google_environment},
        )
        users_table.grant_read_write_data(auth_function)
        can_read_signing_secret(auth_function)
        if google_sign_in:
            auth_function.add_to_role_policy(
                iam.PolicyStatement(actions=["ssm:GetParameter"], resources=[parameter_arn(GOOGLE_CLIENT_SECRET_PARAM)])
            )

        authorizer_function = make_python_function(
            "Authorizer", "authorizer", memory_size=256, environment={"USERS_TABLE": users_table.table_name}
        )
        can_read_signing_secret(authorizer_function)
        users_table.grant_read_data(authorizer_function)
        authorizer = HttpLambdaAuthorizer(
            "BearerAuthorizer",
            authorizer_function,
            response_types=[HttpLambdaResponseType.SIMPLE],
            # No cache: each request checks the user is still active, so disabling or deleting them takes effect at
            # once.
            results_cache_ttl=Duration.seconds(0),
        )

        # Creates the signing secret, the admin password and the admin user on first deploy.
        bootstrap_function = make_python_function(
            "Bootstrap",
            "bootstrap",
            memory_size=512,  # hashes the admin password with scrypt
            timeout=Duration.seconds(30),
            environment={"USERS_TABLE": users_table.table_name},
        )
        users_table.grant_read_write_data(bootstrap_function)
        bootstrap_function.add_to_role_policy(
            iam.PolicyStatement(
                actions=["ssm:GetParameter", "ssm:PutParameter"],
                resources=[parameter_arn(SIGNING_SECRET_PARAM), parameter_arn(ADMIN_PASSWORD_PARAM)],
            )
        )
        bootstrap = CustomResource(
            self,
            "Bootstrap",
            service_token=cr.Provider(self, "BootstrapProvider", on_event_handler=bootstrap_function).service_token,
        )

        admin_function = make_python_function(
            "Admin",
            "admin",
            memory_size=256,
            environment={"USERS_TABLE": users_table.table_name, "DATA_TABLE": data_table.table_name},
        )
        users_table.grant_read_write_data(admin_function)
        # Deleting a user takes their transactions too.
        data_table.grant_read_write_data(admin_function)

        data_function = make_python_function(
            "Data", "data", memory_size=256, environment={"DATA_TABLE": data_table.table_name}
        )
        data_table.grant_read_write_data(data_function)
        can_read_signing_secret(data_function)

        # MCP tools for agents: the Transactions routes again, acting as the caller. The signing secret is for list
        # cursors; the Users table, read-only, is for the usernames on the admin's cross-customer list.
        mcp_function = make_python_function(
            "Mcp",
            "mcp",
            memory_size=256,
            environment={"DATA_TABLE": data_table.table_name, "USERS_TABLE": users_table.table_name},
        )
        data_table.grant_read_write_data(mcp_function)
        users_table.grant_read_data(mcp_function)
        can_read_signing_secret(mcp_function)

        docs_function = make_python_function("Docs", "docs", memory_size=128)

        api = apigw.HttpApi(self, "Api", create_default_stage=False)
        auth = HttpLambdaIntegration("AuthIntegration", auth_function)
        post, get, patch, delete = (
            apigw.HttpMethod.POST,
            apigw.HttpMethod.GET,
            apigw.HttpMethod.PATCH,
            apigw.HttpMethod.DELETE,
        )
        public_routes = [
            *(
                route
                for path in PUBLIC_AUTH_ROUTES
                for route in api.add_routes(path=path, methods=[post], integration=auth)
            ),
            *(
                route
                for path in GOOGLE_AUTH_ROUTES
                for route in api.add_routes(path=path, methods=[get], integration=auth)
            ),
        ]
        api.add_routes(path="/api/v1/auth/me", methods=[get], integration=auth, authorizer=authorizer)
        api.add_routes(
            path="/api/openapi.json",
            methods=[get],
            integration=HttpLambdaIntegration("DocsIntegration", docs_function),
        )
        data = HttpLambdaIntegration("DataIntegration", data_function)
        data_routes = [
            ("/api/v1/transactions", [post, get]),
            # A static segment wins over {id}, so /summary never reaches the {id} route.
            ("/api/v1/transactions/summary", [get]),
            ("/api/v1/transactions/{id}", [get, patch, delete]),
            ("/api/v1/admin/users/{id}/transactions", [get]),
            ("/api/v1/admin/users/{id}/transactions/{transactionId}", [patch, delete]),
            ("/api/v1/admin/transactions", [get]),
        ]
        for path, methods in data_routes:
            api.add_routes(path=path, methods=methods, integration=data, authorizer=authorizer)
        api.add_routes(
            path="/api/mcp",
            methods=[post],
            integration=HttpLambdaIntegration("McpIntegration", mcp_function),
            authorizer=authorizer,
        )
        admin = HttpLambdaIntegration("AdminIntegration", admin_function)
        api.add_routes(path="/api/v1/admin/users", methods=[get], integration=admin, authorizer=authorizer)
        api.add_routes(path="/api/v1/admin/users/{id}", methods=[delete], integration=admin, authorizer=authorizer)
        for action in ("enable", "disable"):
            api.add_routes(
                path=f"/api/v1/admin/users/{{id}}/{action}", methods=[post], integration=admin, authorizer=authorizer
            )

        stage = apigw.HttpStage(
            self,
            "DefaultStage",
            http_api=api,
            stage_name="$default",
            auto_deploy=True,
            throttle=apigw.ThrottleSettings(rate_limit=50, burst_limit=100),
        )
        # RouteSettings is untyped JSON, so CDK passes keys through as written: they must be PascalCase.
        # Per-route limits refer to routes by key, so the routes must exist before the stage.
        public_route_keys = [
            *(f"POST {path}" for path in PUBLIC_AUTH_ROUTES),
            *(f"GET {path}" for path in GOOGLE_AUTH_ROUTES),
        ]
        cast(apigw.CfnStage, stage.node.default_child).route_settings = {
            route_key: {"ThrottlingRateLimit": 5, "ThrottlingBurstLimit": 10} for route_key in public_route_keys
        }
        for route in public_routes:
            stage.node.add_dependency(route)
        # Don't serve traffic before the signing secret exists.
        stage.node.add_dependency(bootstrap)

        # One origin for the browser: /api/* goes to API Gateway, so the refresh cookie is first-party.
        # A UI can later become the default behaviour without changing the API's address.
        api_behavior = cloudfront.BehaviorOptions(
            origin=origins.HttpOrigin(f"{api.api_id}.execute-api.{self.region}.{self.url_suffix}"),
            viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
            cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
            # Forwards the Authorization header, cookies and query strings.
            origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        )
        distribution = cloudfront.Distribution(
            self,
            "Cdn",
            default_behavior=api_behavior,
            additional_behaviors={"/api/*": api_behavior},
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
            domain_names=[custom_domain.domain_name] if custom_domain else None,
            certificate=custom_domain.certificate if custom_domain else None,
        )
        # Only adds the API's own records (and SES's); the zone and its other records belong to whoever manages the
        # domain.
        zone = (
            route53.HostedZone.from_hosted_zone_attributes(
                self, "Zone", zone_name=custom_domain.zone_name, hosted_zone_id=custom_domain.hosted_zone_id
            )
            if custom_domain
            else None
        )
        if custom_domain and zone:
            target = route53.RecordTarget.from_alias(targets.CloudFrontTarget(distribution))
            record_name = custom_domain.domain_name
            route53.ARecord(self, "ApiAliasIpv4", zone=zone, record_name=record_name, target=target)
            route53.AaaaRecord(self, "ApiAliasIpv6", zone=zone, record_name=record_name, target=target)
        CfnOutput(self, "CloudFrontUrl", value=f"https://{distribution.distribution_domain_name}")
        api_host = custom_domain.domain_name if custom_domain else distribution.distribution_domain_name
        CfnOutput(self, "ApiUrl", value=f"https://{api_host}")

        # Four alarms (five with emails on) keeps within CloudWatch's free 10. The Lambda ones use the account-wide
        # metrics (one alarm each instead of one per function), so they also cover any other
        # Lambdas in this account and region.
        alarm_topic = sns.Topic(self, "AlarmTopic")
        alarm_email: str | None = self.node.try_get_context("alarmEmail")
        if alarm_email:
            alarm_topic.add_subscription(subscriptions.EmailSubscription(alarm_email))

        logs.MetricFilter(
            self,
            "FailedLoginsFilter",
            log_group=auth_function.log_group,
            filter_pattern=logs.FilterPattern.string_value("$.event", "=", "login_failed"),
            metric_namespace="LedgerApi",
            metric_name="FailedLogins",
            metric_value="1",
        )
        five_minutes = Duration.minutes(5)
        alarms = [
            (
                "Api5xx",
                cloudwatch.Metric(namespace="AWS/ApiGateway", metric_name="5xx", dimensions_map={"ApiId": api.api_id}),
                1,
            ),
            ("LambdaErrors", cloudwatch.Metric(namespace="AWS/Lambda", metric_name="Errors"), 1),
            ("LambdaThrottles", cloudwatch.Metric(namespace="AWS/Lambda", metric_name="Throttles"), 1),
            # Lockout already stops guessing one account; this catches guessing across many.
            ("FailedLogins", cloudwatch.Metric(namespace="LedgerApi", metric_name="FailedLogins"), 20),
        ]
        for name, metric, threshold in alarms:
            cloudwatch.Alarm(
                self,
                f"{name}Alarm",
                metric=metric.with_(statistic="Sum", period=five_minutes),
                threshold=threshold,
                evaluation_periods=1,
                comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
            ).add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))

        # Customers' account emails: the Users table's stream drives a Lambda that sends through SES.
        # Sends that still fail after three retries land in a queue, and its alarm says so.
        if email_from and custom_domain and zone:
            # Bounces and complaints are published to their own topic, emailed to the alarm address. The
            # configuration set is the domain's default, so every send is tracked without naming it.
            feedback_topic = sns.Topic(self, "EmailFeedbackTopic")
            if alarm_email:
                feedback_topic.add_subscription(subscriptions.EmailSubscription(alarm_email))
            configuration_set = ses.ConfigurationSet(self, "EmailConfigurationSet")
            configuration_set.add_event_destination(
                "BouncesAndComplaints",
                destination=ses.EventDestination.sns_topic(feedback_topic),
                events=[ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT],
            )
            # Easy DKIM: SES adds its three CNAME records to the zone and verifies the domain itself.
            ses.EmailIdentity(
                self,
                "EmailIdentity",
                identity=ses.Identity.public_hosted_zone(zone),
                configuration_set=configuration_set,
            )
            notify_environment = {"EMAIL_FROM": email_from, "API_URL": f"https://{custom_domain.domain_name}"}
            if admin_email:
                notify_environment["ADMIN_EMAIL"] = admin_email
            if admin_page_url:
                notify_environment["ADMIN_PAGE_URL"] = admin_page_url
            notify_function = make_python_function("Notify", "notify", memory_size=128, environment=notify_environment)
            # SES checks the permission on the configuration set, and on every identity involved: the
            # domain, and in the sandbox each verified recipient (the admin's address). So any identity in
            # this account and region, but only ever sending as email_from.
            notify_function.add_to_role_policy(
                iam.PolicyStatement(
                    actions=["ses:SendEmail", "ses:SendRawEmail"],
                    resources=[
                        self.format_arn(service="ses", resource="identity", resource_name="*"),
                        self.format_arn(
                            service="ses",
                            resource="configuration-set",
                            resource_name=configuration_set.configuration_set_name,
                        ),
                    ],
                    conditions={"StringEquals": {"ses:FromAddress": email_from}},
                )
            )

            failed = sqs.Queue(self, "NotifyFailures", retention_period=Duration.days(14))
            notify_function.add_event_source(
                event_sources.DynamoEventSource(
                    users_table,
                    starting_position=lambda_.StartingPosition.LATEST,
                    # Refresh tokens, username claims and lockouts never reach the function.
                    filters=[
                        lambda_.FilterCriteria.filter(
                            {"dynamodb": {"Keys": {"sk": {"S": lambda_.FilterRule.is_equal("PROFILE")}}}}
                        )
                    ],
                    report_batch_item_failures=True,
                    retry_attempts=3,
                    bisect_batch_on_error=True,
                    on_failure=event_sources.SqsDlq(failed),
                )
            )
            cloudwatch.Alarm(
                self,
                "NotifyFailuresAlarm",
                metric=failed.metric_approximate_number_of_messages_visible(statistic="Maximum", period=five_minutes),
                threshold=1,
                evaluation_periods=1,
                comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
            ).add_alarm_action(cloudwatch_actions.SnsAction(alarm_topic))
