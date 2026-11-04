import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { createAuthorizer } from "./authorizer";
import { loadSigningSecret } from "./signing-secret";
import { createUsersStore } from "./users-store";

const users = createUsersStore(process.env.USERS_TABLE!);
const ready = loadSigningSecret().then((signingSecret) =>
  createAuthorizer({ signingSecret, now: () => new Date(), isActive: (userId) => users.isActive(userId) }),
);

export const handler = async (event: APIGatewayRequestAuthorizerEventV2) => (await ready)(event);
