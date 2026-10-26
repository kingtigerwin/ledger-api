import { z } from "zod";
import { ApiError, json, parseBody, withErrors } from "../http";
import { hashPassword, verifyPassword } from "./password";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshCookie,
} from "./refresh-tokens";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "./tokens";
import { createUsersStore, InvalidRefreshTokenError, type User, UsernameTakenError } from "./users-store";

export interface AuthDeps {
  tableName: string;
  signingSecret: string;
  now: () => Date;
}

const CUSTOMER_SCOPE = "members:read members:write transactions:read transactions:write";

const credentialsSchema = z.object({
  username: z.string().min(1).max(64).toLowerCase(),
  password: z.string().min(1).max(1024),
});

const loginSchema = credentialsSchema.extend({
  // Browsers get the refresh token only as an HttpOnly cookie; non-browser clients (an agent) ask for it in the body.
  refreshTokenIn: z.enum(["cookie", "body"]).default("cookie"),
});

type Delivery = "cookie" | "body";

/** Sends the refresh token the way the client asked: as a cookie, or in the JSON body. */
function withRefreshToken(body: Record<string, unknown>, refreshToken: string, deliverIn: Delivery) {
  return deliverIn === "body" ? json(200, { ...body, refreshToken }) : json(200, body, [refreshCookie(refreshToken)]);
}

const invalidRefreshToken = () => new ApiError(401, "invalid_refresh_token", "Log in again");

/** Finds the refresh token in the cookie (browsers) or the JSON body (other clients). */
function readRefreshToken(event: APIGatewayProxyEventV2): { token: string; deliverIn: Delivery } {
  const cookie = event.cookies?.find((c) => c.startsWith("refreshToken="));
  if (cookie) return { token: cookie.slice("refreshToken=".length), deliverIn: "cookie" };
  try {
    const { refreshToken } = JSON.parse(event.body ?? "{}");
    if (typeof refreshToken === "string" && refreshToken) return { token: refreshToken, deliverIn: "body" };
  } catch {
    // An unreadable body is the same as a missing token.
  }
  throw invalidRefreshToken();
}

export function createAuthHandler(deps: AuthDeps) {
  const users = createUsersStore(deps.tableName);
  const dummyHash = hashPassword("not-a-real-password");

  const accessTokenFor = (user: User, now: Date) =>
    signAccessToken({ sub: user.id, role: user.role, scope: CUSTOMER_SCOPE }, deps.signingSecret, now);
  const refreshExpiry = (now: Date) => new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);

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
        const { username, password, refreshTokenIn } = parseBody(event, loginSchema);
        const now = deps.now();
        const found = await users.findByUsername(username);
        if (found?.lockedUntil && new Date(found.lockedUntil) > now) {
          throw new ApiError(423, "account_locked", "Too many failed logins; try again later");
        }
        // Hash even when the user doesn't exist, so response time doesn't reveal which usernames are taken.
        const passwordOk = await verifyPassword(password, found?.passwordHash ?? (await dummyHash));
        if (!found) throw new ApiError(401, "invalid_credentials", "Invalid username or password");
        if (!passwordOk) await users.recordFailedLogin(found.user.id, now);
        if (!passwordOk || found.user.status === "disabled") {
          throw new ApiError(401, "invalid_credentials", "Invalid username or password");
        }
        if (found.failedLogins > 0) await users.clearFailedLogins(found.user.id);
        if (found.user.status === "pending") {
          throw new ApiError(403, "account_pending", "This account is waiting for admin approval");
        }
        const accessToken = await accessTokenFor(found.user, now);
        const refreshToken = generateRefreshToken(found.user.id);
        await users.saveRefreshToken(found.user.id, hashRefreshToken(refreshToken), refreshExpiry(now));
        return withRefreshToken({ accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }, refreshToken, refreshTokenIn);
      }
      case "POST /api/v1/auth/refresh": {
        const now = deps.now();
        const { token, deliverIn } = readRefreshToken(event);
        const [userId] = token.split(".");
        const user = userId ? await users.getById(userId) : undefined;
        if (user?.status !== "active") throw invalidRefreshToken();
        const next = generateRefreshToken(user.id);
        try {
          await users.rotateRefreshToken(user.id, hashRefreshToken(token), hashRefreshToken(next), now, refreshExpiry(now));
        } catch (err) {
          if (!(err instanceof InvalidRefreshTokenError)) throw err;
          if (err.reused) await users.revokeRefreshTokens(user.id);
          throw invalidRefreshToken();
        }
        const accessToken = await accessTokenFor(user, now);
        return withRefreshToken({ accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }, next, deliverIn);
      }
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
