import { createHmac, timingSafeEqual } from "node:crypto";

export class InvalidCursorError extends Error {}

const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/**
 * DynamoDB's LastEvaluatedKey, encoded and signed. Without the signature, a client could edit
 * the key to start a page inside another household's partition.
 */
export function encodeCursor(key: Record<string, unknown>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(key)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeCursor(cursor: string, secret: string): Record<string, unknown> {
  const [payload, signature, ...rest] = cursor.split(".");
  if (!payload || !signature || rest.length > 0) throw new InvalidCursorError();
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new InvalidCursorError();
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
}
