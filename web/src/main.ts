import { openWorkspaceTools } from "./workspace-tools.js";
import { openIntegrations, registeredSkills } from "./integrations.js";
import { openSkills, skillHistory } from "./skills.js";
import {
  api,
  ApiError,
  describeError,
  describeStreamError,
  sendMessage,
  type Conversation,
  type Me,
  type Message,
  type ContextUsage,
  type Model,
  type Project,
  type Usage,
} from "./api.js";
import { profileHome } from "./profile-home.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { matchingTitle, serializeConversation } from "./conversation-tools.js";
import {
  canSubmitComposer,
  composerRowsForContent,
  shouldSubmitComposer,
} from "./composer.js";
import { createRenderer } from "./markdown.js";

try {
  const theme = localStorage.getItem("ivrm-ai-theme");
  if (theme === "light" || theme === "dark")
    document.documentElement.dataset.theme = theme;
} catch {
  /* Browser storage is optional. */
}
const render = createRenderer(window);
const root = document.getElementById("app")!;
const loginUrl =
  document.querySelector<HTMLMetaElement>('meta[name="ivrm-login-url"]')
    ?.content ?? "https://api.ivrm.jp/auth/discord/login";

type State = {
  home: boolean;
  usage: Usage | null;
  usageFailed: boolean;
  recent: Conversation[];
  me: Me | null;
  models: Model[];
  projects: Project[];
  conversations: Conversation[];
  showArchived: boolean;
  projectFilter: string;
  current: {
    conversation: Conversation;
    messages: Message[];
    contextUsage?: ContextUsage | null;
  } | null;
  modelId: string;
  sending: AbortController | null;
  streaming: string | null;
  notice: string | null;
  /** Composer text, kept across redraws (and put back when a send is refused). */
  draft: string;
  sidebarOpen: boolean;
  titleQuery: string;
  sidebarCollapsed: boolean;
  forking: boolean;
  branchSource: { id: string; title: string } | null;
};

const state: State = {
  home: location.pathname === "/",
  usage: null,
  usageFailed: false,
  recent: [],
  me: null,
  models: [],
  projects: [],
  conversations: [],
  showArchived: false,
  projectFilter: "",
  current: null,
  modelId: "",
  sending: null,
  streaming: null,
  draft: "",
  sidebarOpen: false,
  titleQuery: "",
  sidebarCollapsed: false,
  forking: false,
  branchSource: null,
  notice: null,
};

function conversationIdFromPath(): string | null {
  const match = /^\/c\/([^/]+)$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function navigate(conversationId: string | null) {
  const path = conversationId
    ? `/c/${encodeURIComponent(conversationId)}`
    : state.home
      ? "/"
      : "/new";
  if (location.pathname !== path) history.pushState(null, "", path);
}

function showError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    state.me = null;
  }
  state.notice = describeError(error);
  draw();
}

let homeLoadSeq = 0;
async function loadHome() {
  const seq = ++homeLoadSeq;
  state.usageFailed = false;
  const [usage, recent] = await Promise.allSettled([
    api.usage(),
    api.conversations(false),
  ]);
  if (seq !== homeLoadSeq || !state.home || !state.me) return;
  if (
    usage.status === "rejected" &&
    usage.reason instanceof ApiError &&
    usage.reason.status === 401
  ) {
    showError(usage.reason);
    return;
  }
  state.usage = usage.status === "fulfilled" ? usage.value : null;
  state.usageFailed = usage.status === "rejected";
  if (recent.status === "fulfilled") state.recent = recent.value;
  draw();
}
async function openHome() {
  state.home = true;
  state.branchSource = null;
  state.sending?.abort();
  if (state.sidebarOpen) setSidebarOpen(false);
  await openConversation(null);
  await loadHome();
}

async function loadLists() {
  const [projects, conversations] = await Promise.all([
    api.projects(false),
    api.conversations(state.showArchived, state.projectFilter || undefined),
  ]);
  state.projects = projects;
  state.conversations = conversations;
}

/** Bumped by each openConversation, so a slower, older load is dropped. */
let openSeq = 0;

async function openConversation(id: string | null) {
  const seq = ++openSeq;
  state.notice = null;
  if (!id) {
    state.current = null;
    navigate(null);
    draw();
    return;
  }
  try {
    const current = await api.conversation(id);
    if (seq !== openSeq) return;
    state.current = current;
    state.modelId = current.conversation.modelId;
    navigate(id);
  } catch (error) {
    if (seq !== openSeq) return;
    state.current = null;
    navigate(null);
    showError(error);
    return;
  }
  draw();
}

/**
 * Navigation started by the person. A reply still streaming belongs to the
 * conversation it was sent in, so it is stopped first (not saved, as with the
 * stop button) instead of being drawn under another conversation.
 */
async function goTo(id: string | null) {
  state.home = false;
  state.branchSource = null;
  state.sending?.abort();
  if (id !== (state.current?.conversation.id ?? null)) state.draft = "";
  const navigationSeq = openSeq + 1;
  const restoreFocus =
    state.sidebarOpen && window.matchMedia("(max-width: 900px)").matches;
  if (restoreFocus) setSidebarOpen(false);
  else state.sidebarOpen = false;
  await openConversation(id);
  if (
    restoreFocus &&
    openSeq === navigationSeq &&
    !state.sidebarOpen &&
    document.activeElement === document.body
  ) {
    root.querySelector<HTMLElement>(".menu-toggle")?.focus();
  }
}

