import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoogleSignInError, usernameFor } from "../../src/auth/google";
import { createAuthHandler } from "../../src/auth/handler";
import { createUsersStore, UsernameTakenError, type UserStatus } from "../../src/auth/users-store";
import { ddb } from "../../src/db-client";
import type { LogEntry } from "../../src/log";
import { createUsersTable, deleteTable } from "../support/dynamo";
import { CLIENT_ID, idToken, NOW, REDIRECT_URI } from "../support/google";
import { call, cookiePair } from "../support/http";
import { createUserWithStatus } from "../support/users";

const GOOGLE_START = "GET /api/v1/auth/google/start";
const GOOGLE_CALLBACK = "GET /api/v1/auth/google/callback";
const SECRET = "test-signing-secret-of-32-bytes!";

/** Stands in for Google's token endpoint: hands back an ID token carrying the nonce it was sent to. */
class FakeGoogle {
  claims: Record<string, unknown> = {};
  failure?: Error;
  calls: [string, string][] = [];

  exchangeCode = async (code: string, codeVerifier: string) => {
    this.calls.push([code, codeVerifier]);
    if (this.failure) throw this.failure;
    return idToken(this.claims);
  };
}

let tableName: string;
let google: FakeGoogle;
let logged: LogEntry[];
let handler: ReturnType<typeof createAuthHandler>;

// Each test counts what's in the table, so each gets its own.
beforeEach(async () => {
  tableName = await createUsersTable();
  google = new FakeGoogle();
  logged = [];
  handler = createAuthHandler({
    tableName,
    signingSecret: SECRET,
    now: () => NOW,
    log: (entry) => logged.push(entry),
    google: { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, exchangeCode: google.exchangeCode },
  });
});

afterEach(async () => {
  await deleteTable(tableName);
});

/** Begins a sign-in: the browser's cookie, and the state Google will send back. */
async function start() {
  const res = await call(handler, GOOGLE_START);
  const query = new URL(res.location!).searchParams;
  google.claims.nonce ??= query.get("nonce");
  return { cookie: cookiePair(res.cookies[0]!), state: query.get("state")! };
}

/** The whole round trip, with Google accepting the user. */
async function signIn() {
  const { cookie, state } = await start();
  return call(handler, GOOGLE_CALLBACK, undefined, { cookies: [cookie], query: { code: "the-code", state } });
}

const item = async (pk: string, sk: string) =>
  (await ddb.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }))).Item ?? {};
const count = async () => (await ddb.send(new ScanCommand({ TableName: tableName, Select: "COUNT" }))).Count;

/** Signs the user in once, then gives them `status`. */
async function seedGoogleUser(status: UserStatus) {
  const store = createUsersStore(tableName);
  const user = await store.createGoogleUser({ sub: "1234567890", username: "alice-g1", email: "alice@example.com", now: NOW });
  await store.setStatus(user.id, status);
}

