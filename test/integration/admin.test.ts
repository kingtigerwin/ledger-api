import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handler";
import type { AuthContext } from "../../src/auth/authorizer";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { createUserWithStatus } from "../support/users";

const ADMIN: AuthContext = { userId: "admin-1", role: "admin", scope: "admin:read admin:write" };
const CUSTOMER: AuthContext = { userId: "customer-1", role: "customer", scope: "members:read members:write" };

let tableName: string;
let handler: ReturnType<typeof createAdminHandler>;

beforeAll(async () => {
  tableName = await createUsersTable();
  handler = createAdminHandler({ tableName });
});

afterAll(async () => {
  await deleteTable(tableName);
});

describe("GET /admin/users?status=pending", () => {
  describe("given an admin", () => {
    it("lists pending users only, without password hashes", async () => {
      const pending = await createUserWithStatus(tableName, "pat", "pw", "pending");
      await createUserWithStatus(tableName, "act", "pw", "active");

      const res = await call(handler, "GET /api/v1/admin/users", undefined, {
        auth: ADMIN,
        query: { status: "pending" },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [{ id: pending.id, username: "pat", role: "customer", status: "pending", createdAt: pending.createdAt }],
        nextCursor: null,
      });
    });
  });

  describe("given a customer", () => {
    it("refuses with 403 forbidden", async () => {
      const res = await call(handler, "GET /api/v1/admin/users", undefined, { auth: CUSTOMER, query: { status: "pending" } });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });
  });
});
