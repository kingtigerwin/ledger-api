from ledger_api.docs.openapi import build_openapi
from ledger_api.http import Event, Handler, Response, json_response


def create_docs_handler() -> Handler:
    """Serves the OpenAPI document; it never changes while the code doesn't, so it's built once per cold start."""
    spec = build_openapi()

    def handler(event: Event) -> Response:
        return json_response(200, spec)

    return handler
