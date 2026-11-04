// The MCP endpoint as an agent sees it: the SDK's own client, over Streamable HTTP, into the Lambda handler.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHandler } from "../../src/mcp/handler";
import { createDataTable, createUsersTable, deleteTable } from "../support/dynamo";

const URL_ = "https://ledger.example/api/mcp";
const TOKEN = "customer-token";

let tableName: string;
let usersTableName: string;
let mcp: ReturnType<typeof createMcpHandler>;

beforeAll(async () => {
  [tableName, usersTableName] = await Promise.all([createDataTable(), createUsersTable()]);
  mcp = createMcpHandler({ tableName, usersTableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
});

afterAll(async () => {
  await Promise.all([deleteTable(tableName), deleteTable(usersTableName)]);
});

/** Each request as API Gateway would hand it to the Lambda, behind an authorizer that knows one token. */
async function throughApiGateway(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 }); // the only route is POST
  const event = {
    routeKey: "POST /api/mcp",
    rawPath: new URL(request.url).pathname,
    headers: Object.fromEntries(request.headers),
    requestContext: {
      authorizer: { lambda: { userId: "agent-user", role: "customer", scope: "transactions:read transactions:write" } },
    },
    body: await request.text(),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
  const res = (await mcp(event)) as APIGatewayProxyStructuredResultV2;
  return new Response(res.statusCode === 202 ? null : (res.body ?? null), {
    status: res.statusCode,
    headers: res.headers as Record<string, string>,
  });
}

/** Connected as an agent would be: stateless, with the customer's token on every request. */
async function connect() {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: throughApiGateway,
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

const text = (result: CallToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

describe("given the SDK's client with a customer's token", () => {
  it("lists the customer's tools", async () => {
    const client = await connect();

    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toContain("create_transaction");
  });

  it("records an expense and reads it back", async () => {
    const client = await connect();
    const cake = { date: "2026-10-27", category: "groceries", item: "cake", amountCents: 3000 };

    const created = (await client.callTool({ name: "create_transaction", arguments: cake })) as CallToolResult;
    const listed = (await client.callTool({ name: "list_transactions", arguments: {} })) as CallToolResult;
    await client.close();

    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(listed)).items).toEqual([JSON.parse(text(created))]);
  });

  it("gets a rejected call back as a tool error with its message", async () => {
    const client = await connect();

    const result = (await client.callTool({
      name: "get_transaction",
      arguments: { id: "01J0000000000000000000000A" },
    })) as CallToolResult;
    await client.close();

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("No such transaction");
  });
});
