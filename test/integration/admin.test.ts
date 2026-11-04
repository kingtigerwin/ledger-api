import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handler";
import { createAuthHandler } from "../../src/auth/handler";
import { type AuthContext, createAuthorizer } from "../../src/auth/authorizer";
import { signAccessToken } from "../../src/auth/tokens";
import { createUsersStore, type User } from "../../src/auth/users-store";
import { createTransactionsStore } from "../../src/data/transactions-store";
import { ddb } from "../../src/db-client";
import type { LogEntry } from "../../src/log";
import { createDataTable, createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { newUlid } from "../support/ulid";
import { createUserWithStatus } from "../support/users";

const ADMIN: AuthContext = { userId: "admin-1", role: "admin", scope: "admin:read admin:write" };
const CUSTOMER: AuthContext = { userId: "customer-1", role: "customer", scope: "transactions:read transactions:write" };

let tableName: string;
let dataTableName: string;
let handler: ReturnType<typeof createAdminHandler>;
const logged: LogEntry[] = [];
let auth: ReturnType<typeof createAuthHandler>;

const login = (username: string, password: string) =>
  call(auth, "POST /api/v1/auth/login", { username, password, refreshTokenIn: "body" });

beforeAll(async () => {
  tableName = await createUsersTable();
  dataTableName = await createDataTable();
  handler = createAdminHandler({ tableName, dataTableName, log: (entry) => logged.push(entry) });
  auth = createAuthHandler({ tableName, signingSecret: "test-secret", now: () => new Date() });
});

afterAll(async () => {
  await deleteTable(tableName);
  await deleteTable(dataTableName);
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

const DELETE_USER = "DELETE /api/v1/admin/users/{id}";
const NOW = new Date("2026-11-01T00:00:00Z");

/** The root admin, and the authorizer context of a request from them. */
const seedSisi = async (username: string): Promise<AuthContext> => {
  const sisi = await createUserWithStatus(tableName, username, "pw", "active", "admin");
  return { userId: sisi.id, role: "admin", scope: "admin:read admin:write" };
};

const seedTransaction = (userId: string) =>
  createTransactionsStore(dataTableName).create(
    userId,
    { id: newUlid(), date: "2026-10-26", category: "groceries", item: "菜", amountCents: 10000, currency: "AUD" },
    NOW,
  );

const partition = async (table: string, userId: string) =>
  (
    await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `USER#${userId}` },
        ConsistentRead: true,
      }),
    )
  ).Items ?? [];

