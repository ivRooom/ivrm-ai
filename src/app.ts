import { Hono } from "hono";
import {
  requireAiAccess,
  type AuthDeps,
  type AuthEnv,
} from "./auth/middleware.js";

export type AppDeps = { auth: AuthDeps };

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  const api = new Hono<AuthEnv>();
  api.use("*", requireAiAccess(deps.auth));
  api.get("/me", (c) => {
    const session = c.get("session");
    return c.json({
      user: {
        id: session.userId,
        username: session.username,
        isAdmin: session.isAdmin,
      },
    });
  });
  app.route("/api", api);

  return app;
}
