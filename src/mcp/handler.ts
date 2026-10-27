import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { authContext, withErrors } from "../http";
import { log } from "../log";
import { transactionFieldsSchema } from "../data/transaction-schema";
import { createTransactionsStore } from "../data/transactions-store";
import { newUlid } from "../data/ulid";

export interface McpDeps {
  tableName: string;
  now: () => Date;
}

/**
 * MCP over Streamable HTTP, stateless: every POST carries the caller's bearer token, so each request
 * gets a fresh server holding only that caller's tools. Tools run the same store code as the REST API.
 */
export function createMcpHandler(deps: McpDeps) {
  const transactions = createTransactionsStore(deps.tableName);

  const serverFor = (userId: string, scopes: string[]) => {
    const server = new McpServer({ name: "ledger-api", version: "1.0.0" });
    const createTool = server.registerTool(
      "create_transaction",
      {
        title: "Record an expense",
        description:
          "Records one expense for the signed-in customer, in Australian dollars. " +
          "amountCents is the amount in cents ($30 is 3000). date is the day it happened, YYYY-MM-DD, " +
          "in the customer's time zone. Pick the closest category, or other. " +
          "Every call records a new transaction, so call it once per expense. Returns the stored transaction.",
        inputSchema: transactionFieldsSchema,
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (fields) => {
        const now = deps.now();
        try {
          const { transaction } = await transactions.createOnce(
            userId,
            { ...fields, id: newUlid(now), currency: "AUD" },
            now,
          );
          return { content: [{ type: "text", text: JSON.stringify(transaction) }] };
        } catch (err) {
          log({ event: "mcp_tool_failed", tool: "create_transaction", err }, "error");
          return { isError: true, content: [{ type: "text", text: "Couldn't record the transaction; try again" }] };
        }
      },
    );
    // Hidden from tools/list, and calls are refused.
    if (!scopes.includes("transactions:write")) createTool.disable();
    return server;
  };

  return withErrors(async (event) => {
    const ctx = authContext(event);
    const server = serverFor(ctx.userId, ctx.scope.split(" "));
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
