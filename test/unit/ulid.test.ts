import { describe, expect, it } from "vitest";
import { isUlid, ulidTime } from "../../src/data/ulid";

describe("given a ULID", () => {
  // From the ulid library's README: ulid(1469918176385) → "01ARYZ6S41TSV4RRFFQ69G5FAV".
  const specExample = "01ARYZ6S41TSV4RRFFQ69G5FAV";

  it("accepts a well-formed one", () => {
    expect(isUlid(specExample)).toBe(true);
  });

  it("reads the creation time from its first 10 characters", () => {
    expect(ulidTime(specExample).getTime()).toBe(1469918176385);
  });

  it.each([
    ["too short", "01ARZ3NDEKTSV4RRFFQ69G5FA"],
    ["too long", "01ARZ3NDEKTSV4RRFFQ69G5FAVX"],
    ["with a letter Crockford base32 excludes (U)", "01ARZ3NDEKTSV4RRFFQ69G5FAU"],
    ["lowercase", "01arz3ndektsv4rrffq69g5fav"],
    ["beyond the largest timestamp (starts with 8)", "81ARZ3NDEKTSV4RRFFQ69G5FAV"],
  ])("rejects one that is %s", (_, value) => {
    expect(isUlid(value)).toBe(false);
  });
});
