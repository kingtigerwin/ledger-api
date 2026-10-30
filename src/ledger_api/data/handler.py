from ledger_api.data.ledger import Ledger
from ledger_api.data.schemas import LIST_QUERY, NEW_TRANSACTION, SUMMARY_QUERY, TRANSACTION_EDIT
from ledger_api.http import (
    ApiError,
    Event,
    Handler,
    Response,
    auth_context,
    json_response,
    no_content,
    parse_body,
    parse_query,
    with_errors,
)


def _require_scope(event: Event, scope: str) -> str:
    """The caller's user ID, provided their token carries the scope this route needs."""
    ctx = auth_context(event)
    if scope not in ctx.scope.split(" "):
        raise ApiError(403, "forbidden", f"Requires the {scope} scope")
    return ctx.user_id


def _param(event: Event, name: str) -> str:
    params: dict[str, str] = event.get("pathParameters") or {}
    return params.get(name, "")


def create_data_handler(*, ledger: Ledger) -> Handler:
    """The Transactions routes, and the admin's view, edit and delete of any customer's transactions."""

    def handler(event: Event) -> Response:
        match event.get("routeKey"):
            case "POST /api/v1/transactions":
                user_id = _require_scope(event, "transactions:write")
                # A retry returns what was stored.
                transaction, created = ledger.record(user_id, parse_body(event, NEW_TRANSACTION))
                return json_response(201 if created else 200, transaction)
            case "GET /api/v1/transactions/{id}":
                user_id = _require_scope(event, "transactions:read")
                return json_response(200, ledger.get(user_id, _param(event, "id")))
            case "PATCH /api/v1/transactions/{id}":
                user_id = _require_scope(event, "transactions:write")
                return json_response(
                    200, ledger.update(user_id, _param(event, "id"), parse_body(event, TRANSACTION_EDIT))
                )
            case "DELETE /api/v1/transactions/{id}":
                user_id = _require_scope(event, "transactions:write")
                ledger.remove(user_id, _param(event, "id"))
                return no_content()
            case "GET /api/v1/transactions":
                user_id = _require_scope(event, "transactions:read")
                return json_response(200, ledger.list(user_id, parse_query(event, LIST_QUERY)))
            case "GET /api/v1/transactions/summary":
                user_id = _require_scope(event, "transactions:read")
                return json_response(200, ledger.summary(user_id, parse_query(event, SUMMARY_QUERY)["month"]))
            case route:
                raise ApiError(404, "route_not_found", f"No route for {route}")

    return with_errors(handler)
