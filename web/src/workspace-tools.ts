import { h } from "./dom.js";

const version = "2025-11-25";
async function rpc(method: string, params?: unknown, notification = false) {
  const response = await fetch("/api/mcp", {
    method: "POST",
    credentials: "same-origin",
    signal: AbortSignal.timeout(8000),
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(!notification ? { id: 1 } : {}),
      method,
      params,
    }),
  });
  if (!response.ok) throw new Error("MCP unavailable");
  if (notification) return;
  const body = await response.json();
  if (body.error || body.id !== 1) throw new Error("MCP request failed");
  return body.result;
}

export function openWorkspaceTools(conversationId?: string) {
  const dialog = h("dialog", {
    class: "dialog integration-dialog",
    "aria-label": "ワークスペースツール",
  });
  const status = h("p", { role: "status" }, "ツールを読み込んでいます…");
  const choices = h("div", { class: "integration-form" });
  const result = h("div");
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.append(
    h("h2", {}, "ワークスペースツール"),
    h(
      "p",
      { class: "muted" },
      "本人のデータを読み取る組み込み MCP。取得結果はこの画面に表示されます。"
    ),
    choices,
    status,
    result,
    h("button", { type: "button", onclick: () => dialog.close() }, "閉じる")
  );
  document.body.append(dialog);
  dialog.showModal();
  void load();

  async function load() {
    try {
      const hello = await rpc("initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "ivrm-ai-web", version: "1.0.0" },
      });
      if (hello.protocolVersion !== version)
        throw new Error("Unsupported MCP version");
      await rpc("notifications/initialized", undefined, true);
      const catalog = await rpc("tools/list");
      for (const tool of catalog.tools as {
        name: string;
        description: string;
      }[]) {
        if (
          tool.name !== "daily_budget" &&
          (tool.name !== "conversation_context" || !conversationId)
        )
          continue;
        choices.append(
          h(
            "button",
            { type: "button", onclick: () => void run(tool.name) },
            tool.description
          )
        );
      }
      status.textContent = "組み込み MCP に接続済み";
    } catch {
      status.textContent =
        "ツールを読み込めませんでした。閉じて開き直してください。";
    }
  }

  async function run(name: string) {
    const buttons = [...choices.querySelectorAll("button")];
    for (const button of buttons) button.disabled = true;
    status.textContent = "取得中…";
    result.replaceChildren();
    try {
      const reply = await rpc("tools/call", {
        name,
        arguments: name === "daily_budget" ? {} : { conversationId },
      });
      const data = JSON.parse(reply.content[0].text);
      if (reply.isError) {
        status.textContent = "表示できる計測値がありません。";
        return;
      }
      const num = new Intl.NumberFormat("ja-JP");
      const usd = new Intl.NumberFormat("ja-JP", {
        style: "currency",
        currency: "USD",
        currencyDisplay: "code",
        maximumFractionDigits: 6,
      });
      result.append(
        name === "daily_budget"
          ? h(
              "p",
              {},
              "残額 " +
                usd.format(data.remainingMicroUsd / 1_000_000) +
                " / " +
                usd.format(data.limitMicroUsd / 1_000_000) +
                " · 日本時間 0:00 リセット"
            )
          : h(
              "p",
              {},
              "入力 " +
                num.format(data.inputTokens) +
                " · 出力 " +
                num.format(data.outputTokens) +
                " トークン"
            )
      );
      status.textContent = "取得しました。";
    } catch {
      status.textContent = "取得できませんでした。もう一度お試しください。";
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  }
}
