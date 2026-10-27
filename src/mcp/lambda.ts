import { createMcpHandler } from "./handler";

export const handler = createMcpHandler({
  tableName: process.env.DATA_TABLE!,
  now: () => new Date(),
});
