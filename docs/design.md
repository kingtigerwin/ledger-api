# ledger-api design

A public API where customers record their spending. It's a learning and portfolio project focused on serverless AWS and on handling the data correctly. Target cost: $0/month.

## Stack

- TypeScript, AWS CDK, Lambda (Node 22, arm64), API Gateway HTTP API, DynamoDB (on-demand).
- CloudFront in front of the API at `/api/*` (no S3 origin in this stack; a UI may be added later as another origin).
- Region `ap-southeast-2`. The app is one stack, `LedgerApi`; with a custom domain, a small `LedgerApiCertificate` stack in `us-east-1` holds its ACM certificate (CloudFront only accepts certificates from there), passed across with CDK cross-region references.
- Custom domain: `api.haoran.cloud`, in the existing `haoran.cloud` Route 53 zone (which also serves another site). Configured in `cdk.json` (`customDomain`); the zone is imported by ID, never looked up (a lookup would put the account ID in `cdk.context.json`) and never modified apart from the API's `A`/`AAAA` alias records and ACM's validation record. The CloudFront domain keeps working.
- Secrets (JWT signing secret, root admin password) are SSM Parameter Store `SecureString`s, created once by a CDK custom resource and never overwritten. They are never in source.

## Auth

- `POST /api/v1/auth/register`: anyone can sign up. New users are `pending` until an admin enables them.
- Root admin `sisi` is created on first deploy with a random password stored in SSM (`/ledger-api/admin-password`). A CDK custom resource runs the bootstrap: it creates only what's missing (the signing secret, the admin password, the admin user) and never overwrites anything. The API stage waits for it. Read the password with `aws ssm get-parameter --name /ledger-api/admin-password --with-decryption`.
- Passwords are hashed with scrypt (`node:crypto`), stored as `scrypt$N$r$p$salt$hash` and compared with `timingSafeEqual`.
- Input limits: username and password must be non-empty, at most 64 and 1,024 characters respectively. Usernames are unique and stored lowercase. No other password policy.
- `POST /api/v1/auth/login` returns a 15-minute HS256 access token with claims `sub`, `role` (`admin` | `customer`) and `scope`. Failed logins always return the same "invalid username or password" error.
- Refresh tokens last 7 days and are replaced on every use. Only their SHA-256 hash is stored, under `USER#<id>` / `REFRESH#<hash>`, with a DynamoDB TTL for cleanup (expiry is also checked in code, since TTL deletion can lag).
  - Login delivers the refresh token as an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie by default. A non-browser client (a future agent) sends `"refreshTokenIn": "body"` to get it in the JSON body instead, and then sends it back in the body.
  - `POST /api/v1/auth/refresh` answers in the same channel the token arrived in.
  - Replaying a refresh token that was already replaced revokes all of that user's refresh tokens, since it was probably copied.
- `POST /api/v1/auth/logout` deletes the presented refresh token and clears the cookie; it succeeds even without a token.
- `GET /api/v1/auth/me` returns the signed-in user.
- A custom Lambda authorizer (simple responses) validates the bearer access token on every other route and passes `userId`, `role` and `scope` to it. Results are cached for 60 seconds, so an expired token works for at most a minute longer.
- Abuse protection: API Gateway throttling on the stage, tighter on `/auth/*`; 5 failed logins lock a username for 15 minutes.

## Roles

- **Customer**: sees and changes only their own transactions. Every query is scoped by the token's `userId` in the partition key.
- **Admin**: lists users by status, enables and disables users (disabling deletes their refresh tokens), records their own transactions like a customer, and can view, edit and delete every customer's transactions.
  - Admin tokens carry `admin:read admin:write transactions:read transactions:write`; customer tokens carry `transactions:read transactions:write`. The admin's own transactions use the normal `/transactions` routes and live in the admin's own partition. Other customers' transactions are reached only through `/admin/...` routes, which check both role and scope (`admin:read` to view, `admin:write` to edit or delete).
  - Admins can't be disabled (409 `cannot_disable_admin`), so the root admin can't be locked out.
  - Listing users scans the Users table, which is fine at this scale; a status index is the upgrade path.

