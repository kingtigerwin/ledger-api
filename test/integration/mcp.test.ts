import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth/authorizer";
import { createDataHandler } from "../../src/data/handler";
import { isUlid } from "../../src/data/ulid";
import { createMcpHandler } from "../../src/mcp/handler";
import { createDataTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";

const customer = (userId: string): AuthContext => ({
  userId,
  role: "customer",
  scope: "transactions:read transactions:write",
});

let tableName: string;
let mcp: ReturnType<typeof createMcpHandler>;
let data: ReturnType<typeof createDataHandler>;

beforeAll(async () => {
  tableName = await createDataTable();
  mcp = createMcpHandler({ tableName, now: () => new Date() });
  data = createDataHandler({ tableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
});

afterAll(async () => {
  await deleteTable(tableName);
});

let nextId = 1;
/** Sends one JSON-RPC request to POST /api/mcp, as an MCP client over Streamable HTTP would. */
const rpc = (auth: AuthContext | undefined, method: string, params: Record<string, unknown> = {}) =>
  call(
    mcp,
    "POST /api/mcp",
    { jsonrpc: "2.0", id: nextId++, method, params },
    { auth, headers: { accept: "application/json, text/event-stream" } },
  );

const callTool = (auth: AuthContext, name: string, args: Record<string, unknown>) =>
  rpc(auth, "tools/call", { name, arguments: args });

/** "today I went to woolworth and bought 30 dollars for cake", as Claude would fill the tool in. */
const cake = {
  date: "2026-10-27",
  merchant: "Woolworths",
  category: "groceries",
  item: "cake",
  amountCents: 3000,
};

const listOwn = (userId: string) =>
  call(data, "GET /api/v1/transactions", undefined, { auth: customer(userId), query: { from: "2026-10-01" } });

describe("POST /api/mcp", () => {
  describe("given a signed-in customer starting a session", () => {
    it("introduces itself as ledger-api and offers tools", async () => {
      const res = await rpc(customer("mcp-init"), "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-agent", version: "1.0.0" },
      });

      expect(res.status).toBe(200);
      expect(res.body.result.serverInfo.name).toBe("ledger-api");
      expect(res.body.result.capabilities).toHaveProperty("tools");
    });
  });

  describe("given a customer who can record transactions", () => {
    it("lists create_transaction, asking only for what the customer said, not the id or currency", async () => {
      const res = await rpc(customer("mcp-list"), "tools/list");

      const tool = res.body.result.tools.find((t: { name: string }) => t.name === "create_transaction");
      expect(tool).toBeDefined();
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["date", "category", "item", "amountCents"]));
      expect(tool.inputSchema.properties.category.enum).toContain("groceries");
      expect(tool.inputSchema.properties).not.toHaveProperty("id");
      expect(tool.inputSchema.properties).not.toHaveProperty("currency");
    });

    it("records the expense against that customer, in AUD with a new ULID, and returns it", async () => {
      const res = await callTool(customer("mcp-cake"), "create_transaction", cake);

      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBeFalsy();
      const stored = JSON.parse(res.body.result.content[0].text);
      expect(stored).toMatchObject({ ...cake, currency: "AUD", version: 1 });
      expect(isUlid(stored.id)).toBe(true);

      const own = await listOwn("mcp-cake");
      expect(own.body.items).toEqual([stored]);
    });

    it("keeps the expense out of other customers' ledgers", async () => {
      await callTool(customer("mcp-owner"), "create_transaction", cake);

      const others = await listOwn("mcp-someone-else");
      expect(others.body.items).toEqual([]);
    });

    it("records two identical expenses as two transactions", async () => {
      await callTool(customer("mcp-twice"), "create_transaction", cake);
      await callTool(customer("mcp-twice"), "create_transaction", cake);

      const own = await listOwn("mcp-twice");
      expect(own.body.items).toHaveLength(2);
    });
  });

  describe("given an expense the API would reject", () => {
    it("reports a tool error and records nothing", async () => {
      const res = await callTool(customer("mcp-invalid"), "create_transaction", { ...cake, category: "cake" });

      expect(res.body.result?.isError ?? Boolean(res.body.error)).toBe(true);
      const own = await listOwn("mcp-invalid");
      expect(own.body.items).toEqual([]);
    });
  });

  describe("given a token without the transactions:write scope", () => {
    const readOnly: AuthContext = { userId: "mcp-read-only", role: "customer", scope: "transactions:read" };

    it("doesn't offer create_transaction", async () => {
      const res = await rpc(readOnly, "tools/list");

      expect(res.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("create_transaction");
    });

    it("refuses to call it", async () => {
      const res = await callTool(readOnly, "create_transaction", cake);

      expect(res.body.result?.isError ?? Boolean(res.body.error)).toBe(true);
      const own = await listOwn("mcp-read-only");
      expect(own.body.items).toEqual([]);
    });
  });

  describe("given no authorizer context", () => {
    it("refuses with 401", async () => {
      const res = await rpc(undefined, "tools/list");

      expect(res.status).toBe(401);
    });
  });
});
