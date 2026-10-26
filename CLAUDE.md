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
```

Deploys: `LedgerApi` is deployed by the `deploy` job in `.github/workflows/ci.yml` on push to `main` (GitHub OIDC, then the smoke test). `LedgerApiCiAccess` (the OIDC provider and deploy role) is deployed once by hand; see README.md.

## Design and working agreement

`docs/design.md` is the agreed design: endpoints, auth flow, data model, table layout and conventions. Read it before adding features, and update it when a design decision changes.

- Work test-first: write the failing test, make it pass, then refactor. Name tests in BDD style: `describe("given …")` / `it("…")`.
- Behaviour that touches DynamoDB is tested as integration tests in `test/integration/` against DynamoDB Local, not with a stubbed client. Pure logic goes in `test/unit/`.
- Use `src/db-client.ts` for DynamoDB access; it picks up `DYNAMODB_ENDPOINT` for local runs.
- The project must stay at $0/month: prefer free AWS features (SSM Parameter Store over Secrets Manager, no WAF/KMS) and call out anything that would cost money.
- Secrets (JWT signing secret, root admin password) live only in SSM. Never put credentials in source, tests or CDK context.
- Every API route must also be listed in `src/openapi.ts`; `test/unit/openapi.test.ts` fails if the spec and the stack's routes differ. Request schemas live in their own modules (`src/auth/schemas.ts`, `src/data/*-schema.ts`, `src/admin/schemas.ts`) so the spec can import them without pulling in handlers.
- Log through `src/log.ts`, which redacts passwords, tokens, cookies and Authorization headers. The failed-login alarm counts `{ event: "login_failed" }` lines from the auth Lambda.
