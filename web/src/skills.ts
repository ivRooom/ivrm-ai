import { h } from "./dom.js";

const skills = [
  {
    title: "会話を要約",
    description: "要点・決まったこと・未解決の論点を整理",
    prompt:
      "ここまでの会話を要約してください。要点、決まったこと、未解決の論点を分け、会話で確認できる内容に絞ってください。",
  },
  {
    title: "次の行動を整理",
    description: "優先順位と着手の条件が分かるタスク一覧",
    prompt:
      "ここまでの会話をもとに、次に取るべき行動を優先順に整理してください。各項目に完了条件と依存関係を添え、不明な点は確認事項にしてください。",
  },
  {
    title: "案を比較",
    description: "候補ごとの利点・欠点と選定条件を整理",
    prompt:
      "候補を比較し、それぞれの利点、欠点、適する条件を整理してください。判断に必要な情報が足りなければ明示してください。",
  },
] as const;

export function openSkills(
  apply: (prompt: string) => void,
  custom: { title: string; description: string; prompt: string }[] = []
) {
  const dialog = h("dialog", { class: "dialog", "aria-label": "会話のスキル" });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.append(
    h("h2", {}, "会話のスキル"),
    h("p", {}, "選んだ指示を入力欄に追加します。送信前に編集できます。"),
    ...[...skills, ...custom].map((skill) =>
      h(
        "button",
        {
          class: "skill-choice",
          type: "button",
          onclick: () => {
            dialog.close();
            apply(skill.prompt);
          },
        },
        h("strong", {}, skill.title),
        h("span", {}, skill.description)
      )
    ),
    h(
      "button",
      { class: "text-button", type: "button", onclick: () => dialog.close() },
      "閉じる"
    )
  );
  document.body.append(dialog);
  dialog.showModal();
}

export function matchingSkills(content: string): string[] {
  const paragraphs = new Set(
    content
      .trim()
      .split(/\r?\n[ \t]*\r?\n/)
      .map((paragraph) => paragraph.trim())
  );
  return skills
    .filter((skill) => paragraphs.has(skill.prompt))
    .map((skill) => skill.title);
}

export function skillHistory(
  messages: readonly { id: string; role: string; content: string }[]
) {
  const entries = messages
    .filter(
      (message) => message.role === "user" && !message.id.startsWith("pending-")
    )
    .flatMap((message) =>
      matchingSkills(message.content).map((title) => ({
        id: message.id,
        title,
      }))
    )
    .reverse();
  if (!entries.length) return null;

  return h(
    "details",
    { class: "context-usage" },
    h("summary", {}, "スキル履歴 · " + entries.length + "件"),
    h(
      "p",
      {},
      "表示中の送信済みメッセージから、組み込みの定型文と一致する指示を表示します。"
    ),
    h(
      "ul",
      {},
      ...entries.map(({ id, title }) =>
        h(
          "li",
          {},
          h(
            "button",
            {
              class: "text-button",
              type: "button",
              onclick: () => {
                const target = document.getElementById("message-" + id);
                target?.focus({ preventScroll: true });
                target?.scrollIntoView({ block: "nearest" });
              },
            },
            title
          )
        )
      )
    )
  );
}
