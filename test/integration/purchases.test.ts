import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth/authorizer";
import { createDataHandler } from "../../src/data/handler";
import { createDataTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { newUlid } from "../support/ulid";

const ROUTE = "GET /api/v1/transactions/purchases";
const WRITE_ONLY: AuthContext = { userId: "pur-writer", role: "customer", scope: "transactions:write" };
const NOW = new Date("2026-11-01T03:00:00Z");
const BANANAS = { name: "BANANAS PERKG", product: "bananas", amountCents: 284 };

const customer = (userId: string): AuthContext => ({
  userId,
  role: "customer",
  scope: "transactions:read transactions:write",
});

let tableName: string;
let handler: ReturnType<typeof createDataHandler>;
/** For what depends on today. New IDs carry the real time, so nothing can be recorded through this one. */
let stoppedClock: ReturnType<typeof createDataHandler>;

beforeAll(async () => {
  tableName = await createDataTable();
  handler = createDataHandler({ tableName, cursorSecret: "s", now: () => new Date() });
  stoppedClock = createDataHandler({ tableName, cursorSecret: "s", now: () => NOW });
});

afterAll(async () => {
  await deleteTable(tableName);
});

const record = (user: string, fields: Record<string, unknown>) =>
  call(
    handler,
    "POST /api/v1/transactions",
    { id: newUlid(), date: "2026-10-26", category: "groceries", item: "菜", amountCents: 10000, currency: "AUD", ...fields },
    { auth: customer(user) },
  );

const shop = (user: string, date: string) =>
  record(user, { date, item: "2 items", receipt: { totalCents: 1000, lines: [BANANAS, { name: "BREAD", amountCents: 716 }] } });

/** Over the whole of 2026 unless told otherwise, so the real date doesn't matter. */
const search = (user: string, query: Record<string, string>) =>
  call(handler, ROUTE, undefined, { auth: customer(user), query: { from: "2026-01-01", to: "2026-12-31", ...query } });

describe("GET /transactions/purchases", () => {
  describe("given receipts and typed expenses", () => {
    it("finds both and adds them up", async () => {
      await shop("pur-a", "2026-10-20");
      await record("pur-a", { date: "2026-10-21", item: "bananas", amountCents: 300 });

      const res = await search("pur-a", { q: "banana" });

      expect(res.status).toBe(200);
      expect([res.body.count, res.body.totalCents]).toEqual([2, 584]);
      expect(res.body.matches.map((match: { date: string }) => match.date)).toEqual(["2026-10-21", "2026-10-20"]);
    });
  });

  describe("given several terms", () => {
    it("takes them separated by commas", async () => {
      await record("pur-b", { date: "2026-10-20", item: "新鲜香蕉", amountCents: 300 });

      expect((await search("pur-b", { q: "banana, 香蕉" })).body.count).toBe(1);
    });
  });

  describe("given another customer's purchases", () => {
    it("finds nothing", async () => {
      await shop("pur-c", "2026-10-20");

      expect((await search("pur-d", { q: "banana" })).body.count).toBe(0);
    });
  });

  describe("given a date range", () => {
    it("searches only inside it, and says what it covered", async () => {
      for (const date of ["2026-09-30", "2026-10-01", "2026-10-31", "2026-11-01"]) await shop("pur-e", date);

      const res = await search("pur-e", { q: "banana", from: "2026-10-01", to: "2026-10-31" });

      expect(res.body.count).toBe(2);
      expect([res.body.from, res.body.to]).toEqual(["2026-10-01", "2026-10-31"]);
    });
  });

  describe("given no dates", () => {
    it("covers the 400 days up to today", async () => {
      const res = await call(stoppedClock, ROUTE, undefined, { auth: customer("pur-f"), query: { q: "banana" } });

      expect([res.body.from, res.body.to]).toEqual(["2025-09-27", "2026-11-01"]);
    });

    it("counts back from a given end", async () => {
      const res = await call(stoppedClock, ROUTE, undefined, {
        auth: customer("pur-f"),
        query: { q: "banana", to: "2026-01-31" },
      });

      expect(res.body.from).toBe("2024-12-27");
    });
  });

  describe("given more than one page of transactions", () => {
    it("reads them all", async () => {
      for (let cents = 1; cents <= 103; cents++) {
        await record("pur-g", { date: "2026-10-20", item: "bananas", amountCents: cents });
      }

      expect((await search("pur-g", { q: "banana" })).body.count).toBe(103);
    });
  });

  it.each([
    ["no terms", {}, "validation_failed"],
    ["only commas", { q: " , " }, "validation_failed"],
    ["too many terms", { q: "abcdefghijk".split("").join(",") }, "validation_failed"],
    ["a bad date", { q: "a", from: "soon" }, "validation_failed"],
    ["a range that runs backwards", { q: "a", from: "2026-10-02", to: "2026-10-01" }, "invalid_date_range"],
    ["a range that's too long", { q: "a", from: "2020-01-01", to: "2026-10-01" }, "invalid_date_range"],
  ])("refuses a bad search: %s", async (_, query: Record<string, string>, code) => {
    const res = await call(handler, ROUTE, undefined, { auth: customer("pur-h"), query });

    expect([res.status, res.body.error.code]).toEqual([400, code]);
  });

  describe("given a token without the read scope", () => {
    it("refuses it", async () => {
      const res = await call(handler, ROUTE, undefined, { auth: WRITE_ONLY, query: { q: "banana" } });

      expect([res.status, res.body.error.code]).toEqual([403, "forbidden"]);
    });
  });
});
