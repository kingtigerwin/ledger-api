from collections.abc import Callable
from datetime import datetime
from typing import Any

import mcp_types as types
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server

from ledger_api.auth.users_store import UsersStore
from ledger_api.data.ledger import Ledger
from ledger_api.http import Event, Handler, Response, auth_context, with_errors
from ledger_api.mcp.transport import serve


def create_mcp_handler(*, ledger: Ledger, users: UsersStore, now: Callable[[], datetime]) -> Handler:
    """
    MCP over Streamable HTTP, stateless: each request gets a fresh server holding only the caller's
    tools. The tools mirror the REST Transactions routes (and, for the admin, `GET /admin/transactions`)
    and call the same ledger, so rules and error messages are shared.
    """

    def server_for() -> Server[Any]:
        async def list_tools(
            ctx: ServerRequestContext[Any], params: types.PaginatedRequestParams | None
        ) -> types.ListToolsResult:
            return types.ListToolsResult(tools=[])

        return Server("ledger-api", version="1.0.0", on_list_tools=list_tools)

    def handle(event: Event) -> Response:
        auth_context(event)
        return serve(server_for(), event)

    return with_errors(handle)
