/**
 * Sign-in with Google: OpenID Connect's authorization code flow with PKCE. Only the auth Lambda imports this,
 * so the authorizer's cold start stays as it is.
 *
 * The ID token's signature isn't checked. OpenID Connect allows this when the token comes straight from the
 * token endpoint over TLS, authenticated with the client secret, which is the only way one reaches
 * `identityFrom`; checking it would mean fetching Google's keys on a cold start. The claims are checked here.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { decodeJwt } from "jose";
import { GOOGLE_CLIENT_SECRET_PARAM } from "../config";
import { readCookie } from "../http";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
// Leaves room in the function's 10 seconds to redirect the browser back with an error.
const TIMEOUT_MS = 5000;

// __Host- means only this exact host can set it, so another site under haoran.cloud can't plant one. Lax, not
// Strict like the refresh cookie: a Strict cookie isn't sent on the navigation back from Google.
const COOKIE_NAME = "__Host-googleSignIn";
const COOKIE = "HttpOnly; Secure; SameSite=Lax; Path=/";
const COOKIE_MAX_AGE_SECONDS = 10 * 60;

// A username is at most 64 characters: this much of the address, then `-g` and the hash.
const USERNAME_PREFIX_LENGTH = 54;

/** The sign-in can't go on. The message is a short reason for the logs, never a code, state or token. */
export class GoogleSignInError extends Error {
  override name = "GoogleSignInError";
}

export interface GoogleIdentity {
  /** Google's stable ID for the account. Identify people by this: an address can change hands. */
  sub: string;
  email: string;
}

export interface GoogleSignIn {
  clientId: string;
  redirectUri: string;
  /** Takes the code and the PKCE verifier, and returns the ID token. */
  exchangeCode: (code: string, codeVerifier: string) => Promise<string>;
}

/** What ties Google's redirect back to the browser that started the sign-in. */
export interface Attempt {
  state: string;
  nonce: string;
  codeVerifier: string;
}

const token = () => randomBytes(32).toString("base64url");

export const newAttempt = (): Attempt => ({ state: token(), nonce: token(), codeVerifier: token() });

export const attemptCookie = (attempt: Attempt) =>
  `${COOKIE_NAME}=${attempt.state}.${attempt.nonce}.${attempt.codeVerifier}; ${COOKIE}; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;

export const clearAttemptCookie = () => `${COOKIE_NAME}=; ${COOKIE}; Max-Age=0`;

export function readAttempt(event: Pick<APIGatewayProxyEventV2, "cookies">): Attempt | undefined {
  const parts = (readCookie(event, COOKIE_NAME) ?? "").split(".");
  const [state, nonce, codeVerifier] = parts;
  if (parts.length !== 3 || !state || !nonce || !codeVerifier) return undefined;
  return { state, nonce, codeVerifier };
}

/** Compares two strings in constant time; any string, ASCII or not, is just bytes here. */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Where to send the browser. Asking for `select_account` lets someone with several Google accounts choose. */
export function authorizationUrl(attempt: Attempt, { clientId, redirectUri }: { clientId: string; redirectUri: string }) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: createHash("sha256").update(attempt.codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${AUTHORIZATION_ENDPOINT}?${query}`;
}

/** Trades the code for an ID token at Google's token endpoint; the only caller of the network here. */
export async function exchangeCode(form: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<string> {
  let body: unknown;
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: form.code,
        code_verifier: form.codeVerifier,
        client_id: form.clientId,
        client_secret: form.clientSecret,
        redirect_uri: form.redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    body = await res.json();
  } catch {
    throw new GoogleSignInError("token_request_failed");
  }
  const idToken = body && typeof body === "object" ? (body as { id_token?: unknown }).id_token : undefined;
  if (typeof idToken !== "string") throw new GoogleSignInError("no_id_token");
  return idToken;
}

/** Who an ID token from `exchangeCode` says this is. Throws GoogleSignInError unless every claim holds. */
export function identityFrom(
  idToken: string,
  { clientId, nonce, now }: { clientId: string; nonce: string; now: Date },
): GoogleIdentity {
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(idToken);
  } catch {
    throw new GoogleSignInError("malformed_id_token");
  }
  const { iss, aud, exp, sub, email } = claims;
  if (typeof iss !== "string" || !ISSUERS.has(iss)) throw new GoogleSignInError("wrong_issuer");
  if (aud !== clientId) throw new GoogleSignInError("wrong_audience");
  if (!sameSecret(String(claims.nonce ?? ""), nonce)) throw new GoogleSignInError("wrong_nonce");
  if (!Number.isInteger(exp) || (exp as number) <= now.getTime() / 1000) throw new GoogleSignInError("expired_id_token");
  if (typeof sub !== "string" || !sub || typeof email !== "string" || !email) {
    throw new GoogleSignInError("incomplete_id_token");
  }
  if (claims.email_verified !== true) throw new GoogleSignInError("unverified_email");
  return { sub, email };
}

/** Readable in emails and in the admin's MCP filter, and the same each time; the hash keeps two Sams apart. */
export function usernameFor(identity: GoogleIdentity): string {
  const localPart = identity.email.split("@")[0]!.toLowerCase().slice(0, USERNAME_PREFIX_LENGTH);
  return `${localPart}-g${createHash("sha256").update(identity.sub).digest("hex").slice(0, 8)}`;
}

/** Set by hand (see README.md). Read on first use, so a problem with it can't stop password logins. */
export async function loadClientSecret(ssm = new SSMClient({})): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: GOOGLE_CLIENT_SECRET_PARAM, WithDecryption: true }));
  return res.Parameter?.Value ?? "";
}