/** Create a conversation if needed, then send and stream one user message. */
async function send(text: string) {
  if (state.sending || state.forking || !text.trim()) return;
  let viewSeq = openSeq;
  state.notice = null;
  const controller = new AbortController();
  state.sending = controller;
  try {
    draw();
    let conversation = state.current?.conversation;
    if (!conversation) {
      conversation = await api.createConversation({
        modelId: state.modelId,
        projectId: state.projectFilter || null,
      });
      // Creation cannot be cancelled: if the person moved on meanwhile, the
      // empty conversation stays in the list but is not opened.
      if (controller.signal.aborted || viewSeq !== openSeq)
        throw new DOMException("aborted", "AbortError");
      state.current = { conversation, messages: [] };
      navigate(conversation.id);
    }
    state.current!.messages.push({
      id: `pending-${Date.now()}`,
      role: "user",
      content: text,
      modelId: null,
    });
    state.streaming = "";
    draw();

    let failed: string | null = null;
    for await (const event of sendMessage(
      conversation.id,
      { text, modelId: state.modelId },
      controller.signal
    )) {
      if (viewSeq !== openSeq) return;
      if (event.type === "delta") {
        state.streaming += event.text;
        drawStreaming();
      } else if (event.type === "error") {
        failed = describeStreamError(event.code);
      }
    }
    if (viewSeq !== openSeq || controller.signal.aborted) return;
    viewSeq++;
    await openConversation(conversation.id);
    if (viewSeq !== openSeq) return;
    await loadLists();
    // After the reload, which clears the notice: say why the reply is gone.
    if (failed && viewSeq === openSeq) state.notice = failed;
  } catch (error) {
    if (viewSeq !== openSeq) return;
    if (controller.signal.aborted) {
      state.notice = "回答を止めました。止めた回答は保存されません。";
    } else {
      // A refused send stored nothing: drop the optimistic user message and
      // give the text back, so it can be shortened or sent again.
      state.current?.messages.pop();
      state.draft = text;
      showError(error);
    }
  } finally {
    state.sending = null;
    state.streaming = null;
    draw();
  }
}

async function toggleArchive(conversation: Conversation) {
  try {
    await api.setConversationArchived(conversation.id, !conversation.archived);
    await loadLists();
    if (state.current?.conversation.id === conversation.id) {
      await openConversation(conversation.archived ? conversation.id : null);
    }
  } catch (error) {
    showError(error);
    return;
  }
  draw();
}

function openSettings() {
  const dialog = h("dialog", { class: "dialog", "aria-label": "表示設定" });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener("cancel", () => dialog.remove());
  const select = h(
    "select",
    {
      "aria-label": "カラーテーマ",
      onchange: ((event: Event) => {
        const theme = (event.target as HTMLSelectElement).value;
        if (theme === "system") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
        try {
          localStorage.setItem("ivrm-ai-theme", theme);
        } catch {
          /* Current view still works. */
        }
      }) as EventListener,
    },
    ...[
      ["system", "システムに合わせる"],
      ["light", "ライト"],
      ["dark", "ダーク"],
    ].map(([value, label]) =>
      h(
        "option",
        {
          value,
          selected:
            value === (document.documentElement.dataset.theme ?? "system"),
        },
        label
      )
    )
  );
  dialog.append(
    h("h2", {}, "表示設定"),
    h(
      "button",
      {
        type: "button",
        onclick: () => {
          const owner = state.me?.id;
          if (owner) {
            close();
            openIntegrations(owner);
          }
        },
      },
      "MCP・プラグイン"
    ),
    h("label", {}, "カラーテーマ", select),
    h(
      "p",
      { class: "muted" },
      "Ctrl / ⌘ + K：会話タイトル検索 · Enter：送信 · Shift + Enter：改行"
    ),
    h("div", { class: "row end" }, h("button", { onclick: close }, "閉じる"))
  );
  document.body.append(dialog);
  dialog.showModal();
}

/** Fork before the selected question; the original history is never edited or deleted. */
async function forkMessage(messageId: string, replacement?: string) {
  if (!state.current || state.sending || state.forking) return;
  const source = state.current.conversation;
  let seq = openSeq;
  state.forking = true;
  state.notice = null;
  draw();
  try {
    const result = await api.forkConversation(
      source.id,
      messageId,
      state.modelId
    );
    if (seq !== openSeq || state.current?.conversation.id !== source.id) return;
    state.draft = replacement ?? result.draft;
    seq++;
    await openConversation(result.conversation.id);
    if (
      seq !== openSeq ||
      state.current?.conversation.id !== result.conversation.id
    )
      return;
    state.branchSource = { id: source.id, title: source.title || "元の会話" };
    await loadLists();
    if (seq !== openSeq) return;
    state.forking = false;
    const text = state.draft;
    state.draft = "";
    await send(text);
  } catch (error) {
    if (seq !== openSeq) return;
    state.notice =
      describeError(error) +
      (!(error instanceof ApiError)
        ? " 分岐が作成された可能性があります。再操作の前に会話一覧を確認してください。"
        : "");
  } finally {
    state.forking = false;
    draw();
  }
}

