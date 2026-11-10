import { expect, it } from "vitest";
import { summarizeUsage, type UsageBucket } from "./usage.js";

const bucket = (date: string, tokens: number, modelId = "m1"): UsageBucket => ({
  date,
  modelId,
  tokens,
  maxTokens: tokens,
  answers: 1,
  inputTokens: tokens,
  outputTokens: 0,
});

it("uses JST at midnight and zero-fills exactly 365 days", () => {
  const rows = [
    bucket("2026-11-09", 5),
    bucket("2026-11-10", 12),
    bucket("2026-11-11", 20),
  ];
  const before = summarizeUsage(rows, new Date("2026-11-10T14:59:59Z"));
  const after = summarizeUsage(rows, new Date("2026-11-10T15:00:00Z"));
  expect(before).toMatchObject({ totalTokens: 17, currentStreak: 2 });
  expect(after).toMatchObject({
    totalTokens: 37,
    longestStreak: 3,
    currentStreak: 3,
    activeDays: 3,
  });
  expect(after.daily).toHaveLength(365);
  expect(after.daily[0]).toEqual({ date: "2025-11-12", tokens: 0, answers: 0 });
  expect(after.daily.at(-1)).toEqual({
    date: "2026-11-11",
    tokens: 20,
    answers: 1,
  });
});

it("counts consecutive days once across models and keeps yesterday's streak", () => {
  const result = summarizeUsage(
    [
      bucket("2025-01-01", 90),
      bucket("2026-11-09", 30),
      bucket("2026-11-10", 0),
      bucket("2026-11-10", 60, "m2"),
    ],
    new Date("2026-11-11T03:00:00Z")
  );
  expect(result).toMatchObject({
    totalTokens: 180,
    maxTokens: 90,
    answers: 4,
    longestStreak: 2,
    currentStreak: 2,
    activeDays: 2,
  });
  expect(result.models[0]).toMatchObject({ modelId: "m1", answers: 3 });
});
