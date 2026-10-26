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
});
