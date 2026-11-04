# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run db:up                 # start DynamoDB Local in Docker (needed for integration tests)
npm run typecheck             # tsc --noEmit; nothing is emitted, tsx/esbuild run the TypeScript directly
npm run lint
npm run test:unit             # includes the stacks, their routes against the spec, and the deployed-resources guard
npm run test:integration      # against DynamoDB Local on :8000 (override with DYNAMODB_ENDPOINT)
npx vitest run test/integration/some.test.ts         # one file
npx vitest run -t "given a pending user"             # tests matching a name
npm run synth                 # cdk synth (all the stacks)
API_URL=... SMOKE_TEST_PASSWORD=... npm run smoke   # round trip against a deployed API
```

Deploys: `LedgerApi` is deployed by the `deploy` job in `.github/workflows/ci.yml` on push to `main` (GitHub OIDC, then the smoke test). `LedgerApiCiAccess` (the OIDC provider and deploy role) is deployed once by hand; see README.md.

## Architecture

CDK stacks (`lib/app.ts`, run by `bin/app.ts`): `LedgerApi` (`lib/ledger-stack.ts`, the app), `LedgerApiCertificate` (`lib/certificate-stack.ts`, the custom domain's ACM certificate in us-east-1, only when `customDomain` is set in `cdk.json`) and `LedgerApiCiAccess` (`lib/ci-access-stack.ts`, GitHub OIDC deploy role). CloudFront → HTTP API → one Lambda per area, each a thin `lambda.ts` that wires real dependencies into a testable `create…Handler(deps)` in `handler.ts`:

- `src/auth/`: register, login, sign-in with Google (`google.ts`), refresh, logout, me (Users table). `authorizer-lambda.ts` validates the bearer JWT for every protected route, checks the user is still active (uncached, so disabling or deleting them is immediate) and passes `userId`, `role`, `scope` in the request context. `users-store.ts` holds every Users table read and write.
- `src/admin/`: list, enable, disable and delete users.
- `src/data/`: the Transactions routes, plus the admin's `/admin/...` routes to view, edit and delete any customer's transactions. `ledger.ts` holds the rules and errors that both the REST handler and the MCP tools call, so add behaviour there, not in either front door. `insights.ts` has the checks behind the UI's Home page and `purchase-search.ts` the purchase search (both plain rules, no Claude), `transactions-store.ts` the table access, `transaction-schema.ts` the zod request schemas, `cursor.ts` the signed list cursors (REST and MCP share them).
- `src/mcp/`: `POST /api/mcp`, MCP over stateless Streamable HTTP for agents. Behind the same authorizer; a fresh `McpServer` per request holds only the caller's tools, one per Transactions route, plus the admin's read-only `list_all_transactions` (with usernames from the Users table). `test/integration/mcp-client.test.ts` drives it with the SDK's own client.
- `src/notify/`: emails customers on sign-up and first approval (or a welcome, through Google), and the admin (`ADMIN_EMAIL`) on each sign-up. The Users table's stream (only with `emailFrom` in `cdk.json`) drives it; `emails.ts` decides which email a change calls for, and it sends through SES.
- `src/bootstrap/`: custom resource that creates the SSM secrets and the `sisi` admin on deploy, never overwriting. `src/docs/`: serves `/api/openapi.json`, built by `src/openapi.ts` from the zod schemas.
- `src/http.ts` holds the shared handler plumbing (`withErrors`, `ApiError` → `{ error: { code, message } }`, `parseBody`, `requireAdmin`, `redirect`, `readCookie`).

Two tables, both keyed `pk`/`sk`: Users (users, username claims, Google account claims, refresh-token hashes, lockouts) and Data (`USER#<userId>` partition holding `TXN#<date>#<id>` items plus `TXNREF#<id>` pointers and `INSIGHT#<id>` dismissals; indexes `byCategory` on `gsi2pk`/`gsi2sk` and `allByDate` on `gsi3pk`/`gsi3sk` for the admin's cross-customer list). `src/data/data-table.ts` and `src/auth/users-table.ts` define the keys for both the stack and `test/support/dynamo.ts`.

The Lambdas were in Python for a while (tag `python-final`) and came back to TypeScript; the stored formats (password hashes, tokens, cursors, keys) are the same in both, so live data carried over.

## Design and working agreement

`docs/design.md` is the agreed design: endpoints, auth flow, data model, table layout and conventions. Read it before adding features, and update it when a design decision changes.

- Work test-first: write the failing test, make it pass, then refactor. Name tests in BDD style: `describe("given …")` / `it("…")`.
- Behaviour that touches DynamoDB is tested as integration tests in `test/integration/` against DynamoDB Local, not with a stubbed client. Pure logic goes in `test/unit/`.
- Use `src/db-client.ts` for DynamoDB access; it picks up `DYNAMODB_ENDPOINT` for local runs.
- The project must stay at $0/month: prefer free AWS features (SSM Parameter Store over Secrets Manager, no WAF/KMS) and call out anything that would cost money.
- Secrets (JWT signing secret, root admin password, Google client secret) live only in SSM. Never put credentials in source, tests or CDK context.
- A construct's ID decides its logical ID, so renaming one replaces the resource (for a table, a new and empty one). `test/fixtures/deployed-resources.json` lists what CloudFormation holds, and `test/unit/deployed-resources.test.ts` fails if the app would drop or retype any of it; read `cdk diff` before deploying a stack change.
- Every API route must also be listed in `src/openapi.ts`; `test/unit/openapi.test.ts` fails if the spec and the stack's routes differ. Request schemas live in their own modules (`src/auth/schemas.ts`, `src/data/transaction-schema.ts`, `src/admin/schemas.ts`) so the spec can import them without pulling in handlers.
- The smoke test's steps are in `scripts/smoke-run.ts`; `test/integration/smoke.test.ts` runs them against every handler in process, so change them there first.
- Log through `src/log.ts`, which redacts passwords, tokens, cookies, email addresses and Authorization headers. The failed-login alarm counts `{ event: "login_failed" }` lines from the auth Lambda.
