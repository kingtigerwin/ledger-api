import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth/authorizer";
import { createDataHandler } from "../../src/data/handler";
import { createTransactionsStore } from "../../src/data/transactions-store";
import { createDataTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { newUlid } from "../support/ulid";

const TODAY = "2026-10-27";
const READ_ONLY: AuthContext = { userId: "ins-reader", role: "customer", scope: "transactions:read" };
const WRITE_ONLY: AuthContext = { userId: "ins-writer", role: "customer", scope: "transactions:write" };

const customer = (userId: string): AuthContext => ({
  userId,
  role: "customer",
  scope: "transactions:read transactions:write",
});

let tableName: string;
let handler: ReturnType<typeof createDataHandler>;

beforeAll(async () => {
  tableName = await createDataTable();
  handler = createDataHandler({ tableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
});

afterAll(async () => {
  await deleteTable(tableName);
});

const record = (user: string, fields: Record<string, unknown> = {}) =>
  call(
    handler,
    "POST /api/v1/transactions",
    { id: newUlid(), date: "2026-10-26", merchant: "Coles", category: "groceries", item: "菜", amountCents: 10000, currency: "AUD", ...fields },
    { auth: customer(user) },
  );

const recordTwice = async (user: string, fields: Record<string, unknown> = {}) => {
  await record(user, fields);
  await record(user, fields);
};

const insights = (user: string) => call(handler, "GET /api/v1/insights", undefined, { auth: customer(user), query: { today: TODAY } });

const dismiss = (user: string, id: string) =>
  call(handler, "POST /api/v1/insights/{id}/dismiss", undefined, { auth: customer(user), params: { id } });

describe("GET /insights", () => {
  describe("given the same expense recorded twice", () => {
    it("returns a card holding both transactions", async () => {
      await recordTwice("ins-a");

      const res = await insights("ins-a");

      expect(res.status).toBe(200);
      const [card, ...rest] = res.body.items;
      expect(card.type).toBe("possible_duplicate");
      expect(card.transactions[0].item).toBe("菜");
      expect(rest).toEqual([]);
    });
  });

  describe("given another customer's duplicates", () => {
    it("returns nothing", async () => {
      await recordTwice("ins-b");

      const res = await insights("ins-c");

      expect([res.status, res.body]).toEqual([200, { items: [] }]);
    });
  });

  describe("given more than one page of transactions", () => {
    it("reads every page", async () => {
      for (let cents = 1; cents <= 101; cents++) await record("ins-many", { amountCents: cents, date: "2026-10-20" });
      await recordTwice("ins-many");
      // Sorted by date then id, the oldest entries are on the last page; this pair is dated earlier.
      await recordTwice("ins-many", { date: "2026-10-01" });

      expect((await insights("ins-many")).body.items).toHaveLength(2);
    }, 30_000); // a hundred writes and more, while other files run
  });

  describe("given transactions dated after today", () => {
    it("ignores them", async () => {
      await recordTwice("ins-future", { date: "2026-10-28" });

      expect((await insights("ins-future")).body).toEqual({ items: [] });
    });
  });

  it.each([
    ["missing", undefined],
    ["in the wrong format", { today: "27-10-2026" }],
    ["not a real date", { today: "2026-02-30" }],
  ])("rejects a today that's %s", async (_, query) => {
    const res = await call(handler, "GET /api/v1/insights", undefined, { auth: customer("ins-d"), query });

    expect([res.status, res.body.error.code]).toEqual([400, "validation_failed"]);
  });

  describe("given a token without the read scope", () => {
    it("refuses it", async () => {
      const res = await call(handler, "GET /api/v1/insights", undefined, { auth: WRITE_ONLY, query: { today: TODAY } });

      expect([res.status, res.body.error.code]).toEqual([403, "forbidden"]);
    });
  });
});

describe("POST /insights/{id}/dismiss", () => {
  describe("given a card", () => {
    it("stops it coming back", async () => {
      await recordTwice("ins-e");
      const { body } = await insights("ins-e");

      const res = await dismiss("ins-e", body.items[0].id);

      expect([res.status, res.body]).toEqual([204, {}]);
      expect((await insights("ins-e")).body).toEqual({ items: [] });
    });

    it("is safe to dismiss again", async () => {
      await recordTwice("ins-f");
      const { body } = await insights("ins-f");

      expect((await dismiss("ins-f", body.items[0].id)).status).toBe(204);
      expect((await dismiss("ins-f", body.items[0].id)).status).toBe(204);
    });

    it("isn't changed by another customer's dismissal", async () => {
      await recordTwice("ins-g");
      const { body } = await insights("ins-g");

      await dismiss("ins-h", body.items[0].id);

      expect((await insights("ins-g")).body.items).toHaveLength(1);
    });
  });

  describe("given an ID that isn't an insight ID", () => {
    it("refuses it", async () => {
      const res = await dismiss("ins-i", "NOT-AN-ID");

      expect([res.status, res.body.error.code]).toEqual([400, "invalid_insight_id"]);
    });
  });

  describe("given a token without the write scope", () => {
    it("refuses it", async () => {
      const res = await call(handler, "POST /api/v1/insights/{id}/dismiss", undefined, {
        auth: READ_ONLY,
        params: { id: "0123456789abcdef" },
      });

      expect([res.status, res.body.error.code]).toEqual([403, "forbidden"]);
    });
  });
});

describe("storing a dismissal", () => {
  it("never shows it as a transaction", async () => {
    await record("ins-j");
    await dismiss("ins-j", "0123456789abcdef");

    const res = await call(handler, "GET /api/v1/transactions", undefined, { auth: customer("ins-j") });

    expect(res.body.items).toHaveLength(1);
  });

  it("is removed when the customer is deleted", async () => {
    await dismiss("ins-k", "0123456789abcdef");
    const store = createTransactionsStore(tableName);

    expect(await store.dismissedInsights("ins-k")).toEqual(new Set(["0123456789abcdef"]));
    expect(await store.deleteAll("ins-k")).toBe(1);
    expect(await store.dismissedInsights("ins-k")).toEqual(new Set());
  });
});
