import contextlib
import secrets
from collections.abc import Callable
from datetime import datetime
from typing import Any

from ledger_api.auth.password import hash_password
from ledger_api.auth.users_store import UsernameTakenError, UsersStore
from ledger_api.bootstrap.parameters import ParameterStore
from ledger_api.config import ADMIN_PASSWORD_PARAM, ADMIN_USERNAME, SIGNING_SECRET_PARAM

PHYSICAL_RESOURCE_ID = "ledger-api-bootstrap"


def _ensure_parameter(parameters: ParameterStore, name: str, generate: Callable[[], str]) -> str:
    existing = parameters.get(name)
    if existing is not None:
        return existing
    value = generate()
    parameters.create_secure(name, value)
    return value


def bootstrap(*, users: UsersStore, parameters: ParameterStore, now: Callable[[], datetime]) -> None:
    """
    Creates only what's missing: the JWT signing secret, the root admin's random password, and the
    root admin user. Nothing that already exists is changed.
    """
    _ensure_parameter(parameters, SIGNING_SECRET_PARAM, lambda: secrets.token_urlsafe(32))
    password = _ensure_parameter(parameters, ADMIN_PASSWORD_PARAM, lambda: secrets.token_urlsafe(18))
    if users.find_by_username(ADMIN_USERNAME):
        return
    # UsernameTakenError: another run created the admin between our check and our write.
    with contextlib.suppress(UsernameTakenError):
        users.create(
            username=ADMIN_USERNAME,
            email=None,
            password_hash=hash_password(password),
            role="admin",
            status="active",
            now=now(),
        )


def create_bootstrap_handler(
    *, users: UsersStore, parameters: ParameterStore, now: Callable[[], datetime]
) -> Callable[[dict[str, Any]], dict[str, str]]:
    """
    A CDK custom resource's event handler: bootstraps on stack create and update. Delete does nothing,
    so the secrets and the admin survive the resource being replaced.
    """

    def handler(event: dict[str, Any]) -> dict[str, str]:
        if event.get("RequestType") != "Delete":
            bootstrap(users=users, parameters=parameters, now=now)
        return {"PhysicalResourceId": PHYSICAL_RESOURCE_ID}

    return handler
