import json
from typing import Any, get_args

import pytest

from ledger_api.data.schemas import Category
from ledger_api.docs.handler import create_docs_handler
from ledger_api.docs.openapi import build_openapi

SPEC = build_openapi()


def operation(method: str, path: str) -> dict[str, Any]:
    return SPEC["paths"][path][method]


def params(method: str, path: str) -> dict[str, dict[str, Any]]:
    return {p["name"]: p for p in operation(method, path)["parameters"]}


class TestGivenTheOpenApiSpec:
    def test_it_is_openapi_3_1_with_bearer_auth(self) -> None:
        assert SPEC["openapi"] == "3.1.0"
        assert SPEC["components"]["securitySchemes"]["bearerAuth"] == {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
        }

    def test_it_takes_request_schemas_from_the_validators(self) -> None:
        body = operation("post", "/api/v1/transactions")["requestBody"]["content"]["application/json"]["schema"]

        assert body["properties"]["category"]["enum"] == list(get_args(Category.__value__))
        assert {"id", "amountCents", "currency"} <= set(body["required"])

    def test_its_schemas_are_self_contained(self) -> None:
        printed = json.dumps(SPEC)

        assert '"$ref"' not in printed
        assert '"$defs"' not in printed

    def test_its_schemas_leave_out_pydantics_generated_titles(self) -> None:
        body = operation("post", "/api/v1/auth/register")["requestBody"]["content"]["application/json"]["schema"]

        assert "title" not in body
        assert "title" not in body["properties"]["username"]

    def test_it_marks_protected_routes_as_needing_a_bearer_token_and_sign_in_routes_as_public(self) -> None:
        assert operation("get", "/api/v1/transactions")["security"] == [{"bearerAuth": []}]
        assert operation("post", "/api/v1/auth/login")["security"] == []
        assert operation("get", "/api/openapi.json")["security"] == []

    def test_it_documents_query_parameters_and_which_are_required(self) -> None:
        listed = params("get", "/api/v1/transactions")
        summary = params("get", "/api/v1/transactions/summary")

        assert set(listed) == {"from", "to", "category", "limit", "cursor"}
        assert not listed["limit"]["required"]
        assert listed["limit"]["schema"]["default"] == 50
        assert summary["month"]["required"]
        assert params("get", "/api/v1/admin/users")["status"]["schema"]["enum"] == ["pending", "active", "disabled"]

    def test_it_documents_path_parameters_as_required_strings(self) -> None:
        assert params("patch", "/api/v1/admin/users/{id}/transactions/{transactionId}") == {
            "id": {"name": "id", "in": "path", "required": True, "schema": {"type": "string"}},
            "transactionId": {"name": "transactionId", "in": "path", "required": True, "schema": {"type": "string"}},
        }

    def test_it_documents_formats_that_are_checked_in_code(self) -> None:
        register = operation("post", "/api/v1/auth/register")["requestBody"]["content"]["application/json"]["schema"]

        assert register["properties"]["email"]["format"] == "email"
        assert params("get", "/api/v1/transactions/summary")["month"]["schema"]["pattern"] == r"^\d{4}-(0[1-9]|1[0-2])$"

    def test_it_documents_the_logins_refresh_token_default(self) -> None:
        body = operation("post", "/api/v1/auth/login")["requestBody"]["content"]["application/json"]["schema"]

        assert body["properties"]["refreshTokenIn"] == {
            "enum": ["cookie", "body"],
            "type": "string",
            "default": "cookie",
        }

    @pytest.mark.parametrize("path", ["/api/v1/auth/refresh", "/api/v1/auth/logout"])
    def test_it_documents_the_refresh_token_body_as_optional(self, path: str) -> None:
        body = operation("post", path)["requestBody"]["content"]["application/json"]["schema"]

        assert body["properties"]["refreshToken"]["type"] == "string"
        assert "required" not in body

    def test_every_operation_has_a_unique_id(self) -> None:
        ids = [op["operationId"] for ops in SPEC["paths"].values() for op in ops.values()]

        assert len(ids) == len(set(ids)) == 20


class TestGivenARequestForTheSpec:
    def test_it_returns_it_as_json(self) -> None:
        res = create_docs_handler()({"routeKey": "GET /api/openapi.json"})

        assert res["statusCode"] == 200
        assert res["headers"] == {"content-type": "application/json"}
        assert json.loads(res["body"]) == SPEC