describe("DELETE /admin/users/{id}", () => {
  describe("given sisi deleting a customer", () => {
    it("removes everything of theirs and nothing of anyone else's", async () => {
      const sisi = await seedSisi("sisi-1");
      const rita = await createUserWithStatus(tableName, "rita-del-1", "pw", "active");
      const other = await createUserWithStatus(tableName, "other-del-1", "pw", "active");
      for (const user of [rita, other]) {
        await createUsersStore(tableName).saveRefreshToken(user.id, "hash-1", new Date(NOW.getTime() + 86_400_000));
        await seedTransaction(user.id);
        await seedTransaction(user.id);
      }

      const res = await call(handler, DELETE_USER, undefined, { auth: sisi, params: { id: rita.id } });

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(await partition(tableName, rita.id)).toEqual([]);
      expect(await createUsersStore(tableName).userIdFor("rita-del-1")).toBeUndefined();
      expect(await partition(dataTableName, rita.id)).toEqual([]);
      expect(await partition(tableName, other.id)).toHaveLength(2);
      expect(await partition(dataTableName, other.id)).toHaveLength(4);
    });

    it("frees their username for someone new", async () => {
      const sisi = await seedSisi("sisi-2");
      const rita = await createUserWithStatus(tableName, "rita-del-2", "pw", "active");

      await call(handler, DELETE_USER, undefined, { auth: sisi, params: { id: rita.id } });

      expect(await createUsersStore(tableName).findByUsername("rita-del-2")).toBeUndefined();
      await expect(createUserWithStatus(tableName, "rita-del-2", "pw", "pending")).resolves.toBeDefined();
    });

    it("records who deleted whom and how much went", async () => {
      const sisi = await seedSisi("sisi-3");
      const rita = await createUserWithStatus(tableName, "rita-del-3", "pw", "active");
      await seedTransaction(rita.id);

      await call(handler, DELETE_USER, undefined, { auth: sisi, params: { id: rita.id } });

      expect(logged).toContainEqual({ event: "user_deleted", userId: rita.id, by: sisi.userId, dataItemsDeleted: 2 });
    });
  });

  describe("given sisi deleting themselves", () => {
    it("refuses with 409 cannot_delete_admin", async () => {
      const sisi = await seedSisi("sisi-4");

      const res = await call(handler, DELETE_USER, undefined, { auth: sisi, params: { id: sisi.userId } });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("cannot_delete_admin");
      expect((await createUsersStore(tableName).getById(sisi.userId))?.status).toBe("active");
    });
  });

  describe("given a customer", () => {
    it("refuses with 403 and deletes nothing", async () => {
      const rita = await createUserWithStatus(tableName, "rita-del-5", "pw", "active");

      const res = await call(handler, DELETE_USER, undefined, { auth: CUSTOMER, params: { id: rita.id } });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect((await createUsersStore(tableName).getById(rita.id))?.status).toBe("active");
    });
  });

  describe("given an admin token without the write scope", () => {
    it("refuses with 403", async () => {
      const sisi = { ...(await seedSisi("sisi-6")), scope: "admin:read" };

      const res = await call(handler, DELETE_USER, undefined, { auth: sisi, params: { id: "anyone" } });

      expect(res.status).toBe(403);
    });
  });

  describe("given an unknown user id", () => {
    it("returns 404 user_not_found", async () => {
      const sisi = await seedSisi("sisi-7");

      const res = await call(handler, DELETE_USER, undefined, { auth: sisi, params: { id: "no-such-user" } });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("user_not_found");
    });
  });

  describe("given a delete that fails part-way", () => {
    it("leaves them disabled, and trying again finishes the job", async () => {
      const sisi = await seedSisi("sisi-8");
      const rita = await createUserWithStatus(tableName, "rita-del-8", "pw", "active");
      await createUsersStore(tableName).saveRefreshToken(rita.id, "hash-1", new Date(NOW.getTime() + 86_400_000));
      await seedTransaction(rita.id);
      const failing = createAdminHandler({
        tableName,
        dataTableName,
        transactions: {
          ...createTransactionsStore(dataTableName),
          deleteAll: async () => {
            throw new Error("DynamoDB is having a moment");
          },
        },
        log: () => {},
      });

      const failed = await call(failing, DELETE_USER, undefined, { auth: sisi, params: { id: rita.id } });

      expect(failed.status).toBe(500);
      expect((await createUsersStore(tableName).getById(rita.id))?.status).toBe("disabled");

      const retried = await call(handler, DELETE_USER, undefined, { auth: sisi, params: { id: rita.id } });

      expect(retried.status).toBe(204);
      expect(await partition(tableName, rita.id)).toEqual([]);
      expect(await partition(dataTableName, rita.id)).toEqual([]);
    });
  });
});

// What the Lambda authorizer sees: the token is good until it expires, so the user's state has to decide.
describe("given a user still holding a valid access token", () => {
  const authorize = async (user: User) => {
    const token = await signAccessToken({ sub: user.id, role: "customer", scope: "transactions:write" }, "s".repeat(32), NOW);
    const users = createUsersStore(tableName);
    const authorizer = createAuthorizer({
      signingSecret: "s".repeat(32),
      now: () => NOW,
      isActive: (userId) => users.isActive(userId),
    });
    const result = await authorizer({ headers: { authorization: `Bearer ${token}` } } as never);
    return result.isAuthorized;
  };

  it("works while they are active", async () => {
    expect(await authorize(await createUserWithStatus(tableName, "rita-tok-1", "pw", "active"))).toBe(true);
  });

  it("stops working the moment they are deleted", async () => {
    const sisi = await seedSisi("sisi-9");
    const rita = await createUserWithStatus(tableName, "rita-tok-2", "pw", "active");

    await call(handler, DELETE_USER, undefined, { auth: sisi, params: { id: rita.id } });

    expect(await authorize(rita)).toBe(false);
  });

  it("stops when they are disabled, and works again when they are enabled", async () => {
    const rita = await createUserWithStatus(tableName, "rita-tok-3", "pw", "active");

    await call(handler, "POST /api/v1/admin/users/{id}/disable", undefined, { auth: ADMIN, params: { id: rita.id } });
    expect(await authorize(rita)).toBe(false);

    await call(handler, "POST /api/v1/admin/users/{id}/enable", undefined, { auth: ADMIN, params: { id: rita.id } });
    expect(await authorize(rita)).toBe(true);
  });
});

describe("any other route", () => {
  it("returns 404 route_not_found", async () => {
    const res = await call(handler, "PATCH /api/v1/admin/users/{id}", undefined, { auth: ADMIN, params: { id: "u-1" } });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("route_not_found");
  });
});
