from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlsplit

import pytest

from ledger_api.auth.google import GoogleIdentity, GoogleSignIn, GoogleSignInError, username_for
from ledger_api.auth.handler import create_auth_handler
from ledger_api.auth.users_store import UsernameTakenError, UsersStore, UserStatus
from ledger_api.http import Handler
from ledger_api.log import Level, LogEntry
from tests.integration.auth_calls import (
    GOOGLE_CALLBACK,
    GOOGLE_START,
    LOGIN,
    REFRESH,
    SECRET,
    Reply,
    call,
    cookie_pair,
)
from tests.integration.users import seed_user
from tests.unit.test_google import CLIENT_ID, NOW, REDIRECT_URI, id_token

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


@dataclass
class FakeGoogle:
    """Stands in for Google's token endpoint: hands back an ID token carrying the nonce it was sent to."""

    claims: dict[str, Any] = field(default_factory=dict[str, Any])
    failure: Exception | None = None
    calls: list[tuple[str, str]] = field(default_factory=list[tuple[str, str]])

    def __call__(self, code: str, code_verifier: str) -> str:
        self.calls.append((code, code_verifier))
        if self.failure:
            raise self.failure
        return id_token(**self.claims)


@pytest.fixture
def google() -> FakeGoogle:
    return FakeGoogle()


@pytest.fixture
def logged() -> list[LogEntry]:
    return []


@pytest.fixture
def handler(table: "Table", google: FakeGoogle, logged: list[LogEntry]) -> Handler:
    def log(entry: LogEntry, level: Level = "info") -> None:
        logged.append(entry)

    return create_auth_handler(
        users=UsersStore(table),
        signing_secret=SECRET,
        now=lambda: NOW,
        log=log,
        google=GoogleSignIn(client_id=CLIENT_ID, redirect_uri=REDIRECT_URI, exchange_code=google),
    )


def start(handler: Handler, google: FakeGoogle) -> tuple[str, str]:
    """Begins a sign-in: the browser's cookie, and the state Google will send back."""
    res = call(handler, GOOGLE_START)
    query = parse_qs(urlsplit(res.location or "").query)
    google.claims.setdefault("nonce", query["nonce"][0])
    return cookie_pair(res.cookies[0]), query["state"][0]


def sign_in(handler: Handler, google: FakeGoogle) -> Reply:
    """The whole round trip, with Google accepting the user."""
    cookie, state = start(handler, google)
    return call(handler, GOOGLE_CALLBACK, cookies=[cookie], query={"code": "the-code", "state": state})


def item(table: "Table", pk: str, sk: str) -> dict[str, Any]:
    return table.get_item(Key={"pk": pk, "sk": sk}).get("Item") or {}


def seed_google_user(table: "Table", status: UserStatus) -> None:
    """Signs the user in once, which leaves them pending, then gives them `status`."""
    store = UsersStore(table)
    user = store.create_google_user(sub="1234567890", username="alice-g1", email="alice@example.com", now=NOW)
    store.set_status(user.id, status)


class TestStart:
    class TestGivenGoogleIsConfigured:
        def test_it_redirects_to_google_and_remembers_the_attempt_in_a_cookie(self, handler: Handler) -> None:
            res = call(handler, GOOGLE_START)

            assert res.status == 302
            assert (res.location or "").startswith("https://accounts.google.com/o/oauth2/v2/auth?")
            assert len(res.cookies) == 1
            assert res.cookies[0].startswith("__Host-googleSignIn=")

    class TestGivenGoogleIsNotConfigured:
        def test_both_routes_send_the_browser_back_to_the_login_page(self, table: "Table") -> None:
            handler = create_auth_handler(users=UsersStore(table), signing_secret=SECRET, now=lambda: NOW)

            for route in [GOOGLE_START, GOOGLE_CALLBACK]:
                res = call(handler, route)

                assert (res.status, res.location) == (302, "/login?error=google_unavailable")


