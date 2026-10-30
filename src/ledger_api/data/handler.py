from ledger_api.data.ledger import Ledger
from ledger_api.http import ApiError, Event, Handler, Response, with_errors


def create_data_handler(*, ledger: Ledger) -> Handler:
    """The Transactions routes, and the admin's view, edit and delete of any customer's transactions."""

    def handler(event: Event) -> Response:
        match event.get("routeKey"):
            case route:
                raise ApiError(404, "route_not_found", f"No route for {route}")

    return with_errors(handler)
