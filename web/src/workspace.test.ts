// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

it("connects rename, title search, original-text copy and theme settings to the workspace", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "/");
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
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  const conversation = {
    id: "c",
    projectId: null,
    title: "original",
    modelId: "m",
    archived: false,
    updatedAt: "2026-11-11",
  };
  const message = {
    id: "message",
    role: "assistant",
    content: "**原文**\n<script>unsafe()</script>",
    modelId: "m",
  };
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    const url = new URL(path, "http://localhost");
    let data: unknown;
    if (url.pathname === "/api/me")
      data = { user: { id: "u", username: "Test" } };
    else if (url.pathname === "/api/models")
      data = { models: [{ id: "m", label: "M" }] };
    else if (url.pathname === "/api/projects") data = { projects: [] };
    else if (url.pathname === "/api/conversations")
      data = { conversations: [conversation] };
    else if (url.pathname === "/api/conversations/c") {
      if (options?.method === "PATCH")
        conversation.title = JSON.parse(String(options.body)).title;
      data = { conversation, messages: [message] };
    } else throw Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  await import("./main.js");
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (el) => el.textContent === name
    )!;
  await vi.waitFor(() => expect(button("original")).toBeDefined());
  button("original").click();
  await vi.waitFor(() =>
    expect(document.querySelector(".message")).not.toBeNull()
  );
  expect(document.querySelector(".message script")).toBeNull();
  button("コピー").click();
  await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(message.content));
  button("タイトルを変更").click();
  const title = document.querySelector<HTMLInputElement>(
    'input[aria-label="会話タイトル"]'
  )!;
  title.value = "新しいタイトル";
  title
    .closest("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector("h1")?.textContent).toBe("新しいタイトル")
  );
  expect(
    fetcher.mock.calls.some(
      ([path, options]) =>
        path === "/api/conversations/c" && options?.method === "PATCH"
    )
  ).toBe(true);
  const search = document.querySelector<HTMLInputElement>(".history-search")!;
  search.value = "missing";
  search.dispatchEvent(new Event("input"));
  expect(document.querySelector<HTMLElement>("li[data-title]")?.hidden).toBe(
    true
  );
  expect(document.querySelector<HTMLElement>(".search-empty")?.hidden).toBe(
    false
  );
  document
    .querySelector<HTMLButtonElement>(
      'button[aria-label="表示設定・ショートカット"]'
    )!
    .click();
  const theme = document.querySelector<HTMLSelectElement>(
    'select[aria-label="カラーテーマ"]'
  )!;
  theme.value = "light";
  theme.dispatchEvent(new Event("change"));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("ivrm-ai-theme")).toBe("light");
});
