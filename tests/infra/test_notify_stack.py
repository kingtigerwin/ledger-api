import json
from collections.abc import Mapping
from typing import Any

import pytest
from aws_cdk.assertions import Match, Template

from infra.ledger_stack import LedgerStack
from tests.infra.support import ENV, actions_of, certified_domain, found, function_policy, quick_app, synth


def notify_policy(template: Template) -> Mapping[str, Any]:
    return function_policy(template, found(template, "AWS::Lambda::Function", "NotifyFunction"))


def ses_send_statements(template: Template) -> list[dict[str, Any]]:
    return [s for s in notify_policy(template)["Statement"] if "ses:SendEmail" in actions_of(s)]


def feedback_topic_id(template: Template) -> str:
    return next(id for id in template.find_resources("AWS::SNS::Topic") if id.startswith("EmailFeedback"))


class TestGivenAnEmailSenderInTheCustomDomain:
    @pytest.fixture(scope="class")
    @classmethod
    def template(cls) -> Template:
        app = quick_app()
        return Template.from_stack(
            LedgerStack(
                app,
                "LedgerApi",
                custom_domain=certified_domain(app),
                email_from="noreply@example.cloud",
                admin_email="sisi@example.com",
                admin_page_url="https://ledger.example.cloud/admin",
                env=ENV,
            )
        )

    def test_verifies_the_domain_with_ses_adding_its_dkim_records_to_the_existing_zone(
        self, template: Template
    ) -> None:
        # DKIM signing is SES's default, so it is left unset rather than turned off.
        template.has_resource_properties(
            "AWS::SES::EmailIdentity", {"EmailIdentity": "example.cloud", "DkimAttributes": Match.absent()}
        )
        records = template.find_resources("AWS::Route53::RecordSet").values()
        dkim = [r for r in records if r["Properties"]["Type"] == "CNAME"]

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
        properties = found(template, "AWS::Lambda::Function", "NotifyFunction")["Properties"]

        assert properties["Runtime"] == "python3.13"
        assert properties["Handler"] == "ledger_api.notify.lambda_function.handler"
        assert properties["Architectures"] == ["arm64"]
        assert properties["LoggingConfig"]["LogFormat"] == "JSON"
        assert properties["MemorySize"] == 128
        # The admin's address comes from deploy-time context (a GitHub variable), never from source.
        assert properties["Environment"]["Variables"] == {
            "EMAIL_FROM": "noreply@example.cloud",
            "ADMIN_EMAIL": "sisi@example.com",
            "API_URL": "https://api.example.cloud",
            "ADMIN_PAGE_URL": "https://ledger.example.cloud/admin",
        }
        pattern = json.dumps({"dynamodb": {"Keys": {"sk": {"S": ["PROFILE"]}}}}, separators=(",", ":"))
        template.has_resource_properties(
            "AWS::Lambda::EventSourceMapping",
            {
                "FunctionName": Match.any_value(),
                "StartingPosition": "LATEST",
                "FilterCriteria": {"Filters": [{"Pattern": pattern}]},
                "FunctionResponseTypes": ["ReportBatchItemFailures"],
                "MaximumRetryAttempts": 3,
                "BisectBatchOnFunctionError": True,
                "DestinationConfig": {"OnFailure": {"Destination": Match.any_value()}},
            },
        )

    def test_lets_the_notify_function_send_only_as_the_sender_and_do_nothing_else_with_ses(
        self, template: Template
    ) -> None:
        actions = [a for s in notify_policy(template)["Statement"] for a in actions_of(s)]

        assert [a for a in actions if a.startswith("ses:")] == ["ses:SendEmail", "ses:SendRawEmail"]
        [send] = ses_send_statements(template)
        assert send["Condition"] == {"StringEquals": {"ses:FromAddress": "noreply@example.cloud"}}

    # In the sandbox SES also checks the permission against each verified recipient's identity (the
    # admin's address), so the domain's identity alone is denied. The From condition keeps it narrow.
    def test_lets_it_send_to_any_verified_identity_so_the_admins_address_isnt_denied(self, template: Template) -> None:
        [send] = ses_send_statements(template)

        assert ":ses:ap-southeast-2:111111111111:identity/*" in json.dumps(send["Resource"])

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

    def test_sends_through_a_configuration_set_that_is_the_domains_default(self, template: Template) -> None:
        [configuration_set_id] = template.find_resources("AWS::SES::ConfigurationSet")

        template.has_resource_properties(
            "AWS::SES::EmailIdentity",
            {
                "EmailIdentity": "example.cloud",
                "ConfigurationSetAttributes": {"ConfigurationSetName": {"Ref": configuration_set_id}},
            },
        )

    def test_publishes_bounces_and_complaints_and_nothing_else_to_their_own_topic(self, template: Template) -> None:
        [destination] = template.find_resources("AWS::SES::ConfigurationSetEventDestination").values()

        event = destination["Properties"]["EventDestination"]

        assert event["Enabled"] is True
        assert sorted(event["MatchingEventTypes"]) == ["bounce", "complaint"]
        assert event["SnsDestination"]["TopicARN"] == {"Ref": feedback_topic_id(template)}

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
        assert ":configuration-set/" in json.dumps(ses_send_statements(template))


class TestGivenAnEmailSenderAndAnAlarmEmail:
    def test_emails_bounces_and_complaints_to_the_alarm_address_too(self) -> None:
        app = quick_app(alarmEmail="ops@example.com")
        template = Template.from_stack(
            LedgerStack(
                app, "LedgerApi", custom_domain=certified_domain(app), email_from="noreply@example.cloud", env=ENV
            )
        )

        template.has_resource_properties(
            "AWS::SNS::Subscription",
            {"Protocol": "email", "Endpoint": "ops@example.com", "TopicArn": {"Ref": feedback_topic_id(template)}},
        )


class TestGivenAnEmailSenderButNoAdminAddress:
    def test_emails_customers_only(self) -> None:
        app = quick_app()
        template = Template.from_stack(
            LedgerStack(
                app, "LedgerApi", custom_domain=certified_domain(app), email_from="noreply@example.cloud", env=ENV
            )
        )

        variables = found(template, "AWS::Lambda::Function", "NotifyFunction")["Properties"]["Environment"]["Variables"]

        assert "ADMIN_EMAIL" not in variables
        assert "ADMIN_PAGE_URL" not in variables


class TestGivenNoEmailSender:
    def test_sends_no_email(self) -> None:
        template = synth()

        template.resource_count_is("AWS::SES::EmailIdentity", 0)
        template.resource_count_is("AWS::SES::ConfigurationSet", 0)
        # Only the alarm topic.
        template.resource_count_is("AWS::SNS::Topic", 1)
        template.resource_count_is("AWS::Lambda::EventSourceMapping", 0)
        template.resource_count_is("AWS::SQS::Queue", 0)
        tables = template.find_resources("AWS::DynamoDB::GlobalTable").values()
        users = next(t for t in tables if "TimeToLiveSpecification" in t["Properties"])
        assert "StreamSpecification" not in users["Properties"]


class TestGivenAnEmailSenderOutsideTheCustomDomain:
    def test_refuses_to_synthesize_since_ses_verifies_through_the_domains_zone(self) -> None:
        app = quick_app()

        with pytest.raises(ValueError, match=r"example\.cloud"):
            LedgerStack(
                app, "LedgerApi", custom_domain=certified_domain(app), email_from="noreply@elsewhere.com", env=ENV
            )

    def test_refuses_an_email_sender_without_a_custom_domain(self) -> None:
        with pytest.raises(ValueError, match="custom_domain"):
            synth(email_from="noreply@example.cloud")
