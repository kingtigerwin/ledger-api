import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

export interface Response {
  status: number;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Calls a Lambda handler the way the HTTP API would, with a JSON body. */
export async function call(handler: Handler, routeKey: string, body?: unknown): Promise<Response> {
  const [, rawPath] = routeKey.split(" ");
  const event = {
    routeKey,
    rawPath,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
  const res = (await handler(event)) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode ?? 200, body: res.body ? JSON.parse(res.body) : {} };
}
