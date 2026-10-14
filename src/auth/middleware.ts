import { createMiddleware } from "hono/factory";
import { verifySession } from "./session";

export type AuthEnv = { Variables: { auth: { userId: string; sessionId: string } } };

const UNAUTHORIZED = { error: { code: "unauthorized", message: "Missing or invalid credentials" } };

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  if (!m) return c.json(UNAUTHORIZED, 401);
  const session = await verifySession(m[1]);
  if (!session) return c.json(UNAUTHORIZED, 401);
  c.set("auth", session);
  await next();
});
