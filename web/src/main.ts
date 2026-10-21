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

async function openConversation(id: string | null) {
  state.notice = null;
  if (!id) {
    state.current = null;
    navigate(null);
    draw();
    return;
  }
  try {
    state.current = await api.conversation(id);
    state.modelId = state.current.conversation.modelId;
    navigate(id);
  } catch (error) {
    state.current = null;
    navigate(null);
    showError(error);
    return;
  }
  draw();
}

async function send(text: string) {
  if (state.sending || !text.trim()) return;
  state.notice = null;
  const controller = new AbortController();
  state.sending = controller;
  try {
    let conversation = state.current?.conversation;
    if (!conversation) {
      conversation = await api.createConversation({
        modelId: state.modelId,
        projectId: state.projectFilter || null,
      });
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
    if (failed) state.notice = failed;
    await openConversation(conversation.id);
    await loadLists();
  } catch (error) {
    if (controller.signal.aborted) {
      state.notice = "回答を止めました。止めた回答は保存されません。";
    } else {
      // A refused send stored nothing: drop the optimistic user message.
      state.current?.messages.pop();
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

function drawStreaming() {
  const el = document.getElementById("streaming");
  if (!el || state.streaming === null) return;
  el.textContent = state.streaming || "…";
  el.scrollIntoView({ block: "end" });
}

function sidebar() {
  const projectSelect = h(
    "select",
    {
      "aria-label": "プロジェクト",
      onchange: (async (event: Event) => {
        state.projectFilter = (event.target as HTMLSelectElement).value;
        try {
          await loadLists();
        } catch (error) {
          showError(error);
          return;
        }
        await openConversation(null);
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
    { class: "sidebar" },
    h(
      "button",
      { class: "primary", onclick: () => void openConversation(null) },
      "新しい会話"
    ),
    h(
      "div",
      { class: "row" },
      projectSelect,
      current
        ? h(
            "button",
            {
              class: "ghost",
              title: "編集",
              onclick: () => editProject(current),
            },
            "編集"
          )
        : null
    ),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        { class: "ghost", onclick: () => editProject(null) },
        "＋ プロジェクト"
      ),
      h(
        "button",
        { class: "ghost", onclick: () => void openArchivedProjects() },
        "アーカイブ済み"
      )
    ),
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
      "アーカイブした会話を表示"
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
              onclick: () => void openConversation(c.id),
            },
            c.title || "(無題)"
          )
        )
      ),
      state.conversations.length === 0
        ? h("li", { class: "muted" }, "会話はまだありません")
        : null
    )
  );
}

function chat() {
  const conversation = state.current?.conversation ?? null;
  const textarea = h("textarea", {
    rows: "3",
    maxlength: "8000",
    placeholder: "メッセージ(Ctrl+Enter で送信)",
    disabled: !!state.sending || conversation?.archived === true,
  });
  const submit = () => {
    const text = textarea.value;
    textarea.value = "";
    void send(text);
  };
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });

  const modelSelect = h(
    "select",
    {
      "aria-label": "モデル",
      disabled: !!state.sending,
      onchange: ((event: Event) => {
        state.modelId = (event.target as HTMLSelectElement).value;
      }) as EventListener,
    },
    ...state.models.map((m) =>
      h("option", { value: m.id, selected: m.id === state.modelId }, m.label)
    )
  );

  const messages = state.current?.messages ?? [];
  return h(
    "main",
    { class: "chat" },
    h(
      "header",
      { class: "row" },
      h(
        "h1",
        { class: "grow" },
        conversation ? conversation.title || "(無題)" : "新しい会話"
      ),
      conversation
        ? h(
            "button",
            { class: "ghost", onclick: () => void toggleArchive(conversation) },
            conversation.archived ? "復元" : "アーカイブ"
          )
        : null
    ),
    state.notice
      ? h("p", { class: "notice", role: "alert" }, state.notice)
      : null,
    h(
      "section",
      { class: "messages" },
      ...messages.map(messageView),
      state.streaming !== null
        ? h(
            "article",
            { class: "message assistant" },
            h("div", { class: "who" }, "AI"),
            h(
              "div",
              { class: "body streaming", id: "streaming" },
              state.streaming || "…"
            )
          )
        : null,
      messages.length === 0 && state.streaming === null
        ? h("p", { class: "muted" }, "メッセージを送ると会話が始まります。")
        : null
    ),
    conversation?.archived
      ? h(
          "p",
          { class: "muted" },
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
            { class: "row" },
            modelSelect,
            h("span", { class: "grow" }),
            state.sending
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "ghost",
                    onclick: () => state.sending?.abort(),
                  },
                  "停止"
                )
              : null,
            h(
              "button",
              {
                type: "submit",
                disabled: !!state.sending || state.models.length === 0,
              },
              "送信"
            )
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
        "div",
        { class: "topbar row" },
        h("strong", { class: "grow" }, "ivRooom AI"),
        h("span", { class: "muted" }, state.me.username)
      ),
      sidebar(),
      chat()
    )
  );
  document.getElementById("streaming")?.scrollIntoView({ block: "end" });
}

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

window.addEventListener(
  "popstate",
  () => void openConversation(conversationIdFromPath())
);
void start();