/** Editing is explicit: show the original question and send into a new branch. */
function editMessage(message: Message) {
  if (state.sending || state.forking) return;
  const dialog = h("dialog", {
    class: "dialog edit-message-dialog",
    "aria-label": "質問を編集して分岐",
  });
  const textarea = h("textarea", {
    maxlength: "8000",
    required: true,
    rows: "7",
    "aria-label": "編集する質問",
  });
  textarea.value = message.content;
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener("cancel", () => dialog.remove());
  const error = h("p", { role: "alert", class: "muted" });
  dialog.append(
    h(
      "form",
      {
        onsubmit: ((event: Event) => {
          event.preventDefault();
          if (!textarea.value.trim()) {
            error.textContent = "質問を入力してください。";
            return;
          }
          const text = textarea.value.trim();
          close();
          void forkMessage(message.id, text);
        }) as EventListener,
      },
      h("h2", {}, "質問を編集して分岐"),
      h(
        "p",
        { class: "muted" },
        "この質問より前の履歴を引き継いで、新しい会話で回答します。元の会話と回答は残ります。"
      ),
      textarea,
      error,
      h(
        "div",
        { class: "row end" },
        h(
          "button",
          { type: "button", class: "ghost", onclick: close },
          "キャンセル"
        ),
        h("button", { type: "submit" }, "分岐して送信")
      )
    )
  );
  document.body.append(dialog);
  dialog.showModal();
  textarea.focus();
}

function renameConversation(conversation: Conversation) {
  const input = h("input", {
    value: conversation.title,
    maxlength: "300",
    required: true,
    "aria-label": "会話タイトル",
  });
  const error = h("p", { role: "alert", class: "muted" });
  const dialog = h("dialog", {
    class: "dialog",
    "aria-label": "タイトルを変更",
  });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener("cancel", () => dialog.remove());
  const save = h("button", { type: "submit" }, "保存");
  dialog.append(
    h(
      "form",
      {
        onsubmit: (async (event: Event) => {
          event.preventDefault();
          if (!input.value.trim()) {
            error.textContent = "タイトルを入力してください。";
            return;
          }
          save.disabled = true;
          try {
            const updated = await api.renameConversation(
              conversation.id,
              input.value.trim()
            );
            if (state.current?.conversation.id === conversation.id)
              state.current.conversation = updated;
            await loadLists();
            close();
            draw();
          } catch (e) {
            error.textContent = describeError(e);
            save.disabled = false;
          }
        }) as EventListener,
      },
      h("h2", {}, "タイトルを変更"),
      h("label", {}, "会話タイトル", input),
      error,
      h(
        "div",
        { class: "row end" },
        h(
          "button",
          { type: "button", class: "ghost", onclick: close },
          "キャンセル"
        ),
        save
      )
    )
  );
  document.body.append(dialog);
  dialog.showModal();
  input.select();
}

function exportConversation(format: "md" | "json") {
  if (!state.current || state.sending) return;
  const { conversation, messages } = state.current;
  const blob = new Blob(
    [serializeConversation(conversation, messages, format)],
    {
      type:
        format === "json"
          ? "application/json;charset=utf-8"
          : "text/markdown;charset=utf-8",
    }
  );
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: `conversation.${format}` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function conversationMenu(conversation: Conversation) {
  return h(
    "details",
    { class: "conversation-menu" },
    h("summary", { "aria-label": "会話の操作" }, "会話の操作"),
    h(
      "div",
      { class: "menu-panel" },
      h(
        "button",
        {
          class: "ghost",
          disabled: !!state.sending,
          onclick: () => renameConversation(conversation),
        },
        "タイトルを変更"
      ),
      h(
        "p",
        { class: "menu-caption" },
        "表示中のメッセージを書き出す（最大200件）"
      ),
      h(
        "button",
        {
          class: "ghost",
          disabled: !!state.sending,
          onclick: () => exportConversation("md"),
        },
        "Markdown をダウンロード"
      ),
      h(
        "button",
        {
          class: "ghost",
          disabled: !!state.sending,
          onclick: () => exportConversation("json"),
        },
        "JSON をダウンロード"
      ),
      h(
        "button",
        {
          class: "ghost",
          disabled: !!state.sending,
          onclick: () => void toggleArchive(conversation),
        },
        conversation.archived ? "アーカイブから復元" : "アーカイブに移動"
      )
    )
  );
}

// ---- project dialog -------------------------------------------------------

function editProject(project: Project | null) {
  const name = h("input", {
    name: "name",
    maxlength: "200",
    required: true,
    value: project?.name ?? "",
  });
  const instructions = h("textarea", {
    name: "instructions",
    maxlength: "8000",
    rows: "8",
    placeholder: "このプロジェクトの会話すべてに付ける指示(任意)",
  });
  instructions.value = project?.instructions ?? "";
  const dialog = h("dialog", { class: "dialog" });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const form = h(
    "form",
    {
      onsubmit: (async (event: Event) => {
        event.preventDefault();
        const input = {
          name: name.value.trim(),
          instructions: instructions.value,
        };
        try {
          if (project) await api.updateProject(project.id, input);
          else await api.createProject(input);
          await loadLists();
          close();
          draw();
        } catch (error) {
          close();
          showError(error);
        }
      }) as EventListener,
    },
    h("h2", {}, project ? "プロジェクトを編集" : "新しいプロジェクト"),
    h("label", {}, "名前", name),
    h("label", {}, "共通の指示", instructions),
    h(
      "div",
      { class: "row end" },
      project
        ? h(
            "button",
            {
              type: "button",
              class: "ghost",
              onclick: (async () => {
                try {
                  await api.setProjectArchived(project.id, true);
                  if (state.projectFilter === project.id)
                    state.projectFilter = "";
                  await loadLists();
                  close();
                  draw();
                } catch (error) {
                  close();
                  showError(error);
                }
              }) as EventListener,
            },
            "アーカイブ"
          )
        : null,
      h(
        "button",
        { type: "button", class: "ghost", onclick: close },
        "キャンセル"
      ),
      h("button", { type: "submit" }, "保存")
    )
  );
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}

async function openArchivedProjects() {
  let archived: Project[];
  try {
    archived = await api.projects(true);
  } catch (error) {
    showError(error);
    return;
  }
  const dialog = h("dialog", { class: "dialog" });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(
    h("h2", {}, "アーカイブしたプロジェクト"),
    archived.length === 0
      ? h("p", { class: "muted" }, "ありません。")
      : h(
          "ul",
          { class: "plain" },
          ...archived.map((p) =>
            h(
              "li",
              { class: "row" },
              h("span", { class: "grow" }, p.name),
              h(
                "button",
                {
                  class: "ghost",
                  onclick: (async () => {
                    try {
                      await api.setProjectArchived(p.id, false);
                      await loadLists();
                      close();
                      draw();
                    } catch (error) {
                      close();
                      showError(error);
                    }
                  }) as EventListener,
                },
                "復元"
              )
            )
          )
        ),
    h("div", { class: "row end" }, h("button", { onclick: close }, "閉じる"))
  );
  document.body.append(dialog);
  dialog.showModal();
}

// ---- drawing --------------------------------------------------------------

const copyTimers = new WeakMap<
  HTMLButtonElement,
  ReturnType<typeof setTimeout>
>();

/** Copy uses the original text, never HTML from the Markdown renderer. */
function copyButton(text: string, label: string, compact = false) {
  const button = h(
    "button",
    {
      type: "button",
      class: compact ? "code-copy" : "message-action",
      "aria-label": label,
      title: label,
    },
    icon("copy"),
    h("span", {}, "コピー")
  );
  button.addEventListener("click", async () => {
    clearTimeout(copyTimers.get(button));
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(text);
      button.replaceChildren(icon("check"), h("span", {}, "コピーしました"));
    } catch {
      button.replaceChildren(h("span", {}, "コピーできませんでした"));
    } finally {
      button.disabled = false;
      copyTimers.set(
        button,
        setTimeout(() => {
          button.replaceChildren(icon("copy"), h("span", {}, "コピー"));
        }, 2000)
      );
    }
  });
  return button;
}

