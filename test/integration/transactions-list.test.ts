import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth/authorizer";
import { createDataHandler } from "../../src/data/handler";
import { createDataTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { newUlid } from "../support/ulid";

const customer = (userId: string): AuthContext => ({
  userId,
  role: "customer",
  scope: "transactions:read transactions:write",
});
const HOUSE = "list-house";

let tableName: string;
let handler: ReturnType<typeof createDataHandler>;

const list = (query: Record<string, string> = {}, house = HOUSE) =>
  call(handler, "GET /api/v1/transactions", undefined, { auth: customer(house), query });

/** Follows nextCursor until the end and returns every page. */
async function allPages(query: Record<string, string>) {
  const pages: { amountCents: number }[][] = [];
  let cursor: string | null = null;
  do {
    const res = await list(cursor ? { ...query, cursor } : query);
    expect(res.status).toBe(200);
    pages.push(res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor);
  return pages;
}

const amounts = (items: { amountCents: number }[]) => items.map((t) => t.amountCents);

beforeAll(async () => {
  tableName = await createDataTable();
  handler = createDataHandler({ tableName, cursorSecret: "test-cursor-secret", now: () => new Date() });

  // amountCents doubles as a label: 1000 is the oldest, 6000 the newest.
  const rows: [string, string, number][] = [
    ["2026-09-15", "groceries", 1000],
    ["2026-10-01", "transport", 2000],
    ["2026-10-05", "dining", 3000],
    ["2026-10-20", "groceries", 4000],
    ["2026-10-31", "groceries", 5000],
    ["2026-11-02", "groceries", 6000],
  ];
  for (const [date, category, amountCents] of rows) {
    await call(
      handler,
      "POST /api/v1/transactions",
      { id: newUlid(), date, category, item: "x", amountCents, currency: "AUD" },
      { auth: customer(HOUSE) },
    );
  }
  // Another customer's spending must never show up.
  await call(
    handler,
    "POST /api/v1/transactions",
    { id: newUlid(), date: "2026-10-10", category: "groceries", item: "x", amountCents: 9999, currency: "AUD" },
    { auth: customer("other") },
  );
});

afterAll(async () => {
  await deleteTable(tableName);
});

describe("GET /transactions", () => {
  describe("given a page size", () => {
    it("pages through everything, newest first", async () => {
      const pages = await allPages({ limit: "2" });

      expect(pages.every((page) => page.length <= 2)).toBe(true);
      expect(amounts(pages.flat())).toEqual([6000, 5000, 4000, 3000, 2000, 1000]);
    });
  });

  it.each([
    ["a date range", () => ({ from: "2026-10-01", to: "2026-10-31" }), [5000, 4000, 3000, 2000]],
    ["a category", () => ({ category: "groceries" }), [6000, 5000, 4000, 1000]],
    ["category and dates together", () => ({ category: "groceries", from: "2026-10-01", to: "2026-10-31" }), [5000, 4000]],
  ])("filters by %s", async (_, query, expected) => {
    const pages = await allPages({ ...query(), limit: "2" });

    expect(amounts(pages.flat())).toEqual(expected);
  });

  describe("given a cursor that was tampered with", () => {
    it("rejects it with 400 invalid_cursor", async () => {
      const first = await list({ limit: "2" });
      const [payload, signature] = (first.body.nextCursor as string).split(".");

      const res = await list({ cursor: `${payload}x.${signature}` });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_cursor");
    });
  });

  describe("given a limit over 100", () => {
    it("rejects it", async () => {
      expect((await list({ limit: "101" })).status).toBe(400);
    });
  });
});

describe("GET /transactions/summary", () => {
  describe("given a month", () => {
    it("totals that month's spending by category, largest first", async () => {
      const res = await call(handler, "GET /api/v1/transactions/summary", undefined, {
        auth: customer(HOUSE),
        query: { month: "2026-10" },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        month: "2026-10",
        currency: "AUD",
        totalCents: 14000,
        byCategory: [
          { category: "groceries", totalCents: 9000 },
          { category: "dining", totalCents: 3000 },
          { category: "transport", totalCents: 2000 },
        ],
      });
    });
  });

  describe("given a malformed month", () => {
    it("rejects it", async () => {
      const res = await call(handler, "GET /api/v1/transactions/summary", undefined, {
        auth: customer(HOUSE),
        query: { month: "2026-13" },
      });

      expect(res.status).toBe(400);
    });
  });
});

describe("GET /admin/users/{id}/transactions", () => {
  const ADMIN: AuthContext = { userId: "admin-1", role: "admin", scope: "admin:read admin:write" };
  const asAdmin = (query: Record<string, string>, auth: AuthContext = ADMIN) =>
    call(handler, "GET /api/v1/admin/users/{id}/transactions", undefined, { auth, params: { id: HOUSE }, query });

  describe("given an admin", () => {
    it("lists that customer's transactions with the same filters", async () => {
      const res = await asAdmin({ category: "groceries", from: "2026-10-01" });

      expect(res.status).toBe(200);
      expect(amounts(res.body.items)).toEqual([6000, 5000, 4000]);
    });
  });

  describe("given a customer", () => {
    it("refuses with 403", async () => {
      expect((await asAdmin({}, customer("snoop"))).status).toBe(403);
    });
  });
});
