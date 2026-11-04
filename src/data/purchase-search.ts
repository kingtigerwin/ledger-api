/**
 * Finds what a customer bought, for "how much did I spend on bananas?". Pure logic, like `insights`: DynamoDB can't
 * search inside a list of lines, and one customer's transactions for a date range are few enough to filter here.
 */
import type { Transaction } from "./transaction-schema";

/** What a client gets back; `count` and `totalCents` still cover everything found. */
export const MAX_MATCHES = 100;

export interface PurchaseMatch {
  transactionId: string;
  date: string;
  merchant: string | null;
  /** As printed on a receipt, or the item of an expense typed into the chat. */
  name: string;
  /** In plain words, when a receipt line has it: `name` can be `CLS CHKN DRUMSTICKS`. */
  product: string | null;
  amountCents: number;
}

export interface PurchaseResults {
  matches: PurchaseMatch[];
  count: number;
  totalCents: number;
  currency: "AUD";
  /** A receipt's lines are shelf prices, so some of this total may have been paid with points rather than money. */
  includesPoints: boolean;
}

const normal = (text: string) => text.normalize("NFKC").toLowerCase();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A term matches at the start of a word, so `banana` finds `BANANAS` but not `BANDANA`, and only the singular is
 * needed. Chinese has no spaces between words, so a term in it matches anywhere.
 */
function patternFor(terms: Iterable<string>): RegExp {
  const alternatives = [...terms].map((term) => {
    const text = normal(term);
    return text.charCodeAt(0) < 128 ? `(?<![a-z0-9])${escape(text)}` : escape(text);
  });
  return new RegExp(alternatives.join("|"), "u");
}

/** A receipt's lines say what was bought; its `item` only repeats them, or says "18 items". */
function* matchesIn(t: Transaction, pattern: RegExp): Generator<PurchaseMatch> {
  const lines = t.receipt?.lines;
  const found: [string, string | null, number][] = lines?.length
    ? lines
        .filter((line) => pattern.test(normal(`${line.name} ${line.product ?? ""}`)))
        .map((line) => [line.name, line.product ?? null, line.amountCents])
    : pattern.test(normal(t.item))
      ? [[t.item, null, t.amountCents]]
      : [];
  for (const [name, product, amountCents] of found) {
    yield { transactionId: t.id, date: t.date, merchant: t.merchant ?? null, name, product, amountCents };
  }
}

const paidWithPoints = (t: Transaction) => (t.receipt?.payments ?? []).some((payment) => payment.kind === "points");

/** Every line or typed expense matching any term, in the order given; a line matching two terms counts once. */
export async function findPurchases(
  transactions: AsyncIterable<Transaction> | Iterable<Transaction>,
  terms: Iterable<string>,
): Promise<PurchaseResults> {
  const pattern = patternFor(terms);
  const matches: PurchaseMatch[] = [];
  let includesPoints = false;
  for await (const t of transactions) {
    const found = [...matchesIn(t, pattern)];
    matches.push(...found);
    includesPoints ||= found.length > 0 && paidWithPoints(t);
  }
  return {
    matches: matches.slice(0, MAX_MATCHES),
    count: matches.length,
    totalCents: matches.reduce((total, match) => total + match.amountCents, 0),
    currency: "AUD",
    includesPoints,
  };
}
