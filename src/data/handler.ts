import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { ApiError, authContext, json, parseBody, withErrors } from "../http";
import { createMembersStore, MemberNameTakenError } from "./members-store";

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

/** Runs a member write, turning a name clash into a 409. */
async function claimingName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof MemberNameTakenError) {
      throw new ApiError(409, "member_name_taken", "Someone in this household already has that name");
    }
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
        return json(201, await claimingName(() => members.create(userId, name, deps.now())));
      }
      case "GET /api/v1/members": {
        const userId = requireScope(event, "members:read");
        return json(200, { items: await members.list(userId), nextCursor: null });
      }
      default:
        throw new ApiError(404, "route_not_found", `No route for ${event.routeKey}`);
    }
  });
}
