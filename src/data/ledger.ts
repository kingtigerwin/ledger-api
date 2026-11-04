import { ApiError } from "../http";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor";
import { addDays, daysBetween, formatDate, LOOKBACK_DAYS } from "./dates";
import { findInsights, INSIGHT_ID_PATTERN } from "./insights";
import { findPurchases } from "./purchase-search";
import type { CreateTransactionInput, ListQuery, Transaction, TransactionFields } from "./transaction-schema";
import {
  createTransactionsStore,
  TransactionNotFoundError,
  VersionConflictError,
} from "./transactions-store";
import { ulidTime } from "./ulid";

// Client clocks drift a little; an ID from further ahead than this would distort the sort order.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface LedgerDeps {
  tableName: string;
  /** Signs list cursors so clients can't tamper with them. */
  cursorSecret: string;
  now: () => Date;
}

/**
 * What a customer (or the admin) can do with transactions, whichever way they came in: the REST
 * handler and the MCP tools both call this, so the rules and error messages are the same.
 * Failures are `ApiError`s.
 */
export function createLedger(deps: LedgerDeps) {
  const transactions = createTransactionsStore(deps.tableName);

  type Lister<T> = (
    query: Omit<ListQuery, "cursor">,
    startKey?: Record<string, unknown>,
  ) => Promise<{ items: T[]; lastKey?: Record<string, unknown> }>;

  const invalidCursor = () => new ApiError(400, "invalid_cursor", "The cursor is invalid; start from the first page");
  const notFound = () => new ApiError(404, "transaction_not_found", "No such transaction");

  /** One page from `lister` (one customer's transactions, or everyone's), with a signed cursor for the next page. */
  const listPage = async <T>(lister: Lister<T>, { cursor, ...query }: ListQuery) => {
    let startKey: Record<string, unknown> | undefined;
    try {
      startKey = cursor ? decodeCursor(cursor, deps.cursorSecret) : undefined;
    } catch (err) {
      if (err instanceof InvalidCursorError) throw invalidCursor();
      throw err;
    }
    let page;
    try {
      page = await lister(query, startKey);
    } catch (err) {
      // A genuine cursor from a different filter has keys this query can't start from.
      if (startKey && err instanceof Error && err.name === "ValidationException") throw invalidCursor();
      throw err;
    }
    return {
      items: page.items,
      nextCursor: page.lastKey ? encodeCursor(page.lastKey, deps.cursorSecret) : null,
    };
  };

  /** Every page of a date range, for the totals and rules that need the whole of it. */
  async function* allBetween(userId: string, from: string, to: string): AsyncGenerator<Transaction> {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await transactions.list(userId, { from, to, limit: 100 }, startKey);
      yield* page.items;
      startKey = page.lastKey;
    } while (startKey);
  }

  return {
    /** Records the transaction; a retry with the same id returns what was stored, with `created` false. */
    async record(userId: string, input: CreateTransactionInput) {
      const now = deps.now();
      if (ulidTime(input.id).getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
        throw new ApiError(400, "invalid_id", "The id's timestamp is in the future");
      }
      return transactions.createOnce(userId, input, now);
    },

    async get(userId: string, id: string) {
      const transaction = await transactions.get(userId, id);
      if (!transaction) throw notFound();
      return transaction;
    },

    list: (userId: string, query: ListQuery) =>
      listPage((q, startKey) => transactions.list(userId, q, startKey), query),

    /** Every customer's transactions, for the admin. */
    listAll: (query: ListQuery) => listPage(transactions.listAll, query),

    /**
     * Totals for one month, computed on request. A customer records a few hundred transactions a month,
     * so reading them all is cheap; precomputed totals would be the upgrade if that changes.
     */
    async summary(userId: string, month: string) {
      const byCategory = new Map<string, number>();
      let totalCents = 0;
      // Day 31 is a safe upper bound for every month: sort keys compare as strings.
      for await (const t of allBetween(userId, `${month}-01`, `${month}-31`)) {
        totalCents += t.amountCents;
        byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amountCents);
      }

      return {
        month,
        currency: "AUD",
        totalCents,
        byCategory: [...byCategory]
          .map(([category, total]) => ({ category, totalCents: total }))
          .sort((a, b) => b.totalCents - a.totalCents || a.category.localeCompare(b.category)),
      };
    },

    /**
     * What the customer bought matching any term, over at most LOOKBACK_DAYS, which bounds what one search reads.
     * With no dates, it's that long up to today. Unlike the summary, this reads receipt lines, whose prices are
     * shelf prices, so a total here can differ from the money paid (`includesPoints` says when).
     */
    async searchPurchases(userId: string, terms: string[], from?: string, to?: string) {
      const last = to ?? formatDate(deps.now());
      const first = from ?? addDays(last, -LOOKBACK_DAYS);
      const span = daysBetween(first, last);
      if (span < 0 || span > LOOKBACK_DAYS) {
        throw new ApiError(400, "invalid_date_range", `Search at most ${LOOKBACK_DAYS} days at a time`);
      }
      return { ...(await findPurchases(allBetween(userId, first, last), terms)), from: first, to: last };
    },

    /**
     * What needs the customer's attention, computed on request as `summary` is: over a year or so of
     * one customer's transactions, the read costs almost nothing.
     */
    async insights(userId: string, today: string) {
      const recent: Transaction[] = [];
      for await (const t of allBetween(userId, addDays(today, -LOOKBACK_DAYS), today)) recent.push(t);
      return { items: findInsights(recent, today, await transactions.dismissedInsights(userId)) };
    },

    /**
     * Doesn't check the insight still applies, which would mean running every rule: an ID nothing
     * matches is one harmless row. The format check keeps anything else out of the table.
     */
    async dismissInsight(userId: string, id: string) {
      if (!INSIGHT_ID_PATTERN.test(id)) throw new ApiError(400, "invalid_insight_id", "That is not an insight ID");
      await transactions.dismissInsight(userId, id, deps.now());
    },

    async update(userId: string, id: string, version: number, changes: Partial<TransactionFields>) {
      try {
        return await transactions.update(userId, id, version, changes, deps.now());
      } catch (err) {
        if (err instanceof TransactionNotFoundError) throw notFound();
        if (err instanceof VersionConflictError) {
          throw new ApiError(409, "version_conflict", "Someone else changed this transaction; reload it and try again");
        }
        throw err;
      }
    },

    async remove(userId: string, id: string) {
      try {
        await transactions.delete(userId, id);
      } catch (err) {
        if (err instanceof TransactionNotFoundError) throw notFound();
        throw err;
      }
    },
  };
}
