// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.replaceChildren();
});

async function mount(refuseSend = false) {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "/c/source");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
    },
  });
  const source = {
    id: "source",
    title: "元の会話",
    projectId: null,
    modelId: "m",
    archived: false,
    updatedAt: "2026-11-11",
  };
  const branch = { ...source, id: "branch", title: "元の会話 / 分岐" };
  const original = [
    { id: "u0", role: "user", content: "前の質問", modelId: null },
    { id: "a0", role: "assistant", content: "前の回答", modelId: "m" },
    { id: "u1", role: "user", content: "元の質問", modelId: null },
    { id: "a1", role: "assistant", content: "置き換えたい回答", modelId: "m" },
  ];
  let copied = original.slice(0, 2);
  const sends: string[] = [];
  const forks: unknown[] = [];
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    const url = new URL(path, "http://localhost");
    let data: unknown;
    if (url.pathname === "/api/me")
      data = { user: { id: "u", username: "Test" } };
    else if (url.pathname === "/api/models")
      data = { models: [{ id: "m", label: "M" }] };
    else if (url.pathname === "/api/projects") data = { projects: [] };
    else if (url.pathname === "/api/conversations")
      data = { conversations: [source, branch] };
    else if (url.pathname === "/api/conversations/source")
      data = { conversation: source, messages: original };
    else if (url.pathname === "/api/conversations/source/fork") {
      forks.push(JSON.parse(String(options?.body)));
      data = { conversation: branch, draft: "元の質問" };
    } else if (url.pathname === "/api/conversations/branch")
      data = { conversation: branch, messages: copied };
    else if (url.pathname === "/api/conversations/branch/messages") {
      const text = JSON.parse(String(options?.body)).text;
      sends.push(text);
      if (refuseSend)
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
        });
      copied = [
        ...copied,
        { id: "new-u", role: "user", content: text, modelId: null },
        { id: "new-a", role: "assistant", content: "新しい回答", modelId: "m" },
      ];
      return new Response(
        'event: delta\ndata: {"text":"新しい回答"}\n\nevent: done\ndata: {"costMicroUsd":10}\n\n',
        { headers: { "content-type": "text/event-stream" } }
      );
    } else throw Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  await import("./main.js");
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".message").length).toBe(4)
  );
  return { sends, forks, original };
}

it("edits into a new branch, sends once, and keeps later source answers out", async () => {
  const { sends, forks, original } = await mount();
  document
    .querySelectorAll<HTMLButtonElement>('[aria-label="質問を編集して分岐"]')
    .item(1)
    .click();
  const textarea = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="編集する質問"]'
  )!;
  expect(textarea.value).toBe("元の質問");
  textarea.value = "編集した質問";
  textarea
    .closest("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector(".messages")?.textContent).toContain(
      "新しい回答"
    )
  );
  expect(forks).toEqual([{ messageId: "u1", modelId: "m" }]);
  expect(sends).toEqual(["編集した質問"]);
  expect(document.querySelector(".messages")?.textContent).not.toContain(
    "置き換えたい回答"
  );
  expect(document.querySelector(".branch-notice")?.textContent).toContain(
    "元の会話を残して"
  );
  expect(original[2]!.content).toBe("元の質問");
});

it("regenerates the original question and preserves the draft if the gate refuses", async () => {
  const { sends, forks } = await mount(true);
  document
    .querySelectorAll<HTMLButtonElement>('[aria-label="回答を再生成"]')
    .item(1)
    .click();
  await vi.waitFor(() =>
    expect(
      document.querySelector<HTMLTextAreaElement>("#composer-input")?.value
    ).toBe("元の質問")
  );
  expect(forks).toEqual([{ messageId: "u1", modelId: "m" }]);
  expect(sends).toEqual(["元の質問"]);
  expect(document.querySelector("h1")?.textContent).toBe("元の会話 / 分岐");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "停止"
  );
  expect(document.querySelector(".messages")?.textContent).not.toContain(
    "置き換えたい回答"
  );
});