## Data

### Transaction

An expense (no income records), owned by the customer who recorded it. There are no household members: an earlier version had them (transactions carried a `memberId`), and they were removed to keep the model to users and their transactions. Items written back then keep their old `memberId` and `gsi1*` attributes in DynamoDB, but the API never returns them.

```json
{
  "id": "01JBX...",
  "date": "2026-10-26",
  "merchant": "Coles",
  "category": "groceries",
  "item": "菜",
  "amountCents": 10000,
  "currency": "AUD",
  "note": "这些菜是用来准备一家人下一周的食材",
  "createdAt": "2026-10-26T10:05:00Z",
  "updatedAt": "2026-10-26T10:05:00Z",
  "version": 1
}
```

- `id` is a ULID generated by the client. Creation saves the record only if that `id` doesn't exist yet, so repeating a create is safe: it returns the stored record with 200 (even if the body differs). The API rejects malformed ULIDs (400 `validation_failed`) and ones timestamped more than 5 minutes in the future (400 `invalid_id`).
- Each transaction has a pointer item `TXNREF#<id>` → its date, written in the same transaction, so it can be found by ID although it sorts by date. Changing the date moves the item (delete + put + pointer update, atomically).
- Required: `id`, `date`, `category`, `item` (≤200), `amountCents`, `currency`. Optional: `merchant` (≤100), `note` (≤1000).
- `amountCents` is a positive integer. `currency` is stored but only `"AUD"` is accepted for now.
- `category` is one of a fixed list (Zod enum): `groceries`, `dining`, `transport`, `utilities`, `rent`, `health`, `education`, `shopping`, `entertainment`, `other`.
- Unknown fields, such as a `memberId` from an old client, are ignored.
- Updates send the `version` last read and fail with 409 `version_conflict` if it has changed.
- `GET /transactions` uses the by-category index when `category` is given and the main key otherwise; dates are always a sort-key range. `limit` is 1–100 (default 50). Filtered pages can be shorter than `limit`; follow `nextCursor` until it's `null`. A cursor from a different filter is rejected as `invalid_cursor`.
- `GET /transactions/summary?month=YYYY-MM` returns `{ month, currency, totalCents, byCategory: [{ category, totalCents }] }`, largest first.

### Tables

- `Users`: users, username uniqueness items, refresh tokens, lockout counters.
- `Data`: transactions, keyed by customer. Transactions sort by `date#id`. Two secondary indexes: `byCategory` (`gsi2pk`/`gsi2sk`, names kept from when a by-member `gsi1` index existed) filters one customer's transactions by category; `allByDate` (`gsi3pk = TXN`, `gsi3sk = date#id`) lists every customer's transactions for the admin. One partition is fine at household scale.

## Endpoints

