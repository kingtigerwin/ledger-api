export type EmailKind = "pending" | "approved" | "new_signup";

export interface Email {
  kind: EmailKind;
  /** The customer the email is about, whoever it goes to. */
  userId: string;
  to: string;
  subject: string;
  text: string;
}

export interface EmailSettings {
  /** Where sign-ups are sent for approval; without it only customers are emailed. */
  adminEmail?: string;
  /** The API's public URL, for the admin's approve and reject links. */
  apiUrl: string;
}

type Item = Record<string, unknown> | undefined;

/**
 * The emails a change to a Users-table item calls for. A customer who has just registered hears
 * they're waiting for approval, and the admin is asked to approve or reject them; the customer
 * hears again when first enabled. Re-enabling a disabled customer sends nothing, and customers
 * without an email are never written to.
 */
export function emailsFor(before: Item, after: Item, settings: EmailSettings): Email[] {
  if (after?.sk !== "PROFILE" || after.role !== "customer") return [];
  const userId = String(after.id);
  const username = String(after.username);
  const customerEmail = typeof after.email === "string" ? after.email : undefined;
  const emails: Email[] = [];

  if (!before && after.status === "pending") {
    if (customerEmail) {
      emails.push({
        kind: "pending",
        userId,
        to: customerEmail,
        subject: "Your Ledger account is waiting for approval",
        text:
          `Hi ${username},\n\n` +
          "Thanks for signing up to Ledger. Your account has been created and is waiting for an admin to approve it.\n\n" +
          "We'll email you again as soon as you can sign in.\n",
      });
    }
    if (settings.adminEmail) {
      const user = `${settings.apiUrl}/api/v1/admin/users/${userId}`;
      emails.push({
        kind: "new_signup",
        userId,
        to: settings.adminEmail,
        subject: `New Ledger sign-up: ${username} is waiting for approval`,
        text:
          `${username} has signed up to Ledger and is waiting for approval.\n\n` +
          `  Username: ${username}\n` +
          `  Email:    ${customerEmail ?? "(none)"}\n` +
          `  User ID:  ${userId}\n\n` +
          "Signed in as an admin, either:\n\n" +
          `  Approve:  POST ${user}/enable\n` +
          `  Reject:   POST ${user}/disable\n\n` +
          "Approving emails them that they can sign in. Rejecting sends them nothing.\n",
      });
    }
  }
  if (before?.status === "pending" && after.status === "active" && customerEmail) {
    emails.push({
      kind: "approved",
      userId,
      to: customerEmail,
      subject: "Your Ledger account is approved",
      text: `Hi ${username},\n\nYour Ledger account has been approved. You can now sign in as ${username}.\n`,
    });
  }
  return emails;
}
