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
from ledger_api.data.schemas import LIST_QUERY, SUMMARY_QUERY, TRANSACTION_FIELDS, TransactionFields
from ledger_api.data.ulid import new_ulid
from ledger_api.http import ApiError, AuthContext, Event, Handler, Response, auth_context, with_errors
from ledger_api.mcp.schemas import BY_ID, TRANSACTION_CHANGE
from ledger_api.mcp.transport import serve

type Scope = Literal["transactions:read", "transactions:write", "admin:read"]

_READ = types.ToolAnnotations(read_only_hint=True, open_world_hint=False)
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


def _not_yet(caller: AuthContext, input: Any) -> Any:
    raise NotImplementedError


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
        _Tool(
            name="get_transaction",
            scope="transactions:read",
            title="Get a transaction",
            description="One of the signed-in customer's transactions, by id, including its current version.",
            schema=BY_ID,
            annotations=_READ,
            run=lambda caller, input: ledger.get(caller.user_id, input["id"]),
        ),
        _Tool(
            name="list_transactions",
            scope="transactions:read",
            title="List transactions",
            description=(
                "The signed-in customer's transactions, newest first, as { items, nextCursor }. "
                "Optional filters: from and to (YYYY-MM-DD, inclusive), category. limit is 1-100 (default 50). "
                "For the next page, call again with the same filters and cursor set to nextCursor; "
                "it is null on the last page."
            ),
            schema=LIST_QUERY,
            annotations=_READ,
            run=lambda caller, query: ledger.list(caller.user_id, query),
        ),
        _Tool(
            name="get_monthly_summary",
            scope="transactions:read",
            title="Monthly spending summary",
            description=(
                "The signed-in customer's total spending for a month (YYYY-MM), in cents, "
                "and by category, largest first."
            ),
            schema=SUMMARY_QUERY,
            annotations=_READ,
            run=_not_yet,
        ),
        _Tool(
            name="update_transaction",
            scope="transactions:write",
            title="Edit a transaction",
            description=(
                "Changes some fields of one of the signed-in customer's transactions. Send only the fields to "
                "change, plus the version from your latest read (get_transaction or list_transactions). "
                "If someone changed it since, the call fails: read it again and retry. "
                "Returns the updated transaction."
            ),
            schema=TRANSACTION_CHANGE,
            annotations=_WRITE.model_copy(update={"idempotent_hint": False}),
            run=_not_yet,
        ),
        _Tool(
            name="delete_transaction",
            scope="transactions:write",
            title="Delete a transaction",
            description="Permanently deletes one of the signed-in customer's transactions, by id.",
            schema=BY_ID,
            annotations=_WRITE.model_copy(update={"destructive_hint": True, "idempotent_hint": True}),
            run=_not_yet,
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
            try:
                result = tool.run(caller, tool.schema.validate_python(params.arguments or {}))
            except ApiError as err:
                return _text(err.message, is_error=True)
            return _text(json.dumps(result, ensure_ascii=False))

        return Server("ledger-api", version="1.0.0", on_list_tools=list_tools, on_call_tool=call_tool)

    def handle(event: Event) -> Response:
        return serve(server_for(auth_context(event)), event)

    return with_errors(handle)
