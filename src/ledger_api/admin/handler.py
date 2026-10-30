from ledger_api.auth.users_store import UsersStore
from ledger_api.http import ApiError, Event, Handler, Response, with_errors


def create_admin_handler(*, users: UsersStore) -> Handler:
    """The admin's user routes: list users by status, enable and disable them."""

    def handler(event: Event) -> Response:
        raise ApiError(404, "route_not_found", f"No route for {event.get('routeKey')}")

    return with_errors(handler)
