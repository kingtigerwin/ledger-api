import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/password";

describe("given a hashed password", () => {
  it("verifies the same password", async () => {
    const hash = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", hash)).toBe(true);
  });

  it("rejects a different password", async () => {
    const hash = await hashPassword("correct horse");
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
  });

  it("stores scrypt parameters and a fresh salt each time", async () => {
    const [a, b] = [await hashPassword("pw"), await hashPassword("pw")];
    expect(a).toMatch(/^scrypt\$131072\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
  });

  it("treats composed and decomposed Unicode as the same password", async () => {
    const hash = await hashPassword("café");
    expect(await verifyPassword("café", hash)).toBe(true);
  });
});
