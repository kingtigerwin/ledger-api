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
  mcp = createMcpHandler({ tableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
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

/** A successful tool call's JSON payload. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const payload = (res: { body: Record<string, any> }) => {
  expect(res.body.result.isError).toBeFalsy();
  return JSON.parse(res.body.result.content[0].text);
};
/** A failed tool call's message. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const failure = (res: { body: Record<string, any> }): string => {
  expect(res.body.result.isError).toBe(true);
  return res.body.result.content[0].text;
};

const getOwn = (userId: string, id: string) =>
  call(data, "GET /api/v1/transactions/{id}", undefined, { auth: customer(userId), params: { id } });
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

  describe("given a customer's own transactions", () => {
    const read = ["get_transaction", "list_transactions", "get_monthly_summary"];
    const write = ["create_transaction", "update_transaction", "delete_transaction"];

    it("offers every Transactions endpoint as a tool, marking reads read-only and delete destructive", async () => {
      const res = await rpc(customer("mcp-tools"), "tools/list");

      const tools = Object.fromEntries(res.body.result.tools.map((t: { name: string }) => [t.name, t]));
      expect(Object.keys(tools).sort()).toEqual([...read, ...write].sort());
      for (const name of read) expect(tools[name].annotations.readOnlyHint).toBe(true);
      expect(tools.delete_transaction.annotations.destructiveHint).toBe(true);
      expect(tools.update_transaction.inputSchema.required).toEqual(expect.arrayContaining(["id", "version"]));
    });

    it("get_transaction returns one by id", async () => {
      const created = payload(await callTool(customer("mcp-get"), "create_transaction", cake));

      const fetched = payload(await callTool(customer("mcp-get"), "get_transaction", { id: created.id }));

      expect(fetched).toEqual(created);
    });

    it("get_transaction can't see another customer's transaction", async () => {
      const theirs = payload(await callTool(customer("mcp-get-owner"), "create_transaction", cake));

      const message = failure(await callTool(customer("mcp-get-other"), "get_transaction", { id: theirs.id }));

      expect(message).toMatch(/no such transaction/i);
    });

    it("list_transactions pages through the customer's own transactions, newest first, with filters", async () => {
      const who = customer("mcp-list-own");
      for (const [date, category, amountCents] of [
        ["2026-10-01", "groceries", 100],
        ["2026-10-02", "dining", 200],
        ["2026-10-03", "groceries", 300],
      ] as const) {
        await callTool(who, "create_transaction", { ...cake, date, category, amountCents });
      }

      const first = payload(await callTool(who, "list_transactions", { limit: 2 }));
      const second = payload(await callTool(who, "list_transactions", { limit: 2, cursor: first.nextCursor }));
      const groceries = payload(await callTool(who, "list_transactions", { category: "groceries" }));

      expect(first.items.map((t: { amountCents: number }) => t.amountCents)).toEqual([300, 200]);
      expect(second.items.map((t: { amountCents: number }) => t.amountCents)).toEqual([100]);
      expect(second.nextCursor).toBeNull();
      expect(groceries.items.map((t: { amountCents: number }) => t.amountCents)).toEqual([300, 100]);
    });

    it("list_transactions refuses a tampered cursor", async () => {
      const message = failure(await callTool(customer("mcp-cursor"), "list_transactions", { cursor: "bad.cursor" }));

      expect(message).toMatch(/cursor/i);
    });

    it("get_monthly_summary totals a month by category, largest first", async () => {
      const who = customer("mcp-summary");
      await callTool(who, "create_transaction", { ...cake, date: "2026-09-30", amountCents: 9999 });
      await callTool(who, "create_transaction", { ...cake, date: "2026-10-05", category: "dining", amountCents: 1500 });
      await callTool(who, "create_transaction", { ...cake, date: "2026-10-06", amountCents: 3000 });
      await callTool(who, "create_transaction", { ...cake, date: "2026-10-07", amountCents: 500 });

      const summary = payload(await callTool(who, "get_monthly_summary", { month: "2026-10" }));

      expect(summary).toEqual({
        month: "2026-10",
        currency: "AUD",
        totalCents: 5000,
        byCategory: [
          { category: "groceries", totalCents: 3500 },
          { category: "dining", totalCents: 1500 },
        ],
      });
    });

    it("update_transaction applies a change at the current version", async () => {
      const who = customer("mcp-update");
      const created = payload(await callTool(who, "create_transaction", cake));

      const updated = payload(
        await callTool(who, "update_transaction", { id: created.id, version: 1, amountCents: 3500, note: "and candles" }),
      );

      expect(updated).toMatchObject({ id: created.id, version: 2, amountCents: 3500, note: "and candles", item: "cake" });
      expect((await getOwn("mcp-update", created.id)).body).toEqual(updated);
    });

    it("update_transaction refuses a stale version and keeps the newer change", async () => {
      const who = customer("mcp-stale");
      const created = payload(await callTool(who, "create_transaction", cake));
      await callTool(who, "update_transaction", { id: created.id, version: 1, amountCents: 3500 });

      const message = failure(await callTool(who, "update_transaction", { id: created.id, version: 1, amountCents: 1 }));

      expect(message).toMatch(/changed/i);
      expect((await getOwn("mcp-stale", created.id)).body.amountCents).toBe(3500);
    });

    it("delete_transaction removes it, and a second delete reports it's gone", async () => {
      const who = customer("mcp-delete");
      const created = payload(await callTool(who, "create_transaction", cake));

      payload(await callTool(who, "delete_transaction", { id: created.id }));
      const again = failure(await callTool(who, "delete_transaction", { id: created.id }));

      expect((await getOwn("mcp-delete", created.id)).status).toBe(404);
      expect(again).toMatch(/no such transaction/i);
    });

    it("delete_transaction leaves another customer's transaction alone", async () => {
      const theirs = payload(await callTool(customer("mcp-del-owner"), "create_transaction", cake));

      failure(await callTool(customer("mcp-del-other"), "delete_transaction", { id: theirs.id }));

      expect((await getOwn("mcp-del-owner", theirs.id)).status).toBe(200);
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

    it("offers only the read tools", async () => {
      const res = await rpc(readOnly, "tools/list");

      expect(res.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        "get_monthly_summary",
        "get_transaction",
        "list_transactions",
      ]);
    });

    it("refuses update_transaction and delete_transaction", async () => {
      for (const name of ["update_transaction", "delete_transaction"]) {
        const res = await callTool(readOnly, name, { id: "01J0000000000000000000000A", version: 1 });

        expect(res.body.result?.isError ?? Boolean(res.body.error)).toBe(true);
      }
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
