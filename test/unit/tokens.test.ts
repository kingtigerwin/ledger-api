import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../../src/auth/tokens";

const secret = "test-secret";
const issuedAt = new Date("2026-10-26T10:00:00Z");
const claims = { sub: "user-1", role: "customer" as const, scope: "transactions:read" };

describe("given an access token", () => {
  it("returns its claims when verified with the same secret", async () => {
    const token = await signAccessToken(claims, secret, issuedAt);
    expect(await verifyAccessToken(token, secret, issuedAt)).toEqual(claims);
  });

  it("is still valid just before 15 minutes have passed", async () => {
    const token = await signAccessToken(claims, secret, issuedAt);
    await expect(verifyAccessToken(token, secret, new Date("2026-10-26T10:14:59Z"))).resolves.toEqual(claims);
  });

  it("is rejected once 15 minutes have passed", async () => {
    const token = await signAccessToken(claims, secret, issuedAt);
    await expect(verifyAccessToken(token, secret, new Date("2026-10-26T10:15:01Z"))).rejects.toThrow();
  });

  it("is rejected when signed with a different secret", async () => {
    const token = await signAccessToken(claims, "other-secret", issuedAt);
    await expect(verifyAccessToken(token, secret, issuedAt)).rejects.toThrow();
  });

  it("is rejected when its payload is tampered with", async () => {
    const [header, , signature] = (await signAccessToken(claims, secret, issuedAt)).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, role: "admin" })).toString("base64url");
    await expect(verifyAccessToken(`${header}.${forged}.${signature}`, secret, issuedAt)).rejects.toThrow();
  });
});
