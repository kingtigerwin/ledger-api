import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Attempt,
  attemptCookie,
  authorizationUrl,
  clearAttemptCookie,
  exchangeCode,
  GoogleSignInError,
  identityFrom,
  newAttempt,
  readAttempt,
  usernameFor,
} from "../../src/auth/google";
import { CLIENT_ID, idToken, NOW, REDIRECT_URI } from "../support/google";

describe("authorizationUrl", () => {
  describe("given an attempt", () => {
    it("asks Google for a code, with PKCE, for the openid and email scopes", () => {
      const attempt: Attempt = { state: "the-state", nonce: "the-nonce", codeVerifier: "the-verifier" };

      const url = new URL(authorizationUrl(attempt, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI }));

      expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid email",
        state: "the-state",
        nonce: "the-nonce",
        code_challenge: createHash("sha256").update("the-verifier").digest("base64url"),
        code_challenge_method: "S256",
        prompt: "select_account",
      });
    });
  });
});

describe("newAttempt", () => {
  it("makes every value different and long enough to be unguessable", () => {
    const [first, second] = [newAttempt(), newAttempt()];

    expect(new Set([first.state, first.nonce, first.codeVerifier, second.state]).size).toBe(4);
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe("the attempt's cookie", () => {
  describe("given an attempt", () => {
    it("survives the round trip through the browser", () => {
      const attempt = newAttempt();
      const pair = attemptCookie(attempt).split(";")[0]!;

      expect(readAttempt({ cookies: ["other=1", pair] })).toEqual(attempt);
    });

    it("is host-only and Lax, so it comes back on Google's redirect", () => {
      const cookie = attemptCookie(newAttempt());

      expect(cookie.startsWith("__Host-")).toBe(true);
      for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) {
        expect(cookie).toContain(attribute);
      }
      expect(cookie).not.toContain("Domain");
    });
  });

  it("is expired by clearing it", () => {
    const name = attemptCookie(newAttempt()).split("=")[0];

    expect(clearAttemptCookie().startsWith(`${name}=;`)).toBe(true);
    expect(clearAttemptCookie()).toContain("Max-Age=0");
  });

  it.each([
    ["no cookies", undefined],
    ["another cookie", ["other=1"]],
    ["a malformed value", ["__Host-googleSignIn=only.two"]],
  ])("reads as nothing given %s", (_, cookies) => {
    expect(readAttempt({ cookies })).toBeUndefined();
  });
});

describe("identityFrom", () => {
  const identity = (token: string) => identityFrom(token, { clientId: CLIENT_ID, nonce: "the-nonce", now: NOW });

  describe("given a valid ID token", () => {
    it("returns who Google says it is", () => {
      expect(identity(idToken())).toEqual({ sub: "1234567890", email: "Alice.B@example.com" });
    });

    it("accepts Google's issuer without the scheme", () => {
      expect(identity(idToken({ iss: "accounts.google.com" })).sub).toBe("1234567890");
    });
  });

  it.each([
    ["another issuer", { iss: "https://accounts.example.com" }],
    ["no issuer", { iss: undefined }],
    ["another audience", { aud: "another-client" }],
    ["no audience", { aud: undefined }],
    ["another nonce", { nonce: "another-nonce" }],
    ["no nonce", { nonce: undefined }],
    ["a nonce that isn't ASCII", { nonce: "café" }],
    ["expired this second", { exp: Math.floor(NOW.getTime() / 1000) }],
    ["no expiry", { exp: undefined }],
    ["an unverified email", { email_verified: false }],
    ["email_verified that isn't a boolean", { email_verified: "true" }],
    ["no email", { email: undefined }],
    ["no subject", { sub: undefined }],
  ])("refuses %s", (_, claims) => {
    expect(() => identity(idToken(claims))).toThrow(GoogleSignInError);
  });

  it("refuses something that isn't a token", () => {
    expect(() => identity("not-a-token")).toThrow(GoogleSignInError);
  });
});

describe("exchangeCode", () => {
  const exchange = () =>
    exchangeCode({
      code: "the-code",
      codeVerifier: "the-verifier",
      clientId: CLIENT_ID,
      clientSecret: "the-secret",
      redirectUri: REDIRECT_URI,
    });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("given Google accepts the code", () => {
    it("posts the form to the token endpoint with a timeout, and returns the ID token", async () => {
      const fetch = vi.fn(async () => Response.json({ id_token: "the-id-token", access_token: "unused" }));
      vi.stubGlobal("fetch", fetch);

      expect(await exchange()).toBe("the-id-token");

      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://oauth2.googleapis.com/token");
      expect(init.method).toBe("POST");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
        code: "the-code",
        code_verifier: "the-verifier",
        client_id: CLIENT_ID,
        client_secret: "the-secret",
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      });
    });
  });

  it.each([
    ["Google refusing the code", async () => new Response("{}", { status: 400 }), "token_request_failed"],
    ["Google being unreachable", async () => Promise.reject(new TypeError("fetch failed")), "token_request_failed"],
    ["Google being slow", async () => Promise.reject(new DOMException("timed out", "TimeoutError")), "token_request_failed"],
    ["an answer that isn't JSON", async () => new Response("<html>"), "token_request_failed"],
    ["no ID token in the answer", async () => Response.json({}), "no_id_token"],
  ])("fails with a reason that carries no secret, given %s", async (_, fetch, reason) => {
    vi.stubGlobal("fetch", fetch);

    await expect(exchange()).rejects.toThrow(new GoogleSignInError(reason));
  });
});

describe("usernameFor", () => {
  it("is readable, lower case and the same every time", () => {
    const identity = { sub: "1234567890", email: "Alice.B@example.com" };
    const suffix = createHash("sha256").update("1234567890").digest("hex").slice(0, 8);

    expect(usernameFor(identity)).toBe(`alice.b-g${suffix}`);
    expect(usernameFor(identity)).toBe(usernameFor(identity));
  });

  it("gives two people with the same local part different names", () => {
    expect(usernameFor({ sub: "1", email: "sam@example.com" })).not.toBe(usernameFor({ sub: "2", email: "sam@example.org" }));
  });

  it("stays within the 64 characters a username may have", () => {
    expect(usernameFor({ sub: "1", email: `${"a".repeat(64)}@example.com` }).length).toBeLessThanOrEqual(64);
  });
});
