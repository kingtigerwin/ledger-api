import { z } from "zod";

export const credentialsSchema = z.object({
  username: z.string().min(1).max(64).toLowerCase(),
  password: z.string().min(1).max(1024),
});

/** The languages Ledger is written in; a customer with none gets English. */
export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

export const registerSchema = credentialsSchema.extend({
  // For the account emails; not unique, and not used to sign in. 254 is the longest an address can be.
  email: z.email().max(254),
  // The language the UI is showing, so the "waiting for approval" email is in it too.
  locale: localeSchema.optional(),
});

/** `null` forgets the customer's choice, so the UI follows their device's language again. */
export const updateMeSchema = z.object({ locale: localeSchema.nullable() });

/** What Google sends back; the handler checks it against the sign-in attempt rather than validating it here. */
export const googleCallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  // Instead of a code, when the sign-in didn't complete (such as `access_denied`).
  error: z.string().optional(),
});

export const loginSchema = credentialsSchema.extend({
  // Browsers get the refresh token only as an HttpOnly cookie; non-browser clients (an agent) ask for it in the body.
  refreshTokenIn: z.enum(["cookie", "body"]).default("cookie"),
});
