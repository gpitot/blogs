import type { Context, Next } from "hono";
import type { AppVariables } from "../types/context.ts";
import type { UserRepo } from "../repositories/types.ts";

export function createAuthMiddleware(userRepo: UserRepo) {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const apiKey = c.req.header("X-Api-Key");
    if (!apiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const user = await userRepo.getByApiKey(apiKey);
    if (!user || !user.approved) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("user", user);
    await next();
  };
}
