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

let tableName: string;
let handler: ReturnType<typeof createDataHandler>;

beforeAll(async () => {
  tableName = await createDataTable();
  handler = createDataHandler({ tableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
});

afterAll(async () => {
  await deleteTable(tableName);
});

/** The example transaction from the design, with overrides. */
const expense = (overrides: Record<string, unknown> = {}) => ({
  id: newUlid(),
  date: "2026-10-26",
  merchant: "Coles",
  category: "groceries",
  item: "菜",
  amountCents: 10000,
  currency: "AUD",
  note: "这些菜是用来准备一家人下一周的食材",
  ...overrides,
});

const create = (house: string, body: unknown) =>
  call(handler, "POST /api/v1/transactions", body, { auth: customer(house) });
const patch = (house: string, id: string, body: unknown) =>
  call(handler, "PATCH /api/v1/transactions/{id}", body, { auth: customer(house), params: { id } });
const remove = (house: string, id: string) =>
  call(handler, "DELETE /api/v1/transactions/{id}", undefined, { auth: customer(house), params: { id } });
const get = (house: string, id: string) =>
  call(handler, "GET /api/v1/transactions/{id}", undefined, { auth: customer(house), params: { id } });

describe("POST /transactions and GET /transactions/{id}", () => {
  describe("given a valid expense", () => {
    it("records it against the signed-in customer and it reads back the same", async () => {
      const body = expense();

      const created = await create("tx-house-a", body);
      const fetched = await get("tx-house-a", body.id);

      const expected = {
        ...body,
        version: 1,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      };
      expect(created.status).toBe(201);
      expect(created.body).toEqual(expected);
      expect(fetched.status).toBe(200);
      expect(fetched.body).toEqual(expected);
    });
  });

  describe("given another household's transaction id", () => {
    it("returns 404", async () => {
      const body = expense();
      await create("tx-house-b", body);

      const res = await get("tx-house-c", body.id);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("transaction_not_found");
    });
  });

  describe("given the same id sent twice, as a retry would", () => {
    it("returns the original record with 200 and keeps a single transaction", async () => {
      const body = expense();
      const first = await create("tx-house-d", body);

      const retry = await create("tx-house-d", { ...body, amountCents: 99999 });

      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect((await get("tx-house-d", body.id)).body.amountCents).toBe(10000);
    });
  });

  describe("given invalid input", () => {
    it.each([
      ["an id that isn't a ULID", { id: "not-a-ulid" }],
      ["a currency other than AUD", { currency: "USD" }],
      ["a zero amount", { amountCents: 0 }],
      ["a fractional amount", { amountCents: 10.5 }],
      ["an unknown category", { category: "gambling" }],
      ["an impossible date", { date: "2026-02-30" }],
    ])("rejects %s with 400", async (_, overrides) => {
      const res = await create("tx-house-e", expense(overrides));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_failed");
    });

    it("rejects an id dated more than 5 minutes in the future", async () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const res = await create("tx-house-e", expense({ id: newUlid(tomorrow) }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_id");
    });

    it("ignores a memberId, which transactions no longer have", async () => {
      const body = expense();

      const res = await create("tx-house-e", { ...body, memberId: "mom" });

      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty("memberId");
      expect(res.body).not.toHaveProperty("memberName");
    });
  });
});

describe("PATCH /transactions/{id}", () => {
  describe("given the current version", () => {
    it("applies the change and bumps the version", async () => {
      const body = expense();
      await create("tx-house-f", body);

      const res = await patch("tx-house-f", body.id, { version: 1, amountCents: 12000, note: "plus fruit" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: body.id, amountCents: 12000, note: "plus fruit", item: "菜", version: 2 });
      expect((await get("tx-house-f", body.id)).body).toEqual(res.body);
    });
  });

  describe("given a version someone else already changed", () => {
    it("refuses with 409 version_conflict and keeps their change", async () => {
      const body = expense();
      await create("tx-house-g", body);
      await patch("tx-house-g", body.id, { version: 1, amountCents: 5000 });

      const res = await patch("tx-house-g", body.id, { version: 1, amountCents: 7000 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("version_conflict");
      expect((await get("tx-house-g", body.id)).body.amountCents).toBe(5000);
    });
  });

  describe("given a new date", () => {
    it("moves the transaction and it's still found by id", async () => {
      const body = expense();
      await create("tx-house-h", body);

      const res = await patch("tx-house-h", body.id, { version: 1, date: "2026-09-01" });

      expect(res.status).toBe(200);
      expect((await get("tx-house-h", body.id)).body).toMatchObject({ date: "2026-09-01", version: 2 });
    });
  });

  describe("given another household's transaction", () => {
    it("returns 404", async () => {
      const body = expense();
      await create("tx-house-i", body);

      const res = await patch("tx-house-j", body.id, { version: 1, amountCents: 1 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("transaction_not_found");
    });
  });
});

describe("DELETE /transactions/{id}", () => {
  describe("given the household's own transaction", () => {
    it("deletes it", async () => {
      const body = expense();
      await create("tx-house-k", body);

      const res = await remove("tx-house-k", body.id);

      expect(res.status).toBe(204);
      expect((await get("tx-house-k", body.id)).status).toBe(404);
    });
  });

  describe("given another household's transaction", () => {
    it("returns 404 and leaves it alone", async () => {
      const body = expense();
      await create("tx-house-l", body);

      const res = await remove("tx-house-m", body.id);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("transaction_not_found");
      expect((await get("tx-house-l", body.id)).status).toBe(200);
    });
  });
});

