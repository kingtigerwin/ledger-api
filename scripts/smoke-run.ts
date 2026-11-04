// The smoke test's steps, against whatever `send` reaches: the live API from scripts/smoke.ts, or every Lambda's
// handler in process from test/integration/smoke.test.ts, so a change here is tested before it runs after a deploy.
import { ADMIN_USERNAME } from "../src/config";
import { newUlid } from "../src/data/ulid";

export const SMOKE_USER = "smoke-test";
const TRANSACTION_TOOLS = [
  "create_transaction",
  "get_transaction",
  "list_transactions",
  "get_monthly_summary",
  "search_purchases",
  "update_transaction",
  "delete_transaction",
];

/** One HTTP request; any status is an answer here, and the step decides whether it's the right one. */
export type Send = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<{ status: number; body: string }>;

export class SmokeFailedError extends Error {
  override name = "SmokeFailedError";
}

// The API's replies are JSON the steps index into freely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any };

export interface SmokeOptions {
  baseUrl: string;
  send: Send;
  smokePassword: string;
  /** Read only on the first run, when the smoke user still needs approving. */
  adminPassword: () => Promise<string>;
  /** YYYY-MM-DD. */
  today: string;
  say?: (line: string) => void;
}

/** Throws SmokeFailedError at the first step that doesn't answer as it should. */
export async function run({ baseUrl, send, smokePassword, adminPassword, today, say = console.log }: SmokeOptions) {
  const base = baseUrl.replace(/\/$/, "");
  let rpcId = 0;

  const call = async (method: string, url: string, token?: string, payload?: unknown, accept?: string): Promise<Reply> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(accept ? { accept } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const res = await send(method, url, headers, payload === undefined ? undefined : JSON.stringify(payload));
    return { status: res.status, body: res.body ? JSON.parse(res.body) : undefined };
  };
  const api = (method: string, path: string, options: { token?: string; body?: unknown } = {}) =>
    call(method, `${base}/api/v1${path}`, options.token, options.body);
  const mcp = (token: string | undefined, method: string, params: Record<string, unknown> = {}) =>
    call("POST", `${base}/api/mcp`, token, { jsonrpc: "2.0", id: ++rpcId, method, params }, "application/json, text/event-stream");

  const expectStatus = (step: string, res: Reply, ...allowed: number[]) => {
    if (!allowed.includes(res.status)) {
      throw new SmokeFailedError(`${step}: expected ${allowed.join(" or ")}, got ${res.status} ${JSON.stringify(res.body)}`);
    }
    say(`ok  ${step} (${res.status})`);
  };
  /** An MCP call answers 200 even when it fails; the JSON-RPC result says whether it worked. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expectMcp = (step: string, res: Reply, ok: (result: any) => boolean) => {
    const result = res.status === 200 ? res.body?.result : undefined;
    if (!result || !ok(result)) throw new SmokeFailedError(`${step}: got ${res.status} ${JSON.stringify(res.body)}`);
    say(`ok  ${step}`);
    return result;
  };
  const worked = (result: { isError?: boolean }) => !result.isError;
  const text = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);

  const login = (username: string, password: string) =>
    api("POST", "/auth/login", { body: { username, password, refreshTokenIn: "body" } });

  // SES's mailbox simulator: accepts the emails without delivering them, and isn't charged.
  const registration = { username: SMOKE_USER, password: smokePassword, email: "success@simulator.amazonses.com" };
  expectStatus("register smoke-test (or already exists)", await api("POST", "/auth/register", { body: registration }), 201, 409);

  let session = await login(SMOKE_USER, smokePassword);
  if (session.status === 403) {
    // First run: approve the smoke user as the admin.
    const admin = await login(ADMIN_USERNAME, await adminPassword());
    expectStatus("admin login", admin, 200);
    const adminToken = admin.body.accessToken;
    const pending = await api("GET", "/admin/users?status=pending", { token: adminToken });
    expectStatus("list pending users", pending, 200);
    const smokeUser = pending.body.items.find((user: { username: string }) => user.username === SMOKE_USER);
    expectStatus("enable smoke-test", await api("POST", `/admin/users/${smokeUser.id}/enable`, { token: adminToken }), 200);
    session = await login(SMOKE_USER, smokePassword);
  }
  expectStatus("smoke-test login", session, 200);
  const token = session.body.accessToken;

  const month = today.slice(0, 7);
  const txn = { id: newUlid(), date: today, category: "other", item: "smoke test", amountCents: 1, currency: "AUD" };
  expectStatus("create transaction", await api("POST", "/transactions", { token, body: txn }), 201);
  expectStatus("repeat create returns the original", await api("POST", "/transactions", { token, body: txn }), 200);
  expectStatus("read transaction", await api("GET", `/transactions/${txn.id}`, { token }), 200);
  expectStatus("list transactions", await api("GET", "/transactions?category=other", { token }), 200);
  expectStatus("monthly summary", await api("GET", `/transactions/summary?month=${month}`, { token }), 200);
  expectStatus("search purchases", await api("GET", "/transactions/purchases?q=smoke", { token }), 200);
  expectStatus("insights", await api("GET", `/insights?today=${today}`, { token }), 200);
  // A malformed ID stops before any write, so this reaches the route and leaves nothing behind.
  expectStatus("dismiss refuses a bad insight ID", await api("POST", "/insights/nope/dismiss", { token }), 400);
  expectStatus("unauthenticated request is refused", await api("GET", "/transactions"), 401);
  expectStatus("delete transaction", await api("DELETE", `/transactions/${txn.id}`, { token }), 204);
  expectStatus("a customer can't delete a user", await api("DELETE", "/admin/users/nobody", { token }), 403);

  // The agent's path: the same customer token, over MCP.
  const tool = (name: string, args: Record<string, unknown>) => mcp(token, "tools/call", { name, arguments: args });
  expectMcp("MCP lists the Transactions tools", await mcp(token, "tools/list"), (result) =>
    TRANSACTION_TOOLS.every((name) => result.tools.some((t: { name: string }) => t.name === name)),
  );
  const recorded = expectMcp(
    "MCP records a transaction",
    await tool("create_transaction", { date: today, category: "other", item: "smoke test (mcp)", amountCents: 1 }),
    worked,
  );
  const mcpId = text(recorded).id;
  expectStatus("read the MCP transaction over REST", await api("GET", `/transactions/${mcpId}`, { token }), 200);
  expectMcp("MCP gets it", await tool("get_transaction", { id: mcpId }), worked);
  expectMcp(
    "MCP lists it",
    await tool("list_transactions", { category: "other" }),
    (result) => worked(result) && text(result).items.some((t: { id: string }) => t.id === mcpId),
  );
  expectMcp("MCP monthly summary", await tool("get_monthly_summary", { month }), worked);
  expectMcp("MCP searches purchases", await tool("search_purchases", { terms: ["smoke"] }), worked);
  expectMcp(
    "MCP updates it",
    await tool("update_transaction", { id: mcpId, version: 1, note: "edited" }),
    (result) => worked(result) && text(result).version === 2,
  );
  expectMcp("MCP deletes it", await tool("delete_transaction", { id: mcpId }), worked);
  expectStatus("the MCP delete is seen over REST", await api("GET", `/transactions/${mcpId}`, { token }), 404);
  expectStatus("unauthenticated MCP request is refused", await mcp(undefined, "tools/list"), 401);

  expectStatus("logout", await api("POST", "/auth/logout", { body: { refreshToken: session.body.refreshToken } }), 204);
  expectStatus("Google sign-in redirects", await api("GET", "/auth/google/start"), 302);
  const spec = await send("GET", `${base}/api/openapi.json`, {});
  expectStatus("OpenAPI spec", { status: spec.status, body: undefined }, 200);
  say("smoke test passed");
}
