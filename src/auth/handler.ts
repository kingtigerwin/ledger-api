import { z } from "zod";
import { ApiError, json, parseBody, withErrors } from "../http";
import { hashPassword } from "./password";
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
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
