import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { ApiError, authContext, json, noContent, parseBody, requireAdmin, withErrors } from "../http";
import { createLedger, type LedgerDeps } from "./ledger";
import {
  createTransactionSchema,
  listQuerySchema,
  summaryQuerySchema,
  updateTransactionSchema,
} from "./transaction-schema";

export type DataDeps = LedgerDeps;

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

export function createDataHandler(deps: DataDeps) {
  const ledger = createLedger(deps);

  const update = async (userId: string, id: string, event: APIGatewayProxyEventV2) => {
    const { version, ...changes } = parseBody(event, updateTransactionSchema);
    return json(200, await ledger.update(userId, id, version, changes));
  };

  const remove = async (userId: string, id: string) => {
    await ledger.remove(userId, id);
    return noContent();
  };

  return withErrors(async (event) => {
    switch (event.routeKey) {
      case "POST /api/v1/transactions": {
        const userId = requireScope(event, "transactions:write");
        // A retry returns what was stored.
        const { transaction, created } = await ledger.record(userId, parseBody(event, createTransactionSchema));
        return json(created ? 201 : 200, transaction);
      }
      case "GET /api/v1/transactions/{id}": {
        const userId = requireScope(event, "transactions:read");
        return json(200, await ledger.get(userId, event.pathParameters?.id ?? ""));
      }
      case "PATCH /api/v1/transactions/{id}": {
        const userId = requireScope(event, "transactions:write");
        return update(userId, event.pathParameters?.id ?? "", event);
      }
      case "DELETE /api/v1/transactions/{id}": {
        const userId = requireScope(event, "transactions:write");
        return remove(userId, event.pathParameters?.id ?? "");
      }
      case "GET /api/v1/transactions": {
        const userId = requireScope(event, "transactions:read");
        return json(200, await ledger.list(userId, parseQuery(event, listQuerySchema)));
      }
      case "GET /api/v1/transactions/summary": {
        const userId = requireScope(event, "transactions:read");
        return json(200, await ledger.summary(userId, parseQuery(event, summaryQuerySchema).month));
      }
      case "GET /api/v1/admin/users/{id}/transactions": {
        requireAdmin(event, "admin:read");
        return json(200, await ledger.list(event.pathParameters?.id ?? "", parseQuery(event, listQuerySchema)));
      }
      case "GET /api/v1/admin/transactions": {
        requireAdmin(event, "admin:read");
        return json(200, await ledger.listAll(parseQuery(event, listQuerySchema)));
      }
      case "PATCH /api/v1/admin/users/{id}/transactions/{transactionId}": {
        requireAdmin(event, "admin:write");
        return update(event.pathParameters?.id ?? "", event.pathParameters?.transactionId ?? "", event);
      }
      case "DELETE /api/v1/admin/users/{id}/transactions/{transactionId}": {
        requireAdmin(event, "admin:write");
        return remove(event.pathParameters?.id ?? "", event.pathParameters?.transactionId ?? "");
      }
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
