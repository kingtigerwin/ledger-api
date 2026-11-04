import { json } from "../http";
import { buildOpenApi } from "../openapi";

const spec = buildOpenApi();

export const handler = async () => json(200, spec);
