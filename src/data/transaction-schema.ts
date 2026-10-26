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
  memberId: z.string().min(1),
  date: isoDate,
  merchant: z.string().trim().max(100).optional(),
  category: z.enum(CATEGORIES),
  item: z.string().trim().min(1).max(200),
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  note: z.string().trim().max(1000).optional(),
});

export const createTransactionSchema = transactionFieldsSchema.extend({
  id: z.string().refine(isUlid, "Must be a ULID"),
  currency: z.literal("AUD"),
});

/** A partial edit, plus the version the client last read. */
export const updateTransactionSchema = transactionFieldsSchema.partial().extend({
  version: z.number().int().positive(),
});

export const listQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  memberId: z.string().min(1).optional(),
  category: z.enum(CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;
export type TransactionFields = z.infer<typeof transactionFieldsSchema>;
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export interface Transaction extends CreateTransactionInput {
  version: number;
  createdAt: string;
  updatedAt: string;
}
