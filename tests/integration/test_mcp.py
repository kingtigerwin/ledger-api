import itertools
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest

from ledger_api.auth.users_store import UsersStore
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.http import Handler
from ledger_api.mcp.handler import create_mcp_handler

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


def customer(user_id: str) -> dict[str, str]:
    return {"userId": user_id, "role": "customer", "scope": "transactions:read transactions:write"}


@pytest.fixture
def ledger(data_table: "Table") -> Ledger:
    return Ledger(TransactionsStore(data_table), cursor_secret="test-cursor-secret", now=lambda: datetime.now(UTC))


@pytest.fixture
def mcp(ledger: Ledger, table: "Table") -> Handler:
    return create_mcp_handler(ledger=ledger, users=UsersStore(table), now=lambda: datetime.now(UTC))


_ids = itertools.count(1)

# The HTTP status and the JSON body.
type Reply = tuple[int, Any]


def rpc(mcp: Handler, auth: dict[str, str] | None, method: str, params: dict[str, Any] | None = None) -> Reply:
    """Sends one JSON-RPC request to POST /api/mcp, as an MCP client over Streamable HTTP would."""
    res = mcp(
        {
            "routeKey": "POST /api/mcp",
            "rawPath": "/api/mcp",
            "headers": {"content-type": "application/json", "accept": "application/json, text/event-stream"},
            "requestContext": {"authorizer": {"lambda": auth}} if auth else {},
            "body": json.dumps({"jsonrpc": "2.0", "id": next(_ids), "method": method, "params": params or {}}),
            "isBase64Encoded": False,
        }
    )
    return res["statusCode"], json.loads(res["body"]) if res.get("body") else None


class TestPostMcp:
    class TestGivenASignedInCustomerStartingASession:
        def test_introduces_itself_as_ledger_api_and_offers_tools(self, mcp: Handler) -> None:
            status, body = rpc(
                mcp,
                customer("mcp-init"),
                "initialize",
                {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}},
            )

            assert status == 200
            assert body["result"]["serverInfo"]["name"] == "ledger-api"
            assert "tools" in body["result"]["capabilities"]

    class TestGivenNoAuthorizerContext:
        def test_refuses_with_401(self, mcp: Handler) -> None:
            status, _ = rpc(mcp, None, "tools/list")

            assert status == 401
