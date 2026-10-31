"""The auth request schemas; the OpenAPI spec (ledger_api.docs) is built from them too."""

from typing import Annotated, Literal, NotRequired, TypedDict

from pydantic import Field, StrictStr, StringConstraints, TypeAdapter

# zod's email pattern (z.email()), so the API takes the same addresses it did. 254 is the longest an address can be.
EMAIL_PATTERN = (
    r"^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$"
)

# Stored lower-case, so a username is matched in any case.
type Username = Annotated[StrictStr, StringConstraints(min_length=1, max_length=64, to_lower=True)]
type Password = Annotated[StrictStr, StringConstraints(min_length=1, max_length=1024)]
type Email = Annotated[
    StrictStr, StringConstraints(max_length=254, pattern=EMAIL_PATTERN), Field(json_schema_extra={"format": "email"})
]


class Credentials(TypedDict):
    username: Username
    password: Password


class Registration(Credentials):
    # For the account emails; not unique, and not used to sign in.
    email: Email


class Login(Credentials):
    # Browsers get the refresh token only as an HttpOnly cookie; non-browser clients (an agent) ask for it in the body.
    refreshTokenIn: NotRequired[Annotated[Literal["cookie", "body"], Field(json_schema_extra={"default": "cookie"})]]


class RefreshTokenBody(TypedDict, total=False):
    """Refresh and logout read the token from the cookie, or from here; the handler reads it without validating."""

    refreshToken: StrictStr


REGISTRATION = TypeAdapter(Registration)
LOGIN = TypeAdapter(Login)
REFRESH_TOKEN_BODY = TypeAdapter(RefreshTokenBody)
