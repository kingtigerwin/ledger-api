import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthHandler } from "../../src/auth/handler";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";

const REGISTER = "POST /api/v1/auth/register";

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
});
