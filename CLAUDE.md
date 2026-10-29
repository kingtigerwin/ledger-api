# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run db:up                 # start DynamoDB Local in Docker (needed for integration tests)
npm run typecheck             # tsc --noEmit; nothing is emitted, tsx/esbuild run the TypeScript directly
npm run lint
npm run test:unit
npm run test:integration      # against DynamoDB Local on :8000 (override with DYNAMODB_ENDPOINT)
npx vitest run test/integration/some.test.ts         # one file
npx vitest run -t "given a pending user"             # tests matching a name
npm run synth                 # cdk synth (both stacks)
API_URL=... SMOKE_TEST_PASSWORD=... npm run smoke   # round trip against a deployed API

# Python (3.13, managed with uv): the Lambdas moved over from TypeScript so far, now `notify`
uv sync                       # install into .venv
uv run pytest                 # unit and integration tests (integration needs DynamoDB Local too)
uv run pytest tests/unit      # one folder
uv run ruff check && uv run ruff format --check
uv run pyright                # strict mode
```

Deploys: `LedgerApi` is deployed by the `deploy` job in `.github/workflows/ci.yml` on push to `main` (GitHub OIDC, then the smoke test). `LedgerApiCiAccess` (the OIDC provider and deploy role) is deployed once by hand; see README.md.

## Architecture

CDK stacks (`bin/app.ts`): `LedgerApi` (`lib/ledger-stack.ts`, the app), `LedgerApiCertificate` (`lib/certificate-stack.ts`, the custom domain's ACM certificate in us-east-1, only when `customDomain` is set in `cdk.json`) and `LedgerApiCiAccess` (`lib/ci-access-stack.ts`, GitHub OIDC deploy role). CloudFront → HTTP API → one Lambda per area, each a thin `lambda.ts` that wires real dependencies into a testable `create…Handler(deps)` in `handler.ts`:

- `src/auth/`: register, login, refresh, logout, me (Users table); `authorizer-lambda.ts` validates the bearer JWT for every protected route and passes `userId`, `role`, `scope` in the request context.
- `src/admin/`: list, enable, disable users. `src/data/`: transactions, plus the admin's `/admin/...` routes to view, edit and delete any customer's transactions.
- `src/mcp/`: `POST /api/mcp`, MCP over stateless Streamable HTTP for agents. Behind the same authorizer; a fresh `McpServer` per request holds the caller's tools, one per Transactions route, plus the admin's read-only `list_all_transactions` (with usernames from the Users table). `src/data/ledger.ts` holds the transaction rules and errors that both the REST handler and the MCP tools call, so add behaviour there, not in either front door.
- `src/ledger_api/notify/` (Python): emails customers on sign-up and first approval, and the admin (`ADMIN_EMAIL`) on each sign-up to approve or reject, linking to ledger-ui's admin page. The Users table's stream (only with `emailFrom` in `cdk.json`) drives it; `emails.py` decides which email a change calls for, and it sends through SES. Same split as the TypeScript Lambdas: `lambda_function.py` wires boto3 into `create_notify_handler(...)` in `handler.py`.
- `src/bootstrap/`: custom resource that creates the SSM secrets and the `sisi` admin on deploy, never overwriting. `src/docs/`: serves `/api/openapi.json`.
- `src/ledger_api/log.py` is the Python twin of `src/log.ts`: the same JSON lines, with the same keys redacted.
- `src/http.ts` holds the shared handler plumbing (`withErrors`, `ApiError` → `{ error: { code, message } }`, `parseBody`, `requireAdmin`).

Two tables, both keyed `pk`/`sk`: Users (users, username claims, refresh-token hashes, lockouts) and Data (`USER#<userId>` partition holding `TXN#<date>#<id>` items plus `TXNREF#<id>` pointers; indexes `byCategory` on `gsi2pk`/`gsi2sk` and `allByDate` on `gsi3pk`/`gsi3sk` for the admin's cross-customer list). `src/data/data-table.ts` and `src/auth/users-table.ts` define the keys for both the stack and `test/support/dynamo.ts`.

## Design and working agreement

`docs/design.md` is the agreed design: endpoints, auth flow, data model, table layout and conventions. Read it before adding features, and update it when a design decision changes.

- The Lambdas are moving from TypeScript to Python (`src/ledger_api/`, tests in `tests/`), one at a time, to match the newer projects such as ledger-agent. Write new Lambdas in Python. A ported Lambda keeps its logical IDs in the stack (so CloudFormation updates it in place) and its JSON log lines. The CDK stays TypeScript for now. A Python Lambda's code is the `ledger_api` package as it stands (`Code.fromAsset` on `src/`), so it may only import what the Lambda runtime provides (boto3); anything more needs a bundling step first.
- Work test-first: write the failing test, make it pass, then refactor. Name tests in BDD style: `describe("given …")` / `it("…")`, and in Python nested `class TestGiven…` / `def test_…`.
- Behaviour that touches DynamoDB is tested as integration tests in `test/integration/` (`tests/integration/` in Python) against DynamoDB Local, not with a stubbed client. Pure logic goes in `test/unit/`.
- Use `src/db-client.ts` for DynamoDB access; it picks up `DYNAMODB_ENDPOINT` for local runs.
- The project must stay at $0/month: prefer free AWS features (SSM Parameter Store over Secrets Manager, no WAF/KMS) and call out anything that would cost money.
- Secrets (JWT signing secret, root admin password) live only in SSM. Never put credentials in source, tests or CDK context.
- Every API route must also be listed in `src/openapi.ts`; `test/unit/openapi.test.ts` fails if the spec and the stack's routes differ. Request schemas live in their own modules (`src/auth/schemas.ts`, `src/data/*-schema.ts`, `src/admin/schemas.ts`) so the spec can import them without pulling in handlers.
- Log through `src/log.ts`, which redacts passwords, tokens, cookies and Authorization headers. The failed-login alarm counts `{ event: "login_failed" }` lines from the auth Lambda.
