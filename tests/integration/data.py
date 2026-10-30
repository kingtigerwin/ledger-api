"""Calls the data handler the way the HTTP API would, behind the authorizer."""

import json
from typing import Any

from ledger_api.data.ulid import new_ulid
from ledger_api.http import Handler

ADMIN = {"userId": "admin-1", "role": "admin", "scope": "admin:read admin:write transactions:read transactions:write"}


def customer(user_id: str) -> dict[str, str]:
    return {"userId": user_id, "role": "customer", "scope": "transactions:read transactions:write"}


def expense(**overrides: Any) -> dict[str, Any]:
    """The example transaction from the design, with overrides."""
    return {
        "id": new_ulid(),
        "date": "2026-10-26",
        "merchant": "Coles",
        "category": "groceries",
        "item": "菜",
        "amountCents": 10000,
        "currency": "AUD",
        "note": "这些菜是用来准备一家人下一周的食材",
        **overrides,
    }


def call(
    handler: Handler,
    route_key: str,
    body: Any = None,
    *,
    auth: dict[str, str],
    params: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
) -> tuple[int, Any]:
    """Returns the status and the JSON body (None for an empty one)."""
    res = handler(
        {
            "routeKey": route_key,
            "pathParameters": params,
            "queryStringParameters": query,
            "requestContext": {"authorizer": {"lambda": auth}},
            "body": None if body is None else json.dumps(body),
            "isBase64Encoded": False,
        }
    )
    return res["statusCode"], json.loads(res["body"]) if res.get("body") else None
