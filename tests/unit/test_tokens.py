import base64
import json
from datetime import UTC, datetime

import jwt
import pytest

from ledger_api.auth.tokens import AccessClaims, sign_access_token, verify_access_token

SECRET = "test-signing-secret-of-32-bytes!"
ISSUED_AT = datetime(2026, 10, 26, 10, 0, 0, tzinfo=UTC)
CLAIMS = AccessClaims(sub="user-1", role="customer", scope="transactions:read")

# Signed by the TypeScript auth Lambda (jose, src/auth/tokens.ts) with SECRET at ISSUED_AT: tokens already out there.
JOSE_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJyb2xlIjoiY3VzdG9tZXIiLCJzY29wZSI6InRyYW5zYWN0aW9uczpyZWFkIiwic3ViIjoidXNlci0xIiwiaWF0IjoxNzkzMDA4ODAwLCJleHAiOjE3OTMwMDk3MDB9."
    "Yab3r3tHFPPeByaXiZWXiJ-z4PNpIc_Ioay3CGp1YKs"
)


def at(time: str) -> datetime:
    return datetime.fromisoformat(f"2026-10-26T{time}+00:00")


def segment(value: dict[str, object]) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


class TestGivenAnAccessToken:
    def test_it_returns_its_claims_when_verified_with_the_same_secret(self) -> None:
        token = sign_access_token(CLAIMS, SECRET, ISSUED_AT)

        assert verify_access_token(token, SECRET, ISSUED_AT) == CLAIMS

    def test_it_is_still_valid_just_before_15_minutes_have_passed(self) -> None:
        token = sign_access_token(CLAIMS, SECRET, ISSUED_AT)

        assert verify_access_token(token, SECRET, at("10:14:59")) == CLAIMS

    def test_it_is_rejected_once_15_minutes_have_passed(self) -> None:
        token = sign_access_token(CLAIMS, SECRET, ISSUED_AT)

        with pytest.raises(jwt.InvalidTokenError):
            verify_access_token(token, SECRET, at("10:15:01"))

    def test_it_is_rejected_when_signed_with_a_different_secret(self) -> None:
        token = sign_access_token(CLAIMS, "another-signing-secret-of-32-byte", ISSUED_AT)

        with pytest.raises(jwt.InvalidTokenError):
            verify_access_token(token, SECRET, ISSUED_AT)

    def test_it_is_rejected_when_its_payload_is_tampered_with(self) -> None:
        header, _, signature = sign_access_token(CLAIMS, SECRET, ISSUED_AT).split(".")
        forged = segment({"sub": "user-1", "role": "admin", "scope": "admin:read", "exp": 1793009700})

        with pytest.raises(jwt.InvalidTokenError):
            verify_access_token(f"{header}.{forged}.{signature}", SECRET, ISSUED_AT)

    def test_it_is_rejected_when_unsigned(self) -> None:
        payload = segment({"sub": "user-1", "role": "admin", "scope": "admin:read", "exp": 1793009700})

        with pytest.raises(jwt.InvalidTokenError):
            verify_access_token(f"{segment({'alg': 'none', 'typ': 'JWT'})}.{payload}.", SECRET, ISSUED_AT)

    def test_it_is_rejected_without_an_expiry(self) -> None:
        token = jwt.encode({"sub": "user-1", "role": "customer", "scope": "transactions:read"}, SECRET, "HS256")

        with pytest.raises(jwt.InvalidTokenError):
            verify_access_token(token, SECRET, ISSUED_AT)


class TestGivenATokenTheTypeScriptLambdaSigned:
    def test_it_verifies_and_returns_its_claims(self) -> None:
        assert verify_access_token(JOSE_TOKEN, SECRET, ISSUED_AT) == CLAIMS

    def test_it_expires_after_the_same_15_minutes(self) -> None:
        with pytest.raises(jwt.InvalidTokenError):
            verify_access_token(JOSE_TOKEN, SECRET, at("10:15:00"))


class TestGivenATokenThisLambdaSigned:
    def test_it_has_the_claims_and_header_the_typescript_lambda_writes(self) -> None:
        token = sign_access_token(CLAIMS, SECRET, ISSUED_AT)

        assert jwt.get_unverified_header(token) == {"alg": "HS256", "typ": "JWT"}
        assert jwt.decode(token, SECRET, algorithms=["HS256"], options={"verify_exp": False}) == {
            "role": "customer",
            "scope": "transactions:read",
            "sub": "user-1",
            "iat": 1793008800,
            "exp": 1793009700,
        }