class TestCallback:
    class TestGivenSomeoneNewToLedger:
        def test_it_creates_a_pending_customer_and_sends_them_to_wait_for_approval(
            self, handler: Handler, google: FakeGoogle, table: "Table"
        ) -> None:
            res = sign_in(handler, google)

            assert (res.status, res.location) == (302, "/pending?via=google")
            assert not any(cookie.startswith("refreshToken=") for cookie in res.cookies)
            claim = item(table, "GOOGLE#1234567890", "GOOGLE")
            profile = item(table, f"USER#{claim['userId']}", "PROFILE")
            assert profile["status"] == "pending"
            assert profile["role"] == "customer"
            assert profile["email"] == "Alice.B@example.com"
            assert profile["authProvider"] == "google"
            assert "passwordHash" not in profile
            username = str(profile["username"])
            assert item(table, f"USERNAME#{username}", "USERNAME")["userId"] == claim["userId"]

        def test_it_passes_the_code_and_the_pkce_verifier_to_google(self, handler: Handler, google: FakeGoogle) -> None:
            cookie, state = start(handler, google)

            call(handler, GOOGLE_CALLBACK, cookies=[cookie], query={"code": "the-code", "state": state})

            code, verifier = google.calls[0]
            assert code == "the-code"
            assert cookie.endswith(f".{verifier}")

    class TestGivenAnApprovedGoogleUser:
        def test_it_sets_the_refresh_cookie_clears_the_attempt_and_redirects_to_the_landing_page(
            self, handler: Handler, google: FakeGoogle, table: "Table"
        ) -> None:
            seed_google_user(table, "active")

            res = sign_in(handler, google)

            assert (res.status, res.location) == (302, "/chat")
            names = [cookie.split("=")[0] for cookie in res.cookies]
            assert sorted(names) == ["__Host-googleSignIn", "refreshToken"]
            assert next(c for c in res.cookies if c.startswith("__Host-")).find("Max-Age=0") > 0

        def test_the_refresh_cookie_is_the_ordinary_session_the_ui_picks_up(
            self, handler: Handler, google: FakeGoogle, table: "Table"
        ) -> None:
            seed_google_user(table, "active")
            res = sign_in(handler, google)
            refresh_cookie = next(c for c in res.cookies if c.startswith("refreshToken="))

            refreshed = call(handler, REFRESH, cookies=[cookie_pair(refresh_cookie)])

            assert refreshed.status == 200
            assert refreshed.body["accessToken"]

    class TestGivenAPendingGoogleUser:
        def test_it_says_so_without_creating_a_second_account(
            self, handler: Handler, google: FakeGoogle, table: "Table"
        ) -> None:
            seed_google_user(table, "pending")

            res = sign_in(handler, google)

            assert res.location == "/pending?via=google"
            assert table.scan(Select="COUNT")["Count"] == 3

    class TestGivenADisabledGoogleUser:
        def test_it_refuses_them_the_same_way_as_any_failure(
            self, handler: Handler, google: FakeGoogle, table: "Table"
        ) -> None:
            seed_google_user(table, "disabled")

            res = sign_in(handler, google)

            assert res.location == "/login?error=google_failed"
            assert not any(cookie.startswith("refreshToken=") for cookie in res.cookies)

    class TestGivenAPasswordUserWithTheSameEmail:
        def test_it_makes_a_separate_account_rather_than_linking_on_an_unverified_address(
            self, handler: Handler, google: FakeGoogle, table: "Table"
        ) -> None:
            existing = seed_user(table, "alice", "active", email="Alice.B@example.com")

            res = sign_in(handler, google)

            assert res.location == "/pending?via=google"
            assert item(table, "GOOGLE#1234567890", "GOOGLE")["userId"] != existing["id"]

    class TestGivenTwoFirstSignInsAtOnce:
        def test_they_never_make_two_accounts(self, table: "Table") -> None:
            store = UsersStore(table)

            def create(_: int) -> None:
                # A loser may see the winner's transaction still in flight; it fails, and the user tries again.
                with suppress(UsernameTakenError):
                    store.create_google_user(sub="42", username="sam-g1", email="sam@example.com", now=NOW)

            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(create, range(4)))

            items = table.scan()["Items"]
            assert len([item for item in items if item["sk"] == "PROFILE"]) == 1
            assert len(items) == 3

        def test_a_later_attempt_gets_the_account_the_first_made(self, table: "Table") -> None:
            store = UsersStore(table)
            first = store.create_google_user(sub="42", username="sam-g1", email="sam@example.com", now=NOW)

            second = store.create_google_user(sub="42", username="sam-g1", email="sam@example.com", now=NOW)

            assert second.id == first.id

    class TestGivenAGoogleNameAlreadyTakenByAnotherUser:
        def test_the_store_refuses_it_and_the_sign_in_fails_cleanly(
            self, handler: Handler, google: FakeGoogle, table: "Table"
        ) -> None:
            username = username_for(GoogleIdentity(sub="1234567890", email="Alice.B@example.com"))
            seed_user(table, username, "active")

            with pytest.raises(UsernameTakenError):
                UsersStore(table).create_google_user(
                    sub="1234567890", username=username, email="Alice.B@example.com", now=NOW
                )
            assert sign_in(handler, google).location == "/login?error=google_failed"

    @pytest.mark.parametrize(
        "query",
        [
            pytest.param({"code": "the-code", "state": "another-state"}, id="a state that doesn't match"),
            pytest.param({"code": "the-code", "state": "caf\u00e9"}, id="a state that isn't ASCII"),
            pytest.param({"code": "the-code"}, id="no state"),
            pytest.param({"state": None}, id="no code"),
            pytest.param({"error": "access_denied", "state": None}, id="the user cancelling at Google"),
        ],
    )
    def test_a_bad_callback_never_reaches_google_and_clears_the_attempt(
        self, handler: Handler, google: FakeGoogle, query: dict[str, Any]
    ) -> None:
        cookie, state = start(handler, google)
        sent = {key: state if value is None else value for key, value in query.items()}

        res = call(handler, GOOGLE_CALLBACK, cookies=[cookie], query=sent)

        assert (res.status, res.location) == (302, "/login?error=google_failed")
        assert google.calls == []
        assert res.cookies[0].startswith("__Host-googleSignIn=;")

    def test_a_junk_state_is_an_ordinary_failure_not_an_unhandled_error(
        self, handler: Handler, google: FakeGoogle, logged: list[LogEntry]
    ) -> None:
        cookie, _ = start(handler, google)

        call(handler, GOOGLE_CALLBACK, cookies=[cookie], query={"code": "the-code", "state": "caf\u00e9"})

        assert {"event": "google_login_failed", "reason": "state_mismatch"} in logged

    def test_a_callback_without_the_attempts_cookie_fails_so_an_attacker_cant_plant_their_own_login(
        self, handler: Handler, google: FakeGoogle
    ) -> None:
        _, state = start(handler, google)

        res = call(handler, GOOGLE_CALLBACK, query={"code": "the-code", "state": state})

        assert res.location == "/login?error=google_failed"
        assert google.calls == []

    def test_an_id_token_for_another_nonce_is_refused(
        self, handler: Handler, google: FakeGoogle, table: "Table"
    ) -> None:
        google.claims["nonce"] = "replayed-from-another-sign-in"

        res = sign_in(handler, google)

        assert res.location == "/login?error=google_failed"
        assert table.scan(Select="COUNT")["Count"] == 0

    @pytest.mark.parametrize(
        "failure",
        [
            pytest.param(GoogleSignInError("token_request_failed"), id="google refusing the code"),
            pytest.param(RuntimeError("SSM is down"), id="something unexpected"),
        ],
    )
    def test_a_failure_redirects_rather_than_showing_json_in_the_browser(
        self, handler: Handler, google: FakeGoogle, logged: list[LogEntry], failure: Exception
    ) -> None:
        google.failure = failure

        res = sign_in(handler, google)

        assert (res.status, res.location) == (302, "/login?error=google_failed")
        assert res.body == {}
        assert not any(entry.get("event") == "login_failed" for entry in logged)

    def test_it_logs_a_google_failure_for_itself_with_no_code_or_state(
        self, handler: Handler, google: FakeGoogle, logged: list[LogEntry]
    ) -> None:
        google.failure = GoogleSignInError("token_request_failed")

        sign_in(handler, google)

        assert {"event": "google_login_failed", "reason": "token_request_failed"} in logged


class TestPasswordLoginToAGoogleAccount:
    def given_a_google_user(self, table: "Table") -> str:
        store = UsersStore(table)
        user = store.create_google_user(sub="7", username="pat-g1", email="pat@example.com", now=NOW)
        store.set_status(user.id, "active")
        return user.username

    @pytest.mark.parametrize(
        "password",
        [pytest.param("guess", id="a guess"), pytest.param("not-a-real-password", id="the dummy hash's own password")],
    )
    def test_no_password_gets_in(self, handler: Handler, table: "Table", password: str) -> None:
        username = self.given_a_google_user(table)

        res = call(handler, LOGIN, {"username": username, "password": password})

        assert res.status == 401
        assert res.body["error"]["code"] == "invalid_credentials"
