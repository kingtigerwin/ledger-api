import base64
import hmac
import json
from collections.abc import Callable
from datetime import datetime, timedelta
from functools import cache
from typing import Any, Literal, cast

from ledger_api.auth.google import (
    GoogleSignIn,
    GoogleSignInError,
    attempt_cookie,
    authorization_url,
    clear_attempt_cookie,
    identity_from,
    new_attempt,
    read_attempt,
    username_for,
)
from ledger_api.auth.password import hash_password, verify_password
from ledger_api.auth.refresh_tokens import (
    REFRESH_TOKEN_TTL_SECONDS,
    clear_refresh_cookie,
    generate_refresh_token,
    hash_refresh_token,
    refresh_cookie,
)
from ledger_api.auth.schemas import LOGIN, REGISTRATION
from ledger_api.auth.tokens import ACCESS_TOKEN_TTL_SECONDS, AccessClaims, sign_access_token
from ledger_api.auth.users_store import InvalidRefreshTokenError, Role, User, UsernameTakenError, UsersStore
from ledger_api.http import (
    ApiError,
    Event,
    Handler,
    Response,
    auth_context,
    json_response,
    no_content,
    parse_body,
    read_cookie,
    redirect,
    with_errors,
)
from ledger_api.log import Logger
from ledger_api.log import log as default_log

type Delivery = Literal["cookie", "body"]

SCOPES: dict[Role, str] = {
    "customer": "transactions:read transactions:write",
    # Admins manage users, and also record their own spending, like a customer.
    "admin": "admin:read admin:write transactions:read transactions:write",
}

_REFRESH_TTL = timedelta(seconds=REFRESH_TOKEN_TTL_SECONDS)

# ledger-ui's pages; relative, so the browser stays on the host that's showing the app.
_LANDING_PAGE = "/chat"
_LOGIN_PAGE = "/login"


@cache
def _dummy_hash() -> str:
    """Checked against when the username doesn't exist; made on first need rather than slowing every cold start."""
    return hash_password("not-a-real-password")


def _with_refresh_token(body: dict[str, Any], refresh_token: str, deliver_in: Delivery) -> Response:
    """Sends the refresh token the way the client asked: as a cookie, or in the JSON body."""
    if deliver_in == "body":
        return json_response(200, {**body, "refreshToken": refresh_token})
    return json_response(200, body, [refresh_cookie(refresh_token)])


def _invalid_refresh_token() -> ApiError:
    return ApiError(401, "invalid_refresh_token", "Log in again")


def _read_refresh_token(event: Event) -> tuple[str, Delivery] | None:
    """The refresh token from the cookie (browsers) or the JSON body (other clients)."""
    cookie = read_cookie(event, "refreshToken")
    if cookie is not None:
        return cookie, "cookie"
    try:
        text = event.get("body") or "{}"
        body: Any = json.loads(base64.b64decode(text) if event.get("isBase64Encoded") else text)
    except ValueError:
        # An unreadable body is the same as a missing token.
        return None
    token = cast(dict[str, Any], body).get("refreshToken") if isinstance(body, dict) else None
    return (token, "body") if isinstance(token, str) and token else None


