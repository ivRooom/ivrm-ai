import type { Pool } from "pg";
import type { CostLimits } from "./limits.js";
import {
  dayKey,
  monthKey,
  type ReserveResult,
  type UsageStore,
} from "./store.js";

const RESERVE_LOCK_KEY = 7_265_100_002; // serializes every reserve (see below)

/** An open reservation older than this is treated as a dead process. */
export const STALE_AFTER_MINUTES = 15;

/**
 * Postgres-backed store shared by every ivrm-ai process.
 *
 * `reserve` runs in one transaction under a global advisory lock, so the
 * checks and the insert cannot interleave with another reserve: concurrent
 * requests cannot overshoot a limit. The lock serializes reserves only (a short
 * transaction), which is fine at this scale. Sums are recomputed from rows.
 */
export class PostgresUsageStore implements UsageStore {
  constructor(private readonly pool: Pool) {}

  async reserve(input: {
    userId: string;
    amountMicroUsd: number;
    limits: CostLimits;
    now: Date;
  }): Promise<ReserveResult> {
    const { userId, amountMicroUsd, limits, now } = input;
    const day = dayKey(now);
    const month = monthKey(now);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        RESERVE_LOCK_KEY,
      ]);

      // Self-heal: a process that died mid-call leaves an open row. Charge it
      // in full (usage unknown) and free its concurrency slot.
      await client.query(
        `UPDATE usage_reservations
            SET status = 'settled', actual_micro_usd = amount_micro_usd,
                closed_at = $1
          WHERE status = 'open'
            AND created_at < $1::timestamptz - make_interval(mins => $2)`,
        [now, STALE_AFTER_MINUTES]
      );

      const { rows } = await client.query(
        `SELECT
           COALESCE(SUM(COALESCE(actual_micro_usd, amount_micro_usd))
             FILTER (WHERE status <> 'released' AND user_id = $1 AND day = $2),
             0) AS user_daily,
           COALESCE(SUM(COALESCE(actual_micro_usd, amount_micro_usd))
             FILTER (WHERE status <> 'released' AND month = $3), 0)
             AS global_monthly,
           COUNT(*) FILTER (WHERE status = 'open') AS in_flight,
           COUNT(*) FILTER (
             WHERE user_id = $1
               AND created_at > $4::timestamptz - interval '1 minute') AS recent
         FROM usage_reservations
         WHERE month = $3 OR status = 'open'
            OR created_at > $4::timestamptz - interval '1 minute'`,
        [userId, day, month, now]
      );
      const row = rows[0] as Record<string, string>;
      const userDaily = Number(row["user_daily"]);
      const globalMonthly = Number(row["global_monthly"]);
      const inFlight = Number(row["in_flight"]);
      const recent = Number(row["recent"]);

      const refuse = async (
        reason: "rate" | "concurrency" | "user_daily" | "global_monthly"
      ): Promise<ReserveResult> => {
        await client.query("ROLLBACK");
        return { ok: false, reason };
      };

      if (recent >= limits.userRequestsPerMinute) return refuse("rate");
      if (inFlight >= limits.maxConcurrent) return refuse("concurrency");
      if (userDaily + amountMicroUsd > limits.userDailyMicroUsd) {
        return refuse("user_daily");
      }
      if (globalMonthly + amountMicroUsd > limits.globalMonthlyMicroUsd) {
        return refuse("global_monthly");
      }

      const inserted = await client.query(
        `INSERT INTO usage_reservations
           (user_id, day, month, amount_micro_usd, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, day, month, amountMicroUsd, now]
      );
      await client.query("COMMIT");
      return { ok: true, reservationId: inserted.rows[0].id as string };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async settle(reservationId: string, actualMicroUsd: number): Promise<void> {
    await this.pool.query(
      `UPDATE usage_reservations
          SET status = 'settled', actual_micro_usd = $2, closed_at = now()
        WHERE id = $1 AND status = 'open'`,
      [reservationId, actualMicroUsd]
    );
  }

  async release(reservationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE usage_reservations
          SET status = 'released', closed_at = now()
        WHERE id = $1 AND status = 'open'`,
      [reservationId]
    );
  }
}
