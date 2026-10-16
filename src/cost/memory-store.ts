import { randomUUID } from "node:crypto";
import {
  dayKey,
  monthKey,
  type ReserveResult,
  type UsageStore,
} from "./store.js";
import type { CostLimits } from "./limits.js";

type Reservation = {
  userId: string;
  amount: number;
  day: string;
  month: string;
  open: boolean;
};

const MINUTE_MS = 60_000;

/** In-memory store for tests and local development. Not shared across processes. */
export class InMemoryUsageStore implements UsageStore {
  private readonly userDaily = new Map<string, number>();
  private readonly globalMonthly = new Map<string, number>();
  private readonly recent = new Map<string, number[]>();
  private readonly reservations = new Map<string, Reservation>();
  private inFlight = 0;

  async reserve(input: {
    userId: string;
    amountMicroUsd: number;
    limits: CostLimits;
    now: Date;
  }): Promise<ReserveResult> {
    const { userId, amountMicroUsd, limits, now } = input;
    const day = dayKey(now);
    const month = monthKey(now);
    const nowMs = now.getTime();

    const stamps = (this.recent.get(userId) ?? []).filter(
      (t) => nowMs - t < MINUTE_MS
    );
    if (stamps.length >= limits.userRequestsPerMinute) {
      return { ok: false, reason: "rate" };
    }
    if (this.inFlight >= limits.maxConcurrent) {
      return { ok: false, reason: "concurrency" };
    }
    const userKey = `${userId}|${day}`;
    if (
      (this.userDaily.get(userKey) ?? 0) + amountMicroUsd >
      limits.userDailyMicroUsd
    ) {
      return { ok: false, reason: "user_daily" };
    }
    if (
      (this.globalMonthly.get(month) ?? 0) + amountMicroUsd >
      limits.globalMonthlyMicroUsd
    ) {
      return { ok: false, reason: "global_monthly" };
    }

    stamps.push(nowMs);
    this.recent.set(userId, stamps);
    this.add(userKey, month, amountMicroUsd);
    this.inFlight += 1;

    const reservationId = randomUUID();
    this.reservations.set(reservationId, {
      userId,
      amount: amountMicroUsd,
      day,
      month,
      open: true,
    });
    return { ok: true, reservationId };
  }

  async settle(reservationId: string, actualMicroUsd: number): Promise<void> {
    const reservation = this.close(reservationId);
    if (!reservation) return;
    this.add(
      `${reservation.userId}|${reservation.day}`,
      reservation.month,
      actualMicroUsd - reservation.amount
    );
  }

  async release(reservationId: string): Promise<void> {
    const reservation = this.close(reservationId);
    if (!reservation) return;
    this.add(
      `${reservation.userId}|${reservation.day}`,
      reservation.month,
      -reservation.amount
    );
  }

  /** Test helper. */
  usage(userId: string, now: Date) {
    return {
      userDaily: this.userDaily.get(`${userId}|${dayKey(now)}`) ?? 0,
      globalMonthly: this.globalMonthly.get(monthKey(now)) ?? 0,
      inFlight: this.inFlight,
    };
  }

  private close(reservationId: string): Reservation | undefined {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || !reservation.open) return undefined;
    reservation.open = false;
    this.inFlight -= 1;
    return reservation;
  }

  private add(userKey: string, month: string, delta: number) {
    this.userDaily.set(userKey, (this.userDaily.get(userKey) ?? 0) + delta);
    this.globalMonthly.set(month, (this.globalMonthly.get(month) ?? 0) + delta);
  }
}
