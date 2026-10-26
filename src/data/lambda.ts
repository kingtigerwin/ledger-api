import { createHmac } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { loadSigningSecret } from "../auth/signing-secret";
import { createDataHandler } from "./handler";

// Cursors get their own key, derived from the JWT secret, so no second secret is needed
// and a cursor can never be mistaken for a token.
const ready = loadSigningSecret().then((secret) =>
  createDataHandler({
    tableName: process.env.DATA_TABLE!,
    cursorSecret: createHmac("sha256", secret).update("ledger-api cursor key").digest("base64url"),
    now: () => new Date(),
  }),
);

export const handler = async (event: APIGatewayProxyEventV2) => (await ready)(event);
