import type { Usage } from "./api.js";
import { h } from "./dom.js";

const usd = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "code",
  maximumFractionDigits: 6,
});

export function dailyBudget(
  budget: NonNullable<Usage["dailyBudget"]>,
  asOf: string
) {
  const money = (amount: number) => usd.format(amount / 1_000_000);
  const minutes = Math.max(
    0,
    Math.ceil((Date.parse(budget.resetsAt) - Date.parse(asOf)) / 60_000)
  );
  const remainingTime =
    minutes >= 60
      ? Math.floor(minutes / 60) + "時間" + (minutes % 60) + "分"
      : minutes + "分";
  return h(
    "section",
    { class: "home-section" },
    h("h2", {}, "今日の利用枠"),
    h(
      "dl",
      { class: "cost-total" },
      h("dt", {}, "推論予算の残り"),
      h(
        "dd",
        {},
        money(budget.remainingMicroUsd) + " / " + money(budget.limitMicroUsd)
      )
    ),
    h("progress", {
      value: String(Math.min(budget.limitMicroUsd, budget.usedMicroUsd)),
      max: String(budget.limitMicroUsd),
      "aria-label": "日次の推論予算の使用状況",
    }),
    h(
      "p",
      { class: "home-note" },
      "取得時点でリセットまで約" +
        remainingTime +
        "（日本時間 0:00）。使用額には処理中の予約を含みます。"
    ),
    h("p", { class: "home-note" }, "メンバーのトークン上限は未設定です。")
  );
}
