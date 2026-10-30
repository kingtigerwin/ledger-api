import itertools
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest

from ledger_api.auth.users_store import UsersStore
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.data.ulid import is_ulid
from ledger_api.http import Handler
from ledger_api.mcp.handler import create_mcp_handler

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


def customer(user_id: str) -> dict[str, str]:
    return {"userId": user_id, "role": "customer", "scope": "transactions:read transactions:write"}


# "today I went to woolworth and bought 30 dollars for cake", as Claude would fill the tool in.
CAKE = {"date": "2026-10-27", "merchant": "Woolworths", "category": "groceries", "item": "cake", "amountCents": 3000}


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


def call_tool(mcp: Handler, auth: dict[str, str], name: str, arguments: dict[str, Any]) -> Reply:
    return rpc(mcp, auth, "tools/call", {"name": name, "arguments": arguments})


def payload(reply: Reply) -> Any:
    """A successful tool call's JSON payload."""
    _, body = reply
    assert not body["result"]["isError"], body
    return json.loads(body["result"]["content"][0]["text"])


def own(ledger: Ledger, user_id: str) -> list[Any]:
    """What the customer would see over REST."""
    return ledger.list(user_id, {"from": "2026-10-01"})["items"]


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

    class TestGivenACustomerWhoCanRecordTransactions:
        def test_lists_create_transaction_asking_only_for_what_the_customer_said(self, mcp: Handler) -> None:
            _, body = rpc(mcp, customer("mcp-list"), "tools/list")

            tool = next(t for t in body["result"]["tools"] if t["name"] == "create_transaction")
            schema = tool["inputSchema"]
            assert {"date", "category", "item", "amountCents"} <= set(schema["required"])
            assert "groceries" in schema["properties"]["category"]["enum"]
            assert schema["properties"]["date"]["format"] == "date"
            assert "id" not in schema["properties"]
            assert "currency" not in schema["properties"]

        def test_records_the_expense_against_that_customer_in_aud_with_a_new_ulid(
            self, mcp: Handler, ledger: Ledger
        ) -> None:
            reply = call_tool(mcp, customer("mcp-cake"), "create_transaction", CAKE)

            assert reply[0] == 200
            stored = payload(reply)
            assert stored == stored | CAKE | {"currency": "AUD", "version": 1}
            assert is_ulid(stored["id"])
            assert own(ledger, "mcp-cake") == [stored]

        def test_keeps_the_expense_out_of_other_customers_ledgers(self, mcp: Handler, ledger: Ledger) -> None:
            call_tool(mcp, customer("mcp-owner"), "create_transaction", CAKE)

            assert own(ledger, "mcp-someone-else") == []

        def test_records_two_identical_expenses_as_two_transactions(self, mcp: Handler, ledger: Ledger) -> None:
            call_tool(mcp, customer("mcp-twice"), "create_transaction", CAKE)
            call_tool(mcp, customer("mcp-twice"), "create_transaction", CAKE)

            assert len(own(ledger, "mcp-twice")) == 2

    class TestGivenNoAuthorizerContext:
        def test_refuses_with_401(self, mcp: Handler) -> None:
            status, _ = rpc(mcp, None, "tools/list")

            assert status == 401
