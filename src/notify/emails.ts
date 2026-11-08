export type EmailKind = "pending" | "approved" | "new_signup" | "welcome";

export interface Email {
  kind: EmailKind;
  /** The customer the email is about, whoever it goes to. */
  userId: string;
  to: string;
  subject: string;
  text: string;
}

export interface EmailSettings {
  /** Where sign-ups are sent; without it only customers are emailed. */
  adminEmail?: string;
  /** The API's public URL, for the admin's approve and reject calls when there's no admin page. */
  apiUrl: string;
  /** ledger-ui's admin page, where the admin approves or rejects sign-ups from a browser. */
  adminPageUrl?: string;
}

type Item = Record<string, unknown> | undefined;

/** What a customer is told, in each language Ledger has. The admin's emails stay in English. */
const CUSTOMER_EMAILS = {
  en: {
    signInAsGoogle: "sign in with Google",
    signInAs: (username: string) => `sign in as ${username}`,
    pending: (username: string) => ({
      subject: "Your Ledger account is waiting for approval",
      text:
        `Hi ${username},\n\n` +
        "Thanks for signing up to Ledger. Your account has been created and is waiting for an admin to approve it.\n\n" +
        "We'll email you again as soon as you can sign in.\n",
    }),
    welcome: (username: string, signIn: string) => ({
      subject: "Welcome to Ledger",
      text: `Hi ${username},\n\nYour Ledger account is ready. Next time, just ${signIn}.\n`,
    }),
    approved: (username: string, signIn: string) => ({
      subject: "Your Ledger account is approved",
      text: `Hi ${username},\n\nYour Ledger account has been approved. You can now ${signIn}.\n`,
    }),
  },
  "zh-CN": {
    signInAsGoogle: "使用 Google 登录",
    signInAs: (username: string) => `以 ${username} 登录`,
    pending: (username: string) => ({
      subject: "您的 Ledger 账户正在等待审核",
      text:
        `${username}，您好：\n\n` +
        "感谢您注册 Ledger。您的账户已创建，正在等待管理员审核。\n\n" +
        "审核通过后，我们会再发邮件通知您登录。\n",
    }),
    welcome: (username: string, signIn: string) => ({
      subject: "欢迎使用 Ledger",
      text: `${username}，您好：\n\n您的 Ledger 账户已准备就绪。下次只需${signIn}即可。\n`,
    }),
    approved: (username: string, signIn: string) => ({
      subject: "您的 Ledger 账户已通过审核",
      text: `${username}，您好：\n\n您的 Ledger 账户已通过审核，现在可以${signIn}了。\n`,
    }),
  },
};

const customerEmailsFor = (locale: unknown) => (locale === "zh-CN" ? CUSTOMER_EMAILS["zh-CN"] : CUSTOMER_EMAILS.en);

/**
 * The emails a change to a Users-table item calls for. A customer who has just registered hears
 * they're waiting for approval, and the admin is asked to approve or reject them; the customer
 * hears again when first enabled. Someone new through Google starts active, so they're welcomed,
 * and the admin only hears they've joined, in case they need disabling. Re-enabling a disabled
 * customer sends nothing, and customers without an email are never written to. Customers are written
 * to in their `locale`, English when they have none.
 */
export function emailsFor(
  before: Item,
  after: Item,
  settings: EmailSettings,
): Email[] {
  if (after?.sk !== "PROFILE" || after.role !== "customer") return [];
  const userId = String(after.id);
  const username = String(after.username);
  const customerEmail =
    typeof after.email === "string" ? after.email : undefined;
  const words = customerEmailsFor(after.locale);
  // Someone who came through Google has no password to go with their username.
  const signIn = after.authProvider === "google" ? words.signInAsGoogle : words.signInAs(username);
  const emails: Email[] = [];

  if (!before && after.status === "pending") {
    // The admin's first, so a customer's address SES won't take can't hold it up.
    if (settings.adminEmail) {
      const user = `${settings.apiUrl}/api/v1/admin/users/${userId}`;
      const review = settings.adminPageUrl
        ? `Approve or reject them on the admin page, under Pending:\n\n  ${settings.adminPageUrl}\n\n`
        : "Signed in as an admin, either:\n\n" +
          `  Approve:  POST ${user}/enable\n` +
          `  Reject:   POST ${user}/disable\n\n`;
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
          review +
          "Approving emails them that they can sign in. Rejecting sends them nothing.\n",
      });
    }
    if (customerEmail) {
      emails.push({
        kind: "pending",
        userId,
        to: customerEmail,
        ...words.pending(username),
      });
    }
  }
  if (!before && after.status === "active" && after.authProvider === "google") {
    if (settings.adminEmail) {
      const user = `${settings.apiUrl}/api/v1/admin/users/${userId}`;
      const disable = settings.adminPageUrl
        ? `To stop them, disable them on the admin page, under Active:\n\n  ${settings.adminPageUrl}\n`
        : `To stop them, as an admin:\n\n  Disable:  POST ${user}/disable\n`;
      emails.push({
        kind: "new_signup",
        userId,
        to: settings.adminEmail,
        subject: `New Ledger user: ${username} joined with Google`,
        text:
          `${username} has joined Ledger with Google. They don't need approval.\n\n` +
          `  Username: ${username}\n` +
          `  Email:    ${customerEmail ?? "(none)"}\n` +
          `  User ID:  ${userId}\n\n` +
          disable,
      });
    }
    if (customerEmail) {
      emails.push({
        kind: "welcome",
        userId,
        to: customerEmail,
        ...words.welcome(username, signIn),
      });
    }
  }
  if (
    before?.status === "pending" &&
    after.status === "active" &&
    customerEmail
  ) {
    emails.push({
      kind: "approved",
      userId,
      to: customerEmail,
      ...words.approved(username, signIn),
    });
  }
  return emails;
}
