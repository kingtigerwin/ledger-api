# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
docker compose up -d dynamodb-local   # DynamoDB Local (needed for the integration tests)

# Python 3.13, managed with uv
uv sync                       # install into .venv
uv run pytest                 # unit, integration and CDK tests (integration against DynamoDB Local on :8000; override with DYNAMODB_ENDPOINT)
uv run pytest tests/unit      # one folder
uv run pytest tests/infra     # the stacks, their routes against the spec, and the Lambda bundles (Node runs CDK's jsii)
uv run pytest -k "pending"    # tests matching a name
uv run ruff check && uv run ruff format --check
uv run pyright                # strict mode
API_URL=... SMOKE_TEST_PASSWORD=... uv run scripts/smoke.py   # round trip against a deployed API
npx aws-cdk@2.1146.1 synth    # the stacks, with the version of the CLI CI deploys with
```

Deploys: `LedgerApi` is deployed by the `deploy` job in `.github/workflows/ci.yml` on push to `main` (GitHub OIDC, then the smoke test). `LedgerApiCiAccess` (the OIDC provider and deploy role) is deployed once by hand; see README.md.

## Architecture

CDK stacks (`infra/app.py`): `LedgerApi` (`infra/ledger_stack.py`, the app), `LedgerApiCertificate` (`infra/certificate_stack.py`, the custom domain's ACM certificate in us-east-1, only when `customDomain` is set in `cdk.json`) and `LedgerApiCiAccess` (`infra/ci_access_stack.py`, GitHub OIDC deploy role). CloudFront → HTTP API → one Lambda per area, each a thin `lambda_function.py` that wires real dependencies into a testable `create_…_handler(...)` in `handler.py`:

- `src/ledger_api/auth/`: register, login, sign-in with Google (`google.py`), refresh, logout, me (Users table), plus what the other areas share about users: `users_store.py` (every Users table read and write), `tokens.py` (HS256 access tokens, PyJWT), `password.py` (scrypt, `hashlib`), `refresh_tokens.py`. The formats match what the original TypeScript Lambdas stored and issued; `tests/unit/test_password.py` and `test_tokens.py` check them against vectors from them.
- `src/ledger_api/authorizer/`: validates the bearer JWT for every protected route, checks the user is still active (uncached, so disabling or deleting them is immediate) and passes `userId`, `role`, `scope` in the request context. Its cold start is in front of every route's, so it imports only `auth.tokens`, `auth.users_store` and boto3, not pydantic.
- `src/ledger_api/admin/`: list, enable, disable and delete users.
- `src/ledger_api/data/`: the Transactions routes, plus the admin's `/admin/...` routes to view, edit and delete any customer's transactions. `ledger.py` holds the rules, `transactions_store.py` the table access, `schemas.py` the pydantic request checks, `cursor.py` the signed list cursors (REST and MCP share them, so cursors work across both).
- `src/ledger_api/mcp/`: `POST /api/mcp`, MCP over stateless Streamable HTTP for agents, with the MCP SDK's lowlevel `Server`. Behind the same authorizer; `transport.py` hands each API Gateway request to the SDK as ASGI, and `handler.py` builds a fresh server per request holding the caller's tools, one per Transactions route, plus the admin's read-only `list_all_transactions` (with usernames from the Users table). The tools call the same `Ledger` as REST, and their input schemas are the REST pydantic schemas (`mcp/schemas.py` adds the tool-only ones). `tests/integration/test_mcp_client.py` drives it with the SDK's own client, as ledger-agent connects.
- `src/ledger_api/notify/`: emails customers on sign-up and first approval, and the admin (`ADMIN_EMAIL`) on each sign-up, to approve or reject a password sign-up or as a notice of a Google one, linking to ledger-ui's admin page. The Users table's stream (only with `emailFrom` in `cdk.json`) drives it; `emails.py` decides which email a change calls for, and it sends through SES.
- `src/ledger_api/bootstrap/`: custom resource that creates the SSM secrets and the `sisi` admin on deploy, never overwriting.
- `src/ledger_api/docs/`: serves `/api/openapi.json`, which `openapi.py` builds from the pydantic request schemas the Lambdas validate with (`python -m ledger_api.docs.openapi` prints it).
- `src/ledger_api/http.py` holds the shared handler plumbing (`with_errors`, `ApiError` → `{ error: { code, message } }`, `parse_body`, `require_admin`); `log.py` writes the redacted JSON log lines; `db.py` makes the DynamoDB resource.

Two tables, both keyed `pk`/`sk`: Users (users, username claims, Google account claims, refresh-token hashes, lockouts) and Data (`USER#<userId>` partition holding `TXN#<date>#<id>` items plus `TXNREF#<id>` pointers; indexes `byCategory` on `gsi2pk`/`gsi2sk` and `allByDate` on `gsi3pk`/`gsi3sk` for the admin's cross-customer list). `infra/tables.py` defines the keys for the stack; `tests/integration/conftest.py` builds its tables to match.