function messageView(message: Message) {
  const body = h("div", { class: "body" });
  if (message.role === "assistant") {
    body.append(render(message.content));
    for (const pre of body.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      const language =
        code?.className.match(/language-([\w+-]+)/)?.[1] ?? "コード";
      const block = h(
        "div",
        { class: "code-block" },
        h(
          "div",
          { class: "code-heading" },
          h("span", {}, language),
          copyButton(
            code?.textContent ?? pre.textContent ?? "",
            "コードをコピー",
            true
          )
        )
      );
      pre.replaceWith(block);
      block.append(pre);
    }
  } else body.textContent = message.content;
  const index =
    state.current?.messages.findIndex((m) => m.id === message.id) ?? -1;
  const previous = state.current?.messages
    .slice(0, index + 1)
    .reverse()
    .find((m) => m.role === "user");
  const canFork = !state.current?.conversation.archived && index >= 0;
  const forkAction =
    message.role === "user"
      ? h(
          "button",
          {
            class: "message-action",
            title: "元の会話を残して質問を編集",
            "aria-label": "質問を編集して分岐",
            disabled: !!state.sending || state.forking,
            onclick: () => editMessage(message),
          },
          icon("compose"),
          "編集して分岐"
        )
      : previous
        ? h(
            "button",
            {
              class: "message-action",
              title: "元の会話を残して同じ質問から生成",
              "aria-label": "回答を再生成",
              disabled: !!state.sending || state.forking,
              onclick: () => void forkMessage(previous.id),
            },
            icon("refresh"),
            "もう一度生成"
          )
        : null;
  const model =
    state.models.find((m) => m.id === message.modelId)?.label ?? "ivRooom AI";
  return h(
    "article",
    {
      class: `message ${message.role}`,
      id: "message-" + message.id,
      tabindex: "-1",
    },
    h(
      "div",
      { class: "who" },
      message.role === "assistant"
        ? h(
            "span",
            { class: "assistant-symbol", "aria-hidden": "true" },
            icon("spark")
          )
        : null,
      message.role === "user" ? "あなた" : model
    ),
    body,
    h(
      "div",
      { class: "message-actions" },
      copyButton(
        message.content,
        message.role === "user" ? "自分のメッセージをコピー" : "回答をコピー"
      ),
      canFork ? forkAction : null
    )
  );
}

/** Update streamed text in place and keep the conversation pinned to the latest output. */
function drawStreaming() {
  const el = document.getElementById("streaming");
  if (!el || state.streaming === null) return;
  const messages = el.closest<HTMLElement>(".messages");
  const atBottom =
    messages &&
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160;
  el.textContent = state.streaming || "…";
  if (messages && atBottom) messages.scrollTop = messages.scrollHeight;
}

/** Render the project controls, history filters, and existing conversation list. */
async function selectProject(id: string) {
  const previous = state.projectFilter;
  state.projectFilter = id;
  try {
    await loadLists();
    await goTo(null);
  } catch (e) {
    state.projectFilter = previous;
    showError(e);
  }
}

/** Brand signature lives in the navigation, leaving the reading surface quiet. */
function brand() {
  return h(
    "div",
    { class: "brand-lockup" },
    h("span", { class: "brand-symbol", "aria-hidden": "true" }, icon("spark")),
    h("strong", {}, "ivRooom"),
    h("span", { class: "brand-ai" }, "AI")
  );
}

