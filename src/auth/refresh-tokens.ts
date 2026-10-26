import { createHash, randomBytes } from "node:crypto";

export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** `<userId>.<random>`: the user ID lets us find the token's record without a separate index. */
export function generateRefreshToken(userId: string): string {
  return `${userId}.${randomBytes(32).toString("base64url")}`;
}

export function refreshCookie(token: string): string {
  return `refreshToken=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`;
}

/** Only this hash is stored, so a leaked table can't be used to refresh. */
export const hashRefreshToken = (token: string) => createHash("sha256").update(token).digest("base64url");
