import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthHandler } from "../../src/auth/handler";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { createUserWithStatus } from "../support/users";

const LOGIN = "POST /api/v1/auth/login";

let tableName: string;
let handler: ReturnType<typeof createAuthHandler>;

beforeAll(async () => {
  tableName = await createUsersTable();
  handler = createAuthHandler({ tableName, signingSecret: "test-secret", now: () => new Date() });
});

afterAll(async () => {
  await deleteTable(tableName);
});

describe("POST /auth/login", () => {
  describe("given a browser login (the default)", () => {
    it("sets the refresh token in an HttpOnly cookie and keeps it out of the body", async () => {
      await createUserWithStatus(tableName, "ivan", "pw", "active");

      const res = await call(handler, LOGIN, { username: "ivan", password: "pw" });

      expect(res.status).toBe(200);
      expect(res.body.refreshToken).toBeUndefined();
      expect(res.cookies).toHaveLength(1);
      expect(res.cookies[0]).toMatch(/^refreshToken=[^;]+; /);
      expect(res.cookies[0]).toContain("HttpOnly");
      expect(res.cookies[0]).toContain("Secure");
      expect(res.cookies[0]).toContain("SameSite=Strict");
      expect(res.cookies[0]).toContain("Path=/api/v1/auth");
      expect(res.cookies[0]).toContain("Max-Age=604800");
    });
  });

  describe("given a client that asks for the refresh token in the body", () => {
    it("returns it in the body and sets no cookie", async () => {
      await createUserWithStatus(tableName, "judy", "pw", "active");

      const res = await call(handler, LOGIN, { username: "judy", password: "pw", refreshTokenIn: "body" });

      expect(res.status).toBe(200);
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(res.cookies).toEqual([]);
    });
  });
});