/** Toggle the drawer on mobile or collapse the navigation on desktop. */
function toggleNavigation() {
  if (window.matchMedia("(max-width: 900px)").matches)
    setSidebarOpen(!state.sidebarOpen);
  else {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    syncSidebarMode();
    root.querySelector<HTMLElement>(".menu-toggle")?.focus();
  }
}

/** Archive is navigation, not a form preference. Failed loads preserve the current list. */
async function showArchive(archived: boolean) {
  const previous = state.showArchived;
  state.showArchived = archived;
  try {
    await loadLists();
    draw();
  } catch (error) {
    state.showArchived = previous;
    showError(error);
  }
}

function sidebar() {
  const search = h("input", {
    type: "search",
    class: "history-search",
    placeholder: "会話タイトルを検索",
    "aria-label": "会話タイトルを検索",
    value: state.titleQuery,
  });
  search.addEventListener("input", () => {
    state.titleQuery = search.value;
    root
      .querySelectorAll<HTMLElement>(".conversations li[data-title]")
      .forEach((item) => {
        item.hidden = !matchingTitle(
          item.dataset.title ?? "",
          state.titleQuery
        );
      });
    const empty = root.querySelector<HTMLElement>(".search-empty");
    if (empty)
      empty.hidden = state.conversations.some((c) =>
        matchingTitle(c.title, state.titleQuery)
      );
  });
  return h(
    "nav",
    { class: "sidebar", id: "sidebar", "aria-label": "メインナビゲーション" },
    h(
      "div",
      { class: "sidebar-brand" },
      brand(),
      h(
        "button",
        {
          class: "icon-button sidebar-close",
          "aria-label": "Sidebarを閉じる",
          title: "Sidebarを閉じる",
          onclick: toggleNavigation,
        },
        icon("panel")
      )
    ),
    h(
      "div",
      { class: "navigation-primary" },
      h(
        "button",
        {
          class: state.home ? "item home-link active" : "item home-link",
          type: "button",
          ...(state.home ? { "aria-current": "page" } : {}),
          onclick: () => void openHome(),
        },
        icon("layers"),
        "ホーム"
      ),

      h(
        "button",
        {
          class: "new-chat",
          type: "button",
          onclick: () => {
            const previous = state.showArchived;
            state.draft = "";
            state.showArchived = false;
            void loadLists()
              .then(() => goTo(null))
              .catch((error: unknown) => {
                state.showArchived = previous;
                showError(error);
              });
          },
        },
        icon("compose"),
        "新しいチャット"
      ),
      h(
        "div",
        { class: "search-field" },
        icon("search"),
        search,
        h("kbd", { "aria-hidden": "true" }, "⌘ K")
      )
    ),
    h(
      "div",
      { class: "sidebar-scroll" },
      h(
        "section",
        { class: "project-section", "aria-label": "プロジェクト" },
        h(
          "div",
          { class: "section-heading" },
          h("span", {}, "プロジェクト"),
          h(
            "button",
            {
              class: "icon-button",
              title: "プロジェクトを作成",
              "aria-label": "プロジェクトを作成",
              onclick: () => editProject(null),
            },
            icon("plus")
          )
        ),
        h(
          "button",
          {
            class: !state.projectFilter
              ? "item project-link active"
              : "item project-link",
            onclick: () => void selectProject(""),
          },
          icon("layers"),
          h("span", {}, "すべての会話")
        ),
        ...state.projects.map((p) =>
          h(
            "div",
            { class: "project-nav-row" },
            h(
              "button",
              {
                class:
                  p.id === state.projectFilter
                    ? "item project-link active"
                    : "item project-link",
                onclick: () => void selectProject(p.id),
              },
              icon("folder"),
              h("span", {}, p.name)
            ),
            h(
              "button",
              {
                class: "icon-button project-edit",
                title: p.name + "を編集",
                "aria-label": p.name + "を編集",
                onclick: () => editProject(p),
              },
              icon("more")
            )
          )
        ),
        !state.projects.length
          ? h(
              "p",
              { class: "nav-empty" },
              "テーマごとに会話と指示をまとめられます。"
            )
          : null
      ),
      h(
        "section",
        {
          class: "history-section",
          "aria-label": state.showArchived
            ? "アーカイブした会話"
            : "最近の会話",
        },
        h(
          "div",
          { class: "section-heading" },
          h("span", {}, state.showArchived ? "アーカイブ" : "最近の会話"),
          state.showArchived
            ? h(
                "button",
                {
                  class: "text-button",
                  onclick: () => void showArchive(false),
                },
                "戻る"
              )
            : null
        ),
        h(
          "ul",
          { class: "conversations" },
          ...state.conversations.map((c) =>
            h(
              "li",
              {
                "data-title": c.title,
                hidden: !matchingTitle(c.title, state.titleQuery),
              },
              h(
                "button",
                {
                  class:
                    c.id === state.current?.conversation.id
                      ? "item active"
                      : "item",
                  ...(c.id === state.current?.conversation.id
                    ? { "aria-current": "page" }
                    : {}),
                  title: c.title || "無題の会話",
                  onclick: () => void goTo(c.id),
                },
                h("span", {}, c.title || "無題の会話")
              )
            )
          ),
          h(
            "li",
            {
              class: "history-empty search-empty",
              hidden: state.conversations.some((c) =>
                matchingTitle(c.title, state.titleQuery)
              ),
            },
            state.conversations.length
              ? "一致するタイトルはありません"
              : "ここに会話が並びます"
          )
        )
      )
    ),
    h(
      "div",
      { class: "sidebar-footer" },
      h(
        "button",
        {
          class: state.showArchived ? "footer-link active" : "footer-link",
          onclick: () => void showArchive(!state.showArchived),
        },
        icon("archive"),
        "アーカイブ"
      ),
      h(
        "button",
        { class: "footer-link", onclick: () => void openArchivedProjects() },
        icon("folder"),
        "プロジェクトのアーカイブ"
      ),
      h(
        "button",
        {
          class: "account-button",
          "aria-label": "表示設定・ショートカット",
          onclick: openSettings,
        },
        h(
          "span",
          { class: "account-avatar", "aria-hidden": "true" },
          (state.me?.username ?? "U").slice(0, 1).toUpperCase()
        ),
        h(
          "span",
          { class: "account-copy" },
          h("strong", {}, state.me?.username ?? "メンバー"),
          h("span", {}, "表示設定・ショートカット")
        ),
        icon("settings")
      )
    )
  );
}

