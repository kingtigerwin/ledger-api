# ledger-api design

A public API where customers record their spending. It's a learning and portfolio project focused on serverless AWS and on handling the data correctly. Target cost: $0/month. The one exception is SES sending after its first year (see Account emails), a few cents a month at this scale.

## Stack

- TypeScript, AWS CDK, Lambda (Node 22, arm64), API Gateway HTTP API, DynamoDB (on-demand). Each Lambda is bundled with esbuild. The OpenAPI spec is built from the same zod schemas the Lambdas validate requests with.
- The Lambdas and the CDK app were in Python for a while (tag `python-final`) and moved back to TypeScript in one go. Every stored format (password hashes, tokens, cursors, table keys) is the same in both, so live data carried over, and every construct ID was kept, so no resource was replaced: `test/unit/deployed-resources.test.ts` checks the app against the logical IDs CloudFormation held.
- CloudFront in front of the API at `/api/*` (no S3 origin in this stack; a UI may be added later as another origin).
- Region `ap-southeast-2`. The app is one stack, `LedgerApi`; with a custom domain, a small `LedgerApiCertificate` stack in `us-east-1` holds its ACM certificate (CloudFront only accepts certificates from there), passed across with CDK cross-region references.
- Custom domain: `api.haoran.cloud`, in the existing `haoran.cloud` Route 53 zone (which also serves another site). Configured in `cdk.json` (`customDomain`); the zone is imported by ID, never looked up (a lookup would put the account ID in `cdk.context.json`) and never modified apart from the API's `A`/`AAAA` alias records, ACM's validation record and SES's three DKIM `CNAME` records. The CloudFront domain keeps working.
- Secrets (JWT signing secret, root admin password) are SSM Parameter Store `SecureString`s, created once by a CDK custom resource and never overwritten. The Google client secret is one too, put there by hand since it comes from Google. They are never in source.

## Auth

- `POST /api/v1/auth/register`: anyone can sign up with a username, password and email address. New users are `pending` until an admin enables them; both steps are emailed (see Account emails).
- Root admin `sisi` is created on first deploy with a random password stored in SSM (`/ledger-api/admin-password`). A CDK custom resource runs the bootstrap: it creates only what's missing (the signing secret, the admin password, the admin user) and never overwrites anything. The API stage waits for it. Read the password with `aws ssm get-parameter --name /ledger-api/admin-password --with-decryption`.
- Passwords are hashed with scrypt (N=2^17, r=8, p=1, `node:crypto`), stored as `scrypt$N$r$p$salt$hash` and compared with `timingSafeEqual`. The Python Lambdas wrote the same format, so every stored hash verifies.
- Input limits: username and password must be non-empty, at most 64 and 1,024 characters respectively. Usernames are unique and stored lowercase. No other password policy. The email must be a valid address of at most 254 characters; it isn't unique, isn't used to sign in, and isn't verified (a mistyped one just bounces).
- `POST /api/v1/auth/login` returns a 15-minute HS256 access token with claims `sub`, `role` (`admin` | `customer`) and `scope`. Failed logins always return the same "invalid username or password" error.
- Refresh tokens last 7 days and are replaced on every use. Only their SHA-256 hash is stored, under `USER#<id>` / `REFRESH#<hash>`, with a DynamoDB TTL for cleanup (expiry is also checked in code, since TTL deletion can lag).
  - Login delivers the refresh token as an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie by default. A non-browser client (a future agent) sends `"refreshTokenIn": "body"` to get it in the JSON body instead, and then sends it back in the body.
  - `POST /api/v1/auth/refresh` answers in the same channel the token arrived in.
  - Replaying a refresh token that was already replaced revokes all of that user's refresh tokens, since it was probably copied.
