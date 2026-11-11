// Loopback-only integration preview. Real routes/stores/CostGate, synthetic model and identity.
// No credentials, DB, Bedrock client, external service or production flag is used.
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { InMemoryChatStore } from "../src/chat/memory-store.js";
import { InMemoryUsageStore } from "../src/cost/memory-store.js";
import { CostGate } from "../src/cost/gate.js";
import { DEFAULT_LIMITS } from "../src/cost/limits.js";
import { ModelCatalog } from "../src/models/catalog.js";
import type { ChatModel, ModelSpec } from "../src/models/types.js";
import { loadWebAssets } from "../src/web.js";

if (process.env["NODE_ENV"] === "production")
  throw Error("Preview must never run in production");
const port = 4321;
const origin = `http://127.0.0.1:${port}`;
const now = () => new Date("2026-11-11T03:00:00Z");
const spec: ModelSpec = {
  id: "synthetic",
  label: "テストモデル（推論なし）",
  bedrockModelId: "not-a-provider",
  region: "local",
  maxOutputTokens: 1000,
  supports: { tools: false, reasoning: false, vision: false },
  pricing: {
    inputPerMTok: 1,
    outputPerMTok: 2,
    checkedAt: "2026-11-11",
    validUntil: "2026-11-11",
  },
};
const catalog = new ModelCatalog([spec]);
const model: ChatModel = {
  generate: async () => {
    throw Error("Only synthetic streaming is available");
  },
  stream: async function* (request) {
    const text = `## 新しい視点から考える\n\n質問「${request.messages.at(-1)?.text ?? ""}」への合成回答です。\n\n- 元の会話は保存されています。\n- このプレビューでは外部AIを呼びません。\n\n\`\`\`ts\nconst next = '小さく試し、確かめる';\n\`\`\``;
    for (const chunk of text.match(/.{1,12}/gs) ?? []) {
      if (request.signal?.aborted)
        throw new DOMException("aborted", "AbortError");
      await new Promise((resolve) => setTimeout(resolve, 35));
      yield { type: "text", text: chunk };
    }
    yield {
      type: "done",
      usage: { inputTokens: 30, outputTokens: 50 },
      stopReason: "end_turn",
    };
  },
};
let seedTime = now().getTime() - 364 * 86_400_000;
const store = new InMemoryChatStore(() => seedTime);
const project = await store.createProject("preview", {
  name: "プロダクト開発",
  instructions: "要点を簡潔に説明する。",
});
const past = (await store.createConversation("preview", {
  projectId: project.id,
  title: "利用実績のプレビュー用会話",
  modelId: spec.id,
}))!;
for (let day = 0; day < 365; day++) {
  const sample = (day * 37 + (day % 13) * 11) % 97;
  if (sample > Math.min(80, 14 + day / 5) && day < 361) continue;
  seedTime = now().getTime() - (364 - day) * 86_400_000;
  await store.appendMessage("preview", past.id, {
    role: "assistant",
    content: "合成データによる利用統計の例。",
    modelId: spec.id,
    inputTokens: sample * 190 + 180,
    outputTokens: sample * 30 + 50,
    costMicroUsd: 1,
  });
}
seedTime = now().getTime();
await store.setConversationArchived("preview", past.id, true);
const source = (await store.createConversation("preview", {
  projectId: project.id,
  title: "日常で使いたいAIの設計",
  modelId: spec.id,
}))!;
for (const message of [
  { role: "user" as const, content: "プロダクトの設計を始めたい。" },
  {
    role: "assistant" as const,
    content:
      "## 体験の核を決める\n\n利用者が何を達成したいかを一文で定義しましょう。",
    modelId: spec.id,
  },
  {
    role: "user" as const,
    content: "日常的に使うための、最初の機能を考えて。",
  },
  {
    role: "assistant" as const,
    content:
      "## 小さく始めるための3つの問い\n\n| 観点 | 確かめること |\n| --- | --- |\n| 価値 | どの手間を減らすか |\n| 頻度 | 毎日使う操作は何か |\n\n\`\`\`ts\nconst goal = '毎日使いたい体験';\n\`\`\`",
    modelId: spec.id,
  },
])
  await store.appendMessage("preview", source.id, message);
const policy = { authorize: async () => ({ allowed: true }) };
const gate = new CostGate({
  catalog,
  model,
  store: new InMemoryUsageStore(),
  limits: DEFAULT_LIMITS,
  killSwitch: () => false,
  now,
});
const app = createApp({
  auth: {
    allowedOrigin: origin,
    policy,
    verifier: {
      verify: async () => ({
        userId: "preview",
        discordUserId: "preview",
        username: "プレビュー",
        roles: ["member"],
        isAdmin: false,
        cookie: "synthetic-only",
      }),
    },
  },
  chat: {
    store,
    catalog,
    gate,
    policy,
    audit: { record: async () => undefined },
    maxOutputTokens: 500,
    now,
  },
  web: await loadWebAssets("dist/public", `${origin}/`),
});
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () =>
  console.log(`Synthetic integration preview: ${origin}/c/${source.id}`)
);
