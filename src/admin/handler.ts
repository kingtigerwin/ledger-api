import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { createUsersStore, UserNotFoundError, type UserStatus } from "../auth/users-store";
import { ApiError, authContext, json, withErrors } from "../http";

export interface AdminDeps {
  tableName: string;
}

const statusQuery = z.object({ status: z.enum(["pending", "active", "disabled"]) });

/** Admin routes need both the admin role and the scope for the kind of access. */
function requireAdmin(event: APIGatewayProxyEventV2, scope: "admin:read" | "admin:write") {
  const ctx = authContext(event);
  if (ctx.role !== "admin" || !ctx.scope.split(" ").includes(scope)) {
    throw new ApiError(403, "forbidden", "Admins only");
  }
  return ctx;
}

export function createAdminHandler(deps: AdminDeps) {
  const users = createUsersStore(deps.tableName);

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
        // Their access token still works until it expires (at most 15 minutes); refreshing ends now.
        await users.revokeRefreshTokens(user.id);
        return json(200, user);
      }
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
