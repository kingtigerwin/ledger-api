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

let tableName: string;
let handler: ReturnType<typeof createDataHandler>;

beforeAll(async () => {
  tableName = await createDataTable();
  handler = createDataHandler({ tableName, cursorSecret: "test-cursor-secret", now: () => new Date() });
});

afterAll(async () => {
  await deleteTable(tableName);
});

async function addMember(house: string, name: string): Promise<string> {
  const res = await call(handler, "POST /api/v1/members", { name }, { auth: customer(house) });
  return res.body.id;
}

/** The example transaction from the design, with overrides. */
const expense = (memberId: string, overrides: Record<string, unknown> = {}) => ({
  id: newUlid(),
  memberId,
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
const get = (house: string, id: string) =>
  call(handler, "GET /api/v1/transactions/{id}", undefined, { auth: customer(house), params: { id } });

describe("POST /transactions and GET /transactions/{id}", () => {
  describe("given a valid expense", () => {
    it("records it, and it reads back with the member's name", async () => {
      const mom = await addMember("tx-house-a", "mom");
      const body = expense(mom);

      const created = await create("tx-house-a", body);
      const fetched = await get("tx-house-a", body.id);

      const expected = {
        ...body,
        memberName: "mom",
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
      const dad = await addMember("tx-house-b", "dad");
      const body = expense(dad);
      await create("tx-house-b", body);

      const res = await get("tx-house-c", body.id);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("transaction_not_found");
    });
  });
});
