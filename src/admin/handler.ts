import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createUsersStore, UserNotFoundError, type UserStatus } from "../auth/users-store";
import { createTransactionsStore } from "../data/transactions-store";
import { ApiError, json, noContent, requireAdmin, withErrors } from "../http";
import { type Logger, log as defaultLog } from "../log";
import { statusQuery } from "./schemas";

export interface AdminDeps {
  tableName: string;
  dataTableName: string;
  /** Overrides the transactions store, so tests can make a delete fail part-way. */
  transactions?: ReturnType<typeof createTransactionsStore>;
  log?: Logger;
}

/** The admin's user routes: list users by status, enable, disable and delete them. */
export function createAdminHandler(deps: AdminDeps) {
  const users = createUsersStore(deps.tableName);
  const transactions = deps.transactions ?? createTransactionsStore(deps.dataTableName);
  const log = deps.log ?? defaultLog;

  const deleteUser = async (event: APIGatewayProxyEventV2) => {
    const ctx = requireAdmin(event, "admin:write");
    const target = await users.getById(event.pathParameters?.id ?? "");
    if (!target) throw new ApiError(404, "user_not_found", "No such user");
    if (target.role === "admin") throw new ApiError(409, "cannot_delete_admin", "Admins can't be deleted");
    // Disabled first, which also ends their access token at the authorizer, so nothing new arrives while their
    // data goes. The profile goes last: if this fails part-way, the admin can still find them and try again.
    await users.setStatus(target.id, "disabled");
    const deleted = await transactions.deleteAll(target.id);
    await users.delete(target);
    log({ event: "user_deleted", userId: target.id, by: ctx.userId, dataItemsDeleted: deleted });
    return noContent();
  };

  const setStatus = async (event: APIGatewayProxyEventV2, status: UserStatus) => {
    try {
      return await users.setStatus(event.pathParameters?.id ?? "", status);
    } catch (err) {
      if (err instanceof UserNotFoundError) throw new ApiError(404, "user_not_found", "No such user");
      throw err;
    }
  };

  return withErrors(async (event) => {
    switch (event.routeKey) {
      case "GET /api/v1/admin/users": {
        requireAdmin(event, "admin:read");
        const query = statusQuery.safeParse(event.queryStringParameters ?? {});
        if (!query.success) throw new ApiError(400, "validation_failed", "Query is invalid", query.error.issues);
        return json(200, { items: await users.listByStatus(query.data.status), nextCursor: null });
      }
      case "POST /api/v1/admin/users/{id}/enable": {
        requireAdmin(event, "admin:write");
        return json(200, await setStatus(event, "active"));
      }
      case "POST /api/v1/admin/users/{id}/disable": {
        requireAdmin(event, "admin:write");
        const target = await users.getById(event.pathParameters?.id ?? "");
        if (!target) throw new ApiError(404, "user_not_found", "No such user");
        if (target.role === "admin") throw new ApiError(409, "cannot_disable_admin", "Admins can't be disabled");
        const user = await setStatus(event, "disabled");
        // The authorizer refuses their access token from now on; this ends refreshing too.
        await users.revokeRefreshTokens(user.id);
        return json(200, user);
      }
      case "DELETE /api/v1/admin/users/{id}":
        return deleteUser(event);
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
