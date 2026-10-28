export type EmailKind = "pending" | "approved";

export interface Email {
  kind: EmailKind;
  userId: string;
  to: string;
  subject: string;
  text: string;
}

type Item = Record<string, unknown> | undefined;

/**
 * The email, if any, that a change to a Users-table item calls for: a customer who has just
 * registered hears they're waiting for approval, and hears again when first enabled. Re-enabling
 * a disabled customer sends nothing, and nor does any change for a user without an email.
 */
export function emailFor(before: Item, after: Item): Email | undefined {
  if (after?.sk !== "PROFILE" || after.role !== "customer" || typeof after.email !== "string") return undefined;
  const userId = String(after.id);
  const username = String(after.username);

  if (!before && after.status === "pending") {
    return {
      kind: "pending",
      userId,
      to: after.email,
      subject: "Your Ledger account is waiting for approval",
      text:
        `Hi ${username},\n\n` +
        "Thanks for signing up to Ledger. Your account has been created and is waiting for an admin to approve it.\n\n" +
        "We'll email you again as soon as you can sign in.\n",
    };
  }
  if (before?.status === "pending" && after.status === "active") {
    return {
      kind: "approved",
      userId,
      to: after.email,
      subject: "Your Ledger account is approved",
      text: `Hi ${username},\n\nYour Ledger account has been approved. You can now sign in as ${username}.\n`,
    };
  }
  return undefined;
}
