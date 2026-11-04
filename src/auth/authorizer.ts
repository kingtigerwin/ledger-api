/**
 * The Lambda authorizer for every protected route. Its results aren't cached, since a token outlives
 * its user being disabled or deleted.
 */
import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerWithContextResult } from "aws-lambda";
import { verifyAccessToken } from "./tokens";

/** Passed to every protected route as `event.requestContext.authorizer.lambda`. */
export interface AuthContext {
  userId: string;
  role: string;
  scope: string;
}

type Result = APIGatewaySimpleAuthorizerWithContextResult<AuthContext> | { isAuthorized: false };

/**
 * Allows a valid bearer token whose user is still active. The user is only looked up once the token
 * verifies, so junk tokens cost no read.
 */
export function createAuthorizer(deps: {
  signingSecret: string;
  now: () => Date;
  isActive: (userId: string) => Promise<boolean>;
}) {
  return async (event: APIGatewayRequestAuthorizerEventV2): Promise<Result> => {
    const [scheme, token] = (event.headers?.authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !token) return { isAuthorized: false };
    let claims;
    try {
      claims = await verifyAccessToken(token, deps.signingSecret, deps.now());
    } catch {
      return { isAuthorized: false };
    }
    if (!(await deps.isActive(claims.sub))) return { isAuthorized: false };
    return { isAuthorized: true, context: { userId: claims.sub, role: claims.role, scope: claims.scope } };
  };
}
