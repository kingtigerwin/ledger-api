/**
 * What the Home page asks a customer to look at, found by plain rules over their transactions. Pure logic:
 * `ledger.insights` reads the transactions, and the UI writes the wording, so stored text is the only
 * language that comes back from here.
 */
import { createHash } from "node:crypto";
import { addDays, daysBetween, formatDate, LOOKBACK_DAYS, parseDate } from "./dates";
import type { Transaction } from "./transaction-schema";

export const INSIGHT_ID_PATTERN = /^[0-9a-f]{16}$/;

const DUPLICATE_WINDOW_DAYS = 30;
// "Yesterday" is easily recorded a day out, so the same expense on the next day still counts.
const DUPLICATE_MAX_GAP_DAYS = 1;

// A regular bill at a supermarket or restaurant is a coincidence, not a subscription.
const NOT_SUBSCRIPTIONS = new Set(["groceries", "dining"]);

const REGO_WINDOW_DAYS = 30;
// Gaps in days, inclusive, between the last two payments, and the term they show.
const REGO_TERMS_MONTHS: [number, number, number][] = [
  [80, 100, 3],
  [170, 195, 6],
];
const REGO_DEFAULT_TERM_MONTHS = 12;
// Letters are checked by hand rather than with \b, so a term beside Chinese characters still counts.
const REGO = /(?<![a-z])(rego|car registration|vehicle registration|ctp|green slip)(?![a-z])|车辆注册/;

const COMPANY_SUFFIX = /(\s+pty\.?\s+ltd\.?|\s+ltd\.?|\s+inc\.?|\.com(\.au)?)$/;

interface Cadence {
  name: "monthly" | "yearly";
  /** Days between charges, inclusive. */
  minGapDays: number;
  maxGapDays: number;
  minimumCharges: number;
  chargesPerYear: number;
  /** After this long with no charge, the subscription has stopped. */
  currentForDays: number;
}

const CADENCES: Cadence[] = [
  { name: "monthly", minGapDays: 26, maxGapDays: 35, minimumCharges: 3, chargesPerYear: 12, currentForDays: 45 },
  { name: "yearly", minGapDays: 350, maxGapDays: 380, minimumCharges: 2, chargesPerYear: 1, currentForDays: LOOKBACK_DAYS },
];

export interface PossibleDuplicate {
  id: string;
  type: "possible_duplicate";
  merchant: string;
  amountCents: number;
  currency: string;
  transactions: Transaction[];
}

export interface PriceRise {
  id: string;
  type: "price_rise";
  merchant: string;
  previousCents: number;
  currentCents: number;
  since: string;
  cadence: Cadence["name"];
  extraPerYearCents: number;
  currency: string;
  transactions: Transaction[];
}

export interface RegoDue {
  id: string;
  type: "rego_due";
  estimatedDueDate: string;
  lastPaidCents: number;
  currency: string;
  transactions: Transaction[];
}

export type Insight = PossibleDuplicate | PriceRise | RegoDue;

/** A fixed-length hash, so a merchant's name in the key never has to travel in a URL. */
export const insightId = (naturalKey: string) => createHash("sha256").update(naturalKey).digest("hex").slice(0, 16);

/** One form for the ways a free-text name gets typed: `NET-FLIX`, `Netflix Pty Ltd`, `netflix.com`. */
export function merchantKey(name: string): string {
  const text = name.normalize("NFKC").toLowerCase().trim().replace(COMPANY_SUFFIX, "");
  return text.replace(/[^\p{L}\p{N}]/gu, "") || text;
}

const displayName = (t: Transaction) => t.merchant || t.item;
const seriesKey = (t: Transaction) => merchantKey(displayName(t));
// By code point, as the table sorts keys, not by locale.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const oldestFirst = (transactions: Iterable<Transaction>) =>
  [...transactions].sort((a, b) => compare(a.date, b.date) || compare(a.id, b.id));

/** Appends `t` to its group's list, keeping the groups in the order they were first seen. */
function group<K>(groups: Map<K, Transaction[]>, key: K, t: Transaction) {
  const list = groups.get(key);
  if (list) list.push(t);
  else groups.set(key, [t]);
}

/** Splits date-sorted transactions wherever the gap is too wide for them to be copies. */
function* adjacentRuns(transactions: Transaction[]): Generator<Transaction[]> {
  let run: Transaction[] = [];
  for (const t of transactions) {
    const last = run.at(-1);
    if (last && daysBetween(last.date, t.date) > DUPLICATE_MAX_GAP_DAYS) {
      yield run;
      run = [];
    }
    run.push(t);
  }
  if (run.length) yield run;
}

/**
 * A run over three or more dates is a habit, like the same coffee every morning, so only repeats on
 * one date in it count. Over one or two dates, the whole run does.
 */
function* copiesIn(run: Transaction[]): Generator<Transaction[]> {
  const byDate = new Map<string, Transaction[]>();
  for (const t of run) group(byDate, t.date, t);
  if (byDate.size > DUPLICATE_MAX_GAP_DAYS + 1) yield* byDate.values();
  else yield run;
}