def create_auth_handler(
    *,
    users: UsersStore,
    signing_secret: str,
    now: Callable[[], datetime],
    log: Logger = default_log,
    google: GoogleSignIn | None = None,
) -> Handler:
    """Register, log in, sign in with Google, refresh, log out and me: the routes that hand out and take back tokens."""

    def login_failed(reason: Literal["invalid_credentials", "account_locked"]) -> ApiError:
        """A failed login: logged for the failed-login alarm, then returned to the client."""
        log({"event": "login_failed", "reason": reason}, "info")
        if reason == "account_locked":
            return ApiError(423, "account_locked", "Too many failed logins; try again later")
        return ApiError(401, "invalid_credentials", "Invalid username or password")

    def access_token_for(user: User, at: datetime) -> str:
        return sign_access_token(AccessClaims(sub=user.id, role=user.role, scope=SCOPES[user.role]), signing_secret, at)

    def tokens(user: User, at: datetime) -> dict[str, Any]:
        return {"accessToken": access_token_for(user, at), "expiresIn": ACCESS_TOKEN_TTL_SECONDS}

    def new_refresh_token(user: User, at: datetime) -> str:
        refresh_token = generate_refresh_token(user.id)
        users.save_refresh_token(user.id, hash_refresh_token(refresh_token), at + _REFRESH_TTL)
        return refresh_token

    def register(event: Event) -> Response:
        body = parse_body(event, REGISTRATION)
        try:
            # The Users table's stream tells the notify Lambda, which emails them that they're waiting for approval.
            user = users.create(
                username=body["username"],
                email=body["email"],
                password_hash=hash_password(body["password"]),
                role="customer",
                status="pending",
                now=now(),
            )
        except UsernameTakenError:
            raise ApiError(409, "username_taken", "That username is taken") from None
        return json_response(201, user.as_json())

    def login(event: Event) -> Response:
        body = parse_body(event, LOGIN)
        at = now()
        found = users.find_by_username(body["username"])
        if found and found.locked_until and found.locked_until > at:
            raise login_failed("account_locked")
        # Hash even with nothing to check against, so response time doesn't reveal which usernames are taken. The
        # dummy hash has a password of its own, so a match against it must never count.
        stored_hash = found.password_hash if found else None
        password_ok = verify_password(body["password"], stored_hash or _dummy_hash()) and stored_hash is not None
        if not found:
            raise login_failed("invalid_credentials")
        if not password_ok:
            users.record_failed_login(found.user.id, at)
        if not password_ok or found.user.status == "disabled":
            raise login_failed("invalid_credentials")
        if found.failed_logins > 0:
            users.clear_failed_logins(found.user.id)
        if found.user.status == "pending":
            raise ApiError(403, "account_pending", "This account is waiting for admin approval")
        refresh_token = new_refresh_token(found.user, at)
        return _with_refresh_token(tokens(found.user, at), refresh_token, body.get("refreshTokenIn", "cookie"))

    def google_start(_: Event) -> Response:
        if not google:
            return redirect(f"{_LOGIN_PAGE}?error=google_unavailable")
        attempt = new_attempt()
        url = authorization_url(attempt, client_id=google.client_id, redirect_uri=google.redirect_uri)
        return redirect(url, [attempt_cookie(attempt)])

    def finish_google_sign_in(event: Event, config: GoogleSignIn) -> Response:
        query: dict[str, str] = event.get("queryStringParameters") or {}
        attempt = read_attempt(event)
        if not attempt or not hmac.compare_digest(query.get("state", "").encode(), attempt.state.encode()):
            raise GoogleSignInError("state_mismatch")
        code = query.get("code")
        if not code:
            raise GoogleSignInError("no_code")
        at = now()
        id_token = config.exchange_code(code, attempt.code_verifier)
        identity = identity_from(id_token, client_id=config.client_id, nonce=attempt.nonce, now=at)
        # Never matched by email: registered addresses aren't verified, so one could be someone else's.
        user = users.find_by_google_sub(identity.sub)
        if not user:
            # The Users table's stream tells the notify Lambda, as it does for a registration.
            user = users.create_google_user(
                sub=identity.sub, username=username_for(identity), email=identity.email, now=at
            )
        if user.status == "disabled":
            raise GoogleSignInError("account_disabled")
        if user.status == "pending":
            return redirect(f"{_LOGIN_PAGE}?error=account_pending", [clear_attempt_cookie()])
        # The UI's page load trades this cookie for an access token, as it does after any reload.
        return redirect(_LANDING_PAGE, [clear_attempt_cookie(), refresh_cookie(new_refresh_token(user, at))])

    def google_callback(event: Event) -> Response:
        """Every outcome is a redirect: the browser is on this URL, so with_errors' JSON would be the whole page."""
        if not google:
            return redirect(f"{_LOGIN_PAGE}?error=google_unavailable")
        try:
            return finish_google_sign_in(event, google)
        except (GoogleSignInError, UsernameTakenError) as err:
            reason = str(err) if isinstance(err, GoogleSignInError) else "username_taken"
            # Not login_failed: that counts towards the password-guessing alarm.
            log({"event": "google_login_failed", "reason": reason}, "info")
        except Exception as err:
            log({"event": "unhandled_error", "routeKey": event.get("routeKey"), "err": err}, "error")
        return redirect(f"{_LOGIN_PAGE}?error=google_failed", [clear_attempt_cookie()])

    def refresh(event: Event) -> Response:
        at = now()
        presented = _read_refresh_token(event)
        if not presented:
            raise _invalid_refresh_token()
        token, deliver_in = presented
        user_id = token.split(".")[0]
        user = users.get_by_id(user_id) if user_id else None
        if not user or user.status != "active":
            raise _invalid_refresh_token()
        replacement = generate_refresh_token(user.id)
        try:
            users.rotate_refresh_token(
                user.id,
                hash_refresh_token(token),
                hash_refresh_token(replacement),
                now=at,
                expires_at=at + _REFRESH_TTL,
            )
        except InvalidRefreshTokenError as err:
            if err.reused:
                users.revoke_refresh_tokens(user.id)
            raise _invalid_refresh_token() from None
        return _with_refresh_token(tokens(user, at), replacement, deliver_in)

    def logout(event: Event) -> Response:
        # Logging out twice, or without a token, is still a successful logout.
        presented = _read_refresh_token(event)
        if presented:
            token, _ = presented
            user_id = token.split(".")[0]
            if user_id:
                users.delete_refresh_token(user_id, hash_refresh_token(token))
        return no_content([clear_refresh_cookie()])

    def me(event: Event) -> Response:
        user = users.get_by_id(auth_context(event).user_id)
        if not user:
            raise ApiError(401, "unauthorized", "Sign in first")
        profile = user.as_json()
        del profile["createdAt"]
        return json_response(200, profile)

    def handler(event: Event) -> Response:
        match event.get("routeKey"):
            case "POST /api/v1/auth/register":
                return register(event)
            case "POST /api/v1/auth/login":
                return login(event)
            case "GET /api/v1/auth/google/start":
                return google_start(event)
            case "GET /api/v1/auth/google/callback":
                return google_callback(event)
            case "POST /api/v1/auth/refresh":
                return refresh(event)
            case "POST /api/v1/auth/logout":
                return logout(event)
            case "GET /api/v1/auth/me":
                return me(event)
            case route:
                raise ApiError(404, "route_not_found", f"No route for {route}")

    return with_errors(handler)
