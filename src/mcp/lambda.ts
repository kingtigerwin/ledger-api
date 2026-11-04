import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { loadSigningSecret } from "../auth/signing-secret";
import { cursorSecretFrom } from "../data/cursor";
import { createMcpHandler } from "./handler";

const ready = loadSigningSecret().then((secret) =>
  createMcpHandler({
    tableName: process.env.DATA_TABLE!,
    usersTableName: process.env.USERS_TABLE!,
    cursorSecret: cursorSecretFrom(secret),
    now: () => new Date(),
  }),
);

export const handler = async (event: APIGatewayProxyEventV2) => (await ready)(event);
