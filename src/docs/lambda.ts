import { buildOpenApi } from "../openapi";

const body = JSON.stringify(buildOpenApi());

export const handler = async () => ({ statusCode: 200, headers: { "content-type": "application/json" }, body });
