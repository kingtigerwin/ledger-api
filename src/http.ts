import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { z } from "zod";

export type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

/** Thrown anywhere in a request; `withErrors` turns it into `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function json(statusCode: number, body: unknown, cookies?: string[]): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body), cookies };
}

export function noContent(cookies?: string[]): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204, cookies };
}

export function parseBody<T extends z.ZodType>(event: APIGatewayProxyEventV2, schema: T): z.infer<T> {
  let raw: unknown;
  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(400, "validation_failed", "Request body is invalid", result.error.issues);
  }
  return result.data;
}

export function withErrors(handler: Handler): Handler {
  return async (event) => {
    try {
      return await handler(event);
    } catch (err) {
      if (err instanceof ApiError) {
        return json(err.status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      console.error("Unhandled error", { routeKey: event.routeKey, err });
      return json(500, { error: { code: "internal_error", message: "Internal server error" } });
    }
  };
}
