import type { CostPeriod } from "./api.js";
import { h } from "./dom.js";

const usd = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "code",
  maximumFractionDigits: 6,
});
const money = (microUsd: number) => usd.format(microUsd / 1_000_000);

const modes = [
  { id: "day", label: "日別", current: "今日" },
  { id: "week", label: "週別", current: "今週" },
  { id: "month", label: "月別", current: "今月" },
] as const;

export function costHistory(
  costs: Record<(typeof modes)[number]["id"], CostPeriod[]>
) {
  const content = h("div", { "aria-live": "polite" });
  const controls = h("div", {
    class: "activity-modes",
    role: "group",
    "aria-label": "費用の集計単位",
  });
  const rows = h("tbody");

  function show(mode: (typeof modes)[number]) {
    const periods = costs[mode.id];
    for (const button of controls.querySelectorAll("button")) {
      button.setAttribute(
        "aria-pressed",
        String(button.textContent === mode.label)
      );
    }
    content.replaceChildren(
      h(
        "dl",
        { class: "cost-total" },
        h("dt", {}, mode.current),
        h("dd", {}, money(periods[0]?.costMicroUsd ?? 0))
      )
    );
    rows.replaceChildren(
      ...periods.map((period) =>
        h(
          "tr",
          {},
          h(
            "th",
            { scope: "row" },
            mode.id === "month" ? period.start.slice(0, 7) : period.start
          ),
          h("td", {}, money(period.costMicroUsd))
        )
      )
    );
  }
  for (const mode of modes) {
    controls.append(
      h("button", { type: "button", onclick: () => show(mode) }, mode.label)
    );
  }
  show(modes[0]);
  return h(
    "section",
    { class: "home-section cost-history" },
    h(
      "div",
      { class: "home-section-header" },
      h("h2", {}, "推定利用料金"),
      controls
    ),
    content,
    h(
      "details",
      { class: "activity-details" },
      h("summary", {}, "期間ごとの内訳"),
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { scope: "col" }, "期間の開始"),
            h("th", { scope: "col" }, "推定費用")
          )
        ),
        rows
      )
    ),
    h(
      "p",
      { class: "home-note" },
      "保存済みの回答を生成したときの推定費用です。日本時間・月曜始まり。AWSの請求額とは異なります。"
    )
  );
}
