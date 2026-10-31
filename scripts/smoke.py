"""
Post-deploy smoke test against the live API. Usage:
  API_URL=https://dxxxx.cloudfront.net SMOKE_TEST_PASSWORD=... uv run scripts/smoke.py
Reuses one user, `smoke-test` (there's no delete-user endpoint); the admin approves it on the
first run. The transactions it creates are deleted again.
"""

import itertools
import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any

import httpx2

from ledger_api.config import ADMIN_PASSWORD_PARAM, ADMIN_USERNAME
from ledger_api.data.ulid import new_ulid

if TYPE_CHECKING:
    from mypy_boto3_ssm import SSMClient

SMOKE_USER = "smoke-test"
TRANSACTION_TOOLS = [
    "create_transaction",
    "get_transaction",
    "list_transactions",
    "get_monthly_summary",
    "update_transaction",
    "delete_transaction",
]

# method, URL, headers, body -> status, body: real HTTP in CI, the handlers in process in the tests.
type Send = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


class SmokeFailedError(Exception):
    pass


@dataclass(frozen=True)
class Reply:
    status: int
    body: Any


def http_send(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
    """Any status is an answer here; the step decides whether it's the right one."""
    res = httpx2.request(method, url, headers=headers, content=body, timeout=30)
    return res.status_code, res.content


def run(
    *,
    base_url: str,
    send: Send,
    smoke_password: str,
    admin_password: Callable[[], str],
    today: date,
    say: Callable[[str], None] = print,
) -> None:
    """Raises SmokeFailedError at the first step that doesn't answer as it should."""
    base = base_url.rstrip("/")
    rpc_ids = itertools.count(1)

    def call(method: str, url: str, token: str | None, payload: Any, accept: str | None = None) -> Reply:
        headers = {"content-type": "application/json"}
        if accept:
            headers["accept"] = accept
        if token:
            headers["authorization"] = f"Bearer {token}"
        status, raw = send(method, url, headers, None if payload is None else json.dumps(payload).encode())
        return Reply(status, json.loads(raw) if raw else None)

    def api(method: str, path: str, *, token: str | None = None, body: Any = None) -> Reply:
        return call(method, f"{base}/api/v1{path}", token, body)

    def mcp(token: str | None, method: str, params: dict[str, Any] | None = None) -> Reply:
        rpc = {"jsonrpc": "2.0", "id": next(rpc_ids), "method": method, "params": params or {}}
        return call("POST", f"{base}/api/mcp", token, rpc, accept="application/json, text/event-stream")

    def expect_status(step: str, res: Reply, *allowed: int) -> None:
        if res.status not in allowed:
            expected = " or ".join(map(str, allowed))
            raise SmokeFailedError(f"{step}: expected {expected}, got {res.status} {json.dumps(res.body)}")
        say(f"ok  {step} ({res.status})")

    def expect_mcp(step: str, res: Reply, ok: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
        """An MCP call answers 200 even when it fails; the JSON-RPC result says whether it worked."""
        try:
            result: dict[str, Any] | None = res.body["result"] if res.status == 200 else None
        except (TypeError, KeyError):
            result = None
        if not result or not ok(result):
            raise SmokeFailedError(f"{step}: got {res.status} {json.dumps(res.body)}")
        say(f"ok  {step}")
        return result

    def worked(result: dict[str, Any]) -> bool:
        return not result.get("isError")

    def text(result: dict[str, Any]) -> Any:
        return json.loads(result["content"][0]["text"])

    def login(username: str, password: str) -> Reply:
        return api("POST", "/auth/login", body={"username": username, "password": password, "refreshTokenIn": "body"})

    # SES's mailbox simulator: accepts the emails without delivering them, and isn't charged.
    registration = {"username": SMOKE_USER, "password": smoke_password, "email": "success@simulator.amazonses.com"}
    expect_status("register smoke-test (or already exists)", api("POST", "/auth/register", body=registration), 201, 409)

    session = login(SMOKE_USER, smoke_password)
    if session.status == 403:
        # First run: approve the smoke user as the admin.
        admin = login(ADMIN_USERNAME, admin_password())
        expect_status("admin login", admin, 200)
        admin_token = admin.body["accessToken"]
        pending = api("GET", "/admin/users?status=pending", token=admin_token)
        expect_status("list pending users", pending, 200)
        smoke_user = next(user for user in pending.body["items"] if user["username"] == SMOKE_USER)
        expect_status(
            "enable smoke-test", api("POST", f"/admin/users/{smoke_user['id']}/enable", token=admin_token), 200
        )
        session = login(SMOKE_USER, smoke_password)
    expect_status("smoke-test login", session, 200)
    token = session.body["accessToken"]

    month = today.isoformat()[:7]
    txn = {
        "id": new_ulid(),
        "date": today.isoformat(),
        "category": "other",
        "item": "smoke test",
        "amountCents": 1,
        "currency": "AUD",
    }
    expect_status("create transaction", api("POST", "/transactions", token=token, body=txn), 201)
    expect_status("repeat create returns the original", api("POST", "/transactions", token=token, body=txn), 200)
    expect_status("read transaction", api("GET", f"/transactions/{txn['id']}", token=token), 200)
    expect_status("list transactions", api("GET", "/transactions?category=other", token=token), 200)
    expect_status("monthly summary", api("GET", f"/transactions/summary?month={month}", token=token), 200)
    expect_status("unauthenticated request is refused", api("GET", "/transactions"), 401)
    expect_status("delete transaction", api("DELETE", f"/transactions/{txn['id']}", token=token), 204)

    # The agent's path: the same customer token, over MCP.
    def tool(name: str, arguments: dict[str, Any]) -> Reply:
        return mcp(token, "tools/call", {"name": name, "arguments": arguments})

    expect_mcp(
        "MCP lists the Transactions tools",
        mcp(token, "tools/list"),
        lambda result: set(TRANSACTION_TOOLS) <= {t["name"] for t in result["tools"]},
    )
    recorded = expect_mcp(
        "MCP records a transaction",
        tool(
            "create_transaction",
            {"date": txn["date"], "category": "other", "item": "smoke test (mcp)", "amountCents": 1},
        ),
        worked,
    )
    mcp_id = text(recorded)["id"]
    expect_status("read the MCP transaction over REST", api("GET", f"/transactions/{mcp_id}", token=token), 200)
    expect_mcp("MCP gets it", tool("get_transaction", {"id": mcp_id}), worked)
    expect_mcp(
        "MCP lists it",
        tool("list_transactions", {"category": "other"}),
        lambda result: worked(result) and any(t["id"] == mcp_id for t in text(result)["items"]),
    )
    expect_mcp("MCP monthly summary", tool("get_monthly_summary", {"month": month}), worked)
    expect_mcp(
        "MCP updates it",
        tool("update_transaction", {"id": mcp_id, "version": 1, "note": "edited"}),
        lambda result: worked(result) and text(result)["version"] == 2,
    )
    expect_mcp("MCP deletes it", tool("delete_transaction", {"id": mcp_id}), worked)
    expect_status("the MCP delete is seen over REST", api("GET", f"/transactions/{mcp_id}", token=token), 404)
    expect_status("unauthenticated MCP request is refused", mcp(None, "tools/list"), 401)

    logout = api("POST", "/auth/logout", body={"refreshToken": session.body["refreshToken"]})
    expect_status("logout", logout, 204)
    expect_status("Google sign-in redirects", api("GET", "/auth/google/start"), 302)
    spec_status, _ = send("GET", f"{base}/api/openapi.json", {}, None)
    expect_status("OpenAPI spec", Reply(spec_status, None), 200)
    say("smoke test passed")


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SmokeFailedError(f"Set {name}")
    return value


def main() -> int:
    import boto3

    def admin_password() -> str:
        # Only some services' stubs are installed, so boto3.client's overloads for the rest are unknown to pyright.
        ssm: SSMClient = boto3.client("ssm")  # pyright: ignore[reportUnknownMemberType]
        return ssm.get_parameter(Name=ADMIN_PASSWORD_PARAM, WithDecryption=True)["Parameter"].get("Value", "")

    try:
        run(
            base_url=_required("API_URL"),
            send=http_send,
            smoke_password=_required("SMOKE_TEST_PASSWORD"),
            admin_password=admin_password,
            today=datetime.now(UTC).date(),
        )
    except SmokeFailedError as err:
        print(err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
