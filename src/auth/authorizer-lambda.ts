import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { createAuthorizer } from "./authorizer";
import { loadSigningSecret } from "./signing-secret";

const ready = loadSigningSecret().then((signingSecret) => createAuthorizer({ signingSecret, now: () => new Date() }));

export const handler = async (event: APIGatewayRequestAuthorizerEventV2) => (await ready)(event);