## Design and working agreement

`docs/design.md` is the agreed design: endpoints, auth flow, data model, table layout and conventions. Read it before adding features, and update it when a design decision changes.

- Work test-first: write the failing test, make it pass, then refactor. Name tests in BDD style (see below).
- Behaviour that touches DynamoDB is tested as integration tests in `tests/integration/` against DynamoDB Local, not with a stubbed client. Pure logic goes in `tests/unit/`.
- Use `ledger_api.db.dynamodb()` for DynamoDB access; it picks up `DYNAMODB_ENDPOINT` for local runs.
- The project must stay at $0/month: prefer free AWS features (SSM Parameter Store over Secrets Manager, no WAF/KMS) and call out anything that would cost money.
- Secrets (JWT signing secret, root admin password, Google client secret) live only in SSM. Never put credentials in source, tests or CDK context.
- Every API route must also be listed in `src/ledger_api/docs/openapi.py`; `tests/infra/test_openapi_routes.py` fails if the spec and the stack's routes differ. Request schemas live in each area's `schemas.py` (pydantic `TypeAdapter`s) so the spec can import them without pulling in handlers; a check done in code (an `AfterValidator`) also states its format in the schema (`json_schema_extra`), so the spec shows it.
- Log through `ledger_api.log.log`, which redacts passwords, tokens, cookies and Authorization headers. The failed-login alarm counts `{ "event": "login_failed" }` lines from the auth Lambda.

## Python

Everything here is Python, to match ledger-agent: the Lambdas (`src/ledger_api/`), the CDK app (`infra/`) and the tests (`tests/`). Node is only there to run the `cdk` CLI and CDK's jsii. Logical IDs in the stack must not change: a changed ID makes CloudFormation replace the resource, and for the tables that loses the data. Check `cdk diff` before merging anything that moves a construct.

- Style is PEP 8, enforced by ruff with the rules in `pyproject.toml`; types are checked by pyright in strict mode. Python work is done when `ruff check`, `ruff format --check`, `pyright` and `pytest` all pass. Fix the code rather than silencing a rule; the accepted ignores are `reportUnknownMemberType` on `boto3.client(...)`, since only some services' stubs are installed, and `reportArgumentType` in `infra/`, where jsii's generated classes don't match their own interfaces.
- Naming follows PEP 8: `snake_case` modules, functions and variables, `PascalCase` classes, `UPPER_SNAKE` constants, a leading `_` for module-private names. Data that crosses the wire keeps the API's camelCase keys (`userId`, `batchItemFailures`, log fields), so convert at the boundary.
- Each Lambda is split the same way: `handler.py` has `create_<area>_handler(*, deps)`, which tests drive with fakes, and `lambda_function.py` builds the real clients once per cold start and exposes `handler(event, context)`.
- Typing uses Python 3.13 syntax (`X | None`, `list[str]`, `type` aliases). Values are `@dataclass(frozen=True)`; collaborators are `Callable` aliases or `Protocol`s. `Any` stays at the edge, for raw AWS events (`dict[str, Any]`).
- The Lambdas run from two bundles (`infra/python_code.py`): `cdk synth` installs the locked runtime dependencies as arm64 Linux wheels with uv, beside the `ledger_api` package, leaving out boto3 and its dependencies, which the Lambda runtime provides. Only MCP's bundle has the `mcp` dependency group (the SDK) and `ledger_api.mcp`: the SDK is three quarters of that bundle, and a bigger bundle is a slower cold start for every function using it, so keep the SDK out of the other modules. It also compiles everything to unchecked-hash bytecode, since `/var/task` is read-only and a cold start would otherwise compile pydantic and the MCP SDK from source. A bundle's asset hash is `bundleHash`, over its inputs (the modules it ships, `pyproject.toml`, `uv.lock`, `infra/python_code.py`): CDK's OUTPUT hash fingerprints through the asset's excludes, and a hash that misses a change means the deploy leaves the old code in place. So a runtime dependency must publish arm64 manylinux wheels (`--only-binary`). Add packages with `uv add` (`--dev` for tools, `--group mcp` for what only MCP needs, `--group infra` for what only the CDK app needs; the bundles leave `infra` out) so `uv.lock` stays in step. `mypy_boto3_*` stubs are dev-only, so import them under `TYPE_CHECKING`. `tests/infra/test_python_code.py` builds the real bundles and checks them.
- AWS errors arrive as `botocore.exceptions.ClientError`; branch on `err.response["Error"]["Code"]`.
- Docstrings (PEP 257) on public functions and classes state the contract and the why, not the signature.
- Tests are pytest, named BDD-style as nested `class TestGiven…` / `def test_…`. Shared fixtures go in `conftest.py`; tables of cases use `pytest.mark.parametrize` with readable `id`s.
- Load the `aws-sdk-python-usage` skill before writing boto3 code.
