"""The Users table, keyed as src/auth/users-table.ts defines (and the stack builds the table)."""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from boto3.dynamodb.conditions import Attr, Key

from ledger_api.timestamps import iso_timestamp

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

MAX_FAILED_LOGINS = 5
LOCKOUT = timedelta(minutes=15)

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


@dataclass(frozen=True)
class StoredCredentials:
    """What a login checks: the user, their password hash and their lockout state."""

    user: User
    # None for someone who signs in with Google, and so has no password.
    password_hash: str | None
    failed_logins: int
    locked_until: datetime | None


class UserNotFoundError(Exception):
    pass


class UsernameTakenError(Exception):
    pass


class InvalidRefreshTokenError(Exception):
    def __init__(self, *, reused: bool) -> None:
        super().__init__("Refresh token reused" if reused else "Unknown refresh token")
        # True when the token existed but had already been replaced: a sign it was copied.
        self.reused = reused


def _profile_key(user_id: str) -> dict[str, str]:
    return {"pk": f"USER#{user_id}", "sk": "PROFILE"}


def _username_key(username: str) -> dict[str, str]:
    return {"pk": f"USERNAME#{username}", "sk": "USERNAME"}


def _google_key(sub: str) -> dict[str, str]:
    return {"pk": f"GOOGLE#{sub}", "sk": "GOOGLE"}


def _refresh_token_key(user_id: str, token_hash: str) -> dict[str, str]:
    return {"pk": f"USER#{user_id}", "sk": f"REFRESH#{token_hash}"}


