import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthHandler } from "../../src/auth/handler";
import { verifyAccessToken } from "../../src/auth/tokens";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call, cookiePair } from "../support/http";
import { createUserWithStatus } from "../support/users";

const LOGIN = "POST /api/v1/auth/login";
const REFRESH = "POST /api/v1/auth/refresh";

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

describe("POST /auth/refresh", () => {
  describe("given a valid refresh cookie", () => {
    it("returns a new access token and replaces the refresh cookie", async () => {
      const user = await createUserWithStatus(tableName, "kim", "pw", "active");
      const login = await call(handler, LOGIN, { username: "kim", password: "pw" });

      const res = await call(handler, REFRESH, undefined, { cookies: [cookiePair(login.cookies[0]!)] });

      expect(res.status).toBe(200);
      expect((await verifyAccessToken(res.body.accessToken, "test-secret", new Date())).sub).toBe(user.id);
      expect(res.cookies).toHaveLength(1);
      expect(cookiePair(res.cookies[0]!)).not.toBe(cookiePair(login.cookies[0]!));
    });
  });

  describe("given a refresh token sent in the body", () => {
    it("returns the replacement in the body", async () => {
      await createUserWithStatus(tableName, "leo", "pw", "active");
      const login = await call(handler, LOGIN, { username: "leo", password: "pw", refreshTokenIn: "body" });

      const res = await call(handler, REFRESH, { refreshToken: login.body.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).not.toBe(login.body.refreshToken);
      expect(res.cookies).toEqual([]);
    });
  });
});
