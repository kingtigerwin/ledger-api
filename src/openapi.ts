import { z } from "zod";
import { statusQuery } from "./admin/schemas";
import { credentialsSchema, loginSchema } from "./auth/schemas";
import { memberSchema } from "./data/member-schema";
import {
  createTransactionSchema,
  listQuerySchema,
  summaryQuerySchema,
  updateTransactionSchema,
} from "./data/transaction-schema";

interface Operation {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  /** Stable and descriptive: a future MCP server turns these into tool names. */
  operationId: string;
  summary: string;
  body?: z.ZodType;
  query?: z.ZodObject;
  /** Callable without a token (sign-in routes and this spec). */
  public?: boolean;
}

const refreshBody = z.object({ refreshToken: z.string().optional() });

// Every route the stack deploys; a unit test checks the two lists match.
const operations: Operation[] = [
  { method: "post", path: "/api/v1/auth/register", operationId: "register", summary: "Sign up; the account stays pending until an admin enables it", body: credentialsSchema, public: true },
  { method: "post", path: "/api/v1/auth/login", operationId: "login", summary: "Log in; returns an access token and a refresh token (cookie, or body if refreshTokenIn is \"body\")", body: loginSchema, public: true },
  { method: "post", path: "/api/v1/auth/refresh", operationId: "refreshTokens", summary: "Swap a refresh token (cookie or body) for new tokens", body: refreshBody, public: true },
  { method: "post", path: "/api/v1/auth/logout", operationId: "logout", summary: "End the session's refresh token", body: refreshBody, public: true },
  { method: "get", path: "/api/v1/auth/me", operationId: "getCurrentUser", summary: "The signed-in user" },
  { method: "get", path: "/api/v1/admin/users", operationId: "adminListUsers", summary: "Admin: list users by status", query: statusQuery },
  { method: "post", path: "/api/v1/admin/users/{id}/enable", operationId: "adminEnableUser", summary: "Admin: activate a user" },
  { method: "post", path: "/api/v1/admin/users/{id}/disable", operationId: "adminDisableUser", summary: "Admin: block a user and end their refresh tokens" },
  { method: "get", path: "/api/v1/admin/users/{id}/members", operationId: "adminListMembers", summary: "Admin: a customer's members" },
  { method: "get", path: "/api/v1/admin/users/{id}/transactions", operationId: "adminListTransactions", summary: "Admin: a customer's transactions", query: listQuerySchema },
  { method: "post", path: "/api/v1/members", operationId: "createMember", summary: "Add a household member", body: memberSchema },
  { method: "get", path: "/api/v1/members", operationId: "listMembers", summary: "All household members, including archived ones" },
  { method: "patch", path: "/api/v1/members/{id}", operationId: "renameMember", summary: "Rename a member", body: memberSchema },
  { method: "delete", path: "/api/v1/members/{id}", operationId: "deleteMember", summary: "Delete a member, or archive them if they have transactions" },
  { method: "post", path: "/api/v1/transactions", operationId: "createTransaction", summary: "Record an expense; repeating the same id returns the stored record", body: createTransactionSchema },
  { method: "get", path: "/api/v1/transactions", operationId: "listTransactions", summary: "Transactions, newest first, with optional filters", query: listQuerySchema },
  { method: "get", path: "/api/v1/transactions/summary", operationId: "getMonthlySummary", summary: "A month's totals by member and by category", query: summaryQuerySchema },
  { method: "get", path: "/api/v1/transactions/{id}", operationId: "getTransaction", summary: "One transaction" },
  { method: "patch", path: "/api/v1/transactions/{id}", operationId: "updateTransaction", summary: "Edit a transaction; send the version you last read", body: updateTransactionSchema },
  { method: "delete", path: "/api/v1/transactions/{id}", operationId: "deleteTransaction", summary: "Delete a transaction" },
  { method: "get", path: "/api/openapi.json", operationId: "getOpenApiSpec", summary: "This document", public: true },
];

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

function toOperation(op: Operation) {
  const pathParams = [...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const queryParams = op.query
    ? Object.entries((jsonSchema(op.query) as { properties: Record<string, object>; required?: string[] }).properties).map(
        ([name, schema]) => ({ name, in: "query", required: Boolean(op.query?.shape[name] && !op.query.shape[name].isOptional()), schema }),
      )
    : [];
  return {
    operationId: op.operationId,
    summary: op.summary,
    security: op.public ? [] : [{ bearerAuth: [] }],
    parameters: [...pathParams, ...queryParams],
    ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(op.body) } } } } : {}),
    responses: {
      default: {
        description: "Success, or an error shaped as { error: { code, message, details? } }",
      },
    },
  };
}

// The document is plain JSON; callers index into it freely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOpenApi(): { openapi: string; paths: Record<string, Record<string, any>> } & Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) (paths[op.path] ??= {})[op.method] = toOperation(op);
  return {
    openapi: "3.1.0",
    info: { title: "ledger-api", version: "1.0.0", description: "Household expense records. See docs/design.md." },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    paths,
  };
}
