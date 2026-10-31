import re

from ledger_api.auth.refresh_tokens import clear_refresh_cookie, generate_refresh_token, hash_refresh_token, refresh_cookie


class TestGivenARefreshToken:
    def test_it_starts_with_the_user_id_so_its_record_can_be_found(self) -> None:
        token = generate_refresh_token("user-1")

        assert re.fullmatch(r"user-1\.[A-Za-z0-9_-]{43}", token)
        assert token != generate_refresh_token("user-1")

    def test_its_hash_matches_the_typescript_lambdas_so_stored_tokens_still_refresh(self) -> None:
        # From src/auth/refresh-tokens.ts: base64url without padding.
        assert hash_refresh_token("user-1.abc") == "0xn37wqrxxFmJhE2mT32o8tAXXW1AEswFYC5ubCW6gA"


class TestGivenTheRefreshCookie:
    def test_it_is_http_only_secure_strict_and_scoped_to_the_auth_routes_for_7_days(self) -> None:
        assert refresh_cookie("t") == (
            "refreshToken=t; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=604800"
        )

    def test_clearing_it_expires_it_at_once(self) -> None:
        assert clear_refresh_cookie() == "refreshToken=; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=0"
