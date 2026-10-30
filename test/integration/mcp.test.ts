import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth/authorizer";
import { createUsersStore } from "../../src/auth/users-store";
import { createLedger } from "../../src/data/ledger";
import { ApiError } from "../../src/http";
import { isUlid } from "../../src/data/ulid";
import { createMcpHandler } from "../../src/mcp/handler";
import { createDataTable, createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";

const customer = (userId: string): AuthContext => ({
  userId,
  role: "customer",
  scope: "transactions:read transactions:write",
});

let tableName: string;
let usersTableName: string;
let mcp: ReturnType<typeof createMcpHandler>;
let ledger: ReturnType<typeof createLedger>;

beforeAll(async () => {
  [tableName, usersTableName] = await Promise.all([createDataTable(), createUsersTable()]);
  mcp = createMcpHandler({ tableName, usersTableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
  ledger = createLedger({ tableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
});

afterAll(async () => {
  await Promise.all([deleteTable(tableName), deleteTable(usersTableName)]);
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

// What the customer would see over REST, read through the same rules the tools use (src/data/ledger.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getOwn = async (userId: string, id: string): Promise<{ status: number; body: Record<string, any> }> => {
  try {
    return { status: 200, body: await ledger.get(userId, id) };
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, body: { error: { code: err.code } } };
    throw err;
  }
};
const listOwn = async (userId: string) => ({ status: 200, body: await ledger.list(userId, { from: "2026-10-01", limit: 50 }) });

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

  describe("given an admin token", () => {
    const admin = (userId: string): AuthContext => ({
      userId,
      role: "admin",
      scope: "admin:read admin:write transactions:read transactions:write",
    });
    const signUp = (username: string) =>
      createUsersStore(usersTableName).create({
        username,
        passwordHash: "not-a-real-hash",
        role: "customer",
        status: "active",
        now: new Date(),
      });
    // Other tests share the table; this month is only used here.
    const inJan = { from: "2025-01-01", to: "2025-01-31" };
    const amounts = (page: { items: { amountCents: number }[] }) => page.items.map((t) => t.amountCents);

    it("offers list_all_transactions as a read-only tool with the list filters", async () => {
      const res = await rpc(admin("mcp-admin-tools"), "tools/list");

      const tool = res.body.result.tools.find((t: { name: string }) => t.name === "list_all_transactions");
      expect(tool).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
        "category",
        "cursor",
        "from",
        "limit",
        "to",
        "username",
      ]);
    });

    it("lists every customer's transactions, newest first, each with its userId and username", async () => {
      const haoran = await signUp(`haoran-${randomUUID()}`);
      const sisi = await signUp(`sisi-${randomUUID()}`);
      await callTool(customer(haoran.id), "create_transaction", { ...cake, date: "2025-01-02", amountCents: 100 });
      await callTool(customer(sisi.id), "create_transaction", { ...cake, date: "2025-01-03", amountCents: 200 });
      await callTool(customer(haoran.id), "create_transaction", { ...cake, date: "2025-01-04", amountCents: 300 });

      const all = payload(await callTool(admin("mcp-admin-all"), "list_all_transactions", inJan));

      expect(all.items.map((t: { userId: string; username: string; amountCents: number }) => [t.username, t.amountCents]))
        .toEqual([[haoran.username, 300], [sisi.username, 200], [haoran.username, 100]]);
      expect(all.items[0]).toMatchObject({ ...cake, userId: haoran.id, date: "2025-01-04", amountCents: 300 });
      expect(all.nextCursor).toBeNull();
    });

    it("pages and filters by category like the REST route", async () => {
      const kim = await signUp(`kim-${randomUUID()}`);
      for (const [date, category, amountCents] of [
        ["2025-02-01", "groceries", 1],
        ["2025-02-02", "dining", 2],
        ["2025-02-03", "groceries", 3],
      ] as const) {
        await callTool(customer(kim.id), "create_transaction", { ...cake, date, category, amountCents });
      }
      const inFeb = { from: "2025-02-01", to: "2025-02-28" };
      const who = admin("mcp-admin-pages");

      const first = payload(await callTool(who, "list_all_transactions", { ...inFeb, limit: 2 }));
      const second = payload(await callTool(who, "list_all_transactions", { ...inFeb, limit: 2, cursor: first.nextCursor }));
      const groceries = payload(await callTool(who, "list_all_transactions", { ...inFeb, category: "groceries" }));

      expect(amounts(first)).toEqual([3, 2]);
      expect(amounts(second)).toEqual([1]);
      expect(second.nextCursor).toBeNull();
      expect(amounts(groceries)).toEqual([3, 1]);
      expect(second.items[0].username).toBe(kim.username);
    });

    it("gives a transaction whose user can't be found a null username", async () => {
      await callTool(customer("mcp-admin-no-profile"), "create_transaction", { ...cake, date: "2025-03-01" });

      const all = payload(
        await callTool(admin("mcp-admin-missing"), "list_all_transactions", { from: "2025-03-01", to: "2025-03-01" }),
      );

      expect(all.items).toEqual([expect.objectContaining({ userId: "mcp-admin-no-profile", username: null })]);
    });

    describe("filtering by username", () => {
      const inApr = { from: "2025-04-01", to: "2025-04-30" };

      it("lists only that customer's transactions, newest first, paging and filtering as usual", async () => {
        const haoran = await signUp(`haoran-${randomUUID()}`);
        const sisi = await signUp(`sisi-${randomUUID()}`);
        for (const [who, date, category, amountCents] of [
          [haoran, "2025-04-01", "groceries", 1],
          [sisi, "2025-04-02", "groceries", 2],
          [haoran, "2025-04-03", "dining", 3],
          [haoran, "2025-04-04", "groceries", 4],
        ] as const) {
          await callTool(customer(who.id), "create_transaction", { ...cake, date, category, amountCents });
        }
        const who = admin("mcp-admin-by-name");
        const query = { ...inApr, username: haoran.username };

        const first = payload(await callTool(who, "list_all_transactions", { ...query, limit: 2 }));
        const second = payload(await callTool(who, "list_all_transactions", { ...query, limit: 2, cursor: first.nextCursor }));
        const groceries = payload(await callTool(who, "list_all_transactions", { ...query, category: "groceries" }));

        expect(amounts(first)).toEqual([4, 3]);
        expect(amounts(second)).toEqual([1]);
        expect(second.nextCursor).toBeNull();
        expect(amounts(groceries)).toEqual([4, 1]);
        expect(first.items[0]).toMatchObject({ userId: haoran.id, username: haoran.username, date: "2025-04-04" });
      });

      it("matches the username in any case", async () => {
        const kim = await signUp(`kim-${randomUUID()}`);
        await callTool(customer(kim.id), "create_transaction", { ...cake, date: "2025-04-15", amountCents: 15 });

        const page = payload(
          await callTool(admin("mcp-admin-case"), "list_all_transactions", { ...inApr, username: kim.username.toUpperCase() }),
        );

        expect(page.items).toEqual([expect.objectContaining({ userId: kim.id, username: kim.username, amountCents: 15 })]);
      });

      it("reports an unknown username as an error, not as no spending", async () => {
        const message = failure(
          await callTool(admin("mcp-admin-nobody"), "list_all_transactions", { username: `nobody-${randomUUID()}` }),
        );

        expect(message).toMatch(/no such user/i);
      });

      it("refuses a cursor from the unfiltered list", async () => {
        const lee = await signUp(`lee-${randomUUID()}`);
        await callTool(customer(lee.id), "create_transaction", { ...cake, date: "2025-04-20" });
        await callTool(customer(lee.id), "create_transaction", { ...cake, date: "2025-04-21" });
        const who = admin("mcp-admin-mixed-cursor");
        const unfiltered = payload(await callTool(who, "list_all_transactions", { ...inApr, limit: 1 }));

        const message = failure(
          await callTool(who, "list_all_transactions", { ...inApr, username: lee.username, cursor: unfiltered.nextCursor }),
        );

        expect(message).toMatch(/cursor/i);
      });
    });

    it("refuses a tampered cursor", async () => {
      const message = failure(
        await callTool(admin("mcp-admin-cursor"), "list_all_transactions", { cursor: "bad.cursor" }),
      );

      expect(message).toMatch(/cursor/i);
    });
  });

  describe("given a customer token, even one carrying admin:read", () => {
    const pretender: AuthContext = { userId: "mcp-pretender", role: "customer", scope: "admin:read transactions:read" };

    it("hides list_all_transactions and refuses to call it", async () => {
      const tools = await rpc(customer("mcp-not-admin"), "tools/list");
      const pretenderTools = await rpc(pretender, "tools/list");
      const res = await callTool(customer("mcp-not-admin"), "list_all_transactions", {});
      const pretenderRes = await callTool(pretender, "list_all_transactions", {});

      for (const list of [tools, pretenderTools]) {
        expect(list.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("list_all_transactions");
      }
      for (const call of [res, pretenderRes]) expect(call.body.result?.isError ?? Boolean(call.body.error)).toBe(true);
    });
  });

  describe("given an admin token without admin:read", () => {
    it("hides list_all_transactions", async () => {
      const res = await rpc({ userId: "mcp-admin-tx-only", role: "admin", scope: "transactions:read" }, "tools/list");

      expect(res.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("list_all_transactions");
    });
  });

  describe("given no authorizer context", () => {
    it("refuses with 401", async () => {
      const res = await rpc(undefined, "tools/list");

      expect(res.status).toBe(401);
    });
  });
});
