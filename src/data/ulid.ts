import { randomInt } from "node:crypto";

// ULIDs: 26 Crockford base32 characters; the first 10 encode milliseconds since the epoch.
// REST clients generate transaction IDs; the MCP server makes them for agents.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// The first character is at most 7: anything higher overflows the 48-bit timestamp.
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const isUlid = (value: string) => ULID_PATTERN.test(value);

export function ulidTime(ulid: string): Date {
  let ms = 0;
  for (const char of ulid.slice(0, 10)) ms = ms * 32 + ALPHABET.indexOf(char);
  return new Date(ms);
}

export function newUlid(at: Date = new Date()): string {
  let time = "";
  for (let ms = at.getTime(), i = 0; i < 10; i++, ms = Math.floor(ms / 32)) time = ALPHABET[ms % 32] + time;
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[randomInt(32)];
  return time + random;
}
