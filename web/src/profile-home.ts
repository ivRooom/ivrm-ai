import type { Conversation, Me, Project, Usage } from "./api.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";

const number = new Intl.NumberFormat("ja-JP");
const compact = new Intl.NumberFormat("ja-JP", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const dayMs = 86_400_000;
const dayTime = (date: string) => Date.parse(date + "T00:00:00Z");
const weekday = (date: string) => (new Date(dayTime(date)).getUTCDay() + 6) % 7;

function activity(usage: Usage) {
  const content = h("div");
  const controls = h("div", {
    class: "activity-modes",
    role: "group",
    "aria-label": "集計単位",
  });
  const modes = ["日別", "週別", "累計"] as const;
  function show(mode: (typeof modes)[number]) {
    for (const button of controls.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.textContent === mode));
    }
    const weeks = new Map<string, number>();
    let running =
      usage.totalTokens - usage.daily.reduce((sum, day) => sum + day.tokens, 0);
    const daily = usage.daily.map((day) => {
      const week = new Date(dayTime(day.date) - weekday(day.date) * dayMs)
        .toISOString()
        .slice(0, 10);
      weeks.set(week, (weeks.get(week) ?? 0) + day.tokens);
      running += day.tokens;
      return { date: day.date, tokens: mode === "累計" ? running : day.tokens };
    });
    const values =
      mode === "週別"
        ? [...weeks].map(([date, tokens]) => ({ date, tokens }))
        : daily;
    const max = Math.max(1, ...values.map((value) => value.tokens));
    const grid = h("div", {
      class: mode === "週別" ? "activity-grid weekly" : "activity-grid",
      "aria-hidden": "true",
    });
    if (mode !== "週別" && values[0]) {
      for (let i = 0; i < weekday(values[0].date); i++) grid.append(h("span"));
    }
    for (const value of values) {
      const level =
        value.tokens === 0
          ? 0
          : Math.max(1, Math.ceil(4 * Math.sqrt(value.tokens / max)));
      grid.append(
        h("span", {
          class: "activity-cell level-" + level,
          title:
            value.date +
            (mode === "週別" ? "の週" : "") +
            " · " +
            number.format(value.tokens) +
            " トークン",
        })
      );
    }
    const scroll = h(
      "div",
      {
        class: "activity-scroll",
        tabindex: "0",
        "aria-label": "利用ヒートマップ。下の表でも数値を確認できます。",
      },
      grid
    );
    content.replaceChildren(
      scroll,
      h(
        "div",
        { class: "activity-range" },
        h("span", {}, values[0]?.date ?? ""),
        h("span", {}, usage.daily.at(-1)?.date ?? "")
      ),
      h(
        "details",
        { class: "activity-details" },
        h("summary", {}, mode + "の数値を見る"),
        h(
          "div",
          { class: "activity-table-scroll" },
          h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h(
                  "th",
                  { scope: "col" },
                  mode === "週別" ? "週の開始日" : "日付"
                ),
                h("th", { scope: "col" }, "トークン")
              )
            ),
            h(
              "tbody",
              {},
              ...values
                .slice()
                .reverse()
                .map((value) =>
                  h(
                    "tr",
                    {},
                    h("th", { scope: "row" }, value.date),
                    h("td", {}, number.format(value.tokens))
                  )
                )
            )
          )
        )
      )
    );
    queueMicrotask(() => {
      scroll.scrollLeft = scroll.scrollWidth;
    });
  }
  for (const mode of modes)
    controls.append(
      h("button", { type: "button", onclick: () => show(mode) }, mode)
    );
  show("日別");
  return h(
    "section",
    { class: "home-section" },
    h(
      "div",
      { class: "home-section-header" },
      h("h2", {}, "トークンの使用状況"),
      controls
    ),
    h(
      "p",
      { class: "home-note" },
      "直近365日 · 日本時間 · " + number.format(usage.activeDays) + "日利用"
    ),
    content
  );
}

