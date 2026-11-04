import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { loadSigningSecret } from "../auth/signing-secret";
import { cursorSecretFrom } from "./cursor";
import { createDataHandler } from "./handler";

const ready = loadSigningSecret().then((secret) =>
  createDataHandler({
    tableName: process.env.DATA_TABLE!,
    cursorSecret: cursorSecretFrom(secret),
    now: () => new Date(),
  }),
);

export const handler = async (event: APIGatewayProxyEventV2) => (await ready)(event);
