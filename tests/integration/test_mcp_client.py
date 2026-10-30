"""The MCP endpoint as ledger-agent sees it: the SDK's own client, over Streamable HTTP, into the Lambda handler."""

import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import httpx2
import pytest
from mcp import ClientSession, types
from mcp.client.streamable_http import streamable_http_client

from ledger_api.auth.users_store import UsersStore
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.http import Handler
from ledger_api.mcp.handler import create_mcp_handler

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

# The SDK's client is async; anyio's pytest plugin (installed with the SDK) runs these on asyncio.
pytestmark = pytest.mark.anyio

URL = "https://ledger.example/api/mcp"
TOKEN = "customer-token"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def mcp(data_table: "Table", table: "Table") -> Handler:
    ledger = Ledger(TransactionsStore(data_table), cursor_secret="test-cursor-secret", now=lambda: datetime.now(UTC))
    return create_mcp_handler(ledger=ledger, users=UsersStore(table), now=lambda: datetime.now(UTC))


def through_api_gateway(mcp: Handler) -> httpx2.MockTransport:
    """Each request as API Gateway would hand it to the Lambda, behind an authorizer that knows one token."""

    async def handle(request: httpx2.Request) -> httpx2.Response:
        authorized = request.headers.get("authorization") == f"Bearer {TOKEN}"
        if not authorized:
            return httpx2.Response(401, json={"message": "Unauthorized"})
        event = {
            "routeKey": "POST /api/mcp",
            "rawPath": request.url.path,
            "headers": dict(request.headers),
            "requestContext": {
                "authorizer": {
                    "lambda": {
                        "userId": "agent-user",
                        "role": "customer",
                        "scope": "transactions:read transactions:write",
                    }
                }
            },
            "body": request.content.decode(),
            "isBase64Encoded": False,
        }
        # The handler runs its own event loop, as it does in Lambda; keep it off the client's.
        res = await asyncio.to_thread(mcp, event)
        return httpx2.Response(res["statusCode"], headers=res.get("headers"), content=res.get("body", ""))

    return httpx2.MockTransport(handle)


@asynccontextmanager
async def session(mcp: Handler) -> AsyncGenerator[ClientSession]:
    """Connected the way ledger-agent's mcp_ledger.connect does: stateless, so no DELETE at the end."""
    client = httpx2.AsyncClient(headers={"authorization": f"Bearer {TOKEN}"}, transport=through_api_gateway(mcp))
    async with (
        client,
        streamable_http_client(URL, http_client=client, terminate_on_close=False) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        yield session


class TestGivenTheSdksClientWithACustomersToken:
    async def test_it_lists_the_customers_tools(self, mcp: Handler) -> None:
        async with session(mcp) as client:
            listed = await client.list_tools()

        assert "create_transaction" in {tool.name for tool in listed.tools}

    async def test_it_records_an_expense_and_reads_it_back(self, mcp: Handler) -> None:
        cake = {"date": "2026-10-27", "category": "groceries", "item": "cake", "amountCents": 3000}
        async with session(mcp) as client:
            created = await client.call_tool("create_transaction", cake)
            stored = json.loads(text(created))
            listed = await client.call_tool("list_transactions", {})

        assert not created.is_error
        assert json.loads(text(listed))["items"] == [stored]

    async def test_a_rejected_call_comes_back_as_a_tool_error_with_its_message(self, mcp: Handler) -> None:
        async with session(mcp) as client:
            result = await client.call_tool("get_transaction", {"id": "01J0000000000000000000000A"})

        assert result.is_error
        assert text(result) == "No such transaction"


def text(result: types.CallToolResult) -> str:
    return "".join(block.text for block in result.content if isinstance(block, types.TextContent))
