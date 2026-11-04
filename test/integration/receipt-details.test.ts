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

// The Flybuys receipt: $30.50 of goods, of which $0.50 was money.
const RECEIPT = {
  totalCents: 3050,
  gstCents: 0,
  savingsCents: 3100,
  time: "15:06",
  location: "The Glen",
  receiptNumber: "6547",
  abn: "45004189708",
  lines: [
    { name: "PI PERFECT BAKES 450", product: "pasta bake", amountCents: 850 },
    { name: "COLES BEEF MINCE 4ST", product: "beef mince", amountCents: 1550 },
    { name: "CLS CHICKEN MINCE", product: "chicken mince", amountCents: 650 },
  ],
  payments: [
    { label: "Flybuys value redeemed", kind: "points", amountCents: 3000 },
    { label: "EFT", kind: "money", amountCents: 50 },
  ],
};

let tableName: string;
let handler: ReturnType<typeof createDataHandler>;

beforeAll(async () => {
  tableName = await createDataTable();
  handler = createDataHandler({ tableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
});

afterAll(async () => {
  await deleteTable(tableName);
});

const expense = (overrides: Record<string, unknown> = {}) => ({
  id: newUlid(),
  date: "2026-10-26",
  merchant: "Coles",
  category: "groceries",
  item: "3 items",
  amountCents: 10000,
  currency: "AUD",
  ...overrides,
});

const scanned = (receipt: Record<string, unknown> = {}) => expense({ amountCents: 50, receipt: { ...RECEIPT, ...receipt } });

const create = (user: string, body: unknown) => call(handler, "POST /api/v1/transactions", body, { auth: customer(user) });

describe("given a scanned receipt", () => {
  it("keeps every detail, and reads it back exactly", async () => {
    const body = scanned();

    const created = await create("rcpt-a", body);
    const fetched = await call(handler, "GET /api/v1/transactions/{id}", undefined, {
      auth: customer("rcpt-a"),
      params: { id: body.id },
    });

    expect(created.status).toBe(201);
    expect(created.body.receipt).toEqual(RECEIPT);
    expect(fetched.body).toEqual(created.body);
  });

  it("lists it with its details", async () => {
    await create("rcpt-b", scanned());

    const page = await call(handler, "GET /api/v1/transactions", undefined, { auth: customer("rcpt-b") });

    expect(page.body.items[0].receipt).toEqual(RECEIPT);
  });

  it("needs only what was printed", async () => {
    const created = await create("rcpt-c", expense({ receipt: { totalCents: 1774, time: "14:19" } }));

    expect([created.status, created.body.receipt]).toEqual([201, { totalCents: 1774, time: "14:19" }]);
  });

  it("can have a negative discount line", async () => {
    const lines = [{ name: "MEMBER DISCOUNT", amountCents: -200 }];

    const created = await create("rcpt-d", scanned({ lines }));

    expect([created.status, created.body.receipt.lines]).toEqual([201, lines]);
  });

  it("keeps the details through an edit that moves the date", async () => {
    const body = scanned();
    await create("rcpt-e", body);

    const edited = await call(
      handler,
      "PATCH /api/v1/transactions/{id}",
      { version: 1, date: "2026-10-20" },
      { auth: customer("rcpt-e"), params: { id: body.id } },
    );

    expect([edited.status, edited.body.receipt]).toEqual([200, RECEIPT]);
  });

  it("counts what was paid in the summary, not the goods", async () => {
    await create("rcpt-f", scanned());

    const summary = await call(handler, "GET /api/v1/transactions/summary", undefined, {
      auth: customer("rcpt-f"),
      query: { month: "2026-10" },
    });

    expect(summary.body.totalCents).toBe(50);
  });
});

describe("given an expense with no receipt", () => {
  it("has no receipt field", async () => {
    const created = await create("rcpt-g", expense());

    expect(created.body).not.toHaveProperty("receipt");
  });
});

describe("given bad receipt details", () => {
  it.each([
    ["a short ABN", { abn: "4500" }],
    ["an impossible time", { time: "25:00" }],
    ["a zero total", { totalCents: 0 }],
    ["negative GST", { gstCents: -1 }],
    ["a line without a name", { lines: [{ amountCents: 100 }] }],
    ["a payment of an unknown kind", { payments: [{ label: "EFT", kind: "cheque", amountCents: 100 }] }],
    ["too many lines", { lines: Array.from({ length: 201 }, () => ({ name: "x", amountCents: 1 })) }],
  ])("refuses %s", async (_, receipt) => {
    const res = await create("rcpt-h", expense({ receipt }));

    expect([res.status, res.body.error.code]).toEqual([400, "validation_failed"]);
  });
});
