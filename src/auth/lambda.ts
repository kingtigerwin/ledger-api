import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createAuthHandler } from "./handler";
import { loadSigningSecret } from "./signing-secret";

const ready = loadSigningSecret().then((signingSecret) =>
  createAuthHandler({ tableName: process.env.USERS_TABLE!, signingSecret, now: () => new Date() }),
);

export const handler = async (event: APIGatewayProxyEventV2) => (await ready)(event);
