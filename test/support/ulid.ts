import { randomInt } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generates a ULID the way a client would. */
export function newUlid(at: Date = new Date()): string {
  let time = "";
  for (let ms = at.getTime(), i = 0; i < 10; i++, ms = Math.floor(ms / 32)) time = ALPHABET[ms % 32] + time;
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[randomInt(32)];
  return time + random;
}
