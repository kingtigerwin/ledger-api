// What the Google sign-in tests share: the client, a fixed clock, and ID tokens as Google issues them.

export const CLIENT_ID = "client-1.apps.googleusercontent.com";
export const REDIRECT_URI = "https://ledger.example.test/api/v1/auth/google/callback";
export const NOW = new Date("2026-11-01T00:00:00Z");

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An ID token as Google's token endpoint returns it; its signature isn't checked, so any will do. */
export function idToken(overrides: Record<string, unknown> = {}): string {
  const claims: Record<string, unknown> = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "1234567890",
    email: "Alice.B@example.com",
    email_verified: true,
    nonce: "the-nonce",
    exp: Math.floor(NOW.getTime() / 1000) + 5 * 60,
    ...overrides,
  };
  const payload = Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined));
  return `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64(payload)}.c2lnbmF0dXJl`;
}
