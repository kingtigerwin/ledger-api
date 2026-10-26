import { z } from "zod";
import { ApiError, json, parseBody, withErrors } from "../http";
import { hashPassword, verifyPassword } from "./password";
import { createUsersStore, UsernameTakenError } from "./users-store";

export interface AuthDeps {
  tableName: string;
  signingSecret: string;
  now: () => Date;
}

const credentialsSchema = z.object({
  username: z.string().min(1).max(64).toLowerCase(),
  password: z.string().min(1).max(1024),
});

export function createAuthHandler(deps: AuthDeps) {
  const users = createUsersStore(deps.tableName);

  return withErrors(async (event) => {
    switch (event.routeKey) {
      case "POST /api/v1/auth/register": {
        const { username, password } = parseBody(event, credentialsSchema);
        try {
          const user = await users.create({
            username,
            passwordHash: await hashPassword(password),
            role: "customer",
            status: "pending",
            now: deps.now(),
          });
          return json(201, user);
        } catch (err) {
          if (err instanceof UsernameTakenError) throw new ApiError(409, "username_taken", "That username is taken");
          throw err;
        }
      }
      case "POST /api/v1/auth/login": {
        const { username, password } = parseBody(event, credentialsSchema);
        const found = await users.findByUsername(username);
        if (!found || !(await verifyPassword(password, found.passwordHash))) {
          throw new ApiError(401, "invalid_credentials", "Invalid username or password");
        }
        if (found.user.status === "pending") {
          throw new ApiError(403, "account_pending", "This account is waiting for admin approval");
        }
        return json(200, {});
      }
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
