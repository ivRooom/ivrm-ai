import { h } from "./dom.js";

type Entry = {
  id: string;
  kind: "mcp" | "plugin";
  name: string;
  value: string;
};
const key = (owner: string) => "ivrm-ai-integrations-v1:" + owner;

function readEntries(owner: string): Entry[] {
  const saved: unknown = JSON.parse(localStorage.getItem(key(owner)) ?? "[]");
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(
      (entry): entry is Entry =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.name === "string" &&
        typeof entry.value === "string" &&
        (entry.kind === "mcp" || entry.kind === "plugin")
    )
    .slice(0, 30);
}

export function registeredSkills(owner: string) {
  try {
    return readEntries(owner)
      .filter((entry) => entry.kind === "plugin")
      .map((entry) => ({
        title: entry.name,
        description: "自分で登録した指示テンプレート",
        prompt: entry.value,
      }));
  } catch {
    return [];
  }
}

function endpoint(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function openIntegrations(owner: string) {
  const dialog = h("dialog", {
    class: "dialog integration-dialog",
    "aria-label": "MCP・プラグイン",
  });
  const status = h("p", { role: "status" });
  const list = h("ul");
  let entries: Entry[] = [];
  let available = true;
  try {
    entries = readEntries(owner);
  } catch {
    available = false;
    status.textContent = "このブラウザーの登録情報を読み込めません。";
  }

  function renderEntries() {
    list.replaceChildren(
      ...entries.map((entry) =>
        h(
          "li",
          {},
          h("strong", {}, entry.name),
          h(
            "p",
            { class: "muted" },
            entry.kind === "mcp"
              ? "MCP · 未接続 · " + entry.value
              : "指示テンプレート · スキルから利用可能"
          ),
          h(
            "button",
            {
              type: "button",
              "aria-label": entry.name + "を削除",
              onclick: () =>
                save(
                  entries.filter((item) => item.id !== entry.id),
                  "登録を削除しました。"
                ),
            },
            "削除"
          )
        )
      )
    );
    if (!entries.length) list.append(h("li", {}, "登録はありません。"));
  }

  function save(next: Entry[], message: string) {
    try {
      localStorage.setItem(key(owner), JSON.stringify(next));
      entries = next;
      renderEntries();
      status.textContent = message;
      return true;
    } catch {
      status.textContent = "このブラウザーに保存できませんでした。";
      return false;
    }
  }

  const kind = h(
    "select",
    {},
    h("option", { value: "mcp" }, "MCP サーバー"),
    h("option", { value: "plugin" }, "プラグイン（指示テンプレート）")
  );
  const name = h("input", { required: true, maxlength: "80" });
  const url = h("input", {
    type: "url",
    maxlength: "500",
    required: true,
    placeholder: "https://example.com/mcp",
  });
  const prompt = h("textarea", {
    maxlength: "3000",
    rows: "4",
    disabled: true,
  });
  const urlLabel = h("label", {}, "MCP の HTTPS URL", url);
  const promptLabel = h(
    "label",
    { hidden: true },
    "スキルに挿入する指示",
    prompt
  );
  kind.addEventListener("change", () => {
    const plugin = kind.value === "plugin";
    urlLabel.hidden = plugin;
    url.disabled = plugin;
    promptLabel.hidden = !plugin;
    prompt.disabled = !plugin;
    prompt.required = plugin;
  });
  const form = h(
    "form",
    { class: "integration-form" },
    h("label", {}, "種類", kind),
    h("label", {}, "名前", name),
    urlLabel,
    promptLabel,
    h("button", { type: "submit", disabled: !available }, "登録")
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const type = kind.value === "plugin" ? "plugin" : "mcp";
    const value =
      type === "mcp" ? endpoint(url.value.trim()) : prompt.value.trim();
    if (!name.value.trim() || !value) {
      status.textContent =
        type === "mcp"
          ? "名前と、資格情報・クエリ・フラグメントを含まない HTTPS URL を入力してください。"
          : "名前と指示を入力してください。";
      return;
    }
    if (entries.length >= 30) {
      status.textContent = "登録できるのは30件までです。";
      return;
    }
    if (entries.some((item) => item.kind === type && item.value === value)) {
      status.textContent = "同じ内容が登録済みです。";
      return;
    }
    if (
      save(
        [
          ...entries,
          {
            id: crypto.randomUUID(),
            kind: type,
            name: name.value.trim(),
            value,
          },
        ],
        "登録しました。"
      )
    ) {
      name.value = url.value = prompt.value = "";
      name.focus();
    }
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.append(
    h("h2", {}, "MCP・プラグイン"),
    h(
      "p",
      {},
      "登録はこのブラウザーの自分のアカウントに保存されます。MCP は接続先の登録まで利用できます。"
    ),
    form,
    status,
    list,
    h("button", { type: "button", onclick: () => dialog.close() }, "閉じる")
  );
  renderEntries();
  document.body.append(dialog);
  dialog.showModal();
}
