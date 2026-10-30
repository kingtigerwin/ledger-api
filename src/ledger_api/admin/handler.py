from typing import get_args

from ledger_api.auth.users_store import User, UserNotFoundError, UsersStore, UserStatus
from ledger_api.http import ApiError, Event, Handler, Response, json_response, require_admin, with_errors

STATUSES: tuple[UserStatus, ...] = get_args(UserStatus.__value__)


def _status_query(event: Event) -> UserStatus:
    """The `status` query parameter, refused in zod's issue shape (as src/admin/schemas.ts) when it isn't one."""
    query: dict[str, str] = event.get("queryStringParameters") or {}
    status = query.get("status")
    if status not in STATUSES:
        expected = "|".join(f'"{s}"' for s in STATUSES)
        issue = {
            "code": "invalid_value",
            "values": list(STATUSES),
            "path": ["status"],
            "message": f"Invalid option: expected one of {expected}",
        }
        raise ApiError(400, "validation_failed", "Query is invalid", [issue])
    return status


def _user_id(event: Event) -> str:
    params: dict[str, str] = event.get("pathParameters") or {}
    return params.get("id", "")


def create_admin_handler(*, users: UsersStore) -> Handler:
    """The admin's user routes: list users by status, enable and disable them."""

    def _set_status(event: Event, status: UserStatus) -> User:
        try:
            return users.set_status(_user_id(event), status)
        except UserNotFoundError:
            raise ApiError(404, "user_not_found", "No such user") from None

    def handler(event: Event) -> Response:
        match event.get("routeKey"):
            case "GET /api/v1/admin/users":
                require_admin(event, "admin:read")
                items = [user.as_json() for user in users.list_by_status(_status_query(event))]
                return json_response(200, {"items": items, "nextCursor": None})
            case "POST /api/v1/admin/users/{id}/enable":
                require_admin(event, "admin:write")
                return json_response(200, _set_status(event, "active").as_json())
            case "POST /api/v1/admin/users/{id}/disable":
                require_admin(event, "admin:write")
                target = users.get_by_id(_user_id(event))
                if not target:
                    raise ApiError(404, "user_not_found", "No such user")
                if target.role == "admin":
                    raise ApiError(409, "cannot_disable_admin", "Admins can't be disabled")
                user = _set_status(event, "disabled")
                # Their access token still works until it expires (at most 15 minutes); refreshing ends now.
                users.revoke_refresh_tokens(user.id)
                return json_response(200, user.as_json())
            case route:
                raise ApiError(404, "route_not_found", f"No route for {route}")

    return with_errors(handler)
