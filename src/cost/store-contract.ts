import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type CostLimits } from "./limits.js";
import type { UsageStore } from "./store.js";

const base: CostLimits = {
  ...DEFAULT_LIMITS,
  perRequestMicroUsd: 1_000_000,
  userDailyMicroUsd: 1000,
  globalMonthlyMicroUsd: 10_000,
  userRequestsPerMinute: 100,
  maxConcurrent: 100,
};

const t0 = new Date("2026-10-16T03:00:00Z");

/** Behaviour every UsageStore must share (in-memory and Postgres). */
export function usageStoreContract(
  name: string,
  make: () => Promise<UsageStore>
) {
  describe(`UsageStore contract: ${name}`, () => {
    const reserve = (
      store: UsageStore,
      over: Partial<{
        userId: string;
        amount: number;
        limits: Partial<CostLimits>;
        now: Date;
      }> = {}
    ) =>
      store.reserve({
        userId: over.userId ?? "u1",
        amountMicroUsd: over.amount ?? 100,
        limits: { ...base, ...over.limits },
        now: over.now ?? t0,
      });

    it("accepts a reservation within limits", async () => {
      const store = await make();
      expect(await reserve(store)).toMatchObject({ ok: true });
    });

    it("counts the reservation, then the actual cost, against the daily limit", async () => {
      const store = await make();
      const first = await reserve(store, { amount: 600 });
      expect(first.ok).toBe(true);
      expect(await reserve(store, { amount: 600 })).toEqual({
        ok: false,
        reason: "user_daily",
      });
      if (first.ok) await store.settle(first.reservationId, 100);
      expect(await reserve(store, { amount: 600 })).toMatchObject({ ok: true });
    });

    it("gives the amount back on release", async () => {
      const store = await make();
      const first = await reserve(store, { amount: 900 });
      if (first.ok) await store.release(first.reservationId);
      expect(await reserve(store, { amount: 900 })).toMatchObject({ ok: true });
    });

    it("ignores a second settle or release of the same reservation", async () => {
      const store = await make();
      const first = await reserve(store, { amount: 500 });
      if (!first.ok) throw new Error("unexpected");
      await store.settle(first.reservationId, 100);
      await store.settle(first.reservationId, 900);
      await store.release(first.reservationId);
      // Still charged 100, so 800 more fits and 1000 does not.
      expect(await reserve(store, { amount: 800 })).toMatchObject({ ok: true });
    });

    it("does not share the daily limit between users", async () => {
      const store = await make();
      await reserve(store, { userId: "a", amount: 900 });
      expect(await reserve(store, { userId: "b", amount: 900 })).toMatchObject({
        ok: true,
      });
    });

    it("enforces the global monthly limit across users", async () => {
      const store = await make();
      const limits = { globalMonthlyMicroUsd: 1000, userDailyMicroUsd: 5000 };
      await reserve(store, { userId: "a", amount: 600, limits });
      expect(
        await reserve(store, { userId: "b", amount: 600, limits })
      ).toEqual({ ok: false, reason: "global_monthly" });
    });

    it("starts a new daily window at Japan midnight", async () => {
      const store = await make();
      const beforeMidnight = new Date("2026-10-16T14:59:00Z"); // 23:59 JST
      const afterMidnight = new Date("2026-10-16T15:01:00Z"); // 00:01 JST
      await reserve(store, { amount: 900, now: beforeMidnight });
      expect(
        await reserve(store, { amount: 900, now: afterMidnight })
      ).toMatchObject({ ok: true });
    });

    it("enforces the per-user rate within a minute only", async () => {
      const store = await make();
      const limits = { userRequestsPerMinute: 2 };
      await reserve(store, { amount: 1, limits });
      await reserve(store, { amount: 1, limits });
      expect(await reserve(store, { amount: 1, limits })).toEqual({
        ok: false,
        reason: "rate",
      });
      const later = new Date(t0.getTime() + 61_000);
      expect(
        await reserve(store, { amount: 1, limits, now: later })
      ).toMatchObject({ ok: true });
    });

    it("enforces concurrency and frees the slot on settle", async () => {
      const store = await make();
      const limits = { maxConcurrent: 1 };
      const first = await reserve(store, { userId: "a", amount: 1, limits });
      expect(await reserve(store, { userId: "b", amount: 1, limits })).toEqual({
        ok: false,
        reason: "concurrency",
      });
      if (first.ok) await store.settle(first.reservationId, 1);
      expect(
        await reserve(store, { userId: "b", amount: 1, limits })
      ).toMatchObject({ ok: true });
    });

    it("never overshoots a limit under parallel reserves", async () => {
      const store = await make();
      // 100 each against a 500 daily limit: exactly 5 may succeed.
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          reserve(store, { amount: 100, limits: { userDailyMicroUsd: 500 } })
        )
      );
      expect(results.filter((r) => r.ok)).toHaveLength(5);
    });
  });
}
