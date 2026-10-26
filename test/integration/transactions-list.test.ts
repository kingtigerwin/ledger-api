import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth/authorizer";
import { createDataHandler } from "../../src/data/handler";
import { createDataTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { newUlid } from "../support/ulid";

const customer = (userId: string): AuthContext => ({
  userId,
  role: "customer",
  scope: "members:read members:write transactions:read transactions:write",
});
const HOUSE = "list-house";

let tableName: string;
let handler: ReturnType<typeof createDataHandler>;
let mom: string;
let dad: string;

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
  const addMember = async (name: string) =>
    (await call(handler, "POST /api/v1/members", { name }, { auth: customer(HOUSE) })).body.id as string;
  mom = await addMember("mom");
  dad = await addMember("dad");

  // amountCents doubles as a label: 1000 is the oldest, 6000 the newest.
  const rows: [string, string, string, number][] = [
    ["2026-09-15", mom, "groceries", 1000],
    ["2026-10-01", dad, "transport", 2000],
    ["2026-10-05", mom, "dining", 3000],
    ["2026-10-20", mom, "groceries", 4000],
    ["2026-10-31", dad, "groceries", 5000],
    ["2026-11-02", mom, "groceries", 6000],
  ];
  for (const [date, memberId, category, amountCents] of rows) {
    await call(
      handler,
      "POST /api/v1/transactions",
      { id: newUlid(), memberId, date, category, item: "x", amountCents, currency: "AUD" },
      { auth: customer(HOUSE) },
    );
  }
  // Another household's spending must never show up.
  const other = (await call(handler, "POST /api/v1/members", { name: "x" }, { auth: customer("other") })).body.id;
  await call(
    handler,
    "POST /api/v1/transactions",
    { id: newUlid(), memberId: other, date: "2026-10-10", category: "groceries", item: "x", amountCents: 9999, currency: "AUD" },
    { auth: customer("other") },
  );
});

afterAll(async () => {
  await deleteTable(tableName);
});

describe("GET /transactions", () => {
  describe("given a page size", () => {
    it("pages through everything, newest first, with the member's name", async () => {
      const pages = await allPages({ limit: "2" });

      expect(pages.every((page) => page.length <= 2)).toBe(true);
      expect(amounts(pages.flat())).toEqual([6000, 5000, 4000, 3000, 2000, 1000]);
      expect(pages[0]![0]).toMatchObject({ memberName: "mom" });
    });
  });

  it.each([
    ["a date range", () => ({ from: "2026-10-01", to: "2026-10-31" }), [5000, 4000, 3000, 2000]],
    ["a member", () => ({ memberId: mom }), [6000, 4000, 3000, 1000]],
    ["a category", () => ({ category: "groceries" }), [6000, 5000, 4000, 1000]],
    [
      "member, category and dates together",
      () => ({ memberId: mom, category: "groceries", from: "2026-10-01", to: "2026-10-31" }),
      [4000],
    ],
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
