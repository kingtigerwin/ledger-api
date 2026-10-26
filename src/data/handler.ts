import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { ApiError, authContext, json, noContent, parseBody, requireAdmin, withErrors } from "../http";
import { createMembersStore, MemberNameTakenError, MemberNotFoundError } from "./members-store";

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

export function createDataHandler(deps: DataDeps) {
  const members = createMembersStore(deps.tableName);

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
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
