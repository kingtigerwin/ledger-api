import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth/authorizer";
import { createDataHandler } from "../../src/data/handler";
import { createDataTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { newUlid } from "../support/ulid";

// What an admin login now issues: admin scopes plus transaction scopes for the admin's own spending.
const ADMIN: AuthContext = {
  userId: "admin-1",
  role: "admin",
  scope: "admin:read admin:write transactions:read transactions:write",
};
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

const expense = (overrides: Record<string, unknown> = {}) => ({
  id: newUlid(),
  date: "2026-10-26",
  category: "groceries",
  item: "菜",
  amountCents: 10000,
  currency: "AUD",
  ...overrides,
});

const create = (auth: AuthContext, body: unknown) => call(handler, "POST /api/v1/transactions", body, { auth });
const getOwn = (auth: AuthContext, id: string) =>
  call(handler, "GET /api/v1/transactions/{id}", undefined, { auth, params: { id } });
const listAll = (query: Record<string, string> = {}, auth: AuthContext = ADMIN) =>
  call(handler, "GET /api/v1/admin/transactions", undefined, { auth, query });
const adminPatch = (userId: string, transactionId: string, body: unknown, auth: AuthContext = ADMIN) =>
  call(handler, "PATCH /api/v1/admin/users/{id}/transactions/{transactionId}", body, {
    auth,
    params: { id: userId, transactionId },
  });
const adminDelete = (userId: string, transactionId: string, auth: AuthContext = ADMIN) =>
  call(handler, "DELETE /api/v1/admin/users/{id}/transactions/{transactionId}", undefined, {
    auth,
    params: { id: userId, transactionId },
  });

describe("the admin's own transactions", () => {
  describe("given an admin token", () => {
    it("records and reads back a transaction like any customer", async () => {
      const body = expense();

      const created = await create(ADMIN, body);
      const fetched = await getOwn(ADMIN, body.id);

      expect(created.status).toBe(201);
      expect(fetched.status).toBe(200);
      expect(fetched.body).toMatchObject({ id: body.id, amountCents: 10000 });
    });
  });
});

describe("GET /admin/transactions", () => {
  // Each test uses its own month so rows from other tests don't interfere.
  describe("given transactions from several customers and the admin", () => {
    it("lists all of them, newest first, each with its owner's userId", async () => {
      const a = expense({ date: "2025-01-03", amountCents: 1 });
      const b = expense({ date: "2025-01-02", amountCents: 2 });
      const c = expense({ date: "2025-01-01", amountCents: 3 });
      await create(customer("all-alice"), a);
      await create(customer("all-bob"), b);
      await create(ADMIN, c);

      const res = await listAll({ from: "2025-01-01", to: "2025-01-31" });

      expect(res.status).toBe(200);
      expect(res.body.items.map((t: { id: string; userId: string }) => [t.id, t.userId])).toEqual([
        [a.id, "all-alice"],
        [b.id, "all-bob"],
        [c.id, "admin-1"],
      ]);
      expect(res.body.nextCursor).toBeNull();
    });
  });

  describe("given a category and a small page size", () => {
    it("filters by category and pages with a cursor", async () => {
      for (const [who, category, amountCents] of [
        ["cat-alice", "dining", 1],
        ["cat-bob", "dining", 2],
        ["cat-alice", "transport", 3],
        ["cat-carol", "dining", 4],
      ] as const) {
        await create(customer(who), expense({ date: `2025-02-0${amountCents}`, category, amountCents }));
      }

      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const res = await listAll({ from: "2025-02-01", to: "2025-02-28", category: "dining", limit: "2", ...(cursor ? { cursor } : {}) });
        expect(res.status).toBe(200);
        seen.push(...res.body.items.map((t: { amountCents: number }) => t.amountCents));
        cursor = res.body.nextCursor;
      } while (cursor);

      expect(seen).toEqual([4, 2, 1]);
    });
  });

  describe("given a customer", () => {
    it("refuses with 403", async () => {
      const res = await listAll({}, customer("snoop"));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });
  });
});

describe("PATCH /admin/users/{id}/transactions/{transactionId}", () => {
  describe("given another customer's transaction and its current version", () => {
    it("applies the change, and the customer sees it", async () => {
      const body = expense();
      await create(customer("edit-alice"), body);

      const res = await adminPatch("edit-alice", body.id, { version: 1, amountCents: 4200, note: "fixed by sisi" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: body.id, amountCents: 4200, note: "fixed by sisi", version: 2 });
      expect((await getOwn(customer("edit-alice"), body.id)).body).toMatchObject({ amountCents: 4200, version: 2 });
    });
  });

  describe("given a stale version", () => {
    it("refuses with 409 version_conflict", async () => {
      const body = expense();
      await create(customer("edit-bob"), body);
      await adminPatch("edit-bob", body.id, { version: 1, amountCents: 1 });

      const res = await adminPatch("edit-bob", body.id, { version: 1, amountCents: 2 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("version_conflict");
    });
  });

  describe("given the wrong owner for the transaction", () => {
    it("returns 404", async () => {
      const body = expense();
      await create(customer("edit-carol"), body);

      const res = await adminPatch("edit-dave", body.id, { version: 1, amountCents: 1 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("transaction_not_found");
    });
  });

  describe("given a customer", () => {
    it("refuses with 403, even for their own transaction", async () => {
      const body = expense();
      await create(customer("edit-erin"), body);

      const res = await adminPatch("edit-erin", body.id, { version: 1, amountCents: 1 }, customer("edit-erin"));

      expect(res.status).toBe(403);
    });
  });
});

describe("DELETE /admin/users/{id}/transactions/{transactionId}", () => {
  describe("given another customer's transaction", () => {
    it("deletes it, and it's gone for the customer and from the all-customers list", async () => {
      const body = expense({ date: "2025-03-01" });
      await create(customer("del-alice"), body);

      const res = await adminDelete("del-alice", body.id);

      expect(res.status).toBe(204);
      expect((await getOwn(customer("del-alice"), body.id)).status).toBe(404);
      expect((await listAll({ from: "2025-03-01", to: "2025-03-31" })).body.items).toEqual([]);
    });
  });

  describe("given an unknown transaction", () => {
    it("returns 404", async () => {
      const res = await adminDelete("del-bob", newUlid());

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("transaction_not_found");
    });
  });

  describe("given a customer", () => {
    it("refuses with 403 and leaves the transaction alone", async () => {
      const body = expense();
      await create(customer("del-carol"), body);

      const res = await adminDelete("del-carol", body.id, customer("del-dave"));

      expect(res.status).toBe(403);
      expect((await getOwn(customer("del-carol"), body.id)).status).toBe(200);
    });
  });
});