All under `/api/v1`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` |
| Transactions | `POST /transactions`, `GET /transactions/{id}`, `GET /transactions` (`cursor`, `limit`, `from`, `to`, `category`), `GET /transactions/summary?month=YYYY-MM`, `PATCH /transactions/{id}`, `DELETE /transactions/{id}` |
| Admin | `GET /admin/users?status=pending`, `POST /admin/users/{id}/enable`, `POST /admin/users/{id}/disable`, `GET /admin/users/{id}/transactions`, `GET /admin/transactions` (everyone's, each with `userId`; same filters), `PATCH /admin/users/{id}/transactions/{transactionId}`, `DELETE /admin/users/{id}/transactions/{transactionId}` |

### MCP, for agents

`POST /api/mcp` (outside `/api/v1`: MCP versions itself) speaks the Model Context Protocol over Streamable HTTP, stateless, with JSON responses (no sessions, no SSE stream), so it fits Lambda. It sits behind the same authorizer as the REST routes: the agent sends the signed-in customer's own access token, and every tool acts as that customer with that token's scopes. The REST API is unchanged; MCP is a second front door to the same store code (`src/mcp/handler.ts`).

Agents call `/api/mcp` and never the REST routes. The flow it was built for: the UI signs the customer in over REST and sends their free text ("today I went to woolworth and bought 30 dollars for cake") plus their access token to the agent (`ledger-agent`, Python, Claude), which calls `create_transaction` over MCP with that token.

| Tool | Needs | Does |
|---|---|---|
| `create_transaction` | `transactions:write` (hidden otherwise) | Takes `date`, `category`, `item`, `amountCents`, optional `merchant` and `note`. The server makes the ULID `id` and sets `currency` to AUD, so every call records a new transaction (a retried call can duplicate one). Returns the stored transaction as JSON text. |

The agent puts today's date, in the customer's time zone, into Claude's prompt, so "today" resolves to a real date. More tools (list, summary, edit, delete) are added when the UI needs them.

## Conventions

- Lists return `{ items, nextCursor }`. The cursor is DynamoDB's `LastEvaluatedKey`, encoded and signed so it can't be tampered with.
- Errors are `{ error: { code, message, details? } }` with stable `code` strings.
- `camelCase` fields; dates `YYYY-MM-DD`; timestamps ISO 8601 UTC; money is `amountCents` + `currency`.
- An OpenAPI spec is generated from the Zod schemas and published at `/api/openapi.json`. The MCP tools take their input schemas from the same Zod schemas.

## Operations

- GitHub Actions: tests on pull requests; on push to `main` (once the repo variable `DEPLOY_ENABLED` is `true`), a `deploy` job runs after the tests, assumes `ledger-api-github-deploy` via GitHub OIDC (no stored AWS keys), runs `cdk deploy LedgerApi`, then the smoke test.
  - The deploy role's ARN is a repo secret, and `mask-aws-account-id` is on, so the AWS account ID never appears in this public repo's logs.
  - The deploy role is in a separate `LedgerApiCiAccess` stack deployed once by hand. Only `repo:kingtigerwin@9473411/ledger-api@1434244010:ref:refs/heads/main` (GitHub's immutable subject format, with owner and repo IDs) can assume it, and it can only assume CDK's bootstrap roles (`cdk-hnb659fds-*`) and read the admin password for the smoke test.
- CloudFront sends `/api/*` (and, for now, the default behaviour) to API Gateway with caching disabled and the `AllViewerExceptHostHeader` origin request policy, so `Authorization`, cookies and query strings reach the API. The raw `execute-api` URL also stays reachable; blocking it would need WAF or a shared-secret header.
- Lambda JSON logs kept for 2 weeks. All logging goes through `src/log.ts`, which redacts passwords, tokens, cookies and `Authorization` headers.
- Four CloudWatch alarms (within the free 10), emailing the address in the `alarmEmail` CDK context value (GitHub variable `ALARM_EMAIL`) via SNS: API 5xx ≥ 1, Lambda errors ≥ 1 and throttles ≥ 1 (account-wide metrics, so they also cover other Lambdas in the account and region), and ≥ 20 failed logins in 5 minutes.
- The smoke test reuses one user, `smoke-test` (password in the GitHub secret `SMOKE_TEST_PASSWORD`), which the admin approves on its first run. It records one transaction over REST and one over MCP, and deletes both.

## Testing

- Test-first: red, green, refactor. Vitest with BDD-style `describe("given …") / it("…")` names.
- Integration tests run against DynamoDB Local and cover most behaviour. Pure logic (validation, hashing, tokens) has unit tests.
- A smoke test runs after each deploy with one dedicated test user and cleans up after itself.

## Out of scope for now

UI and its deployment, the agent (its own repo), MCP tools beyond `create_transaction`, OAuth discovery for MCP clients such as claude.ai connectors, multiple currencies, income records, custom categories, password reset, WAF, X-Ray.
