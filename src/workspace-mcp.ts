import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AuthEnv } from "./auth/middleware.js";
import type { ChatDeps } from "./chat/routes.js";

const version = "2025-11-25";
const tools = [
  {
    name: "daily_budget",
    description: "今日の推論予算を確認",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "conversation_context",
    description: "会話の実測トークンを確認",
    inputSchema: {
      type: "object",
      properties: { conversationId: { type: "string" } },
      required: ["conversationId"],
      additionalProperties: false,
    },
  },
];
const request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

export function workspaceMcp({
  gate,
  store,
  now = () => new Date(),
}: ChatDeps) {
  const app = new Hono<AuthEnv>();
  app.use("*", bodyLimit({ maxSize: 4096 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.post("/", async (c) => {
    const parsed = request.safeParse(await c.req.json().catch(() => null));
    const id = parsed.success ? (parsed.data.id ?? null) : null;
    const fail = (code: number, message: string) =>
      c.json({ jsonrpc: "2.0", id, error: { code, message } });
    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    if (!parsed.success) return fail(-32600, "Invalid request");
    const { method, params } = parsed.data;
    if (id === null) return c.body(null, 202);
    if (method === "initialize") {
      return reply({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "ivrm-ai-workspace", version: "1.0.0" },
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools });
    if (method !== "tools/call") return fail(-32601, "Method not found");

    const input = z
      .object({ name: z.string(), arguments: z.unknown().optional() })
      .safeParse(params);
    if (!input.success) return fail(-32602, "Invalid params");
    const owner = c.get("session").userId;
    const result = (data: unknown, isError = false) =>
      reply({
        content: [{ type: "text", text: JSON.stringify(data) }],
        ...(isError ? { isError: true } : {}),
      });
    if (input.data.name === "daily_budget") {
      if (!z.strictObject({}).safeParse(input.data.arguments ?? {}).success)
        return fail(-32602, "Invalid arguments");
      return result(await gate.dailyBudget(owner, now()));
    }
    if (input.data.name === "conversation_context") {
      const args = z
        .strictObject({ conversationId: z.string().uuid() })
        .safeParse(input.data.arguments);
      if (!args.success) return fail(-32602, "Invalid arguments");
      const usage = await store.latestContextUsage(
        owner,
        args.data.conversationId
      );
      return usage
        ? result(usage)
        : result({ message: "表示できる計測値がありません。" }, true);
    }
    return fail(-32602, "Unknown tool");
  });
  app.get("/", (c) => c.body(null, 405, { Allow: "POST" }));
  return app;
}
