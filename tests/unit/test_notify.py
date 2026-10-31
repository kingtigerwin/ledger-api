from typing import Any

import pytest
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

from ledger_api.log import Level, LogEntry
from ledger_api.notify.emails import EmailSettings, emails_for
from ledger_api.notify.handler import OutgoingEmail, create_notify_handler

FROM = "noreply@haoran.cloud"
SETTINGS = EmailSettings(api_url="https://api.haoran.cloud", admin_email="sisi@example.com")


def profile(**overrides: Any) -> dict[str, Any]:
    """A Users-table profile item, as the store writes it."""
    item: dict[str, Any] = {
        "pk": "USER#u-1",
        "sk": "PROFILE",
        "id": "u-1",
        "username": "haoran",
        "email": "haoran@example.com",
        "role": "customer",
        "status": "pending",
        "createdAt": "2026-10-28T00:00:00.000Z",
        "passwordHash": "scrypt$...",
    }
    item.update(overrides)
    return {k: v for k, v in item.items() if v is not None}


class TestEmailsFor:
    class TestGivenACustomerWhoSignedInWithGoogleBeingApproved:
        def test_it_tells_them_to_use_google_since_they_have_no_password(self) -> None:
            before = profile(authProvider="google", passwordHash=None)
            after = profile(authProvider="google", passwordHash=None, status="active")

            [approved] = emails_for(before, after, SETTINGS)

            assert approved.kind == "approved"
            assert "sign in with Google" in approved.text
            assert "sign in as" not in approved.text

    class TestGivenACustomerWhoHasJustRegistered:
        def test_asks_the_admin_to_approve_or_reject_it_then_tells_them_the_account_is_waiting(self) -> None:
            # The admin's first, so a customer's address SES won't take can't hold it up.
            admin, customer, *rest = emails_for(None, profile(), SETTINGS)

            assert (customer.kind, customer.to) == ("pending", "haoran@example.com")
            assert "waiting for approval" in customer.subject.lower()
            assert "haoran" in customer.text
            assert (admin.kind, admin.to, admin.user_id) == ("new_signup", "sisi@example.com", "u-1")
            assert "haoran" in admin.subject
            assert "haoran@example.com" in admin.text
            assert "POST https://api.haoran.cloud/api/v1/admin/users/u-1/enable" in admin.text
            assert "POST https://api.haoran.cloud/api/v1/admin/users/u-1/disable" in admin.text
            assert "approve" in admin.text.lower()
            assert "reject" in admin.text.lower()
            assert rest == []

        def test_links_the_admin_to_the_admin_page_when_there_is_one_instead_of_the_api_calls(self) -> None:
            settings = EmailSettings(
                api_url=SETTINGS.api_url,
                admin_email=SETTINGS.admin_email,
                admin_page_url="https://ledger.haoran.cloud/admin",
            )

            admin = emails_for(None, profile(), settings)[0]

            assert admin.kind == "new_signup"
            assert "https://ledger.haoran.cloud/admin" in admin.text
            assert "approve or reject" in admin.text.lower()
            assert "haoran@example.com" in admin.text
            assert "POST" not in admin.text

        def test_emails_only_the_customer_when_no_admin_address_is_set(self) -> None:
            emails = emails_for(None, profile(), EmailSettings(api_url=SETTINGS.api_url))

            assert [e.kind for e in emails] == ["pending"]

    class TestGivenAPendingCustomerTheAdminHasJustEnabled:
        def test_tells_them_and_only_them_that_they_can_sign_in(self) -> None:
            emails = emails_for(profile(), profile(status="active"), SETTINGS)

            assert len(emails) == 1
            assert (emails[0].kind, emails[0].to) == ("approved", "haoran@example.com")
            assert "approved" in emails[0].subject.lower()
            assert "sign in" in emails[0].text.lower()

    class TestGivenAChangeThatIsntASignUpOrAFirstApproval:
        @pytest.mark.parametrize(
            ("before", "after"),
            [
                pytest.param(profile(status="disabled"), profile(status="active"), id="a disabled customer enabled"),
                pytest.param(profile(status="active"), profile(status="disabled"), id="an active customer disabled"),
                pytest.param(profile(), profile(status="disabled"), id="a pending customer disabled"),
                pytest.param(profile(), profile(failedLogins=1), id="a failed login on a pending customer"),
                pytest.param(
                    None, profile(role="admin", status="active", email=None), id="an admin created by bootstrap"
                ),
                pytest.param(None, profile(status="active"), id="a customer created already active"),
                pytest.param(
                    profile(email=None), profile(email=None, status="active"), id="a customer from before emails"
                ),
                pytest.param(profile(), None, id="a deleted item"),
                pytest.param(
                    None,
                    {"pk": "USER#u-1", "sk": "REFRESH#abc", "expiresAt": "2026-11-28T00:00:00.000Z"},
                    id="a refresh token",
                ),
                pytest.param(None, {"pk": "USERNAME#haoran", "sk": "USERNAME", "userId": "u-1"}, id="a username claim"),
            ],
        )
        def test_sends_nothing(self, before: dict[str, Any] | None, after: dict[str, Any] | None) -> None:
            assert emails_for(before, after, SETTINGS) == []


_serializer = TypeSerializer()
_sequence = 0


