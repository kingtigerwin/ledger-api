// The smoke test (scripts/smoke-run.ts), run against the whole API in process: every Lambda's handler behind the
// real authorizer, routed as API Gateway routes them, on DynamoDB Local. So the smoke test itself is tested
// without a deploy.
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type Send, SmokeFailedError } from "../../scripts/smoke-run";
import { createAdminHandler } from "../../src/admin/handler";
import { createAuthorizer } from "../../src/auth/authorizer";
import { createAuthHandler } from "../../src/auth/handler";
import { createUsersStore } from "../../src/auth/users-store";
import { bootstrap } from "../../src/bootstrap/bootstrap";
import { ADMIN_PASSWORD_PARAM, SIGNING_SECRET_PARAM } from "../../src/config";
import { createDataHandler } from "../../src/data/handler";
import { ddb } from "../../src/db-client";
import { handler as docs } from "../../src/docs/lambda";
import type { Handler } from "../../src/http";
import { createMcpHandler } from "../../src/mcp/handler";
import { operations } from "../../src/openapi";
import { createDataTable, createUsersTable, deleteTable } from "../support/dynamo";
import { fakeParameterStore } from "../support/parameters";

const BASE = "https://api.example.test";
const SMOKE_PASSWORD = "smoke-test-password";

/** Sends each request to the handler the stack routes it to, as API Gateway (payload v2) would. */
function apiInProcess(tableName: string, dataTableName: string, signingSecret: string): Send {
  const now = () => new Date();
  const handlers: Record<string, Handler> = {
    auth: createAuthHandler({ tableName, signingSecret, now }),
    admin: createAdminHandler({ tableName, dataTableName }),
    data: createDataHandler({ tableName: dataTableName, cursorSecret: "test-cursor-secret", now }),
    mcp: createMcpHandler({ tableName: dataTableName, usersTableName: tableName, cursorSecret: "test-cursor-secret", now }),
    docs,
  };
  const users = createUsersStore(tableName);
  const authorize = createAuthorizer({ signingSecret, now, isActive: (userId) => users.isActive(userId) });

  const area = (path: string) => {
    if (path.startsWith("/api/v1/auth/")) return "auth";
    if (path.startsWith("/api/v1/admin/users") && !path.includes("/transactions")) return "admin";
    return ({ "/api/mcp": "mcp", "/api/openapi.json": "docs" } as Record<string, string>)[path] ?? "data";
  };
  const routes = operations.map((op) => ({
    op,
    pattern: new RegExp(`^${op.path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`),
  }));

  return async (method, url, headers, body) => {
    const { pathname, searchParams } = new URL(url);
    const found = routes
      .map(({ op, pattern }) => ({ op, match: op.method.toUpperCase() === method ? pattern.exec(pathname) : null }))
      .find(({ match }) => match);
    if (!found?.match) return { status: 404, body: '{"message":"Not Found"}' };
    const { op, match } = found;
    const event = {
      routeKey: `${method} ${op.path}`,
      rawPath: pathname,
      headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
      pathParameters: match.groups,
      queryStringParameters: searchParams.size ? Object.fromEntries(searchParams) : undefined,
      requestContext: {},
      body,
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
    if (!op.public) {
      const verdict = await authorize(event as never);
      if (!verdict.isAuthorized) return { status: 401, body: '{"message":"Unauthorized"}' };
      (event.requestContext as unknown) = { authorizer: { lambda: verdict.context } };
    }
    const res = (await handlers[area(pathname)]!(event)) as APIGatewayProxyStructuredResultV2;
    return { status: res.statusCode ?? 200, body: res.body ?? "" };
  };
}

let tableName: string;
let dataTableName: string;
let parameters: ReturnType<typeof fakeParameterStore>;
let send: Send;

beforeEach(async () => {
  [tableName, dataTableName] = await Promise.all([createUsersTable(), createDataTable()]);
  parameters = fakeParameterStore();
  await bootstrap({ tableName, parameters });
  send = apiInProcess(tableName, dataTableName, parameters.values.get(SIGNING_SECRET_PARAM)!);
});

afterEach(async () => {
  await Promise.all([deleteTable(tableName), deleteTable(dataTableName)]);
});

const smoke = (through: Send, lines: string[] = [], adminPassword = async () => parameters.values.get(ADMIN_PASSWORD_PARAM)!) =>
  run({
    baseUrl: BASE,
    send: through,
    smokePassword: SMOKE_PASSWORD,
    adminPassword,
    today: new Date().toISOString().slice(0, 10),
    say: (line) => lines.push(line),
  });

describe("given a fresh deployment", () => {
  it("approves the smoke user as the admin, and passes", async () => {
    const lines: string[] = [];

    await smoke(send, lines);

    expect(lines).toContain("ok  register smoke-test (or already exists) (201)");
    expect(lines).toContain("ok  enable smoke-test (200)");
    expect(lines.at(-1)).toBe("smoke test passed");
  }, 30_000);

  it("cleans up its transactions", async () => {
    await smoke(send);

    expect((await ddb.send(new ScanCommand({ TableName: dataTableName }))).Items).toEqual([]);
  }, 30_000);
});

describe("given it has run before", () => {
  it("logs in without the admin, and passes", async () => {
    await smoke(send);
    const lines: string[] = [];

    await smoke(send, lines, async () => {
      throw new Error("the smoke user is already approved");
    });

    expect(lines).toContain("ok  register smoke-test (or already exists) (409)");
    expect(lines.at(-1)).toBe("smoke test passed");
  }, 30_000);
});

describe("given a broken API", () => {
  it("fails naming the step and what came back", async () => {
    const noSpec: Send = (method, url, headers, body) =>
      url.endsWith("/api/openapi.json")
        ? Promise.resolve({ status: 500, body: '{"error":{"code":"internal_error"}}' })
        : send(method, url, headers, body);

    await expect(smoke(noSpec)).rejects.toThrow(new SmokeFailedError("OpenAPI spec: expected 200, got 500 undefined"));
  }, 30_000);

  it("fails when an MCP tool reports an error", async () => {
    const failingTools: Send = (method, url, headers, body) => {
      const rpc = url.endsWith("/api/mcp") && body ? JSON.parse(body) : undefined;
      if (rpc?.method !== "tools/call") return send(method, url, headers, body);
      const result = { content: [{ type: "text", text: "Something went wrong" }], isError: true };
      return Promise.resolve({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) });
    };

    await expect(smoke(failingTools)).rejects.toThrow(/MCP records a transaction/);
  }, 30_000);
});
