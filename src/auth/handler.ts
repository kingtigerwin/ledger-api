import { ApiError, authContext, json, noContent, parseBody, withErrors } from "../http";
import { log as defaultLog, type Logger } from "../log";
import { hashPassword, verifyPassword } from "./password";
import { credentialsSchema, loginSchema } from "./schemas";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  clearRefreshCookie,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshCookie,
} from "./refresh-tokens";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "./tokens";
import { createUsersStore, InvalidRefreshTokenError, type Role, type User, UsernameTakenError } from "./users-store";

export interface AuthDeps {
  tableName: string;
  signingSecret: string;
  now: () => Date;
  log?: Logger;
}

// Admins manage users and read data; they have no household of their own.
const SCOPES: Record<Role, string> = {
  customer: "members:read members:write transactions:read transactions:write",
  admin: "admin:read admin:write",
};



type Delivery = "cookie" | "body";

/** Sends the refresh token the way the client asked: as a cookie, or in the JSON body. */
function withRefreshToken(body: Record<string, unknown>, refreshToken: string, deliverIn: Delivery) {
  return deliverIn === "body" ? json(200, { ...body, refreshToken }) : json(200, body, [refreshCookie(refreshToken)]);
}

const invalidRefreshToken = () => new ApiError(401, "invalid_refresh_token", "Log in again");

/** Finds the refresh token in the cookie (browsers) or the JSON body (other clients). */
function readRefreshToken(event: APIGatewayProxyEventV2): { token: string; deliverIn: Delivery } | undefined {
  const cookie = event.cookies?.find((c) => c.startsWith("refreshToken="));
  if (cookie) return { token: cookie.slice("refreshToken=".length), deliverIn: "cookie" };
  try {
    const { refreshToken } = JSON.parse(event.body ?? "{}");
    if (typeof refreshToken === "string" && refreshToken) return { token: refreshToken, deliverIn: "body" };
  } catch {
    // An unreadable body is the same as a missing token.
  }
  return undefined;
}

export function createAuthHandler(deps: AuthDeps) {
  const users = createUsersStore(deps.tableName);
  const dummyHash = hashPassword("not-a-real-password");
  const log = deps.log ?? defaultLog;

  /** A failed login: logged for the failed-login alarm, then returned to the client. */
  const loginFailed = (reason: "invalid_credentials" | "account_locked") => {
    log({ event: "login_failed", reason });
    return reason === "account_locked"
      ? new ApiError(423, "account_locked", "Too many failed logins; try again later")
      : new ApiError(401, "invalid_credentials", "Invalid username or password");
  };

  const accessTokenFor = (user: User, now: Date) =>
    signAccessToken({ sub: user.id, role: user.role, scope: SCOPES[user.role] }, deps.signingSecret, now);
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
          throw loginFailed("account_locked");
        }
        // Hash even when the user doesn't exist, so response time doesn't reveal which usernames are taken.
        const passwordOk = await verifyPassword(password, found?.passwordHash ?? (await dummyHash));
        if (!found) throw loginFailed("invalid_credentials");
        if (!passwordOk) await users.recordFailedLogin(found.user.id, now);
        if (!passwordOk || found.user.status === "disabled") throw loginFailed("invalid_credentials");
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
        const presented = readRefreshToken(event);
        if (!presented) throw invalidRefreshToken();
        const { token, deliverIn } = presented;
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
      case "POST /api/v1/auth/logout": {
        // Logging out twice, or without a token, is still a successful logout.
        const presented = readRefreshToken(event);
        const userId = presented?.token.split(".")[0];
        if (presented && userId) await users.deleteRefreshToken(userId, hashRefreshToken(presented.token));
        return noContent([clearRefreshCookie()]);
      }
      case "GET /api/v1/auth/me": {
        const user = await users.getById(authContext(event).userId);
        if (!user) throw new ApiError(401, "unauthorized", "Sign in first");
        const { id, username, role, status } = user;
        return json(200, { id, username, role, status });
      }
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
