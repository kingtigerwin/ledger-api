"""The Users table, as src/auth/users-store.ts reads and writes it (see src/auth/users-table.ts)."""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

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


class UsersStore:
    def __init__(self, table: "Table") -> None:
        self._table = table
