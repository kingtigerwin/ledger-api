"""
The smoke test (scripts/smoke.py), run against the whole API in process: every Lambda's handler behind
the real authorizer, routed as API Gateway routes them, on DynamoDB Local. So the smoke test itself is
tested without a deploy.
"""

import json
import re
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qsl, urlsplit

import pytest

from ledger_api.admin.handler import create_admin_handler
from ledger_api.auth.handler import create_auth_handler
from ledger_api.auth.users_store import UsersStore
from ledger_api.authorizer.handler import create_authorizer
from ledger_api.bootstrap.handler import bootstrap
from ledger_api.config import ADMIN_PASSWORD_PARAM, SIGNING_SECRET_PARAM
from ledger_api.data.handler import create_data_handler
from ledger_api.data.ledger import Ledger
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.docs.handler import create_docs_handler
from ledger_api.docs.openapi import OPERATIONS, Operation
from ledger_api.http import Handler
from ledger_api.mcp.handler import create_mcp_handler
from scripts.smoke import SmokeFailedError, run
from tests.integration.test_bootstrap import FakeParameterStore

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

BASE = "https://api.example.test"
SMOKE_PASSWORD = "smoke-test-password"

type Send = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


def api_in_process(table: "Table", data_table: "Table", parameters: FakeParameterStore) -> Send:
    """Sends each request to the handler the stack routes it to, as API Gateway (payload v2) would."""
    secret = parameters.values[SIGNING_SECRET_PARAM]

    def now() -> datetime:
        return datetime.now(UTC)

    users = UsersStore(table)
    ledger = Ledger(TransactionsStore(data_table), cursor_secret="test-cursor-secret", now=now)
    auth = create_auth_handler(users=users, signing_secret=secret, now=now)
    handlers: dict[str, Handler] = {
        "auth": auth,
        "admin": create_admin_handler(users=users),
        "data": create_data_handler(ledger=ledger),
        "mcp": create_mcp_handler(ledger=ledger, users=users, now=now),
        "docs": create_docs_handler(),
    }
    authorize = create_authorizer(signing_secret=secret, now=now)

    def area(path: str) -> str:
        if path.startswith("/api/v1/auth/"):
            return "auth"
        if path.startswith("/api/v1/admin/users") and "/transactions" not in path:
            return "admin"
        return {"/api/mcp": "mcp", "/api/openapi.json": "docs"}.get(path, "data")

    routes = [
        (op.method.upper(), re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", op.path) + "$"), op)
        for op in OPERATIONS
    ]

    def route(method: str, path: str) -> tuple[Operation, re.Match[str]] | None:
        for route_method, pattern, op in routes:
            match = pattern.match(path)
            if route_method == method and match:
                return op, match
        return None

    def send(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
        parts = urlsplit(url)
        found = route(method, parts.path)
        if not found:
            return 404, b'{"message":"Not Found"}'
        op, match = found
        lowered = {key.lower(): value for key, value in headers.items()}
        event: dict[str, Any] = {
            "routeKey": f"{method} {op.path}",
            "rawPath": parts.path,
            "headers": lowered,
            "pathParameters": match.groupdict() or None,
            "queryStringParameters": dict(parse_qsl(parts.query)) or None,
            "requestContext": {},
            "body": body.decode() if body else None,
            "isBase64Encoded": False,
        }
        if not op.public:
            verdict = authorize(event)
            if not verdict["isAuthorized"]:
                return 401, b'{"message":"Unauthorized"}'
            event["requestContext"] = {"authorizer": {"lambda": verdict["context"]}}
        res = handlers[area(parts.path)](event)
        return res["statusCode"], str(res.get("body", "")).encode()

    return send


@pytest.fixture
def parameters(table: "Table") -> FakeParameterStore:
    store = FakeParameterStore()
    bootstrap(users=UsersStore(table), parameters=store, now=lambda: datetime.now(UTC))
    return store


@pytest.fixture
def send(table: "Table", data_table: "Table", parameters: FakeParameterStore) -> Send:
    return api_in_process(table, data_table, parameters)


def smoke(send: Send, parameters: FakeParameterStore, lines: list[str]) -> None:
    run(
        base_url=BASE,
        send=send,
        smoke_password=SMOKE_PASSWORD,
        admin_password=lambda: parameters.values[ADMIN_PASSWORD_PARAM],
        today=date.today(),
        say=lines.append,
    )


class TestGivenAFreshDeployment:
    def test_it_approves_the_smoke_user_as_the_admin_and_passes(
        self, send: Send, parameters: FakeParameterStore
    ) -> None:
        lines: list[str] = []

        smoke(send, parameters, lines)

        assert "ok  register smoke-test (or already exists) (201)" in lines
        assert "ok  enable smoke-test (200)" in lines
        assert lines[-1] == "smoke test passed"

    def test_it_cleans_up_its_transactions(
        self, send: Send, parameters: FakeParameterStore, data_table: "Table"
    ) -> None:
        smoke(send, parameters, [])

        assert data_table.scan()["Items"] == []


class TestGivenItHasRunBefore:
    def test_it_logs_in_without_the_admin_and_passes(self, send: Send, parameters: FakeParameterStore) -> None:
        smoke(send, parameters, [])
        lines: list[str] = []

        def no_admin() -> str:
            raise AssertionError("the smoke user is already approved")

        run(
            base_url=BASE,
            send=send,
            smoke_password=SMOKE_PASSWORD,
            admin_password=no_admin,
            today=date.today(),
            say=lines.append,
        )

        assert "ok  register smoke-test (or already exists) (409)" in lines
        assert lines[-1] == "smoke test passed"


class TestGivenABrokenApi:
    def test_it_fails_naming_the_step_and_what_came_back(self, send: Send, parameters: FakeParameterStore) -> None:
        def no_spec(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
            if url.endswith("/api/openapi.json"):
                return 500, b'{"error":{"code":"internal_error"}}'
            return send(method, url, headers, body)

        with pytest.raises(SmokeFailedError, match=r"OpenAPI spec: expected 200, got 500"):
            smoke(no_spec, parameters, [])

    def test_it_fails_when_an_mcp_tool_reports_an_error(self, send: Send, parameters: FakeParameterStore) -> None:
        def failing_tools(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
            if url.endswith("/api/mcp") and body and json.loads(body)["method"] == "tools/call":
                result = {"content": [{"type": "text", "text": "Something went wrong"}], "isError": True}
                return 200, json.dumps({"jsonrpc": "2.0", "id": json.loads(body)["id"], "result": result}).encode()
            return send(method, url, headers, body)

        with pytest.raises(SmokeFailedError, match=r"MCP records a transaction"):
            smoke(failing_tools, parameters, [])
