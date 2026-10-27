// Post-deploy smoke test against the live API. Usage:
//   API_URL=https://dxxxx.cloudfront.net SMOKE_TEST_PASSWORD=... npm run smoke
// Reuses one user, `smoke-test` (there's no delete-user endpoint); the admin approves it on the
// first run. The transaction it creates is deleted again.
import { randomInt } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ADMIN_PASSWORD_PARAM, ADMIN_USERNAME } from "../src/config";

const API_URL = required("API_URL").replace(/\/$/, "");
const SMOKE_PASSWORD = required("SMOKE_TEST_PASSWORD");
const SMOKE_USER = "smoke-test";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

async function api(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

function expectStatus(step: string, res: { status: number; body: unknown }, ...allowed: number[]) {
  if (!allowed.includes(res.status)) {
    throw new Error(`${step}: expected ${allowed.join(" or ")}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`ok  ${step} (${res.status})`);
}

const login = async (username: string, password: string) => {
  const res = await api("POST", "/auth/login", { body: { username, password, refreshTokenIn: "body" } });
  return res;
};

/** A ULID for now, as a client would make one. */
function newUlid(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  for (let ms = Date.now(), i = 0; i < 10; i++, ms = Math.floor(ms / 32)) time = alphabet[ms % 32] + time;
  let random = "";
  for (let i = 0; i < 16; i++) random += alphabet[randomInt(32)];
  return time + random;
}

async function main() {
  expectStatus("register smoke-test (or already exists)", await api("POST", "/auth/register", {
    body: { username: SMOKE_USER, password: SMOKE_PASSWORD },
  }), 201, 409);

  let session = await login(SMOKE_USER, SMOKE_PASSWORD);
  if (session.status === 403) {
    // First run: approve the smoke user as the admin.
    const { Parameter } = await new SSMClient({}).send(
      new GetParameterCommand({ Name: ADMIN_PASSWORD_PARAM, WithDecryption: true }),
    );
    const admin = await login(ADMIN_USERNAME, Parameter!.Value!);
    expectStatus("admin login", admin, 200);
    const pending = await api("GET", "/admin/users?status=pending", { token: admin.body.accessToken });
    expectStatus("list pending users", pending, 200);
    const smoke = pending.body.items.find((u: { username: string }) => u.username === SMOKE_USER);
    expectStatus("enable smoke-test", await api("POST", `/admin/users/${smoke.id}/enable`, { token: admin.body.accessToken }), 200);
    session = await login(SMOKE_USER, SMOKE_PASSWORD);
  }
  expectStatus("smoke-test login", session, 200);
  const token = session.body.accessToken;

  const txn = {
    id: newUlid(),
    date: new Date().toISOString().slice(0, 10),
    category: "other",
    item: "smoke test",
    amountCents: 1,
    currency: "AUD",
  };
  expectStatus("create transaction", await api("POST", "/transactions", { token, body: txn }), 201);
  expectStatus("repeat create returns the original", await api("POST", "/transactions", { token, body: txn }), 200);
  expectStatus("read transaction", await api("GET", `/transactions/${txn.id}`, { token }), 200);
  expectStatus("list transactions", await api("GET", "/transactions?category=other", { token }), 200);
  expectStatus("monthly summary", await api("GET", `/transactions/summary?month=${txn.date.slice(0, 7)}`, { token }), 200);
  expectStatus("unauthenticated request is refused", await api("GET", "/transactions"), 401);

  expectStatus("delete transaction", await api("DELETE", `/transactions/${txn.id}`, { token }), 204);
  expectStatus("logout", await api("POST", "/auth/logout", { body: { refreshToken: session.body.refreshToken } }), 204);
  expectStatus("OpenAPI spec", { status: (await fetch(`${API_URL}/api/openapi.json`)).status, body: null }, 200);
  console.log("smoke test passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
