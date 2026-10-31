"""
The OpenAPI document for /api/openapi.json, built from the pydantic schemas the Lambdas validate with,
so the two can't drift. `python -m ledger_api.docs.openapi` prints it; test/unit/openapi.test.ts checks
it lists exactly the routes the stack deploys.
"""

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import TypeAdapter

from ledger_api.admin.schemas import STATUS_QUERY
from ledger_api.auth.schemas import GOOGLE_CALLBACK_QUERY, LOGIN, REFRESH_TOKEN_BODY, REGISTRATION
from ledger_api.data.schemas import LIST_QUERY, NEW_TRANSACTION, SUMMARY_QUERY, TRANSACTION_EDIT
from ledger_api.json_schema import inline_defs, without_titles


@dataclass(frozen=True)
class Operation:
    method: Literal["get", "post", "patch", "delete"]
    path: str
    # Stable and descriptive: clients generate method names from these.
    operation_id: str
    summary: str
    body: TypeAdapter[Any] | None = None
    query: TypeAdapter[Any] | None = None
    # Callable without a token (sign-in routes and this spec).
    public: bool = False


OPERATIONS = [
    Operation(
        "post",
        "/api/v1/auth/register",
        "register",
        "Sign up; the account stays pending until an admin enables it, and both steps are emailed",
        body=REGISTRATION,
        public=True,
    ),
    Operation(
        "post",
        "/api/v1/auth/login",
        "login",
        'Log in; returns an access token and a refresh token (cookie, or body if refreshTokenIn is "body")',
        body=LOGIN,
        public=True,
    ),
    Operation(
        "post",
        "/api/v1/auth/refresh",
        "refreshTokens",
        "Swap a refresh token (cookie or body) for new tokens",
        body=REFRESH_TOKEN_BODY,
        public=True,
    ),
    Operation(
        "post", "/api/v1/auth/logout", "logout", "End the session's refresh token", body=REFRESH_TOKEN_BODY, public=True
    ),
    Operation(
        "get",
        "/api/v1/auth/google/start",
        "startGoogleSignIn",
        "Redirect to Google to sign in; browsers navigate here",
        public=True,
    ),
    Operation(
        "get",
        "/api/v1/auth/google/callback",
        "finishGoogleSignIn",
        "Google's redirect back: sets the refresh cookie and redirects to the app, or to /login?error=...",
        query=GOOGLE_CALLBACK_QUERY,
        public=True,
    ),
    Operation("get", "/api/v1/auth/me", "getCurrentUser", "The signed-in user"),
    Operation("get", "/api/v1/admin/users", "adminListUsers", "Admin: list users by status", query=STATUS_QUERY),
    Operation("post", "/api/v1/admin/users/{id}/enable", "adminEnableUser", "Admin: activate a user"),
    Operation(
        "post",
        "/api/v1/admin/users/{id}/disable",
        "adminDisableUser",
        "Admin: block a user and end their refresh tokens",
    ),
    Operation(
        "delete",
        "/api/v1/admin/users/{id}",
        "adminDeleteUser",
        "Admin: delete a customer and all their transactions, for good",
    ),
    Operation(
        "get",
        "/api/v1/admin/users/{id}/transactions",
        "adminListTransactions",
        "Admin: a customer's transactions",
        query=LIST_QUERY,
    ),
    Operation(
        "patch",
        "/api/v1/admin/users/{id}/transactions/{transactionId}",
        "adminUpdateTransaction",
        "Admin: edit a customer's transaction; send the version you last read",
        body=TRANSACTION_EDIT,
    ),
    Operation(
        "delete",
        "/api/v1/admin/users/{id}/transactions/{transactionId}",
        "adminDeleteTransaction",
        "Admin: delete a customer's transaction",
    ),
    Operation(
        "get",
        "/api/v1/admin/transactions",
        "adminListAllTransactions",
        "Admin: every customer's transactions, newest first, each with its owner's userId",
        query=LIST_QUERY,
    ),
    Operation(
        "post",
        "/api/v1/transactions",
        "createTransaction",
        "Record an expense; repeating the same id returns the stored record",
        body=NEW_TRANSACTION,
    ),
    Operation(
        "get",
        "/api/v1/transactions",
        "listTransactions",
        "Transactions, newest first, with optional filters",
        query=LIST_QUERY,
    ),
    Operation(
        "get", "/api/v1/transactions/summary", "getMonthlySummary", "A month's totals by category", query=SUMMARY_QUERY
    ),
    Operation("get", "/api/v1/transactions/{id}", "getTransaction", "One transaction"),
    Operation(
        "patch",
        "/api/v1/transactions/{id}",
        "updateTransaction",
        "Edit a transaction; send the version you last read",
        body=TRANSACTION_EDIT,
    ),
    Operation("delete", "/api/v1/transactions/{id}", "deleteTransaction", "Delete a transaction"),
    Operation(
        "post",
        "/api/mcp",
        "mcp",
        "Model Context Protocol (Streamable HTTP, JSON-RPC) for agents; tools act as the signed-in customer",
    ),
    Operation("get", "/api/openapi.json", "getOpenApiSpec", "This document", public=True),
]


def _schema(adapter: TypeAdapter[Any]) -> dict[str, Any]:
    return without_titles(inline_defs(adapter.json_schema()))


def _operation(op: Operation) -> dict[str, Any]:
    parameters: list[dict[str, Any]] = [
        {"name": name, "in": "path", "required": True, "schema": {"type": "string"}}
        for name in re.findall(r"\{(\w+)\}", op.path)
    ]
    if op.query:
        query = _schema(op.query)
        required = set(query.get("required", []))
        parameters += [
            {"name": name, "in": "query", "required": name in required, "schema": schema}
            for name, schema in query["properties"].items()
        ]
    built: dict[str, Any] = {
        "operationId": op.operation_id,
        "summary": op.summary,
        "security": [] if op.public else [{"bearerAuth": []}],
        "parameters": parameters,
    }
    if op.body:
        built["requestBody"] = {"required": True, "content": {"application/json": {"schema": _schema(op.body)}}}
    built["responses"] = {
        "default": {"description": "Success, or an error shaped as { error: { code, message, details? } }"}
    }
    return built


def build_openapi() -> dict[str, Any]:
    paths: dict[str, dict[str, Any]] = {}
    for op in OPERATIONS:
        paths.setdefault(op.path, {})[op.method] = _operation(op)
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "ledger-api",
            "version": "1.0.0",
            "description": "Household expense records. See docs/design.md.",
        },
        "components": {"securitySchemes": {"bearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}}},
        "paths": paths,
    }


if __name__ == "__main__":
    print(json.dumps(build_openapi(), indent=2))
