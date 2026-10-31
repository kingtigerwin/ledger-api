# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run db:up                 # start DynamoDB Local in Docker (needed for the Python integration tests)

# Python (3.13, managed with uv): every Lambda but docs
uv sync                       # install into .venv
uv run pytest                 # unit and integration tests (integration against DynamoDB Local on :8000; override with DYNAMODB_ENDPOINT)
uv run pytest tests/unit      # one folder
uv run pytest -k "pending"    # tests matching a name
uv run ruff check && uv run ruff format --check
uv run pyright                # strict mode

# TypeScript: the CDK app and the smoke test
npm run typecheck             # tsc --noEmit; nothing is emitted, tsx/esbuild run the TypeScript directly
npm run lint
npm run test:unit             # the stack, its routes against the spec, and the Python bundles
npx vitest run -t "given a pending user"             # tests matching a name
npm run synth                 # cdk synth (both stacks)
API_URL=... SMOKE_TEST_PASSWORD=... npm run smoke   # round trip against a deployed API
```

Deploys: `LedgerApi` is deployed by the `deploy` job in `.github/workflows/ci.yml` on push to `main` (GitHub OIDC, then the smoke test). `LedgerApiCiAccess` (the OIDC provider and deploy role) is deployed once by hand; see README.md.

## Architecture

CDK stacks (`bin/app.ts`): `LedgerApi` (`lib/ledger-stack.ts`, the app), `LedgerApiCertificate` (`lib/certificate-stack.ts`, the custom domain's ACM certificate in us-east-1, only when `customDomain` is set in `cdk.json`) and `LedgerApiCiAccess` (`lib/ci-access-stack.ts`, GitHub OIDC deploy role). CloudFront → HTTP API → one Lambda per area, each a thin `lambda_function.py` that wires real dependencies into a testable `create_…_handler(...)` in `handler.py`:

- `src/ledger_api/auth/`: register, login, refresh, logout, me (Users table), plus what the other areas share about users: `users_store.py` (every Users table read and write), `tokens.py` (HS256 access tokens, PyJWT), `password.py` (scrypt, `hashlib`), `refresh_tokens.py`. The formats match what the TypeScript Lambdas stored and issued; `tests/unit/test_password.py` and `test_tokens.py` check them against vectors from it.
- `src/ledger_api/authorizer/`: validates the bearer JWT for every protected route and passes `userId`, `role`, `scope` in the request context. Its cold start is in front of every route's, so it imports only `auth.tokens` and boto3, not pydantic.
- `src/ledger_api/admin/`: list, enable, disable users.
- `src/ledger_api/data/`: the Transactions routes, plus the admin's `/admin/...` routes to view, edit and delete any customer's transactions. `ledger.py` holds the rules, `transactions_store.py` the table access, `schemas.py` the pydantic request checks, `cursor.py` the signed list cursors (REST and MCP share them, so cursors work across both).
- `src/ledger_api/mcp/`: `POST /api/mcp`, MCP over stateless Streamable HTTP for agents, with the MCP SDK's lowlevel `Server`. Behind the same authorizer; `transport.py` hands each API Gateway request to the SDK as ASGI, and `handler.py` builds a fresh server per request holding the caller's tools, one per Transactions route, plus the admin's read-only `list_all_transactions` (with usernames from the Users table). The tools call the same `Ledger` as REST, and their input schemas are the REST pydantic schemas (`mcp/schemas.py` adds the tool-only ones). `tests/integration/test_mcp_client.py` drives it with the SDK's own client, as ledger-agent connects. `src/data/` (TypeScript) keeps only what the OpenAPI spec and the stack use.
- `src/ledger_api/notify/`: emails customers on sign-up and first approval, and the admin (`ADMIN_EMAIL`) on each sign-up to approve or reject, linking to ledger-ui's admin page. The Users table's stream (only with `emailFrom` in `cdk.json`) drives it; `emails.py` decides which email a change calls for, and it sends through SES.
- `src/ledger_api/bootstrap/`: custom resource that creates the SSM secrets and the `sisi` admin on deploy, never overwriting.
- `src/ledger_api/docs/`: serves `/api/openapi.json`, which `openapi.py` builds from the pydantic request schemas the Lambdas validate with (`python -m ledger_api.docs.openapi` prints it).
- `src/ledger_api/http.py` holds the shared handler plumbing (`with_errors`, `ApiError` → `{ error: { code, message } }`, `parse_body`, `require_admin`); `log.py` writes the redacted JSON log lines; `db.py` makes the DynamoDB resource.

Two tables, both keyed `pk`/`sk`: Users (users, username claims, refresh-token hashes, lockouts) and Data (`USER#<userId>` partition holding `TXN#<date>#<id>` items plus `TXNREF#<id>` pointers; indexes `byCategory` on `gsi2pk`/`gsi2sk` and `allByDate` on `gsi3pk`/`gsi3sk` for the admin's cross-customer list). `src/data/data-table.ts` and `src/auth/users-table.ts` define the keys for the stack; `tests/integration/conftest.py` builds its tables to match.

