import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth/authorizer";
import { createDataHandler } from "../../src/data/handler";
import { createDataTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";

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

describe("POST /members and GET /members", () => {
  describe("given two households", () => {
    it("lists only the caller's own members", async () => {
      const created = await call(handler, "POST /api/v1/members", { name: "Mom" }, { auth: customer("house-a") });
      await call(handler, "POST /api/v1/members", { name: "Uncle" }, { auth: customer("house-b") });

      const res = await call(handler, "GET /api/v1/members", undefined, { auth: customer("house-a") });

      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: expect.any(String),
        name: "Mom",
        archived: false,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [created.body], nextCursor: null });
    });
  });

  describe("given a name already used in the household, in any letter case", () => {
    it("rejects it, while another household can still use it", async () => {
      await call(handler, "POST /api/v1/members", { name: "Dad" }, { auth: customer("house-c") });

      const duplicate = await call(handler, "POST /api/v1/members", { name: "dAD" }, { auth: customer("house-c") });
      const elsewhere = await call(handler, "POST /api/v1/members", { name: "Dad" }, { auth: customer("house-d") });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe("member_name_taken");
      expect(elsewhere.status).toBe(201);
    });
  });
});

describe("PATCH /members/{id}", () => {
  const create = (house: string, name: string) =>
    call(handler, "POST /api/v1/members", { name }, { auth: customer(house) }).then((r) => r.body);
  const rename = (house: string, id: string, name: string) =>
    call(handler, "PATCH /api/v1/members/{id}", { name }, { auth: customer(house), params: { id } });

  describe("given a new, unused name", () => {
    it("renames the member and frees the old name", async () => {
      const mum = await create("house-e", "mum");

      const res = await rename("house-e", mum.id, "Mom");
      const reuseOld = await call(handler, "POST /api/v1/members", { name: "mum" }, { auth: customer("house-e") });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: mum.id, name: "Mom" });
      expect(reuseOld.status).toBe(201);
    });
  });

  describe("given only a change of letter case", () => {
    it("renames the member", async () => {
      const kid = await create("house-f", "kid");

      const res = await rename("house-f", kid.id, "Kid");

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Kid");
    });
  });

  describe("given a name another member already has", () => {
    it("rejects it", async () => {
      await create("house-g", "Grandma");
      const other = await create("house-g", "Gran");

      const res = await rename("house-g", other.id, "grandma");

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("member_name_taken");
    });
  });

  describe("given another household's member", () => {
    it("returns 404, as if it didn't exist", async () => {
      const theirs = await create("house-h", "Aunt");

      const res = await rename("house-i", theirs.id, "Mine now");

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("member_not_found");
    });
  });
});