def record(before: dict[str, Any] | None, after: dict[str, Any] | None) -> dict[str, Any]:
    """A stream record carrying the item's images, as DynamoDB Streams delivers them."""
    global _sequence
    _sequence += 1
    dynamodb: dict[str, Any] = {"SequenceNumber": str(_sequence)}
    if before:
        dynamodb["OldImage"] = {k: _serializer.serialize(v) for k, v in before.items()}
    if after:
        dynamodb["NewImage"] = {k: _serializer.serialize(v) for k, v in after.items()}
    return {"eventName": "MODIFY" if before and after else "INSERT" if after else "REMOVE", "dynamodb": dynamodb}


def stream_event(*records: dict[str, Any]) -> dict[str, Any]:
    return {"Records": list(records)}


def ses_error(code: str, to: str) -> ClientError:
    # As SES words it in the sandbox: the error names the address.
    return ClientError({"Error": {"Code": code, "Message": f"Email address is not verified: {to}"}}, "SendEmail")


class Notifier:
    """A notifier whose sender records what it sends, failing for the given addresses with the given SES error."""

    def __init__(self, fail_for: dict[str, str] | None = None) -> None:
        self.sent: list[OutgoingEmail] = []
        self.logs: list[LogEntry] = []
        fail_for = fail_for or {}

        def send_email(email: OutgoingEmail) -> None:
            if email.to in fail_for:
                raise ses_error(fail_for[email.to], email.to)
            self.sent.append(email)

        def log(entry: LogEntry, level: Level = "info") -> None:
            self.logs.append(entry)

        self.handler = create_notify_handler(sender=FROM, settings=SETTINGS, send_email=send_email, log=log)


class TestTheNotifyLambda:
    class TestGivenStreamRecordsForASignUpAnApprovalAndAFailedLogin:
        def test_sends_the_three_emails_from_the_configured_address_and_reports_no_failures(self) -> None:
            notifier = Notifier()

            res = notifier.handler(
                stream_event(
                    record(None, profile()),
                    record(profile(), profile(failedLogins=1)),
                    record(profile(), profile(status="active")),
                )
            )

            assert res == {"batchItemFailures": []}
            assert [(e.sender, e.to) for e in notifier.sent] == [
                (FROM, "sisi@example.com"),
                (FROM, "haoran@example.com"),
                (FROM, "haoran@example.com"),
            ]
            subjects = [e.subject.lower() for e in notifier.sent]
            assert "haoran" in subjects[0]
            assert "waiting for approval" in subjects[1]
            assert "approved" in subjects[2]

    class TestGivenASendThatFailsForAReasonThatMayPassSuchAsThrottling:
        def test_reports_that_record_so_the_stream_retries_from_it_and_sends_nothing_after_it(self) -> None:
            notifier = Notifier({"bad@example.com": "TooManyRequestsException"})
            ok = record(None, profile(id="u-1", email="ok@example.com"))
            failing = record(None, profile(id="u-2", email="bad@example.com"))
            later = record(None, profile(id="u-3", email="later@example.com"))

            res = notifier.handler(stream_event(ok, failing, later))

            assert res == {"batchItemFailures": [{"itemIdentifier": failing["dynamodb"]["SequenceNumber"]}]}
            # The failing sign-up's admin email went first; the retry sends it again.
            assert [e.to for e in notifier.sent] == ["sisi@example.com", "ok@example.com", "sisi@example.com"]

        def test_logs_the_failure_with_the_users_id_but_no_ones_address(self) -> None:
            notifier = Notifier({"bad@example.com": "TooManyRequestsException"})

            notifier.handler(stream_event(record(None, profile(id="u-9", email="bad@example.com"))))

            failure = next(entry for entry in notifier.logs if entry["event"] == "notify_failed")
            assert (failure["kind"], failure["userId"]) == ("pending", "u-9")
            assert "bad@example.com" not in str(notifier.logs)
            assert "sisi@example.com" not in str(notifier.logs)

    @pytest.mark.parametrize("error_code", ["MessageRejected", "BadRequestException"])
    class TestGivenASendSesRefusesOutrightSuchAsToAnUnverifiedAddressInTheSandbox:
        def test_skips_that_email_without_a_retry_and_sends_the_rest_including_the_admins(
            self, error_code: str
        ) -> None:
            notifier = Notifier({"bad@example.com": error_code})

            res = notifier.handler(
                stream_event(
                    record(None, profile(id="u-1", email="bad@example.com")),
                    record(None, profile(id="u-2", email="ok@example.com")),
                )
            )

            assert res == {"batchItemFailures": []}
            assert [e.to for e in notifier.sent] == ["sisi@example.com", "sisi@example.com", "ok@example.com"]
            assert "new ledger sign-up" in notifier.sent[0].subject.lower()
            assert "waiting for approval" in notifier.sent[2].subject.lower()

        def test_logs_it_as_rejected_with_the_users_id_but_not_the_address(self, error_code: str) -> None:
            notifier = Notifier({"bad@example.com": error_code})

            notifier.handler(stream_event(record(None, profile(id="u-7", email="bad@example.com"))))

            rejected = next(entry for entry in notifier.logs if entry["event"] == "email_rejected")
            assert (rejected["kind"], rejected["userId"]) == ("pending", "u-7")
            assert rejected["error"] == {"name": error_code, "message": "Email address is not verified: [email]"}
            assert not any(entry["event"] == "notify_failed" for entry in notifier.logs)
            assert "bad@example.com" not in str(notifier.logs)
