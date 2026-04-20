import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AppVariables } from "../types/context.ts";
import type { UserRepo } from "../repositories/types.ts";

export const AUTH_COOKIE = "api_key";

export function createAuthMiddleware(userRepo: UserRepo) {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const apiKey = c.req.header("X-Api-Key") ?? getCookie(c, AUTH_COOKIE);
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
