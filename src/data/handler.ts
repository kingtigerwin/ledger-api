import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { ApiError, authContext, json, noContent, parseBody, requireAdmin, withErrors } from "../http";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor";
import {
  createTransactionSchema,
  listQuerySchema,
  summaryQuerySchema,
  updateTransactionSchema,
} from "./transaction-schema";
import {
  createTransactionsStore,
  TransactionExistsError,
  TransactionNotFoundError,
  VersionConflictError,
} from "./transactions-store";
import { ulidTime } from "./ulid";

// Client clocks drift a little; an ID from further ahead than this would distort the sort order.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface DataDeps {
  tableName: string;
  /** Signs list cursors so clients can't tamper with them. */
  cursorSecret: string;
  now: () => Date;
}


/** The caller's user ID, provided their token carries the scope this route needs. */
function requireScope(event: APIGatewayProxyEventV2, scope: string): string {
  const ctx = authContext(event);
  if (!ctx.scope.split(" ").includes(scope)) throw new ApiError(403, "forbidden", `Requires the ${scope} scope`);
  return ctx.userId;
}

function parseQuery<T extends z.ZodType>(event: APIGatewayProxyEventV2, schema: T): z.infer<T> {
  const result = schema.safeParse(event.queryStringParameters ?? {});
  if (!result.success) throw new ApiError(400, "validation_failed", "Query is invalid", result.error.issues);
  return result.data;
}

const invalidCursor = () => new ApiError(400, "invalid_cursor", "The cursor is invalid; start from the first page");

export function createDataHandler(deps: DataDeps) {
  const transactions = createTransactionsStore(deps.tableName);

  /** One page of a customer's transactions, with a signed cursor for the next page. */
  const listPage = async (userId: string, event: APIGatewayProxyEventV2) => {
    const { cursor, ...query } = parseQuery(event, listQuerySchema);
    let startKey: Record<string, unknown> | undefined;
    try {
      startKey = cursor ? decodeCursor(cursor, deps.cursorSecret) : undefined;
    } catch (err) {
      if (err instanceof InvalidCursorError) throw invalidCursor();
      throw err;
    }
    let page;
    try {
      page = await transactions.list(userId, query, startKey);
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

  /**
   * Totals for one month, computed on request. A customer records a few hundred transactions a month,
   * so reading them all is cheap; precomputed totals would be the upgrade if that changes.
   */
  const monthSummary = async (userId: string, month: string) => {
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
  };

  return withErrors(async (event) => {
    switch (event.routeKey) {
      case "POST /api/v1/transactions": {
        const userId = requireScope(event, "transactions:write");
        const input = parseBody(event, createTransactionSchema);
        const now = deps.now();
        if (ulidTime(input.id).getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
          throw new ApiError(400, "invalid_id", "The id's timestamp is in the future");
        }
        // A retry returns what was stored.
        const existing = await transactions.get(userId, input.id);
        if (existing) return json(200, existing);
        try {
          return json(201, await transactions.create(userId, input, now));
        } catch (err) {
          if (!(err instanceof TransactionExistsError)) throw err;
          // A retry that raced the first request: answer with what was stored.
          const stored = await transactions.get(userId, input.id);
          if (!stored) throw err;
          return json(200, stored);
        }
      }
      case "GET /api/v1/transactions/{id}": {
        const userId = requireScope(event, "transactions:read");
        const transaction = await transactions.get(userId, event.pathParameters?.id ?? "");
        if (!transaction) throw new ApiError(404, "transaction_not_found", "No such transaction");
        return json(200, transaction);
      }
      case "PATCH /api/v1/transactions/{id}": {
        const userId = requireScope(event, "transactions:write");
        const { version, ...changes } = parseBody(event, updateTransactionSchema);
        try {
          const updated = await transactions.update(userId, event.pathParameters?.id ?? "", version, changes, deps.now());
          return json(200, updated);
        } catch (err) {
          if (err instanceof TransactionNotFoundError) throw new ApiError(404, "transaction_not_found", "No such transaction");
          if (err instanceof VersionConflictError) {
            throw new ApiError(409, "version_conflict", "Someone else changed this transaction; reload it and try again");
          }
          throw err;
        }
      }
      case "DELETE /api/v1/transactions/{id}": {
        const userId = requireScope(event, "transactions:write");
        try {
          await transactions.delete(userId, event.pathParameters?.id ?? "");
        } catch (err) {
          if (err instanceof TransactionNotFoundError) throw new ApiError(404, "transaction_not_found", "No such transaction");
          throw err;
        }
        return noContent();
      }
      case "GET /api/v1/transactions": {
        const userId = requireScope(event, "transactions:read");
        return json(200, await listPage(userId, event));
      }
      case "GET /api/v1/transactions/summary": {
        const userId = requireScope(event, "transactions:read");
        return json(200, await monthSummary(userId, parseQuery(event, summaryQuerySchema).month));
      }
      case "GET /api/v1/admin/users/{id}/transactions": {
        requireAdmin(event, "admin:read");
        return json(200, await listPage(event.pathParameters?.id ?? "", event));
      }
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
