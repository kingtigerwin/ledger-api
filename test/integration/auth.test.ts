import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthHandler } from "../../src/auth/handler";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";

const REGISTER = "POST /api/v1/auth/register";
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

describe("POST /auth/register", () => {
  describe("given a new username and a password", () => {
    it("creates a pending customer and never returns the password", async () => {
      const res = await call(handler, REGISTER, { username: "alice", password: "pw" });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        username: "alice",
        role: "customer",
        status: "pending",
        createdAt: expect.any(String),
      });
    });
  });

  describe("given a username that exists in different letter case", () => {
    it("rejects it as taken", async () => {
      await call(handler, REGISTER, { username: "bob", password: "pw" });

      const res = await call(handler, REGISTER, { username: "Bob", password: "other" });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("username_taken");
    });
  });

  describe("given a field that is empty or too long", () => {
    it.each([
      ["an empty username", { username: "", password: "pw" }],
      ["an empty password", { username: "carol", password: "" }],
      ["a 65-character username", { username: "c".repeat(65), password: "pw" }],
      ["a 1,025-character password", { username: "carol", password: "p".repeat(1025) }],
    ])("rejects %s", async (_, body) => {
      const res = await call(handler, REGISTER, body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_failed");
    });
  });
});

describe("POST /auth/login", () => {
  describe("given a pending user with the correct password", () => {
    it("refuses with account_pending", async () => {
      await call(handler, REGISTER, { username: "dave", password: "pw" });

      const res = await call(handler, LOGIN, { username: "dave", password: "pw" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("account_pending");
    });
  });

  describe("given credentials that don't match", () => {
    it.each([
      ["an unknown username", { username: "nobody", password: "pw" }],
      ["a pending user's wrong password", { username: "erin", password: "wrong" }],
    ])("refuses %s with the same invalid_credentials error", async (_, body) => {
      await call(handler, REGISTER, { username: "erin", password: "pw" });

      const res = await call(handler, LOGIN, body);

      expect(res.status).toBe(401);
      expect(res.body.error).toEqual({ code: "invalid_credentials", message: "Invalid username or password" });
    });
  });
});
