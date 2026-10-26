import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/data/cursor";

const key = { pk: "USER#u1", sk: "TXN#2026-10-26#01ARZ3NDEKTSV4RRFFQ69G5FAV" };

describe("given a list cursor", () => {
  it("decodes back to the DynamoDB key it was made from", () => {
    expect(decodeCursor(encodeCursor(key, "secret"), "secret")).toEqual(key);
  });

  it("is rejected when its contents are changed", () => {
    const [, signature] = encodeCursor(key, "secret").split(".");
    const forged = Buffer.from(JSON.stringify({ ...key, pk: "USER#someone-else" })).toString("base64url");

    expect(() => decodeCursor(`${forged}.${signature}`, "secret")).toThrow();
  });

  it("is rejected when signed with another secret", () => {
    expect(() => decodeCursor(encodeCursor(key, "other"), "secret")).toThrow();
  });

  it.each(["", "garbage", "a.b.c"])("rejects the malformed cursor %j", (cursor) => {
    expect(() => decodeCursor(cursor, "secret")).toThrow();
  });
});
