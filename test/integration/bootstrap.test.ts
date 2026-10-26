import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthHandler } from "../../src/auth/handler";
import { verifyAccessToken } from "../../src/auth/tokens";
import { bootstrap } from "../../src/bootstrap/bootstrap";
import { ADMIN_PASSWORD_PARAM, ADMIN_USERNAME, SIGNING_SECRET_PARAM } from "../../src/config";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { call } from "../support/http";
import { fakeParameterStore } from "../support/parameters";

let tableName: string;
const parameters = fakeParameterStore();

beforeAll(async () => {
  tableName = await createUsersTable();
});

afterAll(async () => {
  await deleteTable(tableName);
});

async function loginAsAdmin() {
  const signingSecret = parameters.values.get(SIGNING_SECRET_PARAM)!;
  const auth = createAuthHandler({ tableName, signingSecret, now: () => new Date() });
  const res = await call(auth, "POST /api/v1/auth/login", {
    username: ADMIN_USERNAME,
    password: parameters.values.get(ADMIN_PASSWORD_PARAM),
  });
  return { res, signingSecret };
}

describe("bootstrap", () => {
  describe("given a fresh deployment", () => {
    it("creates random secrets and an admin who can log in with the stored password", async () => {
      await bootstrap({ tableName, parameters });

      expect(parameters.values.get(SIGNING_SECRET_PARAM)?.length).toBeGreaterThanOrEqual(43);
      expect(parameters.values.get(ADMIN_PASSWORD_PARAM)?.length).toBeGreaterThanOrEqual(24);
      const { res, signingSecret } = await loginAsAdmin();
      expect(res.status).toBe(200);
      expect((await verifyAccessToken(res.body.accessToken, signingSecret, new Date())).role).toBe("admin");
    });
  });

  describe("given it has already run", () => {
    it("changes nothing, so existing logins and tokens keep working", async () => {
      const before = new Map(parameters.values);

      await bootstrap({ tableName, parameters });

      expect(parameters.values).toEqual(before);
      expect((await loginAsAdmin()).res.status).toBe(200);
    });
  });
});
