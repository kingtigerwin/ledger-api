import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast

import mcp_types as types
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server
from pydantic import TypeAdapter

from ledger_api.auth.users_store import UsersStore
from ledger_api.data.ledger import Ledger
from ledger_api.data.schemas import TRANSACTION_FIELDS, TransactionFields
from ledger_api.data.ulid import new_ulid
from ledger_api.http import AuthContext, Event, Handler, Response, auth_context, with_errors
from ledger_api.mcp.transport import serve

type Scope = Literal["transactions:read", "transactions:write", "admin:read"]

_WRITE = types.ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)


@dataclass(frozen=True)
class _Tool[T]:
    name: str
    scope: Scope
    title: str
    description: str
    schema: TypeAdapter[T]
    annotations: types.ToolAnnotations
    run: Callable[[AuthContext, T], Any]

    def allowed(self, caller: AuthContext) -> bool:
        """Needs the scope; admin tools also need the admin role, as `require_admin` does."""
        return self.scope in caller.scope.split(" ") and (not self.scope.startswith("admin:") or caller.role == "admin")

    def listing(self) -> types.Tool:
        return types.Tool(
            name=self.name,
            title=self.title,
            description=self.description,
            input_schema=_inline(self.schema.json_schema()),
            annotations=self.annotations,
        )


def _inline(schema: dict[str, Any]) -> dict[str, Any]:
    """pydantic puts named types under `$defs`; MCP clients read a tool's schema more reliably with them in place."""
    defs: dict[str, Any] = schema.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            fields = cast(dict[str, Any], node)
            if "$ref" in fields:
                return resolve(defs[str(fields["$ref"]).removeprefix("#/$defs/")])
            return {key: resolve(value) for key, value in fields.items()}
        if isinstance(node, list):
            return [resolve(item) for item in cast(list[Any], node)]
        return node

    return {key: resolve(value) for key, value in schema.items() if key not in ("title", "description")}


def _text(text: str, *, is_error: bool = False) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=is_error)


def create_mcp_handler(*, ledger: Ledger, users: UsersStore, now: Callable[[], datetime]) -> Handler:
    """
    MCP over Streamable HTTP, stateless: each request gets a fresh server holding only the caller's
    tools. The tools mirror the REST Transactions routes (and, for the admin, `GET /admin/transactions`)
    and call the same ledger, so rules and error messages are shared.
    """

    def create_transaction(caller: AuthContext, fields: TransactionFields) -> Any:
        transaction, _ = ledger.record(caller.user_id, {**fields, "id": new_ulid(now()), "currency": "AUD"})
        return transaction

    tools: list[_Tool[Any]] = [
        _Tool(
            name="create_transaction",
            scope="transactions:write",
            title="Record an expense",
            description=(
                "Records one expense for the signed-in customer, in Australian dollars. "
                "amountCents is the amount in cents ($30 is 3000). date is the day it happened, YYYY-MM-DD, "
                "in the customer's time zone. Pick the closest category, or other. "
                "Every call records a new transaction, so call it once per expense. Returns the stored transaction."
            ),
            schema=TRANSACTION_FIELDS,
            annotations=_WRITE.model_copy(update={"idempotent_hint": False}),
            run=create_transaction,
        ),
    ]

    def server_for(caller: AuthContext) -> Server[Any]:
        offered = [tool for tool in tools if tool.allowed(caller)]

        async def list_tools(
            ctx: ServerRequestContext[Any], params: types.PaginatedRequestParams | None
        ) -> types.ListToolsResult:
            return types.ListToolsResult(tools=[tool.listing() for tool in offered])

        async def call_tool(
            ctx: ServerRequestContext[Any], params: types.CallToolRequestParams
        ) -> types.CallToolResult:
            tool = next(tool for tool in offered if tool.name == params.name)
            result = tool.run(caller, tool.schema.validate_python(params.arguments or {}))
            return _text(json.dumps(result, ensure_ascii=False))

        return Server("ledger-api", version="1.0.0", on_list_tools=list_tools, on_call_tool=call_tool)

    def handle(event: Event) -> Response:
        return serve(server_for(auth_context(event)), event)

    return with_errors(handle)
