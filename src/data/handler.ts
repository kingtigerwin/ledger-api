import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { ApiError, authContext, json, noContent, parseBody, requireAdmin, withErrors } from "../http";
import { createMembersStore, MemberNameTakenError, MemberNotFoundError } from "./members-store";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor";
import {
  createTransactionSchema,
  listQuerySchema,
  summaryQuerySchema,
  type Transaction,
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

const memberSchema = z.object({ name: z.string().trim().min(1).max(50) });

/** The caller's user ID, provided their token carries the scope this route needs. */
function requireScope(event: APIGatewayProxyEventV2, scope: string): string {
  const ctx = authContext(event);
  if (!ctx.scope.split(" ").includes(scope)) throw new ApiError(403, "forbidden", `Requires the ${scope} scope`);
  return ctx.userId;
}

/** Runs a member write, turning store errors into API errors. */
async function mapMemberErrors<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof MemberNameTakenError) {
      throw new ApiError(409, "member_name_taken", "Someone in this household already has that name");
    }
    if (err instanceof MemberNotFoundError) throw new ApiError(404, "member_not_found", "No such member");
    throw err;
  }
}

function parseQuery<T extends z.ZodType>(event: APIGatewayProxyEventV2, schema: T): z.infer<T> {
  const result = schema.safeParse(event.queryStringParameters ?? {});
  if (!result.success) throw new ApiError(400, "validation_failed", "Query is invalid", result.error.issues);
  return result.data;
}

const invalidCursor = () => new ApiError(400, "invalid_cursor", "The cursor is invalid; start from the first page");

export function createDataHandler(deps: DataDeps) {
  const members = createMembersStore(deps.tableName);
  const transactions = createTransactionsStore(deps.tableName);

  /** A transaction may only point at one of the household's own members. */
  const requireMember = async (userId: string, memberId: string) => {
    const member = await members.get(userId, memberId);
    if (!member) throw new ApiError(422, "member_not_found", "That member isn't in this household");
    return member;
  };

  /** One page of a household's transactions, with member names and a signed cursor for the next page. */
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
    const names = new Map((await members.list(userId)).map((m) => [m.id, m.name]));
    return {
      items: page.items.map((t) => ({ ...t, memberName: names.get(t.memberId) })),
      nextCursor: page.lastKey ? encodeCursor(page.lastKey, deps.cursorSecret) : null,
    };
  };

  /**
   * Totals for one month, computed on request. A household records a few hundred transactions a month,
   * so reading them all is cheap; precomputed totals would be the upgrade if that changes.
   */
  const monthSummary = async (userId: string, month: string) => {
    const byMember = new Map<string, number>();
    const byCategory = new Map<string, number>();
    let totalCents = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      // Day 31 is a safe upper bound for every month: sort keys compare as strings.
      const page = await transactions.list(userId, { from: `${month}-01`, to: `${month}-31`, limit: 100 }, startKey);
      for (const t of page.items) {
        totalCents += t.amountCents;
        byMember.set(t.memberId, (byMember.get(t.memberId) ?? 0) + t.amountCents);
        byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amountCents);
      }
      startKey = page.lastKey;
    } while (startKey);

    const names = new Map((await members.list(userId)).map((m) => [m.id, m.name]));
    const largestFirst = <T extends { totalCents: number }>(key: (row: T) => string) => (a: T, b: T) =>
      b.totalCents - a.totalCents || key(a).localeCompare(key(b));
    return {
      month,
      currency: "AUD",
      totalCents,
      byMember: [...byMember]
        .map(([memberId, total]) => ({ memberId, memberName: names.get(memberId), totalCents: total }))
        .sort(largestFirst((row) => row.memberName ?? "")),
      byCategory: [...byCategory]
        .map(([category, total]) => ({ category, totalCents: total }))
        .sort(largestFirst((row) => row.category)),
    };
  };

  /** Adds the member's current name, so renaming a member never touches transactions. */
  const withMemberName = async (userId: string, t: Transaction) => ({
    ...t,
    memberName: (await members.get(userId, t.memberId))?.name,
  });

  return withErrors(async (event) => {
    switch (event.routeKey) {
      case "POST /api/v1/members": {
        const userId = requireScope(event, "members:write");
        const { name } = parseBody(event, memberSchema);
        return json(201, await mapMemberErrors(() => members.create(userId, name, deps.now())));
      }
      case "GET /api/v1/members": {
        const userId = requireScope(event, "members:read");
        return json(200, { items: await members.list(userId), nextCursor: null });
      }
      case "PATCH /api/v1/members/{id}": {
        const userId = requireScope(event, "members:write");
        const { name } = parseBody(event, memberSchema);
        return json(200, await mapMemberErrors(() => members.rename(userId, event.pathParameters?.id ?? "", name, deps.now())));
      }
      case "DELETE /api/v1/members/{id}": {
        const userId = requireScope(event, "members:write");
        await mapMemberErrors(() => members.delete(userId, event.pathParameters?.id ?? ""));
        return noContent();
      }
      case "GET /api/v1/admin/users/{id}/members": {
        requireAdmin(event, "admin:read");
        return json(200, { items: await members.list(event.pathParameters?.id ?? ""), nextCursor: null });
      }
      case "POST /api/v1/transactions": {
        const userId = requireScope(event, "transactions:write");
        const input = parseBody(event, createTransactionSchema);
        const now = deps.now();
        if (ulidTime(input.id).getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
          throw new ApiError(400, "invalid_id", "The id's timestamp is in the future");
        }
        await requireMember(userId, input.memberId);
        try {
          return json(201, await withMemberName(userId, await transactions.create(userId, input, now)));
        } catch (err) {
          if (!(err instanceof TransactionExistsError)) throw err;
          // A retry: answer with what was stored the first time.
          const existing = await transactions.get(userId, input.id);
          if (!existing) throw err;
          return json(200, await withMemberName(userId, existing));
        }
      }
      case "GET /api/v1/transactions/{id}": {
        const userId = requireScope(event, "transactions:read");
        const transaction = await transactions.get(userId, event.pathParameters?.id ?? "");
        if (!transaction) throw new ApiError(404, "transaction_not_found", "No such transaction");
        return json(200, await withMemberName(userId, transaction));
      }
      case "PATCH /api/v1/transactions/{id}": {
        const userId = requireScope(event, "transactions:write");
        const { version, ...changes } = parseBody(event, updateTransactionSchema);
        if (changes.memberId) await requireMember(userId, changes.memberId);
        try {
          const updated = await transactions.update(userId, event.pathParameters?.id ?? "", version, changes, deps.now());
          return json(200, await withMemberName(userId, updated));
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
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
