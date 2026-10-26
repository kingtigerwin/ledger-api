import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { AuthContext } from "../../src/auth/authorizer";

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

export interface Response {
  status: number;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Set-Cookie values, as the HTTP API payload v2 returns them. */
  cookies: string[];
}

export interface CallOptions {
  /** Request cookies as `name=value` strings. */
  cookies?: string[];
  /** What the Lambda authorizer would have passed for a valid token. */
  auth?: AuthContext;
}

/** Calls a Lambda handler the way the HTTP API would, with a JSON body. */
export async function call(handler: Handler, routeKey: string, body?: unknown, options: CallOptions = {}): Promise<Response> {
  const [, rawPath] = routeKey.split(" ");
  const event = {
    routeKey,
    rawPath,
    headers: { "content-type": "application/json" },
    cookies: options.cookies,
    requestContext: options.auth ? { authorizer: { lambda: options.auth } } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
  const res = (await handler(event)) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode ?? 200, body: res.body ? JSON.parse(res.body) : {}, cookies: res.cookies ?? [] };
}

/** Turns a Set-Cookie value into the `name=value` a browser would send back. */
export const cookiePair = (setCookie: string) => setCookie.split(";")[0]!;
