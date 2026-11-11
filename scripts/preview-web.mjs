// Local visual QA only. Synthetic data; never contacts auth, DB or Bedrock.
// Run after pnpm build. Bound exclusively to loopback.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const staticRoot = process.env.QA_STATIC_ROOT ?? "dist/public";
const port = Number(process.env.QA_PORT ?? 4318);
const conversation = {
  id: "demo",
  title: "新しいプロダクトの設計",
  projectId: "project",
  modelId: "demo-model",
  archived: false,
  updatedAt: "2026-11-11T00:00:00Z",
};
const project = {
  id: "project",
  name: "プロダクト開発",
  instructions: "簡潔に回答してください。",
  archived: false,
};
const messages = [
  {
    id: "user",
    role: "user",
    content:
      "アイデアを日常で使えるプロダクトへ育てたい。\n最初に何を整理すればよい？",
    modelId: null,
  },
  {
    id: "answer",
    role: "assistant",
    content:
      "## 小さな体験から、確かな価値へ\n\nまずは **誰の、どんな時間をよくするか** を一文にしましょう。\n\n| 観点 | 最初の問い |\n| --- | --- |\n| 利用者 | 誰が使いますか？ |\n| 価値 | 何が楽になりますか？ |\n\n```ts\nconst goal = '毎日使いたい体験';\n```\n\nその後で、最も頻繁に使う一つの操作を磨きます。",
    modelId: "demo-model",
  },
];

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    res.setHeader("content-type", "application/json");
    const archived = url.searchParams.get("archived") === "true";
    if (url.pathname === "/api/me")
      return res.end(
        JSON.stringify({ user: { id: "demo", username: "Preview" } })
      );
    if (url.pathname === "/api/models")
      return res.end(
        JSON.stringify({
          models: [{ id: "demo-model", label: "プレビューモデル" }],
        })
      );
    if (url.pathname === "/api/projects")
      return res.end(JSON.stringify({ projects: archived ? [] : [project] }));
    if (url.pathname === "/api/conversations")
      return res.end(
        JSON.stringify({
          conversations:
            conversation.archived === archived ? [conversation] : [],
        })
      );
    if (url.pathname === "/api/conversations/demo" && req.method === "GET")
      return res.end(JSON.stringify({ conversation, messages }));
    if (url.pathname === "/api/conversations/demo" && req.method === "PATCH") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const input = JSON.parse(body);
        if (typeof input.title !== "string" || !input.title.trim())
          throw Error("invalid");
        conversation.title = input.title.trim();
      } catch {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: "bad_request" }));
      }
      return res.end(JSON.stringify({ conversation }));
    }
    if (
      /^\/api\/conversations\/demo\/(unarchive|archive)$/.test(url.pathname)
    ) {
      conversation.archived = url.pathname.endsWith("/archive");
      return res.end(JSON.stringify({ conversation }));
    }
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "preview_read_only" }));
  }
  const assets = {
    "/assets/app.js": [`${staticRoot}/assets/app.js`, "text/javascript"],
    "/assets/styles.css": [`${staticRoot}/assets/styles.css`, "text/css"],
  };
  const [file, type] = assets[url.pathname] ?? [
    `${staticRoot}/index.html`,
    "text/html",
  ];
  try {
    res.setHeader("content-type", type);
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Synthetic preview: http://127.0.0.1:${port} (no AI calls)`)
);