def _refresh_token_item(user_id: str, token_hash: str, expires_at: datetime) -> dict[str, Any]:
    # `ttl` (epoch seconds) lets DynamoDB delete expired tokens for free.
    return {
        **_refresh_token_key(user_id, token_hash),
        "expiresAt": iso_timestamp(expires_at),
        "ttl": int(expires_at.timestamp()),
    }


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

    def get_by_id(self, user_id: str) -> User | None:
        item = self._table.get_item(Key=_profile_key(user_id), ConsistentRead=True).get("Item")
        return _user(item) if item else None

    def is_active(self, user_id: str) -> bool:
        """False for a disabled or deleted user, whose access token may not have expired yet."""
        user = self.get_by_id(user_id)
        return user is not None and user.status == "active"

    def user_id_for(self, username: str) -> str | None:
        """The ID behind a username, from its claim item; usernames are stored lower-case."""
        item = self._table.get_item(Key=_username_key(username)).get("Item")
        return str(item["userId"]) if item else None

    def _put_with_claims(self, user: User, claims: list[dict[str, Any]], attributes: dict[str, Any]) -> None:
        """Writes the profile only if every claim is free; TransactionCanceledException means one wasn't."""
        name = self._table.name
        # The resource's own client: it takes plain values, as the Table does, not DynamoDB's typed ones.
        self._table.meta.client.transact_write_items(
            TransactItems=[
                *[
                    {"Put": {"TableName": name, "Item": claim, "ConditionExpression": "attribute_not_exists(pk)"}}
                    for claim in claims
                ],
                {"Put": {"TableName": name, "Item": {**_profile_key(user.id), **user.as_json(), **attributes}}},
            ]
        )

    def create(
        self, *, username: str, password_hash: str, role: Role, status: UserStatus, now: datetime, email: str | None
    ) -> User:
        """Creates the user and claims the username in one transaction, so two users can never share a name."""
        user = User(
            id=str(uuid.uuid4()),
            username=username,
            role=role,
            status=status,
            created_at=iso_timestamp(now),
            email=email,
        )
        try:
            self._put_with_claims(
                user, [{**_username_key(username), "userId": user.id}], {"passwordHash": password_hash}
            )
        except self._table.meta.client.exceptions.TransactionCanceledException:
            raise UsernameTakenError(username) from None
        return user

    def find_by_google_sub(self, sub: str) -> User | None:
        claim = self._table.get_item(Key=_google_key(sub), ConsistentRead=True).get("Item")
        return self.get_by_id(str(claim["userId"])) if claim else None

    def create_google_user(self, *, sub: str, username: str, email: str, now: datetime) -> User:
        """
        A pending customer with no password, who claims the Google account as well as the username, so one Google
        account can never have two users. If a second sign-in got there first, returns that user. Raises
        UsernameTakenError if the username belongs to someone else.
        """
        user = User(
            id=str(uuid.uuid4()),
            username=username,
            role="customer",
            status="pending",
            created_at=iso_timestamp(now),
            email=email,
        )
        claims = [{**_username_key(username), "userId": user.id}, {**_google_key(sub), "userId": user.id}]
        try:
            self._put_with_claims(user, claims, {"authProvider": "google"})
        except self._table.meta.client.exceptions.TransactionCanceledException:
            existing = self.find_by_google_sub(sub)
            if not existing:
                raise UsernameTakenError(username) from None
            return existing
        return user

    def find_by_username(self, username: str) -> StoredCredentials | None:
        claim = self._table.get_item(Key=_username_key(username), ConsistentRead=True).get("Item")
        if not claim:
            return None
        item = self._table.get_item(Key=_profile_key(str(claim["userId"])), ConsistentRead=True).get("Item")
        if not item:
            return None
        locked_until = item.get("lockedUntil")
        password_hash = item.get("passwordHash")
        return StoredCredentials(
            user=_user(item),
            password_hash=str(password_hash) if password_hash else None,
            failed_logins=int(str(item.get("failedLogins", 0))),
            locked_until=datetime.fromisoformat(str(locked_until)) if locked_until else None,
        )

    def record_failed_login(self, user_id: str, now: datetime) -> None:
        """Counts a failed login; the fifth in a row locks the user for 15 minutes and starts the count again."""
        res = self._table.update_item(
            Key=_profile_key(user_id),
            UpdateExpression="ADD failedLogins :one",
            ExpressionAttributeValues={":one": 1},
            ReturnValues="UPDATED_NEW",
        )
        if int(str(res.get("Attributes", {}).get("failedLogins", 0))) >= MAX_FAILED_LOGINS:
            self._table.update_item(
                Key=_profile_key(user_id),
                UpdateExpression="SET failedLogins = :zero, lockedUntil = :until",
                ExpressionAttributeValues={":zero": 0, ":until": iso_timestamp(now + LOCKOUT)},
            )

    def clear_failed_logins(self, user_id: str) -> None:
        self._table.update_item(
            Key=_profile_key(user_id),
            UpdateExpression="SET failedLogins = :zero REMOVE lockedUntil",
            ExpressionAttributeValues={":zero": 0},
        )

    def usernames(self, user_ids: list[str]) -> dict[str, str]:
        """Usernames by user ID; IDs with no profile are left out. BatchGet takes at most 100 keys a call."""
        found: dict[str, str] = {}
        unique = list(dict.fromkeys(user_ids))
        name = self._table.name
        for start in range(0, len(unique), 100):
            keys: list[dict[str, Any]] = [_profile_key(user_id) for user_id in unique[start : start + 100]]
            while keys:
                res = self._table.meta.client.batch_get_item(
                    RequestItems={name: {"Keys": keys, "ProjectionExpression": "id, username"}}
                )
                found.update((str(item["id"]), str(item["username"])) for item in res["Responses"].get(name, []))
                unprocessed = res.get("UnprocessedKeys", {})
                keys = list(unprocessed[name]["Keys"]) if name in unprocessed else []
        return found

    def set_status(self, user_id: str, status: UserStatus) -> User:
        """Raises UserNotFoundError rather than creating a profile for an unknown ID."""
        try:
            res = self._table.update_item(
                Key=_profile_key(user_id),
                UpdateExpression="SET #status = :status",
                ConditionExpression=Attr("pk").exists(),
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": status},
                ReturnValues="ALL_NEW",
            )
        except self._table.meta.client.exceptions.ConditionalCheckFailedException:
            raise UserNotFoundError(user_id) from None
        return _user(res["Attributes"])

    def save_refresh_token(self, user_id: str, token_hash: str, expires_at: datetime) -> None:
        self._table.put_item(Item=_refresh_token_item(user_id, token_hash, expires_at))

    def rotate_refresh_token(
        self, user_id: str, old_hash: str, new_hash: str, *, now: datetime, expires_at: datetime
    ) -> None:
        """
        Marks the old token as replaced and stores the new one. Raises InvalidRefreshTokenError if the old
        token is unknown, expired or already replaced.
        """
        name = self._table.name
        client = self._table.meta.client
        try:
            client.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": name,
                            "Key": _refresh_token_key(user_id, old_hash),
                            "UpdateExpression": "SET replacedAt = :now",
                            "ConditionExpression": (
                                "attribute_exists(pk) AND attribute_not_exists(replacedAt) AND expiresAt > :now"
                            ),
                            "ExpressionAttributeValues": {":now": iso_timestamp(now)},
                        }
                    },
                    {"Put": {"TableName": name, "Item": _refresh_token_item(user_id, new_hash, expires_at)}},
                ]
            )
        except client.exceptions.TransactionCanceledException:
            old = self._table.get_item(Key=_refresh_token_key(user_id, old_hash), ConsistentRead=True).get("Item")
            raise InvalidRefreshTokenError(reused=bool(old and old.get("replacedAt"))) from None

    def delete_refresh_token(self, user_id: str, token_hash: str) -> None:
        self._table.delete_item(Key=_refresh_token_key(user_id, token_hash))

    def delete(self, user: User) -> None:
        """
        Deletes the user and every item of theirs, which frees their username and Google account. The profile and
        claims go together, so a Google claim can never outlive its profile: find_by_google_sub would find nobody,
        and create_google_user would be refused, shutting that person out for good.
        """
        self.revoke_refresh_tokens(user.id)
        name = self._table.name
        keys = [_profile_key(user.id), _username_key(user.username), *self._google_keys(user.id)]
        self._table.meta.client.transact_write_items(
            TransactItems=[{"Delete": {"TableName": name, "Key": key}} for key in keys]
        )

    def _google_keys(self, user_id: str) -> list[dict[str, str]]:
        """
        The user's Google claims, if any. Only `sub` finds a claim and the profile doesn't hold it, so this scans,
        as listing users does; deleting a user is rare.
        """
        keys: list[dict[str, str]] = []
        scan: dict[str, Any] = {
            "FilterExpression": Attr("sk").eq("GOOGLE") & Attr("userId").eq(user_id),
            "ProjectionExpression": "pk, sk",
            "ConsistentRead": True,
        }
        while True:
            page = self._table.scan(**scan)
            keys.extend({"pk": str(item["pk"]), "sk": str(item["sk"])} for item in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                return keys
            scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def revoke_refresh_tokens(self, user_id: str) -> None:
        """Deletes every refresh token the user has, logging them out everywhere."""
        query: dict[str, Any] = {
            "KeyConditionExpression": Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with("REFRESH#"),
            "ProjectionExpression": "pk, sk",
        }
        with self._table.batch_writer() as batch:
            while True:
                page = self._table.query(**query)
                for key in page.get("Items", []):
                    batch.delete_item(Key=key)
                if "LastEvaluatedKey" not in page:
                    break
                query["ExclusiveStartKey"] = page["LastEvaluatedKey"]