function* possibleDuplicates(transactions: Iterable<Transaction>, today: string): Generator<PossibleDuplicate> {
  const earliest = addDays(today, -DUPLICATE_WINDOW_DAYS);
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.date >= earliest) group(groups, JSON.stringify([seriesKey(t), merchantKey(t.item), t.amountCents]), t);
  }
  for (const list of groups.values()) {
    for (const run of adjacentRuns(oldestFirst(list))) {
      for (const copies of copiesIn(run)) {
        if (copies.length < 2) continue;
        const first = copies[0]!;
        yield {
          id: insightId(`possible_duplicate|${copies.map((t) => t.id).join("|")}`),
          type: "possible_duplicate",
          merchant: displayName(first),
          amountCents: first.amountCents,
          currency: first.currency,
          transactions: copies,
        };
      }
    }
  }
}

/** The newest charges, oldest first, each the cadence's gap after the one before. */
function latestRun(charges: Transaction[], cadence: Cadence): Transaction[] {
  const run = charges.slice(-1);
  for (const t of charges.slice(0, -1).reverse()) {
    const gap = daysBetween(t.date, run[0]!.date);
    if (gap < cadence.minGapDays || gap > cadence.maxGapDays) break;
    run.unshift(t);
  }
  return run;
}

/** A bill that varies has no repeated amount, or falls as often as it rises; a yearly one has too few to tell. */
function isPriceRise(amounts: number[], cadence: Cadence): boolean {
  const rising = amounts.every((amount, i) => i === 0 || amount >= amounts[i - 1]!) && amounts.at(-1)! > amounts[0]!;
  return rising && (cadence.name === "yearly" || new Set(amounts).size < amounts.length);
}

function priceRise(key: string, charges: Transaction[], today: string): PriceRise | undefined {
  const latest = charges.at(-1)!;
  if (NOT_SUBSCRIPTIONS.has(latest.category)) return undefined;
  for (const cadence of CADENCES) {
    const run = latestRun(charges, cadence);
    const amounts = run.map((t) => t.amountCents);
    const current = daysBetween(latest.date, today) <= cadence.currentForDays;
    if (run.length >= cadence.minimumCharges && current && isPriceRise(amounts, cadence)) {
      const [previousCents, currentCents] = [amounts[0]!, amounts.at(-1)!];
      return {
        id: insightId(`price_rise|${key}|${currentCents}`),
        type: "price_rise",
        merchant: displayName(latest),
        previousCents,
        currentCents,
        since: run.find((t) => t.amountCents === currentCents)!.date,
        cadence: cadence.name,
        extraPerYearCents: (currentCents - previousCents) * cadence.chargesPerYear,
        currency: latest.currency,
        transactions: [...run].reverse(),
      };
    }
  }
  return undefined;
}

function* priceRises(transactions: Iterable<Transaction>, today: string): Generator<PriceRise> {
  const series = new Map<string, Transaction[]>();
  for (const t of oldestFirst(transactions)) group(series, seriesKey(t), t);
  for (const [key, charges] of series) {
    const rise = priceRise(key, charges, today);
    if (rise) yield rise;
  }
}

const isRego = (t: Transaction) => REGO.test([t.item, t.merchant ?? "", t.note ?? ""].join(" ").toLowerCase());

/** The same day of the month, or the month's last day if it has no such day. */
function plusMonths(date: string, months: number): string {
  const day = parseDate(date);
  const firstOfMonth = Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + months, 1);
  const target = new Date(firstOfMonth);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day.getUTCDate(), lastDay));
  return formatDate(target);
}

/** Rego can be paid for 3 or 6 months; the last two payments show which, and otherwise it's a year. */
function regoTermMonths(payments: Transaction[]): number {
  if (payments.length > 1) {
    const gap = daysBetween(payments.at(-2)!.date, payments.at(-1)!.date);
    const term = REGO_TERMS_MONTHS.find(([min, max]) => gap >= min && gap <= max);
    if (term) return term[2];
  }
  return REGO_DEFAULT_TERM_MONTHS;
}

function* regoDue(transactions: Iterable<Transaction>, today: string): Generator<RegoDue> {
  const payments = oldestFirst([...transactions].filter(isRego));
  const latest = payments.at(-1);
  if (!latest) return;
  const due = plusMonths(latest.date, regoTermMonths(payments));
  if (Math.abs(daysBetween(today, due)) <= REGO_WINDOW_DAYS) {
    yield {
      id: insightId(`rego_due|${latest.id}`),
      type: "rego_due",
      estimatedDueDate: due,
      lastPaidCents: latest.amountCents,
      currency: latest.currency,
      transactions: [latest],
    };
  }
}

/**
 * Everything needing attention, the most pressing kind first, less what the customer has dismissed.
 * An insight's ID changes when its facts do, so a dismissed one returns only if there's something new.
 */
export function findInsights(transactions: Transaction[], today: string, dismissed: ReadonlySet<string>): Insight[] {
  const found: Insight[] = [
    ...regoDue(transactions, today),
    ...possibleDuplicates(transactions, today),
    ...priceRises(transactions, today),
  ];
  return found.filter((insight) => !dismissed.has(insight.id));
}