/** Resize the composer for wrapped text in browsers without field-sizing support. */
function resizeComposer(textarea: HTMLTextAreaElement) {
  if (CSS.supports("field-sizing", "content")) {
    textarea.style.height = "";
    return;
  }
  const style = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const verticalPadding =
    Number.parseFloat(style.paddingTop) +
    Number.parseFloat(style.paddingBottom);
  const minHeight = Number.parseFloat(style.minHeight);
  textarea.rows = composerRowsForContent(
    textarea.scrollHeight,
    lineHeight,
    verticalPadding,
    minHeight
  );
  textarea.style.height = "auto";
  const contentHeight = Math.max(
    minHeight,
    Math.min(textarea.scrollHeight, lineHeight * 6 + verticalPadding)
  );
  textarea.style.height = `${contentHeight}px`;
}

/** Render the active conversation, empty state, and accessible message composer. */
function chat() {
  const conversation = state.current?.conversation ?? null;
  const textarea = h("textarea", {
    id: "composer-input",
    rows: "1",
    maxlength: "8000",
    placeholder: "何から始めましょう？",
    "aria-label": "メッセージ",
    "aria-describedby": "composer-help",
    disabled:
      !!state.sending || state.forking || conversation?.archived === true,
  });
  textarea.value = state.draft;

  const modelSelect = h(
    "select",
    {
      id: "composer-model",
      "aria-label": "使用するモデル",
      disabled: !!state.sending || state.forking || state.models.length === 0,
      onchange: ((event: Event) => {
        state.modelId = (event.target as HTMLSelectElement).value;
      }) as EventListener,
    },
    ...state.models.map((m) =>
      h("option", { value: m.id, selected: m.id === state.modelId }, m.label)
    )
  );

  const modelAvailable = () =>
    canSubmitComposer(state.draft, state.modelId, state.models.length > 0);
  const sendButton = h(
    "button",
    {
      type: "submit",
      class: "send-button",
      "aria-label": "メッセージを送信",
      disabled: !!state.sending || state.forking || !modelAvailable(),
    },
    icon("send")
  );
  const submit = () => {
    const text = textarea.value;
    if (!canSubmitComposer(text, state.modelId, state.models.length > 0))
      return;
    textarea.value = "";
    state.draft = "";
    sendButton.disabled = true;
    const restoreComposerFocus =
      textarea.matches(":focus") || sendButton.matches(":focus");
    const pending = send(text);
    if (restoreComposerFocus) {
      root.querySelector<HTMLButtonElement>(".stop-button")?.focus();
    }
    void pending.finally(() => {
      if (restoreComposerFocus && document.activeElement === document.body) {
        root.querySelector<HTMLTextAreaElement>("#composer-input")?.focus();
      }
    });
  };
  textarea.addEventListener("input", () => {
    state.draft = textarea.value;
    resizeComposer(textarea);
    sendButton.disabled = !!state.sending || !modelAvailable();
  });
  textarea.addEventListener("keydown", (event) => {
    if (shouldSubmitComposer(event)) {
      event.preventDefault();
      submit();
    }
  });

  const messages = state.current?.messages ?? [];
  const project = state.projects.find(
    (candidate) =>
      candidate.id === (conversation?.projectId ?? state.projectFilter)
  );
  const contextUsage = state.current?.contextUsage;
  const isEmpty = messages.length === 0 && state.streaming === null;

  return h(
    "main",
    { class: isEmpty ? "chat new-workspace" : "chat" },
    h(
      "header",
      { class: "chat-header" },
      h(
        "button",
        {
          class: "icon-button menu-toggle",
          type: "button",
          "aria-controls": "sidebar",
          "aria-expanded": String(!state.sidebarCollapsed),
          "aria-label": "ナビゲーションを開く",
          title: "ナビゲーションを切り替える",
          onclick: toggleNavigation,
        },
        icon("panel")
      ),
      h(
        "div",
        { class: "conversation-heading" },
        h(
          "h1",
          {},
          conversation
            ? conversation.title || "無題の会話"
            : (project?.name ?? "ワークスペース")
        ),
        conversation
          ? h(
              "span",
              { class: "conversation-caption" },
              project?.name ?? "個人の会話"
            )
          : null
      ),
      h("span", { class: "header-spacer" }),
      conversation
        ? conversationMenu(conversation)
        : h(
            "span",
            { class: "private-caption" },
            icon("lock"),
            "自分だけのスペース"
          )
    ),
    h(
      "div",
      { class: "workspace-notices" },
      conversation ? skillHistory(messages) : null,
      conversation && contextUsage
        ? h(
            "details",
            { class: "context-usage" },
            h(
              "summary",
              {},
              "コンテキスト · 入力 " +
                contextUsage.inputTokens.toLocaleString("ja-JP") +
                " トークン"
            ),
            h(
              "p",
              {},
              "直近の完了回答 · 出力 " +
                contextUsage.outputTokens.toLocaleString("ja-JP") +
                " トークン"
            ),
            h(
              "p",
              {},
              [
                state.models.find((model) => model.id === contextUsage.modelId)
                  ?.label ?? contextUsage.modelId,
                new Intl.DateTimeFormat("ja-JP", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "Asia/Tokyo",
                }).format(new Date(contextUsage.measuredAt)) + " JST",
              ]
                .filter(Boolean)
                .join(" · ")
            )
          )
        : null,
      state.branchSource
        ? h(
            "div",
            { class: "branch-notice", role: "status" },
            icon("branch"),
            h("span", {}, "元の会話を残して、新しい会話に分岐しました。"),
            h(
              "button",
              {
                class: "text-button",
                onclick: () => void goTo(state.branchSource!.id),
              },
              "元の会話を開く"
            )
          )
        : null,
      state.forking
        ? h("p", { class: "notice", role: "status" }, "履歴を引き継いでいます…")
        : null,
      state.notice
        ? h("p", { class: "notice", role: "alert" }, state.notice)
        : null
    ),
    h(
      "section",
      {
        class: isEmpty ? "messages is-empty" : "messages",
        "aria-label": "会話",
        tabindex: "0",
      },
      isEmpty
        ? h(
            "div",
            { class: "welcome" },
            h(
              "div",
              { class: "welcome-eyebrow" },
              icon("spark"),
              "考える時間を、もっと自由に。"
            ),
            h(
              "h2",
              { class: "welcome-title" },
              "考えを、",
              h("br"),
              h("span", {}, "次のかたちに。")
            ),
            h(
              "p",
              { class: "welcome-copy" },
              "書く、つくる、解きほぐす。",
              h("br"),
              "ここから、一緒に始めましょう。"
            )
          )
        : null,
      ...messages.map(messageView),
      state.streaming !== null
        ? h(
            "article",
            { class: "message assistant" },
            h("div", { class: "who" }, "AI"),
            h(
              "div",
              { class: "body streaming", id: "streaming", "aria-live": "off" },
              state.streaming || "…"
            )
          )
        : null
    ),
    state.sending
      ? h(
          "span",
          { class: "sr-only", role: "status", "aria-live": "polite" },
          "回答を生成中です。停止するには停止ボタンを押してください。"
        )
      : null,
    conversation?.archived
      ? h(
          "p",
          { class: "archived-message" },
          "アーカイブした会話には送信できません。復元すると続けられます。"
        )
      : h(
          "form",
          {
            class: "composer",
            onsubmit: ((event: Event) => {
              event.preventDefault();
              submit();
            }) as EventListener,
          },
          textarea,
          h(
            "div",
            { class: "composer-toolbar" },

            h(
              "label",
              { class: "sr-only", for: "composer-model" },
              "使用するモデル"
            ),
            h(
              "div",
              { class: "model-picker" },
              icon("model"),
              modelSelect,
              icon("chevron")
            ),
            h(
              "button",
              {
                class: "text-button composer-skill",
                type: "button",
                disabled: !!state.sending,
                onclick: () =>
                  openSkills(
                    (prompt) => {
                      textarea.value = textarea.value.trimEnd()
                        ? textarea.value.trimEnd() + "\n\n" + prompt
                        : prompt;
                      textarea.dispatchEvent(new Event("input"));
                      textarea.focus();
                    },
                    state.me ? registeredSkills(state.me.id) : []
                  ),
              },
              "スキル"
            ),
            h(
              "button",
              {
                class: "text-button composer-skill",
                type: "button",
                onclick: () => openWorkspaceTools(conversation?.id),
              },
              "ツール"
            ),
            h("span", { class: "grow" }),
            h(
              "span",
              { class: "composer-hint", id: "composer-help" },
              "Shift + Enter で改行"
            ),
            state.sending
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "stop-button",
                    "aria-label": "回答を停止",
                    onclick: () => state.sending?.abort(),
                  },
                  icon("stop"),
                  "停止"
                )
              : null,
            sendButton
          )
        ),
    isEmpty && !conversation?.archived
      ? h(
          "div",
          { class: "prompt-starters", "aria-label": "会話のヒント" },
          ...(
            [
              [
                "write",
                "文章を整える",
                "次の文章を、意図が伝わる自然な表現に整えてください。\n\n",
              ],
              [
                "spark",
                "考えを整理する",
                "考えを整理する手伝いをしてください。まず、目的と今迷っていることを聞いてください。",
              ],
              [
                "code",
                "コードを相談する",
                "次のコードについて、問題点と改善案を教えてください。\n\n",
              ],
            ] as const
          ).map(([symbol, title, draft]) =>
            h(
              "button",
              {
                class: "starter",
                type: "button",
                disabled: !!state.sending,
                onclick: () => {
                  state.draft = draft;
                  textarea.value = draft;
                  resizeComposer(textarea);
                  sendButton.disabled = !modelAvailable();
                  textarea.focus();
                },
              },
              icon(symbol),
              title,
              icon("arrow")
            )
          )
        )
      : null,
    h(
      "p",
      { class: "workspace-disclaimer" },
      "AIの回答は必ずしも正確ではありません。大切な情報は確認してください。"
    )
  );
}

