import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthHandler } from "../../src/auth/handler";
import { verifyAccessToken } from "../../src/auth/tokens";
import { createUsersStore } from "../../src/auth/users-store";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call, cookiePair } from "../support/http";
import { createUserWithStatus } from "../support/users";

const LOGIN = "POST /api/v1/auth/login";
const REFRESH = "POST /api/v1/auth/refresh";
const LOGOUT = "POST /api/v1/auth/logout";
const ME = "GET /api/v1/auth/me";

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

  describe("given a refresh token that was already replaced", () => {
    it("refuses it and revokes the user's newer token too, since it was probably stolen", async () => {
      await createUserWithStatus(tableName, "mia", "pw", "active");
      const login = await call(handler, LOGIN, { username: "mia", password: "pw", refreshTokenIn: "body" });
      const first = login.body.refreshToken;
      const rotated = await call(handler, REFRESH, { refreshToken: first });

      const replay = await call(handler, REFRESH, { refreshToken: first });
      const afterReplay = await call(handler, REFRESH, { refreshToken: rotated.body.refreshToken });

      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe("invalid_refresh_token");
      expect(afterReplay.status).toBe(401);
    });
  });

  describe("given a refresh token older than 7 days", () => {
    it("refuses it, even if DynamoDB hasn't deleted it yet", async () => {
      let now = new Date("2026-10-01T09:00:00Z");
      const clocked = createAuthHandler({ tableName, signingSecret: "test-secret", now: () => now });
      await createUserWithStatus(tableName, "noah", "pw", "active");
      const login = await call(clocked, LOGIN, { username: "noah", password: "pw", refreshTokenIn: "body" });

      now = new Date("2026-10-08T09:00:01Z");
      const res = await call(clocked, REFRESH, { refreshToken: login.body.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_refresh_token");
    });
  });

  describe("given a user who was disabled after logging in", () => {
    it("refuses to refresh", async () => {
      const user = await createUserWithStatus(tableName, "olga", "pw", "active");
      const login = await call(handler, LOGIN, { username: "olga", password: "pw", refreshTokenIn: "body" });
      await createUsersStore(tableName).setStatus(user.id, "disabled");

      const res = await call(handler, REFRESH, { refreshToken: login.body.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_refresh_token");
    });
  });
});

describe("POST /auth/logout", () => {
  describe("given a logged-in browser", () => {
    it("clears the cookie, and the refresh token stops working", async () => {
      await createUserWithStatus(tableName, "pia", "pw", "active");
      const login = await call(handler, LOGIN, { username: "pia", password: "pw" });
      const cookie = cookiePair(login.cookies[0]!);

      const res = await call(handler, LOGOUT, undefined, { cookies: [cookie] });
      const refresh = await call(handler, REFRESH, undefined, { cookies: [cookie] });

      expect(res.status).toBe(204);
      expect(res.cookies[0]).toMatch(/^refreshToken=; .*Max-Age=0/);
      expect(refresh.status).toBe(401);
    });
  });
});

describe("GET /auth/me", () => {
  describe("given a request the authorizer let through", () => {
    it("returns the signed-in user", async () => {
      const user = await createUserWithStatus(tableName, "quinn", "pw", "active");

      const res = await call(handler, ME, undefined, {
        auth: { userId: user.id, role: "customer", scope: "members:read" },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: user.id, username: "quinn", role: "customer", status: "active" });
    });
  });
});
