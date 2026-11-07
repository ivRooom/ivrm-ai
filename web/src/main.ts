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
import { shouldSubmitComposer } from "./composer.js";
import { createRenderer } from "./markdown.js";

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
  const restoreFocus =
    state.sidebarOpen && window.matchMedia("(max-width: 900px)").matches;
  if (restoreFocus) setSidebarOpen(false);
  else state.sidebarOpen = false;
  await openConversation(id);
  if (restoreFocus && !state.sidebarOpen) {
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
    body
  );
}

/** Update streamed text in place and keep the conversation pinned to the latest output. */
function drawStreaming() {
  const el = document.getElementById("streaming");
  if (!el || state.streaming === null) return;
  el.textContent = state.streaming || "…";
  const messages = el.closest<HTMLElement>(".messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

/** Render the project controls, history filters, and existing conversation list. */
function sidebar() {
  const projectSelect = h(
    "select",
    {
      id: "project-filter",
      "aria-label": "プロジェクト",
      onchange: (async (event: Event) => {
        state.projectFilter = (event.target as HTMLSelectElement).value;
        try {
          await loadLists();
        } catch (error) {
          showError(error);
          return;
        }
        await goTo(null);
      }) as EventListener,
    },
    h("option", { value: "" }, "すべての会話"),
    ...state.projects.map((p) =>
      h(
        "option",
        { value: p.id, selected: p.id === state.projectFilter },
        p.name
      )
    )
  );
  const current = state.projects.find((p) => p.id === state.projectFilter);

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
      h("span", { class: "new-chat-icon", "aria-hidden": "true" }, "+"),
      "新しいチャット"
    ),
    h(
      "div",
      { class: "project-picker" },
      h(
        "label",
        { class: "sidebar-label", for: "project-filter" },
        "プロジェクト"
      ),
      h(
        "div",
        { class: "project-select-row" },
        projectSelect,
        current
          ? h(
              "button",
              {
                class: "icon-button",
                type: "button",
                title: "プロジェクトを編集",
                "aria-label": "プロジェクトを編集",
                onclick: () => editProject(current),
              },
              "⋯"
            )
          : null
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
    h(
      "ul",
      { class: "conversations" },
      ...state.conversations.map((c) =>
        h(
          "li",
          {},
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
      state.conversations.length === 0
        ? h("li", { class: "history-empty" }, "会話はまだありません")
        : null
    )
  );
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

  const sendButton = h(
    "button",
    {
      type: "submit",
      class: "send-button",
      "aria-label": "メッセージを送信",
      disabled:
        !!state.sending || state.models.length === 0 || !state.draft.trim(),
    },
    h("span", { "aria-hidden": "true" }, "↑")
  );
  const submit = () => {
    const text = textarea.value;
    if (!text.trim()) return;
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
    // Also grow by explicit newlines in browsers without field-sizing support.
    textarea.rows = Math.min(6, Math.max(1, textarea.value.split("\n").length));
    sendButton.disabled =
      !!state.sending || state.models.length === 0 || !state.draft.trim();
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
    { class: "chat" },
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
      conversation
        ? h(
            "button",
            {
              class: "ghost archive-button",
              type: "button",
              disabled: !!state.sending,
              onclick: () => void toggleArchive(conversation),
            },
            conversation.archived ? "復元" : "アーカイブ"
          )
        : null
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
            h(
              "h2",
              { class: "welcome-title" },
              `こんにちは、${state.me?.username ?? ""} さん`
            ),
            h(
              "p",
              { class: "welcome-copy" },
              "今日はどんなことを一緒に考えましょう？"
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
                  h("span", { "aria-hidden": "true" }, "■"),
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
          h("span", { "aria-hidden": "true" }, "☰")
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
  const messages = root.querySelector<HTMLElement>(".messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

window.addEventListener("resize", syncSidebarMode);
window.addEventListener("keydown", (event) => {
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