- `POST /api/v1/auth/logout` deletes the presented refresh token and clears the cookie; it succeeds even without a token.
- Sign-in with Google is OpenID Connect's authorization code flow with PKCE, run entirely by the auth Lambda, so the UI only links to it.
  - `GET /api/v1/auth/google/start` sets a 10-minute `__Host-googleSignIn` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`) holding `state`, `nonce` and the PKCE verifier, and redirects to Google with the scopes `openid email`. `__Host-` stops another site under `haoran.cloud` planting one; it's `Lax` because a `Strict` cookie isn't sent on the navigation back from Google.
  - `GET /api/v1/auth/google/callback` checks `state` against the cookie, trades the code for an ID token, and redirects: to `/`, the app's Home page, with the ordinary refresh cookie (the UI's page load trades it for an access token, so no token is ever in a URL), and to `/login?error=google_failed` for a disabled one or any failure. Every outcome is a redirect, since the browser is on that URL.
  - The redirect URI is on `ledger.haoran.cloud`, whose CloudFront forwards `/api/*` here, so the cookies are first-party to the UI.
  - The ID token's signature isn't checked: OpenID Connect allows this for a token fetched directly from the token endpoint over TLS with the client secret, and checking it would mean fetching Google's keys on a cold start. `iss`, `aud`, `exp`, `nonce` and `email_verified` are checked in code (`src/auth/google.ts`).
  - Someone new becomes an `active` customer with no approval: Google has verified their address, and ledger-agent's daily limits (5 messages per customer, 300 in total) bound what they can cost. A Google user left `pending` from before this is activated at their next sign-in. Password sign-ups still wait for approval, since their addresses aren't verified and they're easy to script. They're found again by Google's `sub`, through a `GOOGLE#<sub>` claim item. Their username is the address's local part plus a hash of `sub` (`alice-g1a2b3c4d`), they have no `passwordHash`, and `authProvider` is `google`, so no password logs them in and their emails say to use Google.
  - Accounts are never linked by email: registered addresses aren't verified, so a password account with a matching address could belong to someone else. A customer with both gets two accounts. The admin stays password-only.
  - The client ID and redirect URI are in `cdk.json`; the client secret is in SSM (`/ledger-api/google-client-secret`), put there by hand and read on first use, so a problem with it can't stop password logins. Without a client ID, both routes redirect to `/login?error=google_unavailable`. Failures log `google_login_failed`, not `login_failed`, so they don't count towards the failed-login alarm.
- `GET /api/v1/auth/me` returns the signed-in user: `id`, `username`, `email`, `role`, `status`. The admin's user list includes `email` too. Users from before emails, and the bootstrap admin, have none.
- A custom Lambda authorizer (simple responses) validates the bearer access token on every other route and passes `userId`, `role` and `scope` to it. It also reads the user from the Users table, and refuses unless they're still `active`, so disabling or deleting someone ends their access token at once rather than up to 15 minutes later. Results aren't cached, or that check would be up to a cache lifetime late. It costs one read per request, a tiny fraction of a cent a month at this scale, and a few milliseconds. API Gateway answers a refusal with 403 and `{"message":"Forbidden"}` (401 only when there's no `Authorization` header), and that includes an expired token; the UI treats it as its cue to refresh.
- Abuse protection: API Gateway throttling on the stage, tighter on `/auth/*`; 5 failed logins lock a username for 15 minutes.

## Roles

- **Customer**: sees and changes only their own transactions. Every query is scoped by the token's `userId` in the partition key.
- **Admin**: lists users by status, enables and disables users (disabling deletes their refresh tokens), records their own transactions like a customer, and can view, edit and delete every customer's transactions.
  - Admin tokens carry `admin:read admin:write transactions:read transactions:write`; customer tokens carry `transactions:read transactions:write`. The admin's own transactions use the normal `/transactions` routes and live in the admin's own partition. Other customers' transactions are reached only through `/admin/...` routes, which check both role and scope (`admin:read` to view, `admin:write` to edit or delete).
  - Admins can't be disabled (409 `cannot_disable_admin`), so the root admin can't be locked out.
  - The admin can delete a customer: `DELETE /admin/users/{id}` returns 204. There is one admin, `sisi`, so nobody else can. Admins can't be deleted (409 `cannot_delete_admin`), so `sisi` can't delete themselves. Disabling is the reversible way to block someone; deleting can't be undone, and is logged as `user_deleted` with who did it.
  - Deleting removes the profile, username claim, Google claim, refresh tokens and every item in the user's Data partition, and sends no email. The username and Google account are free to come back as someone new, who starts as a new user would: `pending` with a password, `active` with Google. The user is disabled first and the profile goes last, so a delete that fails part-way leaves them unable to sign in and can be run again. Being disabled first also stops their access token at the authorizer, so nothing new can arrive while their data is deleted. Signing out doesn't do this: `logout` ends the refresh token, and the UI forgets its access token, but a copy of that token keeps working until it expires, up to 15 minutes.
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
- A scanned receipt also sends `receipt`, optional and fixed once created. It holds only what was printed: `totalCents`, `gstCents`, `savingsCents`, `time` (`HH:MM`), `location`, `receiptNumber`, `abn` (11 digits), `lines` (up to 200 of `{ name, product?, amountCents }`, where `name` is as printed, `product` is in plain words for searching, and a discount line is negative) and `payments` (up to 10 of `{ label, kind, amountCents }`, `kind` being `money` or `points`). It never holds a photo, card number, loyalty number or staff name.
- `amountCents` is what was paid in money, so totals match the customer's bank: a $30.50 shop with $30.00 of Flybuys points has `amountCents` 50 and `receipt.totalCents` 3050. Monthly totals count `amountCents`.
- Updates send the `version` last read and fail with 409 `version_conflict` if it has changed.
- `GET /transactions` uses the by-category index when `category` is given and the main key otherwise; dates are always a sort-key range. `limit` is 1–100 (default 50). Filtered pages can be shorter than `limit`; follow `nextCursor` until it's `null`. A cursor from a different filter is rejected as `invalid_cursor`.
- `GET /transactions/summary?month=YYYY-MM` returns `{ month, currency, totalCents, byCategory: [{ category, totalCents, count }] }`, largest first, where `count` is how many transactions make up the category's total.

### Searching purchases

`GET /transactions/purchases?q=banana,香蕉&from=&to=` answers "how much did I spend on bananas?", returning only what matches: `{ matches: [{ transactionId, date, merchant, name, product, amountCents }], count, totalCents, currency, includesPoints, from, to }`. `matches` holds at most 100; `count` and `totalCents` cover everything found. Terms are comma-separated, since HTTP API joins repeated query parameters with commas anyway.

- It searches a receipt's `lines`, both the printed `name` and the plain `product`, so `chicken` finds `CLS CHKN DRUMSTICKS`, and the `item` of an expense with no lines, so one typed into the chat counts too. A receipt's own `item` isn't searched: it only repeats a line, or says "18 items".
- Rules are in `src/data/purchase-search.ts`. A term matches case-insensitively at the start of a word, so `banana` finds `BANANAS` but not `BANDANA`, and only the singular is needed. A term in Chinese matches anywhere, since Chinese has no spaces. A line matching two terms counts once. It's literal text, with no synonyms: the agent passes those as extra terms.
- There's no index. DynamoDB can't search inside a list, and one customer's transactions for a date range are few enough to filter in code, the same read as `summary` and `insights`. A range is at most 400 days (400 `invalid_date_range`), which bounds what one search reads; with no dates it's the 400 days up to today in UTC.
- Line amounts are shelf prices, so this total can differ from the money paid. `includesPoints` is true when a match came from a receipt partly paid with points, and the reply should say so.

### Insights

`GET /insights?today=YYYY-MM-DD` returns what the UI's Home page asks the customer to look at, as `{ items: [...] }`. The rules are plain code in `src/data/insights.ts`, not Claude: they compare dates and amounts, which code does exactly, instantly and for nothing, while a Claude call per page load would cost money and give different answers on the same data. They run on request over the customer's last 400 days, as `summary` does. The API returns structured fields and the UI writes the wording, so the only non-English text is what the customer stored. `today` comes from the browser, since "due in 14 days" depends on the day it is where the customer is.

The items are ordered by kind, as below. Each carries a 16-character hex `id`, a `type`, `currency` and the `transactions` behind it, so the UI can show them without another request. Transactions are typed in by hand, not read from a bank, so these only know what was recorded: a duplicate is an expense recorded twice rather than a merchant charging twice, and a subscription is visible only if it's recorded every time. Merchants match on a normalised name (case, punctuation, `Pty Ltd`, `.com`), falling back to `item` when there's no merchant, so `Netflix` and `奈飞` are different merchants.

| `type` | Shows when | Extra fields | Clears when |
|---|---|---|---|
| `rego_due` | The latest payment mentions `rego`, `car registration`, `vehicle registration`, `CTP`, `green slip` or `车辆注册` in its item, merchant or note, and the estimated due date is within 30 days either way. The estimate is 12 months after that payment, or 3 or 6 if the last two payments were that far apart. There's no stored due date, so the UI says "around". | `estimatedDueDate`, `lastPaidCents` | A newer payment is recorded |
| `possible_duplicate` | The same merchant, item and amount, at most a day apart, in the last 30 days. A run over three or more dates is a habit, so only repeats on one date in it count. | `merchant`, `amountCents` | One is deleted |
| `price_rise` | Charges from one merchant at a monthly (26 to 35 days apart, at least 3, the latest within 45 days) or yearly (350 to 380 days apart, at least 2) rhythm whose amounts never fall and end higher; monthly ones must also repeat an amount, so a bill that varies doesn't count. Not `groceries` or `dining`. It compares the oldest charge in the run with the latest, which becomes a comparison with last year once there's a year of history. | `merchant`, `previousCents`, `currentCents`, `since` (the first charge at the new price), `cadence`, `extraPerYearCents` | The price falls or the charges stop |

`POST /insights/{id}/dismiss` returns 204 and can be repeated. An `id` hashes the facts it's about (the transactions, or the merchant and new amount), so a dismissed insight returns only if those change: a third copy, a further rise, the next year's rego. An `id` that isn't 16 hex characters is refused (400 `invalid_insight_id`), but a well-formed one isn't checked against the rules, which would mean running them all; one that matches nothing is a harmless row.

### Tables

- `Users`: users (with their email), username uniqueness items, Google account claims, refresh tokens, lockout counters. With emails on, it streams new and old images to the notify Lambda.
- `Data`: transactions and dismissed insights (`INSIGHT#<id>`, which sort outside every transaction range, have no index keys and go with the customer), keyed by customer. Transactions sort by `date#id`. Two secondary indexes: `byCategory` (`gsi2pk`/`gsi2sk`, names kept from when a by-member `gsi1` index existed) filters one customer's transactions by category; `allByDate` (`gsi3pk = TXN`, `gsi3sk = date#id`) lists every customer's transactions for the admin. One partition is fine at household scale.

## Endpoints

All under `/api/v1`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/google/start`, `GET /auth/google/callback`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` |
| Transactions | `POST /transactions`, `GET /transactions/{id}`, `GET /transactions` (`cursor`, `limit`, `from`, `to`, `category`), `GET /transactions/summary?month=YYYY-MM`, `GET /transactions/purchases?q=&from=&to=`, `PATCH /transactions/{id}`, `DELETE /transactions/{id}` |
| Insights | `GET /insights?today=YYYY-MM-DD`, `POST /insights/{id}/dismiss` |
| Admin | `GET /admin/users?status=pending`, `POST /admin/users/{id}/enable`, `POST /admin/users/{id}/disable`, `DELETE /admin/users/{id}`, `GET /admin/users/{id}/transactions`, `GET /admin/transactions` (everyone's, each with `userId`; same filters), `PATCH /admin/users/{id}/transactions/{transactionId}`, `DELETE /admin/users/{id}/transactions/{transactionId}` |

### MCP, for agents

`POST /api/mcp` (outside `/api/v1`: MCP versions itself) speaks the Model Context Protocol over Streamable HTTP, stateless, with JSON responses (no sessions, no SSE stream), so it fits Lambda. It sits behind the same authorizer as the REST routes: the agent sends the signed-in user's own access token, and every tool acts as that user with that token's scopes. The REST API is unchanged; MCP is a second front door to the same ledger code (`src/mcp/handler.ts`, on the MCP TypeScript SDK).

Agents call `/api/mcp` and never the REST routes. The flow it was built for: the UI signs the customer in over REST and sends their free text ("today I went to woolworth and bought 30 dollars for cake") plus their access token to the agent (`ledger-agent`, Python, Claude), which calls `create_transaction` over MCP with that token.

Each customer tool mirrors a Transactions route and acts on the signed-in user's own transactions. Tools whose scope the token lacks are hidden from `tools/list` and refused; admin tools also need the `admin` role, as the REST admin routes do, so a customer token never sees them. Results are JSON text: the same bodies the REST routes return, except that `list_all_transactions` adds `username`, and `list_transactions` and `list_all_transactions` leave `lines` out of each `receipt`: everything a list returns goes to Claude, and a receipt can hold dozens of lines. The other receipt fields stay, so chat can answer questions about savings, GST and stores. `search_purchases` is how chat reaches them, returning only what matches. Failures (not found, stale version, bad cursor) come back as tool errors (`isError: true`) with the REST error's message; bad arguments are rejected against the same zod schemas, as a tool error naming the field (`... at category`). A tool the caller may not use isn't registered for that request, so calling it gets the same `Tool ... not found` error as one that doesn't exist.

| Tool | Route it mirrors | Needs | Notes |
|---|---|---|---|
| `create_transaction` | `POST /transactions` | `transactions:write` | Takes `date`, `category`, `item`, `amountCents`, optional `merchant` and `note`. The server makes the ULID `id` and sets `currency` to AUD, so every call records a new transaction (a retried call can duplicate one). |
| `get_transaction` | `GET /transactions/{id}` | `transactions:read` | Read-only. |
| `list_transactions` | `GET /transactions` | `transactions:read` | Read-only. Same filters and signed `nextCursor`; cursors work across REST and MCP. |
| `get_monthly_summary` | `GET /transactions/summary` | `transactions:read` | Read-only. |
| `search_purchases` | `GET /transactions/purchases` | `transactions:read` | Read-only. Takes `terms` as a list, and optional `from` and `to`. Returns only the matching lines, so Claude never reads a whole receipt. |
| `update_transaction` | `PATCH /transactions/{id}` | `transactions:write` | `id`, `version` from the latest read, and the fields to change. |
| `delete_transaction` | `DELETE /transactions/{id}` | `transactions:write` | Marked destructive, so clients can ask before calling it. |
| `list_all_transactions` | `GET /admin/transactions` | `admin:read` (and the `admin` role) | Read-only. Every customer's transactions, newest first, same filters and cursors. Each item has `userId` and `username` (null if the user can't be found). Optional `username` (any case) limits it to one customer, for "show haoran's spending": it is resolved through the username claim and lists that customer's own partition, and an unknown username is a `user_not_found` tool error rather than an empty list. Cursors don't carry over between the filtered and unfiltered lists. Unfiltered pages get their usernames from one `BatchGetItem` per page on the Users table, which the MCP Lambda can read but not write. |

REST and MCP share the rules in `src/data/ledger.ts`. The agent puts today's date, in the customer's time zone, into Claude's prompt, so "today" resolves to a real date. The admin's write routes (edit or delete any customer's transaction) and the user-management routes are not exposed over MCP.

## Account emails

Emails come from `noreply@haoran.cloud` (`emailFrom` in `cdk.json`):

| When | To | Email |
|---|---|---|
| A customer registers (a new `pending` customer) | the customer | "Your Ledger account is waiting for approval" |
| A customer registers | the admin (`ADMIN_EMAIL`) | "New Ledger sign-up: <username> is waiting for approval", with their username, email and ID and a link to ledger-ui's admin page (`adminPageUrl` in `cdk.json`), where the admin approves or rejects them under Pending. Without `adminPageUrl` it gives the `POST /admin/users/{id}/enable` (approve) and `/disable` (reject) URLs instead |
| Someone new signs in with Google (a new `active` customer) | the customer | "Welcome to Ledger" |
| Someone new signs in with Google | the admin (`ADMIN_EMAIL`) | "New Ledger user: <username> joined with Google", with their username, email and ID and how to disable them; no approval is needed |
| The admin enables them for the first time (`pending` → `active`) | the customer | "Your Ledger account is approved", saying they can sign in |

Rejecting is disabling a pending customer; there is no separate reject route, and the customer isn't emailed. Nothing is sent when a disabled customer is enabled again, or to users without an email. Emails are plain text.

The admin's address is personal, so it isn't in `cdk.json`: the GitHub variable `ADMIN_EMAIL` reaches the stack as the `adminEmail` context value, and the Notify Lambda as `ADMIN_EMAIL`. Without it, only customers are emailed. The bootstrap admin has no email of their own on the Users table.

```text
register / enable  →  Users table PROFILE item  →  DynamoDB Stream  →  Notify Lambda  →  SES
                                                                        └ fails 3 retries → SQS queue → alarm
```

- The handlers don't send anything: the Users table's stream (new and old images) drives `src/notify/`. Registration never fails because of email, and every way a user changes is covered. A Lambda event filter passes only `PROFILE` items, so refresh tokens, username claims and lockouts don't invoke it. `src/notify/emails.ts` decides which email a change calls for.
- Records are handled in order, and a sign-up's admin email is sent before the customer's, so a customer's address SES won't take can't hold it up.
- An email SES refuses outright (`MessageRejected`, e.g. an unverified recipient in the sandbox, or `BadRequestException` for a malformed address) is logged as `email_rejected` and skipped: a retry can't help. It isn't alarmed, so in the sandbox customers' emails are dropped quietly while the admin's still arrive.
- On any other failed send (throttling, SES unavailable) the Lambda reports that record (`ReportBatchItemFailures`), so the stream retries from there; after 3 retries the batch goes to an SQS queue (kept 14 days) and an alarm fires. Delivery is at least once: a timeout mid-batch can repeat an email, and a retried sign-up sends both of its emails again.
- SES verifies `haoran.cloud` with Easy DKIM: CDK adds the three `CNAME` records to the existing zone. The Notify Lambda may only `ses:SendEmail`/`SendRawEmail` as `emailFrom` (a `ses:FromAddress` condition), on any identity in the account and region plus its configuration set: in the sandbox SES also checks the permission against each verified recipient's identity, such as the admin's address, so allowing only the domain's identity is denied. `emailFrom` must be in the custom domain's zone, and without it no stream, Lambda, identity, configuration set, feedback topic or queue is created.
- Bounces and complaints: the identity's default configuration set publishes `BOUNCE` and `COMPLAINT` events (nothing else) to the `EmailFeedbackTopic` SNS topic, which emails them to `alarmEmail` (GitHub variable `ALARM_EMAIL`; confirm the subscription email AWS sends). The topic policy lets only this account's configuration set publish. SES's account-level suppression list (bounces and complaints) also stops any further sends to those addresses. Both are free: SNS includes 1,000 email deliveries a month.
- New SES accounts are in the sandbox (200 emails a day, only to verified addresses) until production access is requested in the SES console, once, by hand. Until then, verify the admin's address in SES too.
- Email addresses are personal data: `src/log.ts` redacts `email` fields, and the Lambda logs only the user's ID and the email kind, scrubbing the address out of SES error messages.
- Cost: the stream, Lambda, queue and alarm are free. SES gives 3,000 emails a month free for the first 12 months, then $0.10 per 1,000 (three per customer). This is the project's only cost above $0.
- The register route is public, so someone could sign up with another person's address and send them the "waiting for approval" email, and every sign-up also emails the admin. Throttling on `/auth/*` limits how often; verifying the address first would be the fix if it's abused.

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
- Four CloudWatch alarms, five with account emails on (within the free 10), emailing the address in the `alarmEmail` CDK context value (GitHub variable `ALARM_EMAIL`) via SNS: API 5xx ≥ 1, Lambda errors ≥ 1 and throttles ≥ 1 (account-wide metrics, so they also cover other Lambdas in the account and region), and ≥ 20 failed logins in 5 minutes; with emails on, also any email that still failed after its retries (the notify queue isn't empty).
- The smoke test reuses one user, `smoke-test` (password in the GitHub secret `SMOKE_TEST_PASSWORD`), which the admin approves on its first run. It registers with `success@simulator.amazonses.com`, SES's mailbox simulator, so its emails cost nothing and reach no one. It runs a transaction through REST and another through every MCP tool, and deletes both. Its steps are `scripts/smoke-run.ts`; `test/integration/smoke.test.ts` runs them against every Lambda handler in process (behind the real authorizer, on DynamoDB Local), so a change to it is tested before it runs after a deploy.

## Testing

- Test-first: red, green, refactor. Vitest with BDD-style `describe("given …") / it("…")` names.
- Integration tests run against DynamoDB Local and cover most behaviour. Pure logic (validation, hashing, tokens) has unit tests.
- A smoke test runs after each deploy with one dedicated test user and cleans up after itself.

## Out of scope for now

UI and its deployment, the agent (its own repo), OAuth discovery for MCP clients such as claude.ai connectors, multiple currencies, income records, custom categories, password reset, email verification, HTML emails, acting on bounces and complaints automatically (they're emailed and suppressed, not recorded against the user), WAF, X-Ray.
