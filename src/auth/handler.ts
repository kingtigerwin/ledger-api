import { ApiError, authContext, json, noContent, parseBody, readCookie, redirect, withErrors } from "../http";
import { log as defaultLog, type Logger } from "../log";
import {
  attemptCookie,
  authorizationUrl,
  clearAttemptCookie,
  type GoogleSignIn,
  GoogleSignInError,
  identityFrom,
  newAttempt,
  readAttempt,
  sameSecret,
  usernameFor,
} from "./google";
import { localeFromAcceptLanguage } from "./locale";
import { hashPassword, verifyPassword } from "./password";
import { loginSchema, registerSchema, updateMeSchema } from "./schemas";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  clearRefreshCookie,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshCookie,
} from "./refresh-tokens";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "./tokens";
import {
  createUsersStore,
  InvalidRefreshTokenError,
  type Role,
  type User,
  UsernameTakenError,
  UserNotFoundError,
} from "./users-store";

export interface AuthDeps {
  tableName: string;
  signingSecret: string;
  now: () => Date;
  log?: Logger;
  /** Sign-in with Google, if the stack configured it. */
  google?: GoogleSignIn;
}

const SCOPES: Record<Role, string> = {
  customer: "transactions:read transactions:write",
  // The admin also records their own spending, like a customer.
  admin: "admin:read admin:write transactions:read transactions:write",
};

// ledger-ui's pages; relative, so the browser stays on the host that's showing the app.
const LANDING_PAGE = "/";
const LOGIN_PAGE = "/login";

type Delivery = "cookie" | "body";

/** Sends the refresh token the way the client asked: as a cookie, or in the JSON body. */
function withRefreshToken(body: Record<string, unknown>, refreshToken: string, deliverIn: Delivery) {
  return deliverIn === "body" ? json(200, { ...body, refreshToken }) : json(200, body, [refreshCookie(refreshToken)]);
}

/** What `/auth/me` shows the user of themselves. */
const profileOf = ({ id, username, email, role, status, locale }: User) => ({ id, username, email, role, status, locale });

const invalidRefreshToken = () => new ApiError(401, "invalid_refresh_token", "Log in again");

/** Finds the refresh token in the cookie (browsers) or the JSON body (other clients). */
function readRefreshToken(event: APIGatewayProxyEventV2): { token: string; deliverIn: Delivery } | undefined {
  const cookie = readCookie(event, "refreshToken");
  if (cookie !== undefined) return { token: cookie, deliverIn: "cookie" };
  try {
    const { refreshToken } = JSON.parse(event.body ?? "{}");
    if (typeof refreshToken === "string" && refreshToken) return { token: refreshToken, deliverIn: "body" };
  } catch {
    // An unreadable body is the same as a missing token.
  }
  return undefined;
}

