from typing import cast

from ledger_api.auth.users_store import UsersStore, UserStatus
from ledger_api.http import ApiError, Event, Handler, Response, json_response, require_admin, with_errors


def _status_query(event: Event) -> UserStatus:
    query: dict[str, str] = event.get("queryStringParameters") or {}
    return cast(UserStatus, query.get("status"))


def create_admin_handler(*, users: UsersStore) -> Handler:
    """The admin's user routes: list users by status, enable and disable them."""

    def handler(event: Event) -> Response:
        match event.get("routeKey"):
            case "GET /api/v1/admin/users":
                require_admin(event, "admin:read")
                items = [user.as_json() for user in users.list_by_status(_status_query(event))]
                return json_response(200, {"items": items, "nextCursor": None})
            case _:
                pass
        raise ApiError(404, "route_not_found", f"No route for {event.get('routeKey')}")

    return with_errors(handler)