function loginView() {
  const returnTo = `${location.origin}${location.pathname}`;
  const href = `${loginUrl}?return_to=${encodeURIComponent(returnTo)}`;
  return h(
    "main",
    { class: "login" },
    h("h1", {}, "ivRooom AI"),
    state.notice && state.notice !== "ログインが必要です。"
      ? h("p", { class: "notice", role: "alert" }, state.notice)
      : null,
    h(
      "p",
      {},
      "ivRooom のメンバー向けの AI チャットです。Discord でログインしてください。"
    ),
    h("a", { class: "button primary", href }, "Discord でログイン")
  );
}

/** Apply drawer visibility and keyboard interactivity without rebuilding the workspace. */
function syncSidebarMode() {
  const mobile = window.matchMedia("(max-width: 900px)").matches;
  const layout = root.querySelector<HTMLElement>(".layout");
  const nav = root.querySelector<HTMLElement>("#sidebar");
  const chatMain = root.querySelector<HTMLElement>(".chat, .home");
  if (!layout || !nav || !chatMain) return;
  const hidden = mobile ? !state.sidebarOpen : state.sidebarCollapsed;
  layout.classList.toggle(
    "sidebar-collapsed",
    !mobile && state.sidebarCollapsed
  );
  layout.classList.toggle("sidebar-open", mobile && state.sidebarOpen);
  nav.toggleAttribute("inert", hidden);
  nav.setAttribute("aria-hidden", String(hidden));
  chatMain.toggleAttribute("inert", mobile && state.sidebarOpen);
  const toggle = root.querySelector<HTMLElement>(".menu-toggle");
  toggle?.setAttribute("aria-expanded", String(!hidden));
  toggle?.setAttribute(
    "aria-label",
    hidden ? "ナビゲーションを開く" : "ナビゲーションを閉じる"
  );
}

