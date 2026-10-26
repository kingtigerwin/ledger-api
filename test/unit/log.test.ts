import { describe, expect, it } from "vitest";
import { redact } from "../../src/log";

describe("given something about to be logged", () => {
  it("hides passwords, tokens, cookies and Authorization headers at any depth", () => {
    const logged = redact({
      routeKey: "POST /api/v1/auth/login",
      body: { username: "alice", password: "hunter2", refreshToken: "u.abc" },
      headers: { Authorization: "Bearer eyJ...", "content-type": "application/json" },
      cookies: ["refreshToken=u.abc"],
      nested: [{ accessToken: "eyJ..." }],
    });

    expect(logged).toEqual({
      routeKey: "POST /api/v1/auth/login",
      body: { username: "alice", password: "[REDACTED]", refreshToken: "[REDACTED]" },
      headers: { Authorization: "[REDACTED]", "content-type": "application/json" },
      cookies: "[REDACTED]",
      nested: [{ accessToken: "[REDACTED]" }],
    });
  });

  it("keeps an Error's name and message", () => {
    const logged = redact({ err: new TypeError("boom") }) as { err: { name: string; message: string } };

    expect(logged.err).toMatchObject({ name: "TypeError", message: "boom" });
  });
});
