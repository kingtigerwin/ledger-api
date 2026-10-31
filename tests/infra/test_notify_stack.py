import json
from typing import Any

import pytest
from aws_cdk import App, Environment
from aws_cdk.assertions import Match, Template

from infra.ledger_stack import LedgerStack
from tests.infra.stacks import ENV, Resource, actions_of, as_text, custom_domain, function_named, policy_of, synth

SENDER = "noreply@example.cloud"


def with_email(app: App, *, sender: str = SENDER, **kwargs: Any) -> LedgerStack:
    env = Environment(account=ENV.account, region=ENV.region)
    return LedgerStack(app, "LedgerApi", env=env, custom_domain=custom_domain(app), email_from=sender, **kwargs)


def sends(template: Template) -> list[Resource]:
    statements = policy_of(template, function_named(template, "Notify"))["Statement"]
    return [statement for statement in statements if "ses:SendEmail" in actions_of(statement)]


def feedback_topic_id(template: Template) -> str:
    topics = template.find_resources("AWS::SNS::Topic")
    return next(logical_id for logical_id in topics if logical_id.startswith("EmailFeedback"))


@pytest.fixture(scope="module")
def template() -> Template:
    app = App()
    return Template.from_stack(
        with_email(app, admin_email="sisi@example.com", admin_page_url="https://ledger.example.cloud/admin")
    )


class TestGivenAnEmailSenderInTheCustomDomain:
    def test_verifies_the_domain_with_ses_adding_its_dkim_records_to_the_existing_zone(
        self, template: Template
    ) -> None:
        # DKIM signing is SES's default, so it is left unset rather than turned off.
        template.has_resource_properties(
            "AWS::SES::EmailIdentity", {"EmailIdentity": "example.cloud", "DkimAttributes": Match.absent()}
        )
        records = template.find_resources("AWS::Route53::RecordSet").values()
        dkim = [record for record in records if record["Properties"]["Type"] == "CNAME"]

        assert len(dkim) == 3
        assert all(record["Properties"]["HostedZoneId"] == "ZEXAMPLE123" for record in dkim)

    def test_streams_the_users_table_with_old_and_new_images(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::DynamoDB::GlobalTable",
            {
                "KeySchema": Match.any_value(),
                "TimeToLiveSpecification": {"AttributeName": "ttl", "Enabled": True},
                "StreamSpecification": {"StreamViewType": "NEW_AND_OLD_IMAGES"},
            },
        )

    def test_sends_from_the_notify_function_which_only_hears_about_profile_items(self, template: Template) -> None:
        properties = function_named(template, "Notify")["Properties"]

        assert properties["Runtime"] == "python3.13"
        assert properties["Handler"] == "ledger_api.notify.lambda_function.handler"
        assert properties["Architectures"] == ["arm64"]
        assert properties["LoggingConfig"]["LogFormat"] == "JSON"
        assert properties["MemorySize"] == 128
        # The admin's address comes from deploy-time context (a GitHub variable), never from source.
        assert properties["Environment"]["Variables"] == {
            "EMAIL_FROM": SENDER,
            "ADMIN_EMAIL": "sisi@example.com",
            "API_URL": "https://api.example.cloud",
            "ADMIN_PAGE_URL": "https://ledger.example.cloud/admin",
        }
        template.has_resource_properties(
            "AWS::Lambda::EventSourceMapping",
            {
                "FunctionName": Match.any_value(),
                "StartingPosition": "LATEST",
                "FilterCriteria": {
                    "Filters": [
                        {
                            "Pattern": json.dumps(
                                {"dynamodb": {"Keys": {"sk": {"S": ["PROFILE"]}}}}, separators=(",", ":")
                            )
                        }
                    ]
                },
                "FunctionResponseTypes": ["ReportBatchItemFailures"],
                "MaximumRetryAttempts": 3,
                "BisectBatchOnFunctionError": True,
                "DestinationConfig": {"OnFailure": {"Destination": Match.any_value()}},
            },
        )

    def test_lets_the_notify_function_send_only_as_the_sender_and_do_nothing_else_with_ses(
        self, template: Template
    ) -> None:
        document = policy_of(template, function_named(template, "Notify"))
        actions = [action for statement in document["Statement"] for action in actions_of(statement)]

        assert [action for action in actions if action.startswith("ses:")] == ["ses:SendEmail", "ses:SendRawEmail"]
        assert sends(template)[0]["Condition"] == {"StringEquals": {"ses:FromAddress": SENDER}}

    # In the sandbox SES also checks the permission against each verified recipient's identity (the
    # admin's address), so the domain's identity alone is denied. The From condition keeps it narrow.
    def test_lets_it_send_to_any_verified_identity_so_the_admins_verified_address_isnt_denied(
        self, template: Template
    ) -> None:
        assert ":ses:ap-southeast-2:" in as_text(sends(template)[0]["Resource"])
        assert ":identity/*" in as_text(sends(template)[0]["Resource"])

    def test_keeps_emails_that_still_fail_after_retries_in_a_queue_with_an_alarm(self, template: Template) -> None:
        template.resource_count_is("AWS::SQS::Queue", 1)
        template.has_resource_properties(
            "AWS::CloudWatch::Alarm",
            {
                "Namespace": "AWS/SQS",
                "MetricName": "ApproximateNumberOfMessagesVisible",
                "Threshold": 1,
                "AlarmActions": [Match.any_value()],
            },
        )
        # Five alarms: still within CloudWatch's free 10.
        template.resource_count_is("AWS::CloudWatch::Alarm", 5)

    def test_sends_through_a_configuration_set_that_is_the_domains_default_so_every_email_is_tracked(
        self, template: Template
    ) -> None:
        [configuration_set_id] = template.find_resources("AWS::SES::ConfigurationSet")

        template.has_resource_properties(
            "AWS::SES::EmailIdentity",
            {
                "EmailIdentity": "example.cloud",
                "ConfigurationSetAttributes": {"ConfigurationSetName": {"Ref": configuration_set_id}},
            },
        )

    def test_publishes_bounces_and_complaints_and_nothing_else_to_their_own_sns_topic(self, template: Template) -> None:
        [destination] = template.find_resources("AWS::SES::ConfigurationSetEventDestination").values()
        event_destination = destination["Properties"]["EventDestination"]

        assert event_destination["Enabled"] is True
        assert sorted(event_destination["MatchingEventTypes"]) == ["bounce", "complaint"]
        assert event_destination["SnsDestination"]["TopicARN"] == {"Ref": feedback_topic_id(template)}

    def test_lets_only_this_accounts_configuration_set_publish_to_the_feedback_topic(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::SNS::TopicPolicy",
            {
                "PolicyDocument": {
                    "Statement": Match.array_with(
                        [
                            Match.object_like(
                                {
                                    "Action": "sns:Publish",
                                    "Principal": {"Service": "ses.amazonaws.com"},
                                    "Condition": {
                                        "StringEquals": Match.object_like({"AWS:SourceAccount": "111111111111"})
                                    },
                                }
                            )
                        ]
                    )
                }
            },
        )

    def test_lets_the_notify_function_send_with_the_configuration_set(self, template: Template) -> None:
        assert ":configuration-set/" in as_text(sends(template))


