import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerWithContextResult } from "aws-lambda";
import { verifyAccessToken } from "./tokens";

/** Passed to every protected route as `event.requestContext.authorizer.lambda`. */
export interface AuthContext {
  userId: string;
  role: string;
  scope: string;
}

type Result = APIGatewaySimpleAuthorizerWithContextResult<AuthContext> | { isAuthorized: false };

export function createAuthorizer(deps: { signingSecret: string; now: () => Date }) {
  return async (event: APIGatewayRequestAuthorizerEventV2): Promise<Result> => {
    const [scheme, token] = (event.headers?.authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !token) return { isAuthorized: false };
    try {
      const claims = await verifyAccessToken(token, deps.signingSecret, deps.now());
      return { isAuthorized: true, context: { userId: claims.sub, role: claims.role, scope: claims.scope } };
    } catch {
      return { isAuthorized: false };
    }
  };
}
