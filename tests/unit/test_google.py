import base64
import hashlib
import io
import json
from datetime import UTC, datetime, timedelta
from email.message import Message
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request

import pytest

from ledger_api.auth.google import (
    Attempt,
    GoogleIdentity,
    GoogleSignInError,
    attempt_cookie,
    authorization_url,
    clear_attempt_cookie,
    exchange_code,
    identity_from,
    new_attempt,
    read_attempt,
    username_for,
)

CLIENT_ID = "client-1.apps.googleusercontent.com"
REDIRECT_URI = "https://ledger.example.test/api/v1/auth/google/callback"
NOW = datetime(2026, 11, 1, tzinfo=UTC)


def _b64(value: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def id_token(**overrides: Any) -> str:
    """An ID token as Google's token endpoint returns it; its signature isn't checked, so any will do."""
    claims: dict[str, Any] = {
        "iss": "https://accounts.google.com",
        "aud": CLIENT_ID,
        "sub": "1234567890",
        "email": "Alice.B@example.com",
        "email_verified": True,
        "nonce": "the-nonce",
        "exp": int((NOW + timedelta(minutes=5)).timestamp()),
    }
    claims.update(overrides)
    payload = {key: value for key, value in claims.items() if value is not None}
    return f"{_b64({'alg': 'RS256', 'kid': 'k1', 'typ': 'JWT'})}.{_b64(payload)}.c2lnbmF0dXJl"


class TestAuthorizationUrl:
    class TestGivenAnAttempt:
        def test_it_asks_google_for_a_code_with_pkce_for_the_openid_email_scopes(self) -> None:
            attempt = Attempt(state="the-state", nonce="the-nonce", code_verifier="the-verifier")

            url = urlsplit(authorization_url(attempt, client_id=CLIENT_ID, redirect_uri=REDIRECT_URI))
            query = {key: values[0] for key, values in parse_qs(url.query).items()}

            assert f"{url.scheme}://{url.netloc}{url.path}" == "https://accounts.google.com/o/oauth2/v2/auth"
            challenge = base64.urlsafe_b64encode(hashlib.sha256(b"the-verifier").digest()).decode().rstrip("=")
            assert query == {
                "client_id": CLIENT_ID,
                "redirect_uri": REDIRECT_URI,
                "response_type": "code",
                "scope": "openid email",
                "state": "the-state",
                "nonce": "the-nonce",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "prompt": "select_account",
            }


class TestNewAttempt:
    def test_every_value_is_different_and_long_enough_to_be_unguessable(self) -> None:
        first, second = new_attempt(), new_attempt()

        assert len({first.state, first.nonce, first.code_verifier, second.state}) == 4
        assert len(first.code_verifier) >= 43


class TestAttemptCookie:
    class TestGivenAnAttempt:
        def test_it_survives_the_round_trip_through_the_browser(self) -> None:
            attempt = new_attempt()
            pair = attempt_cookie(attempt).split(";")[0]

            assert read_attempt({"cookies": ["other=1", pair]}) == attempt

        def test_it_is_host_only_and_lax_so_it_comes_back_on_googles_redirect(self) -> None:
            cookie = attempt_cookie(new_attempt())

            assert cookie.startswith("__Host-")
            for attribute in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]:
                assert attribute in cookie
            assert "Domain" not in cookie

    def test_clearing_it_expires_the_same_cookie(self) -> None:
        name = attempt_cookie(new_attempt()).split("=")[0]

        assert clear_attempt_cookie().startswith(f"{name}=;")
        assert "Max-Age=0" in clear_attempt_cookie()

    @pytest.mark.parametrize(
        "cookies",
        [
            pytest.param(None, id="no cookies"),
            pytest.param(["other=1"], id="another cookie"),
            pytest.param(["__Host-googleSignIn=only.two"], id="a malformed value"),
        ],
    )
    def test_a_missing_or_malformed_cookie_reads_as_none(self, cookies: list[str] | None) -> None:
        assert read_attempt({"cookies": cookies}) is None