class TestGivenAnEmailSenderAndAnAlarmEmail:
    def test_emails_bounces_and_complaints_to_the_alarm_address_too(self) -> None:
        template = Template.from_stack(with_email(App(context={"alarmEmail": "ops@example.com"})))

        template.has_resource_properties(
            "AWS::SNS::Subscription",
            {"Protocol": "email", "Endpoint": "ops@example.com", "TopicArn": {"Ref": feedback_topic_id(template)}},
        )


class TestGivenAnEmailSenderButNoAdminAddress:
    def test_emails_customers_only(self) -> None:
        template = Template.from_stack(with_email(App()))

        variables = function_named(template, "Notify")["Properties"]["Environment"]["Variables"]

        assert "ADMIN_EMAIL" not in variables
        assert "ADMIN_PAGE_URL" not in variables


class TestGivenNoEmailSender:
    def test_sends_no_email_no_identity_set_feedback_topic_function_stream_or_queue(self) -> None:
        template = synth()

        template.resource_count_is("AWS::SES::EmailIdentity", 0)
        template.resource_count_is("AWS::SES::ConfigurationSet", 0)
        # Only the alarm topic.
        template.resource_count_is("AWS::SNS::Topic", 1)
        template.resource_count_is("AWS::Lambda::EventSourceMapping", 0)
        template.resource_count_is("AWS::SQS::Queue", 0)
        tables = template.find_resources("AWS::DynamoDB::GlobalTable").values()
        users = next(table for table in tables if "TimeToLiveSpecification" in table["Properties"])
        assert "StreamSpecification" not in users["Properties"]


class TestGivenAnEmailSenderOutsideTheCustomDomain:
    def test_refuses_to_synthesize_since_ses_can_only_be_verified_through_the_domains_zone(self) -> None:
        with pytest.raises(ValueError, match=r"example\.cloud"):
            with_email(App(), sender="noreply@elsewhere.com")

    def test_refuses_an_email_sender_without_a_custom_domain(self) -> None:
        with pytest.raises(ValueError, match="custom_domain"):
            synth(email_from=SENDER)
