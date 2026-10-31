from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest

from ledger_api.auth.handler import create_auth_handler
from ledger_api.auth.tokens import AccessClaims, verify_access_token
from ledger_api.auth.users_store import UsersStore
from ledger_api.http import Handler
from ledger_api.log import Level, LogEntry
from tests.integration.auth_calls import LOGIN, ME, REGISTER, SECRET, Clock, call
from tests.integration.users import seed_user

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

# Valid apart from its length: 255 characters, one more than an address can have.
TOO_LONG_EMAIL = f"{'c' * 60}@{('d' * 60 + '.') * 3}example.com"


@pytest.fixture
def handler(table: "Table") -> Handler:
    return create_auth_handler(users=UsersStore(table), signing_secret=SECRET, now=lambda: datetime.now(UTC))


def claims_of(body: Any) -> AccessClaims:
    return verify_access_token(body["accessToken"], SECRET, datetime.now(UTC))


class TestRegister:
    class TestGivenANewUsernameAPasswordAndAnEmailAddress:
        def test_it_creates_a_pending_customer_with_that_email_and_never_returns_the_password(
            self, handler: Handler, table: "Table"
        ) -> None:
            res = call(handler, REGISTER, {"username": "alice", "password": "pw", "email": "alice@example.com"})

            assert res.status == 201
            assert res.body == {
                "id": res.body["id"],
                "username": "alice",
                "email": "alice@example.com",
                "role": "customer",
                "status": "pending",
                "createdAt": res.body["createdAt"],
            }
            # As the TypeScript Lambda wrote users, so those and these read the same.
            profile = table.get_item(Key={"pk": f"USER#{res.body['id']}", "sk": "PROFILE"}).get("Item", {})
            assert str(profile["passwordHash"]).startswith("scrypt$131072$8$1$")
            assert str(profile["createdAt"]).endswith("Z")
            claim = table.get_item(Key={"pk": "USERNAME#alice", "sk": "USERNAME"}).get("Item", {})
            assert claim["userId"] == res.body["id"]

    class TestGivenAUsernameThatExistsInDifferentLetterCase:
        def test_it_rejects_it_as_taken(self, handler: Handler) -> None:
            call(handler, REGISTER, {"username": "bob", "password": "pw", "email": "bob@example.com"})

            res = call(handler, REGISTER, {"username": "Bob", "password": "other", "email": "bob@example.com"})

            assert res.status == 409
            assert res.body["error"]["code"] == "username_taken"

    class TestGivenAFieldThatIsEmptyOrTooLong:
        @pytest.mark.parametrize(
            "body",
            [
                pytest.param({"username": "", "password": "pw", "email": "carol@example.com"}, id="an empty username"),
                pytest.param(
                    {"username": "carol", "password": "", "email": "carol@example.com"}, id="an empty password"
                ),
                pytest.param(
                    {"username": "c" * 65, "password": "pw", "email": "carol@example.com"}, id="a 65-character username"
                ),
                pytest.param(
                    {"username": "carol", "password": "p" * 1025, "email": "carol@example.com"},
                    id="a 1,025-character password",
                ),
                pytest.param({"username": "carol", "password": "pw"}, id="no email"),
                pytest.param(
                    {"username": "carol", "password": "pw", "email": "carol-at-example"}, id="an email that isn't one"
                ),
                pytest.param(
                    {"username": "carol", "password": "pw", "email": TOO_LONG_EMAIL}, id="a 255-character email"
                ),
                pytest.param({"username": 7, "password": "pw", "email": "carol@example.com"}, id="a number for a name"),
            ],
        )
        def test_it_rejects(self, handler: Handler, body: dict[str, Any]) -> None:
            res = call(handler, REGISTER, body)

            assert res.status == 400
            assert res.body["error"]["code"] == "validation_failed"

    class TestGivenABodyThatIsNotJson:
        def test_it_rejects_it(self, handler: Handler) -> None:
            res = handler({"routeKey": REGISTER, "body": "{not json", "isBase64Encoded": False})

            assert res["statusCode"] == 400


class TestMe:
    class TestGivenACustomerWhoRegisteredWithAnEmail:
        def test_it_includes_the_email(self, handler: Handler) -> None:
            registered = call(handler, REGISTER, {"username": "mia", "password": "pw", "email": "mia@example.com"})

            res = call(
                handler,
                ME,
                auth={"userId": registered.body["id"], "role": "customer", "scope": "transactions:read"},
            )

            assert res.body == {
                "id": registered.body["id"],
                "username": "mia",
                "email": "mia@example.com",
                "role": "customer",
                "status": "pending",
            }

    class TestGivenAUserWithoutAnEmail:
        def test_it_leaves_the_email_out(self, handler: Handler, table: "Table") -> None:
            user = seed_user(table, "quinn", "active")

            res = call(handler, ME, auth={"userId": user["id"], "role": "customer", "scope": "transactions:read"})

            assert res.status == 200
            assert res.body == {"id": user["id"], "username": "quinn", "role": "customer", "status": "active"}

    class TestGivenAUserWhoNoLongerExists:
        def test_it_refuses(self, handler: Handler) -> None:
            res = call(handler, ME, auth={"userId": "gone", "role": "customer", "scope": "transactions:read"})

            assert res.status == 401