/** Register, log in, sign in with Google, refresh, log out and me: the routes that hand out and take back tokens. */
export function createAuthHandler(deps: AuthDeps) {
  const users = createUsersStore(deps.tableName);
  // Checked against when the username doesn't exist; made on first need rather than slowing every cold start.
  let dummyHash: Promise<string> | undefined;
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
  const newRefreshToken = async (user: User, now: Date) => {
    const refreshToken = generateRefreshToken(user.id);
    await users.saveRefreshToken(user.id, hashRefreshToken(refreshToken), refreshExpiry(now));
    return refreshToken;
  };

  const finishGoogleSignIn = async (event: APIGatewayProxyEventV2, google: GoogleSignIn) => {
    const query = event.queryStringParameters ?? {};
    const attempt = readAttempt(event);
    if (!attempt || !sameSecret(query.state ?? "", attempt.state)) throw new GoogleSignInError("state_mismatch");
    if (!query.code) throw new GoogleSignInError("no_code");
    const now = deps.now();
    const idToken = await google.exchangeCode(query.code, attempt.codeVerifier);
    const identity = identityFrom(idToken, { clientId: google.clientId, nonce: attempt.nonce, now });
    // Never matched by email: registered addresses aren't verified, so one could be someone else's.
    let user =
      (await users.findByGoogleSub(identity.sub)) ??
      // The Users table's stream tells the notify Lambda, as it does for a registration.
      // Their browser's language, for the welcome email; there's no form to choose one on the way in.
      (await users.createGoogleUser({
        sub: identity.sub,
        username: usernameFor(identity),
        email: identity.email,
        locale: localeFromAcceptLanguage(event.headers["accept-language"]),
        now,
      }));
    if (user.status === "disabled") throw new GoogleSignInError("account_disabled");
    // From before Google sign-ins started active. Someone the admin rejected is disabled, so stops above.
    if (user.status === "pending") user = await users.setStatus(user.id, "active");
    // The UI's page load trades this cookie for an access token, as it does after any reload.
    return redirect(LANDING_PAGE, [clearAttemptCookie(), refreshCookie(await newRefreshToken(user, now))]);
  };

  /** Every outcome is a redirect: the browser is on this URL, so withErrors' JSON would be the whole page. */
  const googleCallback = async (event: APIGatewayProxyEventV2) => {
    if (!deps.google) return redirect(`${LOGIN_PAGE}?error=google_unavailable`);
    try {
      return await finishGoogleSignIn(event, deps.google);
    } catch (err) {
      if (err instanceof GoogleSignInError || err instanceof UsernameTakenError) {
        const reason = err instanceof GoogleSignInError ? err.message : "username_taken";
        // Not login_failed: that counts towards the password-guessing alarm.
        log({ event: "google_login_failed", reason });
      } else {
        log({ event: "unhandled_error", routeKey: event.routeKey, err }, "error");
      }
      return redirect(`${LOGIN_PAGE}?error=google_failed`, [clearAttemptCookie()]);
    }
  };

  return withErrors(async (event) => {
    switch (event.routeKey) {
      case "POST /api/v1/auth/register": {
        const { username, password, email, locale } = parseBody(event, registerSchema);
        try {
          // The Users table's stream tells the notify Lambda, which emails them that they're waiting for approval.
          const user = await users.create({
            username,
            email,
            locale,
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
        // Hash even with nothing to check against, so response time doesn't reveal which usernames are taken. The
        // dummy hash has a password of its own, so a match against it must never count.
        const storedHash = found?.passwordHash;
        dummyHash ??= hashPassword("not-a-real-password");
        const passwordOk = (await verifyPassword(password, storedHash ?? (await dummyHash))) && storedHash !== undefined;
        if (!found) throw loginFailed("invalid_credentials");
        if (!passwordOk) await users.recordFailedLogin(found.user.id, now);
        if (!passwordOk || found.user.status === "disabled") throw loginFailed("invalid_credentials");
        if (found.failedLogins > 0) await users.clearFailedLogins(found.user.id);
        if (found.user.status === "pending") {
          throw new ApiError(403, "account_pending", "This account is waiting for admin approval");
        }
        const accessToken = await accessTokenFor(found.user, now);
        const refreshToken = await newRefreshToken(found.user, now);
        return withRefreshToken({ accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }, refreshToken, refreshTokenIn);
      }
      case "GET /api/v1/auth/google/start": {
        if (!deps.google) return redirect(`${LOGIN_PAGE}?error=google_unavailable`);
        const attempt = newAttempt();
        return redirect(authorizationUrl(attempt, deps.google), [attemptCookie(attempt)]);
      }
      case "GET /api/v1/auth/google/callback":
        return googleCallback(event);
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
        return json(200, profileOf(user));
      }
      case "PATCH /api/v1/auth/me": {
        const { userId } = authContext(event);
        const { locale } = parseBody(event, updateMeSchema);
        try {
          return json(200, profileOf(await users.setLocale(userId, locale)));
        } catch (err) {
          if (err instanceof UserNotFoundError) throw new ApiError(401, "unauthorized", "Sign in first");
          throw err;
        }
      }
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
