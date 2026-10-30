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


READ_ONLY = {"userId": "mcp-read-only", "role": "customer", "scope": "transactions:read"}

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


def record(mcp: Handler, auth: dict[str, str], *expenses: tuple[str, str, int]) -> None:
    """Records cake-like expenses, each as (date, category, amountCents)."""
    for date, category, amount in expenses:
        payload(
            call_tool(
                mcp, auth, "create_transaction", CAKE | {"date": date, "category": category, "amountCents": amount}
            )
        )


def payload(reply: Reply) -> Any:
    """A successful tool call's JSON payload."""
    _, body = reply
    assert not body["result"]["isError"], body
    return json.loads(body["result"]["content"][0]["text"])


def failure(reply: Reply) -> str:
    """A failed tool call's message."""
    _, body = reply
    assert body["result"]["isError"], body
    return body["result"]["content"][0]["text"]


def amounts(page: Any) -> list[int]:
    return [t["amountCents"] for t in page["items"]]


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

    class TestGivenACustomersOwnTransactions:
        READ = ("get_transaction", "list_transactions", "get_monthly_summary")
        WRITE = ("create_transaction", "update_transaction", "delete_transaction")

        def test_offers_every_transactions_endpoint_marking_reads_read_only_and_delete_destructive(
            self, mcp: Handler
        ) -> None:
            _, body = rpc(mcp, customer("mcp-tools"), "tools/list")

            tools = {tool["name"]: tool for tool in body["result"]["tools"]}
            assert sorted(tools) == sorted(self.READ + self.WRITE)
            assert all(tools[name]["annotations"]["readOnlyHint"] for name in self.READ)
            assert tools["delete_transaction"]["annotations"]["destructiveHint"] is True
            assert {"id", "version"} <= set(tools["update_transaction"]["inputSchema"]["required"])

        def test_get_transaction_returns_one_by_id(self, mcp: Handler) -> None:
            created = payload(call_tool(mcp, customer("mcp-get"), "create_transaction", CAKE))

            fetched = payload(call_tool(mcp, customer("mcp-get"), "get_transaction", {"id": created["id"]}))

            assert fetched == created

        def test_get_transaction_cant_see_another_customers_transaction(self, mcp: Handler) -> None:
            theirs = payload(call_tool(mcp, customer("mcp-get-owner"), "create_transaction", CAKE))

            message = failure(call_tool(mcp, customer("mcp-get-other"), "get_transaction", {"id": theirs["id"]}))

            assert "no such transaction" in message.lower()

        def test_list_transactions_pages_through_the_customers_own_newest_first_with_filters(
            self, mcp: Handler
        ) -> None:
            who = customer("mcp-list-own")
            record(
                mcp,
                who,
                ("2026-10-01", "groceries", 100),
                ("2026-10-02", "dining", 200),
                ("2026-10-03", "groceries", 300),
            )

            first = payload(call_tool(mcp, who, "list_transactions", {"limit": 2}))
            second = payload(call_tool(mcp, who, "list_transactions", {"limit": 2, "cursor": first["nextCursor"]}))
            groceries = payload(call_tool(mcp, who, "list_transactions", {"category": "groceries"}))

            assert amounts(first) == [300, 200]
            assert amounts(second) == [100]
            assert second["nextCursor"] is None
            assert amounts(groceries) == [300, 100]

        def test_list_transactions_refuses_a_tampered_cursor(self, mcp: Handler) -> None:
            message = failure(call_tool(mcp, customer("mcp-cursor"), "list_transactions", {"cursor": "bad.cursor"}))

            assert "cursor" in message

        def test_get_monthly_summary_totals_a_month_by_category_largest_first(self, mcp: Handler) -> None:
            who = customer("mcp-summary")
            record(
                mcp,
                who,
                ("2026-09-30", "groceries", 9999),
                ("2026-10-05", "dining", 1500),
                ("2026-10-06", "groceries", 3000),
                ("2026-10-07", "groceries", 500),
            )

            summary = payload(call_tool(mcp, who, "get_monthly_summary", {"month": "2026-10"}))

            assert summary == {
                "month": "2026-10",
                "currency": "AUD",
                "totalCents": 5000,
                "byCategory": [
                    {"category": "groceries", "totalCents": 3500},
                    {"category": "dining", "totalCents": 1500},
                ],
            }

        def test_update_transaction_applies_a_change_at_the_current_version(self, mcp: Handler, ledger: Ledger) -> None:
            who = customer("mcp-update")
            created = payload(call_tool(mcp, who, "create_transaction", CAKE))

            updated = payload(
                call_tool(
                    mcp,
                    who,
                    "update_transaction",
                    {"id": created["id"], "version": 1, "amountCents": 3500, "note": "and candles"},
                )
            )

            assert updated == created | {
                "version": 2,
                "amountCents": 3500,
                "note": "and candles",
                "updatedAt": updated["updatedAt"],
            }
            assert ledger.get("mcp-update", created["id"]) == updated

        def test_update_transaction_refuses_a_stale_version_and_keeps_the_newer_change(
            self, mcp: Handler, ledger: Ledger
        ) -> None:
            who = customer("mcp-stale")
            created = payload(call_tool(mcp, who, "create_transaction", CAKE))
            payload(call_tool(mcp, who, "update_transaction", {"id": created["id"], "version": 1, "amountCents": 3500}))

            message = failure(
                call_tool(mcp, who, "update_transaction", {"id": created["id"], "version": 1, "amountCents": 1})
            )

            assert "changed" in message
            assert ledger.get("mcp-stale", created["id"])["amountCents"] == 3500

        def test_delete_transaction_removes_it_and_a_second_delete_reports_its_gone(
            self, mcp: Handler, ledger: Ledger
        ) -> None:
            who = customer("mcp-delete")
            created = payload(call_tool(mcp, who, "create_transaction", CAKE))

            assert payload(call_tool(mcp, who, "delete_transaction", {"id": created["id"]})) == {
                "id": created["id"],
                "deleted": True,
            }
            again = failure(call_tool(mcp, who, "delete_transaction", {"id": created["id"]}))

            assert own(ledger, "mcp-delete") == []
            assert "no such transaction" in again.lower()

        def test_delete_transaction_leaves_another_customers_transaction_alone(
            self, mcp: Handler, ledger: Ledger
        ) -> None:
            theirs = payload(call_tool(mcp, customer("mcp-del-owner"), "create_transaction", CAKE))

            failure(call_tool(mcp, customer("mcp-del-other"), "delete_transaction", {"id": theirs["id"]}))

            assert ledger.get("mcp-del-owner", theirs["id"]) == theirs

    class TestGivenAnExpenseTheApiWouldReject:
        def test_reports_a_tool_error_naming_the_field_and_records_nothing(self, mcp: Handler, ledger: Ledger) -> None:
            message = failure(
                call_tool(mcp, customer("mcp-invalid"), "create_transaction", CAKE | {"category": "cake"})
            )

            assert "category" in message
            assert own(ledger, "mcp-invalid") == []

    class TestGivenATokenWithoutTheTransactionsWriteScope:
        def test_offers_only_the_read_tools(self, mcp: Handler) -> None:
            _, body = rpc(mcp, READ_ONLY, "tools/list")

            assert sorted(t["name"] for t in body["result"]["tools"]) == [
                "get_monthly_summary",
                "get_transaction",
                "list_transactions",
            ]

        @pytest.mark.parametrize(
            ("name", "arguments"),
            [
                pytest.param("create_transaction", CAKE, id="create"),
                pytest.param("update_transaction", {"id": "01J0000000000000000000000A", "version": 1}, id="update"),
                pytest.param("delete_transaction", {"id": "01J0000000000000000000000A"}, id="delete"),
            ],
        )
        def test_refuses_the_write_tools(
            self, mcp: Handler, ledger: Ledger, name: str, arguments: dict[str, Any]
        ) -> None:
            message = failure(call_tool(mcp, READ_ONLY, name, arguments))

            assert name in message
            assert own(ledger, "mcp-read-only") == []

    class TestGivenAFailureTheLedgerDidntExpect:
        def test_reports_a_generic_tool_error_and_logs_the_cause(
            self, data_table: "Table", table: "Table", capsys: pytest.CaptureFixture[str]
        ) -> None:
            class BrokenLedger(Ledger):
                def get(self, user_id: str, id: str) -> Any:
                    raise RuntimeError("table unreachable")

            broken = BrokenLedger(TransactionsStore(data_table), cursor_secret="x", now=lambda: datetime.now(UTC))
            mcp = create_mcp_handler(ledger=broken, users=UsersStore(table), now=lambda: datetime.now(UTC))

            message = failure(
                call_tool(mcp, customer("mcp-broken"), "get_transaction", {"id": "01J0000000000000000000000A"})
            )

            assert message == "Something went wrong; try again"
            logged = json.loads(capsys.readouterr().err)
            assert logged["event"] == "mcp_tool_failed"
            assert logged["tool"] == "get_transaction"
            assert logged["err"]["message"] == "table unreachable"

    class TestGivenNoAuthorizerContext:
        def test_refuses_with_401(self, mcp: Handler) -> None:
            status, _ = rpc(mcp, None, "tools/list")

            assert status == 401
