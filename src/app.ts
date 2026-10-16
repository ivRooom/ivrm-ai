import { Hono } from "hono";
import {
  requireAiAccess,
  type AuthDeps,
  type AuthEnv,
} from "./auth/middleware.js";
import { chatRoutes, type ChatDeps } from "./chat/routes.js";

export type AppDeps = { auth: AuthDeps; chat: ChatDeps };

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
  api.route("/", chatRoutes(deps.chat));
  app.route("/api", api);

  return app;
}