export function profileHome(input: {
  me: Me;
  usage: Usage | null;
  failed: boolean;
  projects: Project[];
  recent: Conversation[];
  retry: () => void;
  newChat: () => void;
  toggleNavigation: () => void;
  openConversation: (id: string) => void;
  openProject: (id: string) => void;
  createProject: () => void;
}) {
  const { me, usage } = input;
  const metric = (label: string, value: number | undefined, suffix = "") =>
    h(
      "div",
      {},
      h("dt", {}, label),
      h(
        "dd",
        { title: value === undefined ? "" : number.format(value) + suffix },
        value === undefined ? "—" : compact.format(value) + suffix
      )
    );
  return h(
    "main",
    { class: "home" },
    h(
      "header",
      { class: "home-toolbar" },
      h(
        "button",
        {
          class: "icon-button menu-toggle",
          type: "button",
          "aria-controls": "sidebar",
          "aria-label": "ナビゲーションを開く",
          onclick: input.toggleNavigation,
        },
        icon("panel")
      ),
      h("span", {}, "ホーム"),
      h(
        "button",
        { class: "home-new", type: "button", onclick: input.newChat },
        icon("compose"),
        "新しいチャット"
      )
    ),
    h(
      "div",
      { class: "home-content" },
      h(
        "div",
        { class: "profile-intro" },
        h(
          "span",
          { class: "profile-avatar", "aria-hidden": "true" },
          Array.from(me.username)[0]?.toUpperCase() ?? "U"
        ),
        h("h1", {}, me.username),
        h("p", {}, "ivRooom メンバー")
      ),
      h(
        "dl",
        { class: "profile-metrics", "aria-label": "保存済み回答の利用実績" },
        metric("累計トークン", usage?.totalTokens),
        metric("最大トークン／回答", usage?.maxTokens),
        metric("生成した回答", usage?.answers, "件"),
        metric("最長連続利用", usage?.longestStreak, "日"),
        metric("現在の連続利用", usage?.currentStreak, "日")
      ),
      input.failed
        ? h(
            "div",
            { class: "home-usage-error", role: "status" },
            "利用統計を読み込めませんでした。",
            h("button", { type: "button", onclick: input.retry }, "再読み込み")
          )
        : usage
          ? activity(usage)
          : h(
              "p",
              { class: "home-note", role: "status" },
              "利用統計を読み込んでいます…"
            ),
      usage
        ? h(
            "section",
            { class: "home-section" },
            h("h2", {}, "よく使うモデル"),
            usage.models.length
              ? h(
                  "ul",
                  { class: "home-models" },
                  ...usage.models
                    .slice(0, 5)
                    .map((model) =>
                      h(
                        "li",
                        {},
                        h("span", { class: "home-model-icon" }, icon("model")),
                        h(
                          "div",
                          {},
                          h("strong", {}, model.label),
                          h(
                            "span",
                            {},
                            number.format(model.answers) +
                              "回答 · " +
                              compact.format(model.tokens) +
                              "トークン"
                          )
                        )
                      )
                    )
                )
              : h(
                  "p",
                  { class: "home-note" },
                  "回答が保存されると、ここに利用実績が表示されます。"
                )
          )
        : null,
      h(
        "section",
        { class: "home-section" },
        h(
          "div",
          { class: "home-section-header" },
          h("h2", {}, "プロジェクト"),
          h(
            "button",
            {
              class: "text-button",
              type: "button",
              onclick: input.createProject,
            },
            icon("plus"),
            "作成"
          )
        ),
        input.projects.length
          ? h(
              "div",
              { class: "home-projects" },
              ...input.projects.slice(0, 4).map((project) =>
                h(
                  "button",
                  {
                    class: "home-project",
                    type: "button",
                    onclick: () => input.openProject(project.id),
                  },
                  icon("folder"),
                  h("span", {}, project.name),
                  icon("arrow")
                )
              )
            )
          : h(
              "p",
              { class: "home-note" },
              "プロジェクトを作って、テーマごとに会話をまとめられます。"
            )
      ),
      h(
        "section",
        { class: "home-section" },
        h("h2", {}, "最近の会話"),
        input.recent.length
          ? h(
              "ul",
              { class: "home-recent" },
              ...input.recent.slice(0, 5).map((conversation) =>
                h(
                  "li",
                  {},
                  h(
                    "button",
                    {
                      type: "button",
                      onclick: () => input.openConversation(conversation.id),
                    },
                    icon("compose"),
                    h("span", {}, conversation.title || "無題の会話"),
                    icon("arrow")
                  )
                )
              )
            )
          : h(
              "p",
              { class: "home-note" },
              "新しいチャットを始めると、ここに会話が並びます。"
            )
      ),
      usage
        ? h(
            "p",
            { class: "home-note home-footnote" },
            "保存済みの完了回答の入力・出力トークンを集計しています。連続利用は今日または昨日までの利用日数です。"
          )
        : null
    )
  );
}
