import { z } from "zod";

export const memberSchema = z.object({ name: z.string().trim().min(1).max(50) });
