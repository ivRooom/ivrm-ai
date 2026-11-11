import type { CostLimits } from "./limits.js";

export type LimitReason =
  "user_daily" | "global_monthly" | "rate" | "concurrency";

export type ReserveResult =
  { ok: true; reservationId: string } | { ok: false; reason: LimitReason };

/**
 * Atomic usage accounting. `reserve` must check every limit and record the
 * reservation in one step, so concurrent requests cannot overshoot a limit
 * (a Postgres implementation does this in one transaction).
 */
export interface UsageStore {
  readUserDaily(userId: string, now: Date): Promise<number>;
  reserve(input: {
    userId: string;
    amountMicroUsd: number;
    limits: CostLimits;
    now: Date;
  }): Promise<ReserveResult>;
  /** Replace the reservation by the actual cost and free its concurrency slot. */
  settle(reservationId: string, actualMicroUsd: number): Promise<void>;
  /** Give the reservation back (the provider was never reached). */
  release(reservationId: string): Promise<void>;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Day and month windows follow Japan time (the operators' calendar). */
export function dayKey(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextDayReset(now: Date): string {
  const midnight = Date.parse(dayKey(now) + "T00:00:00+09:00");
  return new Date(midnight + 86_400_000).toISOString();
}

export function monthKey(now: Date): string {
  return dayKey(now).slice(0, 7);
}
