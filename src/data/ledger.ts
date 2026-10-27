import { ApiError } from "../http";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor";
import type { CreateTransactionInput, ListQuery, TransactionFields } from "./transaction-schema";
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
      let startKey: Record<string, unknown> | undefined;
      do {
        // Day 31 is a safe upper bound for every month: sort keys compare as strings.
        const page = await transactions.list(userId, { from: `${month}-01`, to: `${month}-31`, limit: 100 }, startKey);
        for (const t of page.items) {
          totalCents += t.amountCents;
          byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amountCents);
        }
        startKey = page.lastKey;
      } while (startKey);

      return {
        month,
        currency: "AUD",
        totalCents,
        byCategory: [...byCategory]
          .map(([category, total]) => ({ category, totalCents: total }))
          .sort((a, b) => b.totalCents - a.totalCents || a.category.localeCompare(b.category)),
      };
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
