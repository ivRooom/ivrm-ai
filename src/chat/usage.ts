import { dayKey } from "../cost/store.js";

export type UsageBucket = {
  date: string;
  modelId: string;
  answers: number;
  tokens: number;
  maxTokens: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
};

/** Stored completed answers only: excludes copied history and failed/unknown reservations. */
export function summarizeUsage(buckets: UsageBucket[], now: Date) {
  const today = dayKey(now);
  const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
  const start = dayMs(today) - 364 * 86_400_000;
  const costs = summarizeCosts(buckets, today);
  const days = new Map<
    string,
    { date: string; tokens: number; answers: number }
  >();
  const models = new Map<
    string,
    { modelId: string; tokens: number; answers: number }
  >();
  let totalTokens = 0,
    maxTokens = 0,
    answers = 0,
    inputTokens = 0,
    outputTokens = 0;
  for (const b of buckets) {
    if (b.date > today) continue;
    totalTokens += b.tokens;
    answers += b.answers;
    maxTokens = Math.max(maxTokens, b.maxTokens);
    inputTokens += b.inputTokens;
    outputTokens += b.outputTokens;
    const day = days.get(b.date) ?? { date: b.date, tokens: 0, answers: 0 };
    day.tokens += b.tokens;
    day.answers += b.answers;
    days.set(b.date, day);
    const model = models.get(b.modelId) ?? {
      modelId: b.modelId,
      tokens: 0,
      answers: 0,
    };
    model.tokens += b.tokens;
    model.answers += b.answers;
    models.set(b.modelId, model);
  }
  const active = [...days.values()]
    .filter((d) => d.answers > 0 && dayMs(d.date) >= start)
    .map((d) => d.date)
    .sort();
  let longestStreak = 0,
    run = 0,
    previous = -Infinity;
  for (const day of active) {
    const at = dayMs(day);
    run = at - previous === 86_400_000 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = at;
  }
  let cursor = dayMs(today);
  if (!days.has(today)) cursor -= 86_400_000;
  let currentStreak = 0;
  while (
    cursor >= start &&
    days.get(new Date(cursor).toISOString().slice(0, 10))?.answers
  ) {
    currentStreak++;
    cursor -= 86_400_000;
  }
  const daily = Array.from({ length: 365 }, (_, i) => {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    return days.get(date) ?? { date, tokens: 0, answers: 0 };
  });
  return {
    asOf: now.toISOString(),
    timezone: "Asia/Tokyo",
    basis: "stored-completed-responses",
    totalTokens,
    maxTokens,
    answers,
    inputTokens,
    outputTokens,
    longestStreak,
    currentStreak,
    activeDays: daily.filter((d) => d.answers > 0).length,
    daily,
    costs,
    models: [...models.values()].sort(
      (a, b) => b.answers - a.answers || a.modelId.localeCompare(b.modelId)
    ),
  };
}

function summarizeCosts(buckets: UsageBucket[], today: string) {
  const date = new Date(today + "T00:00:00Z");
  const at = (offset: number) =>
    new Date(date.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const monday = -((date.getUTCDay() + 6) % 7);
  const group = (starts: string[]) => {
    const periods = starts.map((start) => ({ start, costMicroUsd: 0 }));
    for (const bucket of buckets) {
      if (bucket.date > today) continue;
      const period = periods.find(({ start }) => start <= bucket.date);
      if (period) period.costMicroUsd += bucket.costMicroUsd;
    }
    return periods;
  };
  return {
    day: group(Array.from({ length: 7 }, (_, i) => at(-i))),
    week: group(Array.from({ length: 8 }, (_, i) => at(monday - 7 * i))),
    month: group(
      Array.from({ length: 12 }, (_, i) =>
        new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - i, 1))
          .toISOString()
          .slice(0, 10)
      )
    ),
  };
}
