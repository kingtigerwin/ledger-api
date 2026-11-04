import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createAuthorizer } from "../../src/auth/authorizer";
import { signAccessToken } from "../../src/auth/tokens";

const secret = "test-secret";
const issuedAt = new Date("2026-10-26T10:00:00Z");
const claims = { sub: "user-1", role: "customer" as const, scope: "transactions:read" };

const eventWith = (authorization?: string) =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as unknown as APIGatewayRequestAuthorizerEventV2;

describe("given a request to a protected route", () => {
  const authorize = (at: Date, active = true) =>
    createAuthorizer({ signingSecret: secret, now: () => at, isActive: async () => active });

  it("allows a valid bearer token and passes its claims to the route", async () => {
    const token = await signAccessToken(claims, secret, issuedAt);

    const result = await authorize(issuedAt)(eventWith(`Bearer ${token}`));

    expect(result).toEqual({
      isAuthorized: true,
      context: { userId: "user-1", role: "customer", scope: "transactions:read" },
    });
  });

  it.each([
    ["no Authorization header", undefined],
    ["a scheme other than Bearer", "Basic dXNlcjpwdw=="],
    ["a malformed token", "Bearer not-a-jwt"],
  ])("refuses %s", async (_, header) => {
    expect(await authorize(issuedAt)(eventWith(header))).toEqual({ isAuthorized: false });
  });

  it("refuses an expired token", async () => {
    const token = await signAccessToken(claims, secret, issuedAt);

    const result = await authorize(new Date("2026-10-26T10:15:01Z"))(eventWith(`Bearer ${token}`));

    expect(result).toEqual({ isAuthorized: false });
  });

  it("refuses a token signed with another secret", async () => {
    const token = await signAccessToken(claims, "other-secret", issuedAt);

    expect(await authorize(issuedAt)(eventWith(`Bearer ${token}`))).toEqual({ isAuthorized: false });
  });

  it("refuses a valid token whose user is no longer active", async () => {
    const token = await signAccessToken(claims, secret, issuedAt);

    expect(await authorize(issuedAt, false)(eventWith(`Bearer ${token}`))).toEqual({ isAuthorized: false });
  });

  describe("looking up the user", () => {
    const asked: string[] = [];
    const recording = createAuthorizer({
      signingSecret: secret,
      now: () => issuedAt,
      isActive: async (userId) => {
        asked.push(userId);
        return true;
      },
    });

    it("only asks about the user of a token it has verified, so junk tokens cost no read", async () => {
      asked.length = 0;

      await recording(eventWith("Bearer not-a-jwt"));

      expect(asked).toEqual([]);
    });

    it("asks about the user the token names", async () => {
      asked.length = 0;

      await recording(eventWith(`Bearer ${await signAccessToken(claims, secret, issuedAt)}`));

      expect(asked).toEqual(["user-1"]);
    });
  });
});
