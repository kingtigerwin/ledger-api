import { z } from "zod";
import { isUlid } from "./ulid";

export const CATEGORIES = [
  "groceries",
  "dining",
  "transport",
  "utilities",
  "rent",
  "health",
  "education",
  "shopping",
  "entertainment",
  "other",
] as const;

const isoDate = z.iso.date();

// The fields a customer edits; `id` and `currency` are fixed once created.
export const transactionFieldsSchema = z.object({
  date: isoDate,
  merchant: z.string().trim().max(100).optional(),
  category: z.enum(CATEGORIES),
  item: z.string().trim().min(1).max(200),
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  note: z.string().trim().max(1000).optional(),
});

const amountCents = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const taxCents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().trim().min(1).max(100);

/**
 * What a scanned receipt says beyond the transaction's own fields. Only what was printed is sent. There's
 * no photo, card number, loyalty number or staff name here, on purpose.
 */
export const receiptSchema = z.object({
  totalCents: amountCents.optional(),
  gstCents: taxCents.optional(),
  savingsCents: taxCents.optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:MM").optional(),
  location: shortText.optional(),
  receiptNumber: shortText.optional(),
  abn: z.string().regex(/^\d{11}$/, "Must be 11 digits").optional(),
  lines: z
    .array(
      z.object({
        // As printed, and `product` in plain words: a search for "chicken" can't find `CLS CHKN DRUMSTICKS` otherwise.
        name: z.string().trim().min(1).max(200),
        product: shortText.optional(),
        // A discount line is negative.
        amountCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(200)
    .optional(),
  payments: z
    .array(
      z.object({
        label: shortText,
        // `amountCents` on the transaction is what was paid in money, so points are told apart here.
        kind: z.enum(["money", "points"]),
        amountCents,
      }),
    )
    .max(10)
    .optional(),
});

/** What a client sends to record one; `id`, `currency` and `receipt` are fixed once created. */
export const createTransactionSchema = transactionFieldsSchema.extend({
  id: z.string().refine(isUlid, "Must be a ULID"),
  currency: z.literal("AUD"),
  receipt: receiptSchema.optional(),
});

/** A partial edit, plus the version the client last read. */
export const updateTransactionSchema = transactionFieldsSchema.partial().extend({
  version: z.number().int().positive(),
});

export const listQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.enum(CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const summaryQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Must be YYYY-MM"),
});

export const MAX_SEARCH_TERMS = 10;

/** The terms in `q`. HTTP API joins repeated query parameters with commas, so commas separate them either way. */
export const searchTerms = (q: string) =>
  q
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);

const searchTermsMessage = `Must be 1 to ${MAX_SEARCH_TERMS} comma-separated terms of at most 50 characters`;

export const purchaseQuerySchema = z.object({
  q: z
    .string()
    .refine((q) => {
      const terms = searchTerms(q);
      return terms.length >= 1 && terms.length <= MAX_SEARCH_TERMS && terms.every((term) => term.length <= 50);
    }, searchTermsMessage)
    .describe(searchTermsMessage),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** The same search as a tool takes it: a list of terms rather than a comma-separated string. */
export const purchaseSearchSchema = z.object({
  terms: z
    .array(z.string().trim().min(1).max(50))
    .min(1)
    .max(MAX_SEARCH_TERMS)
    .describe("What to look for. A line matches any term. Each matches the start of a word."),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const insightsQuerySchema = z.object({
  // The customer's own date: "due in 14 days" depends on the day it is where they are.
  today: isoDate,
});

export type ListQuery = z.infer<typeof listQuerySchema>;
export type TransactionFields = z.infer<typeof transactionFieldsSchema>;
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type Receipt = z.infer<typeof receiptSchema>;

export interface Transaction extends CreateTransactionInput {
  version: number;
  createdAt: string;
  updatedAt: string;
}
