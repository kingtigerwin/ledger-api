import { jwtVerify, SignJWT } from "jose";
import type { Role } from "./users-store";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessClaims {
  sub: string;
  role: Role;
  /** Space-separated, as in OAuth. */
  scope: string;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(claims: AccessClaims, secret: string, now: Date): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({ role: claims.role, scope: claims.scope })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key(secret));
}

/** Throws if the token is malformed, wrongly signed or expired. */
export async function verifyAccessToken(token: string, secret: string, now: Date): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"], currentDate: now });
  return { sub: payload.sub!, role: payload.role as Role, scope: payload.scope as string };
}
