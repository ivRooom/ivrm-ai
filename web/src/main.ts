import {
  api,
  ApiError,
  describeError,
  describeStreamError,
  sendMessage,
  type Conversation,
  type Me,
  type Message,
  type Model,
  type Project,
} from "./api.js";
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
  me: Me | null;
  models: Model[];
  projects: Project[];
  conversations: Conversation[];
  showArchived: boolean;
  projectFilter: string;
  current: { conversation: Conversation; messages: Message[] } | null;
  modelId: string;
  sending: AbortController | null;
  streaming: string | null;
  notice: string | null;
  /** Composer text, kept across redraws (and put back when a send is refused). */
  draft: string;
  sidebarOpen: boolean;
  titleQuery: string;
};

const state: State = {
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
  notice: null,
};

function conversationIdFromPath(): string | null {
  const match = /^\/c\/([^/]+)$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function navigate(conversationId: string | null) {
  const path = conversationId
    ? `/c/${encodeURIComponent(conversationId)}`
    : "/";
  if (location.pathname !== path) history.pushState(null, "", path);
}

function showError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    state.me = null;
  }
  state.notice = describeError(error);
  draw();
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
  if (state.sending || !text.trim()) return;
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
      if (controller.signal.aborted)
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
      if (event.type === "delta") {
        state.streaming += event.text;
        drawStreaming();
      } else if (event.type === "error") {
        failed = describeStreamError(event.code);
      }
    }
    await openConversation(conversation.id);
    await loadLists();
    // After the reload, which clears the notice: say why the reply is gone.
    if (failed) state.notice = failed;
  } catch (error) {
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

function messageView(message: { role: string; content: string }) {
  const body = h("div", { class: "body" });
  if (message.role === "assistant") {
    // Untrusted: parsed and sanitized to an allowlist (markdown.ts).
    body.append(render(message.content));
  } else {
    body.textContent = message.content;
  }
  return h(
    "article",
    { class: `message ${message.role}` },
    h("div", { class: "who" }, message.role === "user" ? "あなた" : "AI"),
    body,
    h(
      "div",
      { class: "message-actions" },
      h(
        "button",
        {
          type: "button",
          class: "ghost",
          "aria-label":
            message.role === "user"
              ? "自分のメッセージをコピー"
              : "回答をコピー",
          onclick: (async (event: Event) => {
            const button = event.currentTarget as HTMLButtonElement;
            try {
              await navigator.clipboard.writeText(message.content);
              button.textContent = "コピーしました";
            } catch {
              button.textContent = "コピーできませんでした";
            }
          }) as EventListener,
        },
        "コピー"
      )
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
  state.projectFilter = id;
  try {
    await loadLists();
    await goTo(null);
  } catch (e) {
    showError(e);
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
      { class: "sidebar-heading" },
      h("span", { class: "sidebar-label" }, "ワークスペース"),
      h(
        "button",
        {
          class: "sidebar-close",
          type: "button",
          onclick: () => setSidebarOpen(false),
        },
        "閉じる"
      )
    ),
    h(
      "button",
      {
        class: "primary new-chat",
        type: "button",
        onclick: () => void goTo(null),
      },
      icon("plus"),
      "新しいチャット"
    ),
    h(
      "details",
      { class: "project-picker", open: true },
      h("summary", { class: "sidebar-label" }, "プロジェクト"),
      h(
        "button",
        {
          class: !state.projectFilter ? "item active" : "item",
          onclick: () => void selectProject(""),
        },
        "すべての会話"
      ),
      ...state.projects.map((p) =>
        h(
          "div",
          { class: "project-nav-row" },
          h(
            "button",
            {
              class: p.id === state.projectFilter ? "item active" : "item",
              onclick: () => void selectProject(p.id),
            },
            p.name
          ),
          h(
            "button",
            {
              class: "ghost",
              "aria-label": p.name + "を編集",
              onclick: () => editProject(p),
            },
            "編集"
          )
        )
      )
    ),
    h(
      "div",
      { class: "sidebar-actions" },
      h(
        "button",
        { class: "ghost", type: "button", onclick: () => editProject(null) },
        "＋ プロジェクト"
      ),
      h(
        "button",
        {
          class: "ghost",
          type: "button",
          onclick: () => void openArchivedProjects(),
        },
        "アーカイブ済み"
      )
    ),
    h(
      "div",
      { class: "history-heading" },
      h("span", { class: "sidebar-label" }, "最近の会話"),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: state.showArchived,
          onchange: (async (event: Event) => {
            state.showArchived = (event.target as HTMLInputElement).checked;
            try {
              await loadLists();
            } catch (error) {
              showError(error);
              return;
            }
            draw();
          }) as EventListener,
        }),
        "アーカイブを表示"
      )
    ),
    search,
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
              type: "button",
              onclick: () => void goTo(c.id),
            },
            c.title || "(無題)"
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
          : "会話はまだありません"
      )
    ),
    h(
      "div",
      { class: "sidebar-footer" },
      h(
        "button",
        { class: "ghost", onclick: openSettings },
        "表示設定・ショートカット"
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
    placeholder: "メッセージを入力…",
    "aria-label": "メッセージ",
    "aria-describedby": "composer-help",
    disabled: !!state.sending || conversation?.archived === true,
  });
  textarea.value = state.draft;

  const modelSelect = h(
    "select",
    {
      id: "composer-model",
      "aria-label": "使用するモデル",
      disabled: !!state.sending || state.models.length === 0,
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
      disabled: !!state.sending || !modelAvailable(),
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
    (candidate) => candidate.id === conversation?.projectId
  );
  const isEmpty = messages.length === 0 && state.streaming === null;

  return h(
    "main",
    { class: isEmpty ? "chat new-workspace" : "chat" },
    h(
      "header",
      { class: "chat-header" },
      h(
        "div",
        { class: "conversation-heading" },
        h(
          "h1",
          {},
          conversation ? conversation.title || "(無題)" : "新しいチャット"
        ),
        h("p", { class: "conversation-caption" }, project?.name ?? "ivRooom AI")
      ),
      conversation ? conversationMenu(conversation) : null
    ),
    state.notice
      ? h("p", { class: "notice", role: "alert" }, state.notice)
      : null,
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
            h("span", { class: "welcome-mark", "aria-hidden": "true" }, "i"),
            h("h2", { class: "welcome-title" }, "今日は、何を考えましょう？"),
            h(
              "p",
              { class: "welcome-copy" },
              "アイデアを整理する。深く調べる。次の一歩をつくる。"
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
              "span",
              { class: "composer-hint", id: "composer-help" },
              "Enter で送信 · Shift+Enter で改行"
            ),
            h("span", { class: "grow" }),
            h(
              "label",
              { class: "sr-only", for: "composer-model" },
              "使用するモデル"
            ),
            modelSelect,
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
  const chatMain = root.querySelector<HTMLElement>(".chat");
  if (!layout || !nav || !chatMain) return;
  const hidden = mobile && !state.sidebarOpen;
  layout.classList.toggle("sidebar-open", mobile && state.sidebarOpen);
  nav.toggleAttribute("inert", hidden);
  nav.setAttribute("aria-hidden", String(hidden));
  chatMain.toggleAttribute("inert", mobile && state.sidebarOpen);
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
      h(
        "header",
        { class: "topbar" },
        h(
          "button",
          {
            class: "menu-toggle",
            type: "button",
            "aria-controls": "sidebar",
            "aria-expanded": String(state.sidebarOpen),
            "aria-label": state.sidebarOpen
              ? "ナビゲーションを閉じる"
              : "ナビゲーションを開く",
            onclick: () => setSidebarOpen(!state.sidebarOpen),
          },
          icon("menu")
        ),
        h(
          "div",
          { class: "brand-lockup" },
          h("span", { class: "brand-mark", "aria-hidden": "true" }, "i"),
          h("strong", {}, "ivRooom"),
          h("span", { class: "brand-ai" }, "AI")
        ),
        h("span", { class: "account-name" }, state.me.username)
      ),
      h("button", {
        class: "sidebar-backdrop",
        type: "button",
        "aria-label": "ナビゲーションを閉じる",
        tabindex: "-1",
        onclick: () => setSidebarOpen(false),
      }),
      sidebar(),
      chat()
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
  await openConversation(conversationIdFromPath());
}

window.addEventListener("popstate", () => void goTo(conversationIdFromPath()));
void start();
