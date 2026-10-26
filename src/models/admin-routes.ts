import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import type { ModelCatalog } from "./catalog.js";
import type { ModelSpec } from "./types.js";

const PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
};

/** The vendor from a Bedrock model or inference profile id (`jp.anthropic.…`). */
export function providerOf(spec: Pick<ModelSpec, "bedrockModelId">): string {
  const parts = spec.bedrockModelId.split(".");
  const vendor =
    parts.find((part) => part in PROVIDERS) ?? parts[parts.length > 2 ? 1 : 0];
  return PROVIDERS[vendor ?? ""] ?? vendor ?? "";
}

/**
 * The whole catalog for the admin screen that edits ai policies (ivrm-web), so
 * a policy can name a model before its price is verified (#35). Only ids, labels
 * and providers: no prices, Bedrock ids or regions. Owner / admin only, as
 * reported by api.ivrm.jp (/auth/me); mounted behind requireAiAccess.
 */
export function adminModelRoutes(
  catalog: ModelCatalog,
  now = () => new Date()
) {
  const app = new Hono<AuthEnv>();

  app.get("/models", (c) => {
    if (!c.get("session").isAdmin) return c.json({ error: "forbidden" }, 403);
    const callable = new Set(catalog.listCallable(now()).map((m) => m.id));
    return c.json({
      models: catalog.list().map((m) => ({
        id: m.id,
        label: m.label,
        provider: providerOf(m),
        callable: callable.has(m.id),
      })),
    });
  });

  return app;
}
