import { z } from "zod";

export const credentialsSchema = z.object({
  username: z.string().min(1).max(64).toLowerCase(),
  password: z.string().min(1).max(1024),
});

export const loginSchema = credentialsSchema.extend({
  // Browsers get the refresh token only as an HttpOnly cookie; non-browser clients (an agent) ask for it in the body.
  refreshTokenIn: z.enum(["cookie", "body"]).default("cookie"),
});
