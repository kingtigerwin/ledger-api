import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { createUsersStore } from "../auth/users-store";
import { ApiError, authContext, withErrors } from "../http";
import { log } from "../log";
import { createLedger, type LedgerDeps } from "../data/ledger";
import {
  listQuerySchema,
  summaryQuerySchema,
  transactionFieldsSchema,
  updateTransactionSchema,
} from "../data/transaction-schema";
import { newUlid } from "../data/ulid";

export type McpDeps = LedgerDeps & {
  /** For the usernames on the admin's cross-customer list. */
  usersTableName: string;
};

const byId = z.object({ id: z.string().describe("The transaction's id") });

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/**
 * MCP over Streamable HTTP, stateless: every POST carries the caller's bearer token, so each request
 * gets a fresh server holding only that caller's tools. The tools mirror the REST Transactions
 * routes (and, for the admin, `GET /admin/transactions`) and call the same ledger, so rules and
 * error messages are shared.
 */
export function createMcpHandler(deps: McpDeps) {
  const ledger = createLedger(deps);
  const users = createUsersStore(deps.usersTableName);

  const serverFor = (userId: string, role: string, scopes: string[]) => {
    const server = new McpServer({ name: "ledger-api", version: "1.0.0" });

    /** Registers a tool that needs `scope`, answers with JSON text, and reports API errors as tool errors. */
    const tool = <S extends z.ZodObject>(
      name: string,
      scope: "transactions:read" | "transactions:write" | "admin:read",
      config: { title: string; description: string; inputSchema: S; annotations: ToolAnnotations },
      run: (input: z.infer<S>) => Promise<unknown>,
    ) => {
      // The SDK has already validated `input` against `config.inputSchema`.
      const callback: ToolCallback<z.ZodObject> = async (input) => {
        try {
          return { content: [{ type: "text", text: JSON.stringify(await run(input as z.infer<S>)) }] };
        } catch (err) {
          if (err instanceof ApiError) return { isError: true, content: [{ type: "text", text: err.message }] };
          log({ event: "mcp_tool_failed", tool: name, err }, "error");
          return { isError: true, content: [{ type: "text", text: "Something went wrong; try again" }] };
        }
      };
      const registered = server.registerTool(name, { ...config, inputSchema: config.inputSchema as z.ZodObject }, callback);
      // Hidden from tools/list, and calls are refused. Admin tools also need the admin role, as `requireAdmin` does.
      const allowed = scopes.includes(scope) && (!scope.startsWith("admin:") || role === "admin");
      if (!allowed) registered.disable();
    };

    tool(
      "create_transaction",
      "transactions:write",
      {
        title: "Record an expense",
        description:
          "Records one expense for the signed-in customer, in Australian dollars. " +
          "amountCents is the amount in cents ($30 is 3000). date is the day it happened, YYYY-MM-DD, " +
          "in the customer's time zone. Pick the closest category, or other. " +
          "Every call records a new transaction, so call it once per expense. Returns the stored transaction.",
        inputSchema: transactionFieldsSchema,
        annotations: { ...WRITE, idempotentHint: false },
      },
      async (fields) => {
        const { transaction } = await ledger.record(userId, { ...fields, id: newUlid(deps.now()), currency: "AUD" });
        return transaction;
      },
    );

    tool(
      "get_transaction",
      "transactions:read",
      {
        title: "Get a transaction",
        description: "One of the signed-in customer's transactions, by id, including its current version.",
        inputSchema: byId,
        annotations: READ,
      },
      ({ id }) => ledger.get(userId, id),
    );

    tool(
      "list_transactions",
      "transactions:read",
      {
        title: "List transactions",
        description:
          "The signed-in customer's transactions, newest first, as { items, nextCursor }. " +
          "Optional filters: from and to (YYYY-MM-DD, inclusive), category. limit is 1-100 (default 50). " +
          "For the next page, call again with the same filters and cursor set to nextCursor; it is null on the last page.",
        inputSchema: listQuerySchema,
        annotations: READ,
      },
      (query) => ledger.list(userId, query),
    );

    tool(
      "get_monthly_summary",
      "transactions:read",
      {
        title: "Monthly spending summary",
        description: "The signed-in customer's total spending for a month (YYYY-MM), in cents, and by category, largest first.",
        inputSchema: summaryQuerySchema,
        annotations: READ,
      },
      ({ month }) => ledger.summary(userId, month),
    );

    tool(
      "update_transaction",
      "transactions:write",
      {
        title: "Edit a transaction",
        description:
          "Changes some fields of one of the signed-in customer's transactions. Send only the fields to change, " +
          "plus the version from your latest read (get_transaction or list_transactions). " +
          "If someone changed it since, the call fails: read it again and retry. Returns the updated transaction.",
        inputSchema: updateTransactionSchema.extend(byId.shape),
        annotations: { ...WRITE, idempotentHint: false },
      },
      ({ id, version, ...changes }) => ledger.update(userId, id, version, changes),
    );

    tool(
      "delete_transaction",
      "transactions:write",
      {
        title: "Delete a transaction",
        description: "Permanently deletes one of the signed-in customer's transactions, by id.",
        inputSchema: byId,
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
      },
      async ({ id }) => {
        await ledger.remove(userId, id);
        return { id, deleted: true };
      },
    );

    tool(
      "list_all_transactions",
      "admin:read",
      {
        title: "List every customer's transactions",
        description:
          "Admin only. Every customer's transactions, newest first, as { items, nextCursor }; each item has the " +
          "customer's userId and username (null if the user can't be found). Same filters as list_transactions: " +
          "from and to (YYYY-MM-DD, inclusive), category, limit 1-100 (default 50). To find one customer's " +
          "spending, filter by date and keep the items with their username. For the next page, call again with " +
          "the same filters and cursor set to nextCursor; it is null on the last page.",
        inputSchema: listQuerySchema,
        annotations: READ,
      },
      async (query) => {
        const page = await ledger.listAll(query);
        const usernames = await users.usernames(page.items.map((t) => t.userId));
        return {
          ...page,
          items: page.items.map((t) => ({ ...t, username: usernames.get(t.userId) ?? null })),
        };
      },
    );

    return server;
  };

  return withErrors(async (event) => {
    const ctx = authContext(event);
    const server = serverFor(ctx.userId, ctx.role, ctx.scope.split(" "));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(toRequest(event));
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    } finally {
      await server.close();
    }
  });
}

function toRequest(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value);
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  // The route only accepts POST; the host only matters for the transport's URL parsing.
  return new Request(`https://${event.headers?.host ?? "localhost"}${event.rawPath}`, { method: "POST", headers, body });
}