## Design and working agreement

`docs/design.md` is the agreed design: endpoints, auth flow, data model, table layout and conventions. Read it before adding features, and update it when a design decision changes.

- Work test-first: write the failing test, make it pass, then refactor. Name tests in BDD style: `describe("given …")` / `it("…")` (Python: see below).
- Behaviour that touches DynamoDB is tested as integration tests in `tests/integration/` against DynamoDB Local, not with a stubbed client. Pure logic goes in `tests/unit/`.
- Use `ledger_api.db.dynamodb()` for DynamoDB access; it picks up `DYNAMODB_ENDPOINT` for local runs.
- The project must stay at $0/month: prefer free AWS features (SSM Parameter Store over Secrets Manager, no WAF/KMS) and call out anything that would cost money.
- Secrets (JWT signing secret, root admin password) live only in SSM. Never put credentials in source, tests or CDK context.
- Every API route must also be listed in `src/ledger_api/docs/openapi.py`; `test/unit/openapi.test.ts` fails if the spec and the stack's routes differ. Request schemas live in each area's `schemas.py` (pydantic `TypeAdapter`s) so the spec can import them without pulling in handlers; a check done in code (an `AfterValidator`) also states its format in the schema (`json_schema_extra`), so the spec shows it.
- Log through `ledger_api.log.log`, which redacts passwords, tokens, cookies and Authorization headers. The failed-login alarm counts `{ "event": "login_failed" }` lines from the auth Lambda.

## Python

The Lambdas moved from TypeScript to Python (`src/ledger_api/`, tests in `tests/`) one at a time, to match ledger-agent; all of them have. Write every new Lambda in Python; the CDK stays TypeScript for now. A ported Lambda keeps its logical IDs in the stack, so CloudFormation updates it in place, and keeps its JSON log lines.

- Style is PEP 8, enforced by ruff with the rules in `pyproject.toml`; types are checked by pyright in strict mode. Python work is done when `ruff check`, `ruff format --check`, `pyright` and `pytest` all pass. Fix the code rather than silencing a rule; the one accepted ignore is `reportUnknownMemberType` on `boto3.client(...)`, since only some services' stubs are installed.
- Naming follows PEP 8: `snake_case` modules, functions and variables, `PascalCase` classes, `UPPER_SNAKE` constants, a leading `_` for module-private names. Data that crosses the wire keeps the API's camelCase keys (`userId`, `batchItemFailures`, log fields), so convert at the boundary.
- Each Lambda is split the same way: `handler.py` has `create_<area>_handler(*, deps)`, which tests drive with fakes, and `lambda_function.py` builds the real clients once per cold start and exposes `handler(event, context)`.
- Typing uses Python 3.13 syntax (`X | None`, `list[str]`, `type` aliases). Values are `@dataclass(frozen=True)`; collaborators are `Callable` aliases or `Protocol`s. `Any` stays at the edge, for raw AWS events (`dict[str, Any]`).
- The Python Lambdas run from two bundles (`lib/python-code.ts`): `cdk synth` installs the locked runtime dependencies as arm64 Linux wheels with uv, beside the `ledger_api` package, leaving out boto3 and its dependencies, which the Lambda runtime provides. Only MCP's bundle has the `mcp` dependency group (the SDK) and `ledger_api.mcp`: the SDK is three quarters of that bundle, and a bigger bundle is a slower cold start for every function using it, so keep the SDK out of the other modules. It also compiles everything to unchecked-hash bytecode, since `/var/task` is read-only and a cold start would otherwise compile pydantic and the MCP SDK from source. A bundle's asset hash is `bundleHash`, over its inputs (the modules it ships, `pyproject.toml`, `uv.lock`, `lib/python-code.ts`): CDK's OUTPUT hash fingerprints through the asset's excludes, and a hash that misses a change means the deploy leaves the old code in place. So a runtime dependency must publish arm64 manylinux wheels (`--only-binary`). Add packages with `uv add` (`--dev` for tools, `--group mcp` for what only MCP needs) so `uv.lock` stays in step. `mypy_boto3_*` stubs are dev-only, so import them under `TYPE_CHECKING`. `test/unit/python-code.test.ts` builds the real bundle and checks it.
- AWS errors arrive as `botocore.exceptions.ClientError`; branch on `err.response["Error"]["Code"]`.
- Docstrings (PEP 257) on public functions and classes state the contract and the why, not the signature.
- Tests are pytest, named BDD-style as nested `class TestGiven…` / `def test_…`. Shared fixtures go in `conftest.py`; tables of cases use `pytest.mark.parametrize` with readable `id`s.
- Load the `aws-sdk-python-usage` skill before writing boto3 code.
