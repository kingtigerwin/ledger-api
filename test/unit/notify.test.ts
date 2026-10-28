import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../src/log";
import { emailsFor } from "../../src/notify/emails";
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

const SETTINGS = { adminEmail: "sisi@example.com", apiUrl: "https://api.haoran.cloud" };

describe("emailsFor", () => {
  describe("given a customer who has just registered", () => {
    it("tells them the account is waiting for approval, then asks the admin to approve or reject it", () => {
      const [customer, admin, ...rest] = emailsFor(undefined, profile(), SETTINGS);

      expect(customer).toMatchObject({ kind: "pending", to: "haoran@example.com" });
      expect(customer?.subject).toMatch(/waiting for approval/i);
      expect(customer?.text).toContain("haoran");
      expect(admin).toMatchObject({ kind: "new_signup", to: "sisi@example.com", userId: "u-1" });
      expect(admin?.subject).toMatch(/haoran/);
      expect(admin?.text).toContain("haoran@example.com");
      expect(admin?.text).toContain("POST https://api.haoran.cloud/api/v1/admin/users/u-1/enable");
      expect(admin?.text).toContain("POST https://api.haoran.cloud/api/v1/admin/users/u-1/disable");
      expect(admin?.text).toMatch(/approve/i);
      expect(admin?.text).toMatch(/reject/i);
      expect(rest).toEqual([]);
    });

    it("emails only the customer when no admin address is set", () => {
      const emails = emailsFor(undefined, profile(), { apiUrl: SETTINGS.apiUrl });

      expect(emails.map((e) => e.kind)).toEqual(["pending"]);
    });
  });

  describe("given a pending customer the admin has just enabled", () => {
    it("tells them, and only them, that they can sign in", () => {
      const emails = emailsFor(profile(), profile({ status: "active" }), SETTINGS);

      expect(emails).toHaveLength(1);
      expect(emails[0]).toMatchObject({ kind: "approved", to: "haoran@example.com" });
      expect(emails[0]?.subject).toMatch(/approved/i);
      expect(emails[0]?.text).toMatch(/sign in/i);
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
      expect(emailsFor(before, after, SETTINGS)).toEqual([]);
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
    ...SETTINGS,
    sendEmail: async (email) => {
      // As SES words it in the sandbox: the error names the address.
      if (failFor.includes(email.to)) throw new Error(`Email address is not verified: ${email.to}`);
      sent.push(email);
    },
    log: (entry) => logs.push(entry),
  });
  return { handler, sent, logs };
}

describe("the notify Lambda", () => {
  describe("given stream records for a sign-up, an approval and a failed login", () => {
    it("sends the three emails from the configured address and reports no failures", async () => {
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
        [FROM, "sisi@example.com", expect.stringMatching(/haoran/)],
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
      expect(sent.map((e) => e.to)).toEqual(["ok@example.com", "sisi@example.com"]);
    });

    it("logs the failure with the user's id but no one's address", async () => {
      const { handler, logs } = setup(["bad@example.com"]);

      await handler(streamEvent(record(undefined, profile({ id: "u-9", email: "bad@example.com" }))));

      const failure = logs.find((l) => l.event === "notify_failed");
      expect(failure).toMatchObject({ kind: "pending", userId: "u-9" });
      expect(JSON.stringify(logs)).not.toContain("bad@example.com");
      expect(JSON.stringify(logs)).not.toContain("sisi@example.com");
    });
  });
});
