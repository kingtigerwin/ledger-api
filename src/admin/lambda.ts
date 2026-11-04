import { createAdminHandler } from "./handler";

export const handler = createAdminHandler({ tableName: process.env.USERS_TABLE! });
