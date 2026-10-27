import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handler";
import { createAuthHandler } from "../../src/auth/handler";
import type { AuthContext } from "../../src/auth/authorizer";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { createUserWithStatus } from "../support/users";

const ADMIN: AuthContext = { userId: "admin-1", role: "admin", scope: "admin:read admin:write" };
const CUSTOMER: AuthContext = { userId: "customer-1", role: "customer", scope: "transactions:read transactions:write" };

let tableName: string;
let handler: ReturnType<typeof createAdminHandler>;
let auth: ReturnType<typeof createAuthHandler>;

const login = (username: string, password: string) =>
  call(auth, "POST /api/v1/auth/login", { username, password, refreshTokenIn: "body" });

beforeAll(async () => {
  tableName = await createUsersTable();
  handler = createAdminHandler({ tableName });
  auth = createAuthHandler({ tableName, signingSecret: "test-secret", now: () => new Date() });
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

describe("POST /admin/users/{id}/enable", () => {
  describe("given a pending user", () => {
    it("activates them so they can log in", async () => {
      const user = await createUserWithStatus(tableName, "quentin", "pw", "pending");

      const res = await call(handler, "POST /api/v1/admin/users/{id}/enable", undefined, {
        auth: ADMIN,
        params: { id: user.id },
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
      expect((await login("quentin", "pw")).status).toBe(200);
    });
  });

  describe("given an unknown user id", () => {
    it("returns 404 user_not_found", async () => {
      const res = await call(handler, "POST /api/v1/admin/users/{id}/enable", undefined, {
        auth: ADMIN,
        params: { id: "no-such-user" },
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("user_not_found");
    });
  });
});

describe("POST /admin/users/{id}/disable", () => {
  describe("given an active, logged-in customer", () => {
    it("blocks login and ends their refresh token immediately", async () => {
      const user = await createUserWithStatus(tableName, "rita", "pw", "active");
      const session = await login("rita", "pw");

      const res = await call(handler, "POST /api/v1/admin/users/{id}/disable", undefined, {
        auth: ADMIN,
        params: { id: user.id },
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("disabled");
      expect((await login("rita", "pw")).status).toBe(401);
      const refresh = await call(auth, "POST /api/v1/auth/refresh", { refreshToken: session.body.refreshToken });
      expect(refresh.status).toBe(401);
    });
  });

  describe("given an admin", () => {
    it("refuses, so the last admin can't be locked out", async () => {
      const admin = await createUserWithStatus(tableName, "root", "pw", "active", "admin");

      const res = await call(handler, "POST /api/v1/admin/users/{id}/disable", undefined, {
        auth: ADMIN,
        params: { id: admin.id },
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("cannot_disable_admin");
    });
  });
});
