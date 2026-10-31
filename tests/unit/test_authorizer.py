from datetime import UTC, datetime
from typing import Any

import pytest

from ledger_api.auth.tokens import AccessClaims, sign_access_token
from ledger_api.authorizer.handler import create_authorizer

SECRET = "test-signing-secret-of-32-bytes!"
ISSUED_AT = datetime(2026, 10, 26, 10, 0, 0, tzinfo=UTC)
CLAIMS = AccessClaims(sub="user-1", role="customer", scope="transactions:read")


def event_with(authorization: str | None) -> dict[str, Any]:
    return {"headers": {} if authorization is None else {"authorization": authorization}}


def authorize(now: datetime, event: dict[str, Any], *, active: bool = True) -> dict[str, Any]:
    return create_authorizer(signing_secret=SECRET, now=lambda: now, is_active=lambda _: active)(event)


class TestGivenARequestToAProtectedRoute:
    def test_it_allows_a_valid_bearer_token_and_passes_its_claims_to_the_route(self) -> None:
        token = sign_access_token(CLAIMS, SECRET, ISSUED_AT)

        result = authorize(ISSUED_AT, event_with(f"Bearer {token}"))

        assert result == {
            "isAuthorized": True,
            "context": {"userId": "user-1", "role": "customer", "scope": "transactions:read"},
        }

    @pytest.mark.parametrize(
        "header",
        [
            pytest.param(None, id="no Authorization header"),
            pytest.param("Basic dXNlcjpwdw==", id="a scheme other than Bearer"),
            pytest.param("Bearer not-a-jwt", id="a malformed token"),
            pytest.param("Bearer ", id="an empty token"),
        ],
    )
    def test_it_refuses(self, header: str | None) -> None:
        assert authorize(ISSUED_AT, event_with(header)) == {"isAuthorized": False}

    def test_it_refuses_a_request_without_headers(self) -> None:
        assert authorize(ISSUED_AT, {}) == {"isAuthorized": False}

    def test_it_refuses_a_valid_token_whose_user_is_no_longer_active(self) -> None:
        token = sign_access_token(CLAIMS, SECRET, ISSUED_AT)

        assert authorize(ISSUED_AT, event_with(f"Bearer {token}"), active=False) == {"isAuthorized": False}

    def test_it_only_looks_up_the_user_of_a_token_it_has_verified(self) -> None:
        asked: list[str] = []

        def is_active(user_id: str) -> bool:
            asked.append(user_id)
            return True

        create_authorizer(signing_secret=SECRET, now=lambda: ISSUED_AT, is_active=is_active)(
            event_with("Bearer not-a-jwt")
        )

        assert asked == []

    def test_it_asks_about_the_user_the_token_names(self) -> None:
        asked: list[str] = []

        def is_active(user_id: str) -> bool:
            asked.append(user_id)
            return True

        token = sign_access_token(CLAIMS, SECRET, ISSUED_AT)
        create_authorizer(signing_secret=SECRET, now=lambda: ISSUED_AT, is_active=is_active)(
            event_with(f"Bearer {token}")
        )

        assert asked == ["user-1"]

    def test_it_refuses_an_expired_token(self) -> None:
        token = sign_access_token(CLAIMS, SECRET, ISSUED_AT)

        result = authorize(datetime(2026, 10, 26, 10, 15, 1, tzinfo=UTC), event_with(f"Bearer {token}"))

        assert result == {"isAuthorized": False}

    def test_it_refuses_a_token_signed_with_another_secret(self) -> None:
        token = sign_access_token(CLAIMS, "another-signing-secret-of-32-byte", ISSUED_AT)

        assert authorize(ISSUED_AT, event_with(f"Bearer {token}")) == {"isAuthorized": False}
