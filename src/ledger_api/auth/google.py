"""
Sign-in with Google: OpenID Connect's authorization code flow with PKCE. Only `auth` imports this, so the
authorizer's cold start stays as it is.

The ID token's signature isn't checked. It's RS256, which PyJWT needs `cryptography` for, and adding that to the
shared bundle would make every `import jwt` load it, the authorizer's included. OpenID Connect allows this when the
token comes straight from the token endpoint over TLS, authenticated with the client secret, which is the only way
one reaches `identity_from`. Turning the signature check off turns PyJWT's claim checks off too, so they are here.
"""

import base64
import hashlib
import hmac
import json
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, cast
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import jwt

from ledger_api.config import GOOGLE_CLIENT_SECRET_PARAM
from ledger_api.http import Event, read_cookie

if TYPE_CHECKING:
    from mypy_boto3_ssm import SSMClient

_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}
# Leaves room in the function's 10 seconds to redirect the browser back with an error.
_TIMEOUT_SECONDS = 5

# __Host- means only this exact host can set it, so another site under haoran.cloud can't plant one. Lax, not Strict
# like the refresh cookie: a Strict cookie isn't sent on the navigation back from Google.
_COOKIE_NAME = "__Host-googleSignIn"
_COOKIE = "HttpOnly; Secure; SameSite=Lax; Path=/"
_COOKIE_MAX_AGE_SECONDS = 10 * 60

# A username is at most 64 characters: this much of the address, then `-g` and the hash.
_USERNAME_PREFIX_LENGTH = 54


class GoogleSignInError(Exception):
    """The sign-in can't go on. The message is a short reason for the logs, never a code, state or token."""


@dataclass(frozen=True)
class GoogleIdentity:
    # Google's stable ID for the account. Identify people by this: an address can change hands.
    sub: str
    email: str


@dataclass(frozen=True)
class GoogleSignIn:
    client_id: str
    redirect_uri: str
    # Takes the code and the PKCE verifier, and returns the ID token.
    exchange_code: Callable[[str, str], str]


@dataclass(frozen=True)
class Attempt:
    """What ties Google's redirect back to the browser that started the sign-in."""

    state: str
    nonce: str
    code_verifier: str


def new_attempt() -> Attempt:
    return Attempt(
        state=secrets.token_urlsafe(32), nonce=secrets.token_urlsafe(32), code_verifier=secrets.token_urlsafe(32)
    )


def attempt_cookie(attempt: Attempt) -> str:
    value = f"{attempt.state}.{attempt.nonce}.{attempt.code_verifier}"
    return f"{_COOKIE_NAME}={value}; {_COOKIE}; Max-Age={_COOKIE_MAX_AGE_SECONDS}"


def clear_attempt_cookie() -> str:
    return f"{_COOKIE_NAME}=; {_COOKIE}; Max-Age=0"


def read_attempt(event: Event) -> Attempt | None:
    match (read_cookie(event, _COOKIE_NAME) or "").split("."):
        case [state, nonce, code_verifier] if state and nonce and code_verifier:
            return Attempt(state=state, nonce=nonce, code_verifier=code_verifier)
        case _:
            return None


def authorization_url(attempt: Attempt, *, client_id: str, redirect_uri: str) -> str:
    """Where to send the browser. Asking for `select_account` lets someone with several Google accounts choose."""
    challenge = base64.urlsafe_b64encode(hashlib.sha256(attempt.code_verifier.encode()).digest()).decode().rstrip("=")
    query = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email",
        "state": attempt.state,
        "nonce": attempt.nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    return f"{_AUTHORIZATION_ENDPOINT}?{urlencode(query)}"


def exchange_code(*, code: str, code_verifier: str, client_id: str, client_secret: str, redirect_uri: str) -> str:
    """Trades the code for an ID token at Google's token endpoint; the only caller of the network here."""
    form = {
        "code": code,
        "code_verifier": code_verifier,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    request = Request(_TOKEN_ENDPOINT, data=urlencode(form).encode(), method="POST")
    try:
        with urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            body: Any = json.load(response)
    except (URLError, TimeoutError, ValueError):
        raise GoogleSignInError("token_request_failed") from None
    id_token = cast(dict[str, Any], body).get("id_token") if isinstance(body, dict) else None
    if not isinstance(id_token, str):
        raise GoogleSignInError("no_id_token")
    return id_token


def identity_from(id_token: str, *, client_id: str, nonce: str, now: datetime) -> GoogleIdentity:
    """Who an ID token from `exchange_code` says this is. Raises GoogleSignInError unless every claim holds."""
    try:
        claims: dict[str, Any] = jwt.decode(id_token, options={"verify_signature": False})
    except jwt.InvalidTokenError:
        raise GoogleSignInError("malformed_id_token") from None
    expiry = claims.get("exp")
    sub, email = claims.get("sub"), claims.get("email")
    if claims.get("iss") not in _ISSUERS:
        raise GoogleSignInError("wrong_issuer")
    if claims.get("aud") != client_id:
        raise GoogleSignInError("wrong_audience")
    if not hmac.compare_digest(str(claims.get("nonce", "")).encode(), nonce.encode()):
        raise GoogleSignInError("wrong_nonce")
    if not isinstance(expiry, int) or expiry <= now.timestamp():
        raise GoogleSignInError("expired_id_token")
    if not isinstance(sub, str) or not sub or not isinstance(email, str) or not email:
        raise GoogleSignInError("incomplete_id_token")
    if claims.get("email_verified") is not True:
        raise GoogleSignInError("unverified_email")
    return GoogleIdentity(sub=sub, email=email)


def username_for(identity: GoogleIdentity) -> str:
    """Readable in emails and in the admin's MCP filter, and the same each time; the hash keeps two Sams apart."""
    local_part = identity.email.split("@")[0].lower()[:_USERNAME_PREFIX_LENGTH]
    return f"{local_part}-g{hashlib.sha256(identity.sub.encode()).hexdigest()[:8]}"


def load_client_secret(ssm: "SSMClient") -> str:
    """Set by hand (see README.md). Read on first use, so a problem with it can't stop password logins."""
    return ssm.get_parameter(Name=GOOGLE_CLIENT_SECRET_PARAM, WithDecryption=True)["Parameter"].get("Value", "")