class TestLogin:
    class TestGivenAPendingUserWithTheCorrectPassword:
        def test_it_refuses_with_account_pending(self, handler: Handler) -> None:
            call(handler, REGISTER, {"username": "dave", "password": "pw", "email": "dave@example.com"})

            res = call(handler, LOGIN, {"username": "dave", "password": "pw"})

            assert res.status == 403
            assert res.body["error"]["code"] == "account_pending"

    class TestGivenCredentialsThatDontMatch:
        @pytest.mark.parametrize(
            "body",
            [
                pytest.param({"username": "nobody", "password": "pw"}, id="an unknown username"),
                pytest.param({"username": "erin", "password": "wrong"}, id="a pending user's wrong password"),
            ],
        )
        def test_it_refuses_with_the_same_invalid_credentials_error(
            self, handler: Handler, body: dict[str, str]
        ) -> None:
            call(handler, REGISTER, {"username": "erin", "password": "pw", "email": "erin@example.com"})

            res = call(handler, LOGIN, body)

            assert res.status == 401
            assert res.body["error"] == {"code": "invalid_credentials", "message": "Invalid username or password"}

    class TestGivenAnActiveUserWithTheCorrectPassword:
        def test_it_returns_an_access_token_for_that_customer(self, handler: Handler, table: "Table") -> None:
            user = seed_user(table, "frank", "active", password="pw")

            res = call(handler, LOGIN, {"username": "Frank", "password": "pw"})

            assert res.status == 200
            claims = claims_of(res.body)
            assert claims.sub == user["id"]
            assert claims.role == "customer"
            assert claims.scope.split(" ") == ["transactions:read", "transactions:write"]
            assert res.body["expiresIn"] == 900

    class TestGivenADisabledUserWithTheCorrectPassword:
        def test_it_refuses_with_the_same_invalid_credentials_error(self, handler: Handler, table: "Table") -> None:
            seed_user(table, "grace", "disabled", password="pw")

            res = call(handler, LOGIN, {"username": "grace", "password": "pw"})

            assert res.status == 401
            assert res.body["error"]["code"] == "invalid_credentials"

    class TestGiven5FailedLoginsInARow:
        @pytest.fixture
        def clock(self) -> Clock:
            return Clock(datetime(2026, 10, 26, 10, 0, 0, tzinfo=UTC))

        @pytest.fixture
        def clocked(self, table: "Table", clock: Clock) -> Handler:
            handler = create_auth_handler(users=UsersStore(table), signing_secret=SECRET, now=clock)
            seed_user(table, "heidi", "active", password="pw")
            for _ in range(5):
                call(handler, LOGIN, {"username": "heidi", "password": "wrong"})
            return handler

        def test_it_locks_the_username_even_against_the_correct_password(self, clocked: Handler, clock: Clock) -> None:
            clock.at = datetime(2026, 10, 26, 10, 14, 59, tzinfo=UTC)

            res = call(clocked, LOGIN, {"username": "heidi", "password": "pw"})

            assert res.status == 423
            assert res.body["error"]["code"] == "account_locked"

        def test_it_unlocks_once_15_minutes_have_passed(self, clocked: Handler, clock: Clock) -> None:
            clock.at = datetime(2026, 10, 26, 10, 15, 1, tzinfo=UTC)

            res = call(clocked, LOGIN, {"username": "heidi", "password": "pw"})

            assert res.status == 200

        def test_a_successful_login_starts_the_count_again(
            self, clocked: Handler, clock: Clock, table: "Table"
        ) -> None:
            clock.at = datetime(2026, 10, 26, 10, 15, 1, tzinfo=UTC)
            call(clocked, LOGIN, {"username": "heidi", "password": "wrong"})
            call(clocked, LOGIN, {"username": "heidi", "password": "pw"})

            for _ in range(4):
                call(clocked, LOGIN, {"username": "heidi", "password": "wrong"})

            assert call(clocked, LOGIN, {"username": "heidi", "password": "pw"}).status == 200

    class TestGivenAnActiveAdmin:
        def test_it_issues_admin_scopes_plus_the_transaction_scopes_for_the_admins_own_spending(
            self, handler: Handler, table: "Table"
        ) -> None:
            seed_user(table, "boss", "active", role="admin", password="pw")

            res = call(handler, LOGIN, {"username": "boss", "password": "pw"})

            claims = claims_of(res.body)
            assert claims.role == "admin"
            assert sorted(claims.scope.split(" ")) == [
                "admin:read",
                "admin:write",
                "transactions:read",
                "transactions:write",
            ]


class TestLogging:
    class TestGivenAFailedLogin:
        def test_it_logs_a_login_failed_event_for_the_alarm_without_the_password(self, table: "Table") -> None:
            entries: list[LogEntry] = []

            def log(entry: LogEntry, level: Level = "info") -> None:
                entries.append(entry)

            logged = create_auth_handler(
                users=UsersStore(table), signing_secret=SECRET, now=lambda: datetime.now(UTC), log=log
            )
            seed_user(table, "ivy", "active", password="pw")

            call(logged, LOGIN, {"username": "ivy", "password": "wrong"})

            assert {"event": "login_failed", "reason": "invalid_credentials"} in entries
            assert "wrong" not in str(entries)
