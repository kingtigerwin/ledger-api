"""Seeds the Users table in the item shapes the auth Lambda writes."""

import uuid
from typing import TYPE_CHECKING, Any

from ledger_api.auth.password import hash_password

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


def seed_user(
    table: "Table",
    username: str,
    status: str,
    *,
    role: str = "customer",
    email: str | None = None,
    password: str | None = None,
) -> dict[str, Any]:
    """
    A user with their username claim, as registration (and the admin's approval) would leave them.
    Without a password the hash is a placeholder no login matches; scrypt is slow, so only hash when needed.
    """
    user: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "username": username,
        "role": role,
        "status": status,
        "createdAt": f"2026-10-30T00:00:{len(username):02d}.000Z",
    }
    if email:
        user["email"] = email
    table.put_item(Item={"pk": f"USERNAME#{username}", "sk": "USERNAME", "userId": user["id"]})
    password_hash = hash_password(password) if password else "scrypt$..."
    table.put_item(Item={"pk": f"USER#{user['id']}", "sk": "PROFILE", **user, "passwordHash": password_hash})
    return user


def seed_refresh_token(table: "Table", user_id: str, token_hash: str) -> None:
    table.put_item(
        Item={"pk": f"USER#{user_id}", "sk": f"REFRESH#{token_hash}", "expiresAt": "2026-11-30T00:00:00.000Z"}
    )
