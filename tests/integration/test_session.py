import base64
import hashlib
import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest

from ledger_api.auth.handler import create_auth_handler
from ledger_api.auth.tokens import verify_access_token
from ledger_api.auth.users_store import UsersStore
from ledger_api.http import Handler
from tests.integration.auth_calls import LOGIN, LOGOUT, REFRESH, SECRET, Clock, call, cookie_pair
from tests.integration.users import seed_user

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


@pytest.fixture
def handler(table: "Table") -> Handler:
    return create_auth_handler(users=UsersStore(table), signing_secret=SECRET, now=lambda: datetime.now(UTC))


class TestLogin:
    class TestGivenABrowserLoginTheDefault:
        def test_it_sets_the_refresh_token_in_an_http_only_cookie_and_keeps_it_out_of_the_body(
            self, handler: Handler, table: "Table"
        ) -> None:
            seed_user(table, "ivan", "active", password="pw")

            res = call(handler, LOGIN, {"username": "ivan", "password": "pw"})

            assert res.status == 200
            assert "refreshToken" not in res.body
            assert len(res.cookies) == 1
            assert re.match(r"^refreshToken=[^;]+; ", res.cookies[0])
            for attribute in ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/v1/auth", "Max-Age=604800"]:
                assert attribute in res.cookies[0]

    class TestGivenAClientThatAsksForTheRefreshTokenInTheBody:
        def test_it_returns_it_in_the_body_and_sets_no_cookie(self, handler: Handler, table: "Table") -> None:
            seed_user(table, "judy", "active", password="pw")

            res = call(handler, LOGIN, {"username": "judy", "password": "pw", "refreshTokenIn": "body"})

            assert res.status == 200
            assert isinstance(res.body["refreshToken"], str)
            assert res.cookies == []


class TestRefresh:
    class TestGivenAValidRefreshCookie:
        def test_it_returns_a_new_access_token_and_replaces_the_refresh_cookie(
            self, handler: Handler, table: "Table"
        ) -> None:
            user = seed_user(table, "kim", "active", password="pw")
            login = call(handler, LOGIN, {"username": "kim", "password": "pw"})

            res = call(handler, REFRESH, cookies=[cookie_pair(login.cookies[0])])

            assert res.status == 200
            assert verify_access_token(res.body["accessToken"], SECRET, datetime.now(UTC)).sub == user["id"]
            assert len(res.cookies) == 1
            assert cookie_pair(res.cookies[0]) != cookie_pair(login.cookies[0])

    class TestGivenARefreshTokenSentInTheBody:
        def test_it_returns_the_replacement_in_the_body(self, handler: Handler, table: "Table") -> None:
            seed_user(table, "leo", "active", password="pw")
            login = call(handler, LOGIN, {"username": "leo", "password": "pw", "refreshTokenIn": "body"})

            res = call(handler, REFRESH, {"refreshToken": login.body["refreshToken"]})

            assert res.status == 200
            assert isinstance(res.body["refreshToken"], str)
            assert res.body["refreshToken"] != login.body["refreshToken"]
            assert res.cookies == []

    class TestGivenARefreshTokenThatWasAlreadyReplaced:
        def test_it_refuses_it_and_revokes_the_users_newer_token_too_since_it_was_probably_stolen(
            self, handler: Handler, table: "Table"
        ) -> None:
            seed_user(table, "mia", "active", password="pw")
            first = call(handler, LOGIN, {"username": "mia", "password": "pw", "refreshTokenIn": "body"}).body[
                "refreshToken"
            ]
            rotated = call(handler, REFRESH, {"refreshToken": first})

            replay = call(handler, REFRESH, {"refreshToken": first})
            after_replay = call(handler, REFRESH, {"refreshToken": rotated.body["refreshToken"]})

            assert replay.status == 401
            assert replay.body["error"]["code"] == "invalid_refresh_token"
            assert after_replay.status == 401

    class TestGivenARefreshTokenOlderThan7Days:
        def test_it_refuses_it_even_if_dynamodb_hasnt_deleted_it_yet(self, table: "Table") -> None:
            clock = Clock(datetime(2026, 10, 1, 9, 0, 0, tzinfo=UTC))
            clocked = create_auth_handler(users=UsersStore(table), signing_secret=SECRET, now=clock)
            seed_user(table, "noah", "active", password="pw")
            login = call(clocked, LOGIN, {"username": "noah", "password": "pw", "refreshTokenIn": "body"})

            clock.at = datetime(2026, 10, 8, 9, 0, 1, tzinfo=UTC)
            res = call(clocked, REFRESH, {"refreshToken": login.body["refreshToken"]})

            assert res.status == 401
            assert res.body["error"]["code"] == "invalid_refresh_token"

    class TestGivenAUserWhoWasDisabledAfterLoggingIn:
        def test_it_refuses_to_refresh(self, handler: Handler, table: "Table") -> None:
            user = seed_user(table, "olga", "active", password="pw")
            login = call(handler, LOGIN, {"username": "olga", "password": "pw", "refreshTokenIn": "body"})
            UsersStore(table).set_status(user["id"], "disabled")

            res = call(handler, REFRESH, {"refreshToken": login.body["refreshToken"]})

            assert res.status == 401
            assert res.body["error"]["code"] == "invalid_refresh_token"

    class TestGivenNoRefreshToken:
        @pytest.mark.parametrize(
            "body", [pytest.param(None, id="no body"), pytest.param({"refreshToken": ""}, id="an empty token")]
        )
        def test_it_refuses(self, handler: Handler, body: dict[str, str] | None) -> None:
            res = call(handler, REFRESH, body)

            assert res.status == 401
            assert res.body["error"]["code"] == "invalid_refresh_token"

    class TestGivenARefreshTokenTheTypeScriptLambdaStored:
        def test_it_refreshes_with_it(self, handler: Handler, table: "Table") -> None:
            user = seed_user(table, "rory", "active")
            token = f"{user['id']}.issued-by-typescript"
            # The TypeScript store's item: the token's hash (base64url, no padding), expiry and ttl.
            table.put_item(
                Item={
                    "pk": f"USER#{user['id']}",
                    "sk": "REFRESH#" + _node_hash(token),
                    "expiresAt": "2099-01-01T00:00:00.000Z",
                    "ttl": 4070908800,
                }
            )

            res = call(handler, REFRESH, {"refreshToken": token})

            assert res.status == 200


class TestLogout:
    class TestGivenALoggedInBrowser:
        def test_it_clears_the_cookie_and_the_refresh_token_stops_working(
            self, handler: Handler, table: "Table"
        ) -> None:
            seed_user(table, "pia", "active", password="pw")
            login = call(handler, LOGIN, {"username": "pia", "password": "pw"})
            cookie = cookie_pair(login.cookies[0])

            res = call(handler, LOGOUT, cookies=[cookie])
            refresh = call(handler, REFRESH, cookies=[cookie])

            assert res.status == 204
            assert re.match(r"^refreshToken=; .*Max-Age=0", res.cookies[0])
            assert refresh.status == 401

    class TestGivenNoRefreshToken:
        def test_it_still_logs_out(self, handler: Handler) -> None:
            res = call(handler, LOGOUT)

            assert res.status == 204


def _node_hash(token: str) -> str:
    """As the TypeScript Lambda hashed it, worked out here rather than with the code under test."""
    return base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip("=")
