import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../src/log";
import { emailFor } from "../../src/notify/emails";
import { createNotifyHandler, type OutgoingEmail } from "../../src/notify/handler";

const FROM = "noreply@haoran.cloud";

/** A Users-table profile item, as the store writes it. */
const profile = (overrides: Record<string, unknown> = {}) => ({
  pk: "USER#u-1",
  sk: "PROFILE",
  id: "u-1",
  username: "haoran",
  email: "haoran@example.com",
  role: "customer",
  status: "pending",
  createdAt: "2026-10-28T00:00:00.000Z",
  passwordHash: "scrypt$...",
  ...overrides,
});

describe("emailFor", () => {
  describe("given a customer who has just registered", () => {
    it("tells them the account is waiting for approval", () => {
      const email = emailFor(undefined, profile());

      expect(email).toMatchObject({ kind: "pending", to: "haoran@example.com" });
      expect(email?.subject).toMatch(/waiting for approval/i);
      expect(email?.text).toContain("haoran");
    });
  });

  describe("given a pending customer the admin has just enabled", () => {
    it("tells them they can sign in", () => {
      const email = emailFor(profile(), profile({ status: "active" }));

      expect(email).toMatchObject({ kind: "approved", to: "haoran@example.com" });
      expect(email?.subject).toMatch(/approved/i);
      expect(email?.text).toMatch(/sign in/i);
    });
  });

  describe("given a change that isn't a sign-up or a first approval", () => {
    it.each([
      ["a disabled customer enabled again", profile({ status: "disabled" }), profile({ status: "active" })],
      ["an active customer disabled", profile({ status: "active" }), profile({ status: "disabled" })],
      ["a pending customer disabled", profile(), profile({ status: "disabled" })],
      ["a failed login on a pending customer", profile(), profile({ failedLogins: 1 })],
      ["an admin created by bootstrap", undefined, profile({ role: "admin", status: "active", email: undefined })],
      ["a customer created already active", undefined, profile({ status: "active" })],
      ["a customer from before emails, enabled", profile({ email: undefined }), profile({ email: undefined, status: "active" })],
      ["a deleted item", profile(), undefined],
      ["a refresh token", undefined, { pk: "USER#u-1", sk: "REFRESH#abc", expiresAt: "2026-11-28T00:00:00.000Z" }],
      ["a username claim", undefined, { pk: "USERNAME#haoran", sk: "USERNAME", userId: "u-1" }],
    ])("sends nothing for %s", (_, before, after) => {
      expect(emailFor(before, after)).toBeUndefined();
    });
  });
});

let sequence = 0;
/** A stream record carrying the item's images, as DynamoDB Streams delivers them. */
const record = (before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): DynamoDBRecord => ({
  eventName: before && after ? "MODIFY" : after ? "INSERT" : "REMOVE",
  dynamodb: {
    SequenceNumber: String(++sequence),
    ...(before ? { OldImage: marshall(before, { removeUndefinedValues: true }) as never } : {}),
    ...(after ? { NewImage: marshall(after, { removeUndefinedValues: true }) as never } : {}),
  },
});
const streamEvent = (...Records: DynamoDBRecord[]): DynamoDBStreamEvent => ({ Records });

/** A notifier whose sender records what it was asked to send, failing for the given addresses. */
function setup(failFor: string[] = []) {
  const sent: OutgoingEmail[] = [];
  const logs: LogEntry[] = [];
  const handler = createNotifyHandler({
    from: FROM,
    sendEmail: async (email) => {
      if (failFor.includes(email.to)) throw new Error("SES is unavailable");
      sent.push(email);
    },
    log: (entry) => logs.push(entry),
  });
  return { handler, sent, logs };
}

describe("the notify Lambda", () => {
  describe("given stream records for a sign-up, an approval and a failed login", () => {
    it("sends the two emails from the configured address and reports no failures", async () => {
      const { handler, sent } = setup();

      const res = await handler(
        streamEvent(
          record(undefined, profile()),
          record(profile(), profile({ failedLogins: 1 })),
          record(profile(), profile({ status: "active" })),
        ),
      );

      expect(res).toEqual({ batchItemFailures: [] });
      expect(sent.map((e) => [e.from, e.to, e.subject])).toEqual([
        [FROM, "haoran@example.com", expect.stringMatching(/waiting for approval/i)],
        [FROM, "haoran@example.com", expect.stringMatching(/approved/i)],
      ]);
    });
  });

  describe("given a send that fails", () => {
    it("reports that record, so the stream retries from it, and sends nothing after it", async () => {
      const { handler, sent } = setup(["bad@example.com"]);
      const ok = record(undefined, profile({ id: "u-1", email: "ok@example.com" }));
      const failing = record(undefined, profile({ id: "u-2", email: "bad@example.com" }));
      const later = record(undefined, profile({ id: "u-3", email: "later@example.com" }));

      const res = await handler(streamEvent(ok, failing, later));

      expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: failing.dynamodb!.SequenceNumber }] });
      expect(sent.map((e) => e.to)).toEqual(["ok@example.com"]);
    });

    it("logs the failure with the user's id but not their address", async () => {
      const { handler, logs } = setup(["bad@example.com"]);

      await handler(streamEvent(record(undefined, profile({ id: "u-9", email: "bad@example.com" }))));

      const failure = logs.find((l) => l.event === "notify_failed");
      expect(failure).toMatchObject({ kind: "pending", userId: "u-9" });
      expect(JSON.stringify(logs)).not.toContain("bad@example.com");
    });
  });
});