describe("GET /auth/google/start", () => {
  describe("given Google is configured", () => {
    it("redirects to Google and remembers the attempt in a cookie", async () => {
      const res = await call(handler, GOOGLE_START);

      expect(res.status).toBe(302);
      expect(res.location?.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
      expect(res.cookies).toHaveLength(1);
      expect(res.cookies[0]?.startsWith("__Host-googleSignIn=")).toBe(true);
    });
  });

  describe("given Google isn't configured", () => {
    it("sends the browser back to the login page from both routes", async () => {
      const unconfigured = createAuthHandler({ tableName, signingSecret: SECRET, now: () => NOW });

      for (const route of [GOOGLE_START, GOOGLE_CALLBACK]) {
        const res = await call(unconfigured, route);

        expect([res.status, res.location]).toEqual([302, "/login?error=google_unavailable"]);
      }
    });
  });
});

describe("GET /auth/google/callback", () => {
  describe("given someone new to Ledger", () => {
    it("creates an active customer and signs them straight in", async () => {
      const res = await signIn();

      expect([res.status, res.location]).toEqual([302, "/"]);
      expect(res.cookies.some((c) => c.startsWith("refreshToken="))).toBe(true);
      const claim = await item("GOOGLE#1234567890", "GOOGLE");
      const profile = await item(`USER#${claim.userId}`, "PROFILE");
      expect(profile).toMatchObject({
        status: "active",
        role: "customer",
        email: "Alice.B@example.com",
        authProvider: "google",
      });
      expect(profile).not.toHaveProperty("passwordHash");
      expect((await item(`USERNAME#${profile.username}`, "USERNAME")).userId).toBe(claim.userId);
    });

    it("passes the code and the PKCE verifier to Google", async () => {
      const { cookie, state } = await start();

      await call(handler, GOOGLE_CALLBACK, undefined, { cookies: [cookie], query: { code: "the-code", state } });

      const [code, verifier] = google.calls[0]!;
      expect(code).toBe("the-code");
      expect(cookie.endsWith(`.${verifier}`)).toBe(true);
    });
  });

  describe("given an approved Google user", () => {
    it("sets the refresh cookie, clears the attempt and redirects to the landing page", async () => {
      await seedGoogleUser("active");

      const res = await signIn();

      expect([res.status, res.location]).toEqual([302, "/"]);
      expect(res.cookies.map((c) => c.split("=")[0]).sort()).toEqual(["__Host-googleSignIn", "refreshToken"]);
      expect(res.cookies.find((c) => c.startsWith("__Host-"))).toContain("Max-Age=0");
    });

    it("starts the ordinary session, which the UI picks up from the refresh cookie", async () => {
      await seedGoogleUser("active");
      const res = await signIn();
      const refreshCookie = res.cookies.find((c) => c.startsWith("refreshToken="))!;

      const refreshed = await call(handler, "POST /api/v1/auth/refresh", undefined, { cookies: [cookiePair(refreshCookie)] });

      expect(refreshed.status).toBe(200);
      expect(refreshed.body.accessToken).toBeTruthy();
    });
  });

  describe("given a pending Google user", () => {
    it("activates them and signs them in, without creating a second account", async () => {
      await seedGoogleUser("pending");

      const res = await signIn();

      expect(res.location).toBe("/");
      const claim = await item("GOOGLE#1234567890", "GOOGLE");
      expect((await item(`USER#${claim.userId}`, "PROFILE")).status).toBe("active");
      // The profile and its two claims, plus the session this sign-in started.
      expect(await count()).toBe(4);
    });
  });

  describe("given a disabled Google user", () => {
    it("refuses them the same way as any failure", async () => {
      await seedGoogleUser("disabled");

      const res = await signIn();

      expect(res.location).toBe("/login?error=google_failed");
      expect(res.cookies.some((c) => c.startsWith("refreshToken="))).toBe(false);
    });
  });

  describe("given a password user with the same email", () => {
    it("makes a separate account rather than linking on an unverified address", async () => {
      const existing = await createUsersStore(tableName).create({
        username: "alice",
        email: "Alice.B@example.com",
        passwordHash: "scrypt$unused",
        role: "customer",
        status: "active",
        now: NOW,
      });

      const res = await signIn();

      expect(res.location).toBe("/");
      expect((await item("GOOGLE#1234567890", "GOOGLE")).userId).not.toBe(existing.id);
    });
  });

  describe("given two first sign-ins at once", () => {
    it("never makes two accounts", async () => {
      const store = createUsersStore(tableName);

      await Promise.all(
        Array.from({ length: 4 }, () =>
          // A loser may see the winner's transaction still in flight; it fails, and the user tries again.
          store.createGoogleUser({ sub: "42", username: "sam-g1", email: "sam@example.com", now: NOW }).catch((err) => {
            if (!(err instanceof UsernameTakenError)) throw err;
          }),
        ),
      );

      const { Items = [] } = await ddb.send(new ScanCommand({ TableName: tableName }));
      expect(Items.filter((i) => i.sk === "PROFILE")).toHaveLength(1);
      expect(Items).toHaveLength(3);
    });

    it("gives a later attempt the account the first made", async () => {
      const store = createUsersStore(tableName);
      const first = await store.createGoogleUser({ sub: "42", username: "sam-g1", email: "sam@example.com", now: NOW });

      const second = await store.createGoogleUser({ sub: "42", username: "sam-g1", email: "sam@example.com", now: NOW });

      expect(second.id).toBe(first.id);
    });
  });

  describe("given a Google name already taken by another user", () => {
    it("is refused by the store, and the sign-in fails cleanly", async () => {
      const username = usernameFor({ sub: "1234567890", email: "Alice.B@example.com" });
      await createUserWithStatus(tableName, username, "pw", "active");

      await expect(
        createUsersStore(tableName).createGoogleUser({ sub: "1234567890", username, email: "Alice.B@example.com", now: NOW }),
      ).rejects.toThrow(UsernameTakenError);
      expect((await signIn()).location).toBe("/login?error=google_failed");
    });
  });

  it.each([
    ["a state that doesn't match", { code: "the-code", state: "another-state" }],
    ["a state that isn't ASCII", { code: "the-code", state: "café" }],
    ["no state", { code: "the-code" }],
    ["no code", { state: undefined }],
    ["the user cancelling at Google", { error: "access_denied", state: undefined }],
  ])("never reaches Google, and clears the attempt, given %s", async (_, query: Record<string, string | undefined>) => {
    const { cookie, state } = await start();
    const sent = Object.fromEntries(Object.entries(query).map(([key, value]) => [key, value ?? state]));

    const res = await call(handler, GOOGLE_CALLBACK, undefined, { cookies: [cookie], query: sent });

    expect([res.status, res.location]).toEqual([302, "/login?error=google_failed"]);
    expect(google.calls).toEqual([]);
    expect(res.cookies[0]?.startsWith("__Host-googleSignIn=;")).toBe(true);
  });

  it("treats a junk state as an ordinary failure, not an unhandled error", async () => {
    const { cookie } = await start();

    await call(handler, GOOGLE_CALLBACK, undefined, { cookies: [cookie], query: { code: "the-code", state: "café" } });

    expect(logged).toContainEqual({ event: "google_login_failed", reason: "state_mismatch" });
  });

  it("fails without the attempt's cookie, so an attacker can't plant their own login", async () => {
    const { state } = await start();

    const res = await call(handler, GOOGLE_CALLBACK, undefined, { query: { code: "the-code", state } });

    expect(res.location).toBe("/login?error=google_failed");
    expect(google.calls).toEqual([]);
  });

  it("refuses an ID token for another nonce", async () => {
    google.claims.nonce = "replayed-from-another-sign-in";

    const res = await signIn();

    expect(res.location).toBe("/login?error=google_failed");
    expect(await count()).toBe(0);
  });

  it.each([
    ["Google refusing the code", new GoogleSignInError("token_request_failed")],
    ["something unexpected", new Error("SSM is down")],
  ])("redirects rather than showing JSON in the browser, given %s", async (_, failure) => {
    google.failure = failure;

    const res = await signIn();

    expect([res.status, res.location]).toEqual([302, "/login?error=google_failed"]);
    expect(res.body).toEqual({});
    expect(logged.some((entry) => entry.event === "login_failed")).toBe(false);
  });

  it("logs a Google failure for itself, with no code or state", async () => {
    google.failure = new GoogleSignInError("token_request_failed");

    await signIn();

    expect(logged).toContainEqual({ event: "google_login_failed", reason: "token_request_failed" });
  });
});

describe("a password login to a Google account", () => {
  it.each([
    ["a guess", "guess"],
    ["the dummy hash's own password", "not-a-real-password"],
  ])("never gets in, with %s", async (_, password) => {
    const store = createUsersStore(tableName);
    const user = await store.createGoogleUser({ sub: "7", username: "pat-g1", email: "pat@example.com", now: NOW });

    const res = await call(handler, "POST /api/v1/auth/login", { username: user.username, password });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_credentials");
  });
});
