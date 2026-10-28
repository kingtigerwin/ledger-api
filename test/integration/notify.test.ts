import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handler";
import type { AuthContext } from "../../src/auth/authorizer";
import { createAuthHandler } from "../../src/auth/handler";
import { createNotifyHandler, type OutgoingEmail } from "../../src/notify/handler";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { streamRecords } from "../support/streams";

const ADMIN: AuthContext = { userId: "admin-1", role: "admin", scope: "admin:read admin:write" };

let tableName: string;

beforeAll(async () => {
  tableName = await createUsersTable();
});

afterAll(async () => {
  await deleteTable(tableName);
});

describe("emails from the Users table's stream", () => {
  describe("given a customer who registers, fails a login, and is enabled, disabled and enabled again", () => {
    it("emails them once when they register and once when first approved", async () => {
      const auth = createAuthHandler({ tableName, signingSecret: "test-secret", now: () => new Date() });
      const admin = createAdminHandler({ tableName });
      const registered = await call(auth, "POST /api/v1/auth/register", {
        username: "haoran",
        password: "pw",
        email: "haoran@example.com",
      });
      await call(auth, "POST /api/v1/auth/login", { username: "haoran", password: "wrong" });
      for (const action of ["enable", "disable", "enable"]) {
        await call(admin, `POST /api/v1/admin/users/{id}/${action}`, undefined, {
          auth: ADMIN,
          params: { id: registered.body.id },
        });
      }
      const sent: OutgoingEmail[] = [];
      const notify = createNotifyHandler({
        from: "noreply@haoran.cloud",
        sendEmail: async (email) => void sent.push(email),
        log: () => {},
      });

      const res = await notify({ Records: await streamRecords(tableName) });

      expect(res.batchItemFailures).toEqual([]);
      expect(sent.map((e) => [e.to, e.subject])).toEqual([
        ["haoran@example.com", expect.stringMatching(/waiting for approval/i)],
        ["haoran@example.com", expect.stringMatching(/approved/i)],
      ]);
    });
  });
});
