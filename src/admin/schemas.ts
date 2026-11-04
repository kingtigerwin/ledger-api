import { z } from "zod";

export const statusQuery = z.object({ status: z.enum(["pending", "active", "disabled"]) });