/** Toggle mobile navigation in place so conversation scroll and draft selection survive. */
function setSidebarOpen(open: boolean) {
  state.sidebarOpen = open;
  syncSidebarMode();
  const toggle = root.querySelector<HTMLButtonElement>(".menu-toggle");
  toggle?.setAttribute("aria-expanded", String(open));
  toggle?.setAttribute(
    "aria-label",
    open ? "ナビゲーションを閉じる" : "ナビゲーションを開く"
  );
  root
    .querySelector<HTMLElement>(open ? ".sidebar .new-chat" : ".menu-toggle")
    ?.focus();
}

/** Rebuild the application view after data changes and scroll messages to the end. */
function draw() {
  if (!state.me) {
    root.replaceChildren(loginView());
    return;
  }
  root.replaceChildren(
    h(
      "div",
      { class: "layout" },
      h("button", {
        class: "sidebar-backdrop",
        type: "button",
        "aria-label": "ナビゲーションを閉じる",
        tabindex: "-1",
        onclick: () => setSidebarOpen(false),
      }),
      sidebar(),
      state.home
        ? profileHome({
            me: state.me,
            usage: state.usage,
            failed: state.usageFailed,
            projects: state.projects,
            recent: state.recent,
            retry: () => void loadHome(),
            newChat: () => {
              state.draft = "";
              void goTo(null);
            },
            openTools: () => openWorkspaceTools(),
            openIntegrations: () => {
              const owner = state.me?.id;
              if (owner) openIntegrations(owner);
            },
            toggleNavigation,
            openConversation: (id) => void goTo(id),
            openProject: (id) => void selectProject(id),
            createProject: () => editProject(null),
          })
        : chat()
    )
  );
  syncSidebarMode();
  const attachedTextarea =
    root.querySelector<HTMLTextAreaElement>("#composer-input");
  if (attachedTextarea) resizeComposer(attachedTextarea);
  const messages = root.querySelector<HTMLElement>(".messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

window.addEventListener("resize", syncSidebarMode);
window.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "k" &&
    state.me &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(true);
    else if (state.sidebarCollapsed) {
      state.sidebarCollapsed = false;
      syncSidebarMode();
    }
    root.querySelector<HTMLInputElement>(".history-search")?.focus();
    return;
  }
  if (event.key === "Escape")
    root
      .querySelectorAll<HTMLDetailsElement>(".conversation-menu[open]")
      .forEach((el) => {
        el.open = false;
        el.querySelector("summary")?.focus();
      });
  if (
    event.key === "Escape" &&
    state.sidebarOpen &&
    !document.querySelector("dialog[open]") &&
    window.matchMedia("(max-width: 900px)").matches
  ) {
    setSidebarOpen(false);
  }
});

async function start() {
  try {
    state.me = await api.me();
    const [models] = await Promise.all([api.models(), loadLists()]);
    state.models = models;
    state.modelId = models[0]?.id ?? "";
    if (models.length === 0)
      state.notice = "使えるモデルがありません。運営にお問い合わせください。";
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      state.me = null;
      draw();
      return;
    }
    if (error instanceof ApiError && error.status === 403) {
      root.replaceChildren(
        h(
          "main",
          { class: "login" },
          h("h1", {}, "ivRooom AI"),
          h(
            "p",
            {},
            "このアカウントには AI の利用が許可されていません。運営にお問い合わせください。"
          )
        )
      );
      return;
    }
    state.me = null;
    state.notice = describeError(error);
    draw();
    return;
  }
  if (state.home) await openHome();
  else await openConversation(conversationIdFromPath());
}

window.addEventListener("popstate", () => {
  if (location.pathname === "/") void openHome();
  else void goTo(conversationIdFromPath());
});
void start();
