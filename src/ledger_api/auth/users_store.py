"""The Users table, as src/auth/users-store.ts reads and writes it (see src/auth/users-table.ts)."""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from boto3.dynamodb.conditions import Attr

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

type Role = Literal["admin", "customer"]
type UserStatus = Literal["pending", "active", "disabled"]


@dataclass(frozen=True)
class User:
    id: str
    username: str
    role: Role
    status: UserStatus
    created_at: str
    # Customers give one when they register; the bootstrap admin and earlier users have none.
    email: str | None = None

    def as_json(self) -> dict[str, Any]:
        """The API's shape: camelCase, and no `email` key when there is none."""
        body: dict[str, Any] = {"id": self.id, "username": self.username}
        if self.email is not None:
            body["email"] = self.email
        return body | {"role": self.role, "status": self.status, "createdAt": self.created_at}


def _user(item: dict[str, Any]) -> User:
    return User(
        id=str(item["id"]),
        username=str(item["username"]),
        role=item["role"],
        status=item["status"],
        created_at=str(item["createdAt"]),
        email=str(item["email"]) if "email" in item else None,
    )


class UsersStore:
    def __init__(self, table: "Table") -> None:
        self._table = table

    def list_by_status(self, status: UserStatus) -> list[User]:
        """
        Scans the whole table. Fine at household-app scale (an admin listing a few sign-ups);
        a status index would be the upgrade if the table grows large.
        """
        users: list[User] = []
        # Table has no paginator, and the client's is typed for string expressions only, so follow the pages here.
        scan: dict[str, Any] = {"FilterExpression": Attr("sk").eq("PROFILE") & Attr("status").eq(status)}
        while True:
            page = self._table.scan(**scan)
            users.extend(_user(item) for item in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return sorted(users, key=lambda user: user.created_at)
