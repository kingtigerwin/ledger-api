import { randomBytes } from "node:crypto";
import { hashPassword } from "../auth/password";
import { createUsersStore, UsernameTakenError } from "../auth/users-store";
import { ADMIN_PASSWORD_PARAM, ADMIN_USERNAME, SIGNING_SECRET_PARAM } from "../config";
import type { ParameterStore } from "./parameters";

async function ensureParameter(parameters: ParameterStore, name: string, generate: () => string): Promise<string> {
  const existing = await parameters.get(name);
  if (existing !== undefined) return existing;
  const value = generate();
  await parameters.createSecure(name, value);
  return value;
}

/**
 * Runs on every deploy and only creates what's missing: the JWT signing secret, the root admin's
 * random password, and the root admin user. Nothing that already exists is changed.
 */
export async function bootstrap(deps: { tableName: string; parameters: ParameterStore }): Promise<void> {
  await ensureParameter(deps.parameters, SIGNING_SECRET_PARAM, () => randomBytes(32).toString("base64url"));
  const password = await ensureParameter(deps.parameters, ADMIN_PASSWORD_PARAM, () =>
    randomBytes(18).toString("base64url"),
  );

  const users = createUsersStore(deps.tableName);
  if (await users.findByUsername(ADMIN_USERNAME)) return;
  try {
    await users.create({
      username: ADMIN_USERNAME,
      passwordHash: await hashPassword(password),
      role: "admin",
      status: "active",
      now: new Date(),
    });
  } catch (err) {
    // Another run created the admin between our check and our write.
    if (!(err instanceof UsernameTakenError)) throw err;
  }
}