class TestIdentityFrom:
    class TestGivenAValidIdToken:
        def test_it_returns_who_google_says_it_is(self) -> None:
            identity = identity_from(id_token(), client_id=CLIENT_ID, nonce="the-nonce", now=NOW)

            assert identity == GoogleIdentity(sub="1234567890", email="Alice.B@example.com")

        def test_it_accepts_googles_issuer_without_the_scheme(self) -> None:
            token = id_token(iss="accounts.google.com")

            assert identity_from(token, client_id=CLIENT_ID, nonce="the-nonce", now=NOW).sub == "1234567890"

    @pytest.mark.parametrize(
        "claims",
        [
            pytest.param({"iss": "https://accounts.example.com"}, id="another issuer"),
            pytest.param({"iss": None}, id="no issuer"),
            pytest.param({"aud": "another-client"}, id="another audience"),
            pytest.param({"aud": None}, id="no audience"),
            pytest.param({"nonce": "another-nonce"}, id="another nonce"),
            pytest.param({"nonce": None}, id="no nonce"),
            pytest.param({"nonce": "caf\u00e9"}, id="a nonce that isn't ASCII"),
            pytest.param({"exp": int(NOW.timestamp())}, id="expired this second"),
            pytest.param({"exp": None}, id="no expiry"),
            pytest.param({"email_verified": False}, id="unverified email"),
            pytest.param({"email_verified": "true"}, id="email_verified that isn't a boolean"),
            pytest.param({"email": None}, id="no email"),
            pytest.param({"sub": None}, id="no subject"),
        ],
    )
    def test_it_refuses(self, claims: dict[str, Any]) -> None:
        with pytest.raises(GoogleSignInError):
            identity_from(id_token(**claims), client_id=CLIENT_ID, nonce="the-nonce", now=NOW)

    def test_it_refuses_something_that_is_not_a_token(self) -> None:
        with pytest.raises(GoogleSignInError):
            identity_from("not-a-token", client_id=CLIENT_ID, nonce="the-nonce", now=NOW)


class TestExchangeCode:
    def exchange(self) -> str:
        return exchange_code(
            code="the-code",
            code_verifier="the-verifier",
            client_id=CLIENT_ID,
            client_secret="the-secret",
            redirect_uri=REDIRECT_URI,
        )

    class TestGivenGoogleAcceptsTheCode:
        def test_it_posts_the_form_to_the_token_endpoint_with_a_timeout_and_returns_the_id_token(
            self, monkeypatch: pytest.MonkeyPatch
        ) -> None:
            sent: list[tuple[Request, float]] = []

            def urlopen(request: Request, timeout: float) -> io.BytesIO:
                sent.append((request, timeout))
                return io.BytesIO(b'{"id_token": "the-id-token", "access_token": "unused"}')

            monkeypatch.setattr("ledger_api.auth.google.urlopen", urlopen)

            assert TestExchangeCode().exchange() == "the-id-token"

            [(request, timeout)] = sent
            assert request.full_url == "https://oauth2.googleapis.com/token"
            assert request.get_method() == "POST"
            assert timeout == 5
            assert isinstance(request.data, bytes)
            assert parse_qs(request.data.decode()) == {
                "code": ["the-code"],
                "code_verifier": ["the-verifier"],
                "client_id": [CLIENT_ID],
                "client_secret": ["the-secret"],
                "redirect_uri": [REDIRECT_URI],
                "grant_type": ["authorization_code"],
            }

    @pytest.mark.parametrize(
        ("result", "reason"),
        [
            pytest.param(
                HTTPError("https://token", 400, "Bad Request", Message(), None),
                "token_request_failed",
                id="google refusing the code",
            ),
            pytest.param(URLError("unreachable"), "token_request_failed", id="google being unreachable"),
            pytest.param(TimeoutError(), "token_request_failed", id="google being slow"),
            pytest.param(io.BytesIO(b"<html>"), "token_request_failed", id="an answer that isn't JSON"),
            pytest.param(io.BytesIO(b"{}"), "no_id_token", id="no ID token in the answer"),
        ],
    )
    def test_it_fails_with_a_reason_that_carries_no_secret(
        self, monkeypatch: pytest.MonkeyPatch, result: Exception | io.BytesIO, reason: str
    ) -> None:
        def urlopen(request: Request, timeout: float) -> io.BytesIO:
            if isinstance(result, Exception):
                raise result
            return result

        monkeypatch.setattr("ledger_api.auth.google.urlopen", urlopen)

        with pytest.raises(GoogleSignInError) as raised:
            self.exchange()

        assert str(raised.value) == reason


class TestUsernameFor:
    def test_it_is_readable_lower_case_and_the_same_every_time(self) -> None:
        identity = GoogleIdentity(sub="1234567890", email="Alice.B@example.com")
        suffix = hashlib.sha256(b"1234567890").hexdigest()[:8]

        assert username_for(identity) == f"alice.b-g{suffix}"
        assert username_for(identity) == username_for(identity)

    def test_two_people_with_the_same_local_part_get_different_names(self) -> None:
        first = GoogleIdentity(sub="1", email="sam@example.com")
        second = GoogleIdentity(sub="2", email="sam@example.org")

        assert username_for(first) != username_for(second)

    def test_it_stays_within_the_64_characters_a_username_may_have(self) -> None:
        identity = GoogleIdentity(sub="1", email=f"{'a' * 64}@example.com")

        assert len(username_for(identity)) <= 64
