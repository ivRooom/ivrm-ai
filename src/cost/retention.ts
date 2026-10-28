import type { Pool } from "pg";
import { monthKey } from "./store.js";

/**
 * Months of raw reservations kept, counting the current one. The cost gate only
 * reads the current month (and open or very recent rows), so older rows are
 * history: they are summed into usage_monthly and deleted (#23). Per-message
 * cost also stays in `messages` and in the `chat.message` audit entries.
 */
export const DEFAULT_KEEP_MONTHS = 3;

/** First month (YYYY-MM) that is kept: `keepMonths - 1` months before `now`'s. */
export function cutoffMonth(now: Date, keepMonths: number): string {
  if (!Number.isInteger(keepMonths) || keepMonths < 2) {
    // The current and the previous month must stay: a month's limit is still
    // being checked, and a late settlement can land just after it ends.
    throw new Error("keepMonths must be an integer of at least 2");
  }
  const [y, m] = monthKey(now).split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) - (keepMonths - 1);
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export type RetentionResult = {
  /** Reservations in months before this one are summarized and deleted. */
  cutoff: string;
  rows: number;
  months: string[];
  applied: boolean;
};

/**
 * Sums closed reservations older than the cutoff into usage_monthly and deletes
 * them, in one transaction, with an audit entry. Open rows are never touched.
 * With `apply: false` it only reports what it would do.
 */
export async function pruneUsage(
  pool: Pool,
  options: { now: Date; keepMonths?: number; apply: boolean; actorId: string }
): Promise<RetentionResult> {
  const cutoff = cutoffMonth(
    options.now,
    options.keepMonths ?? DEFAULT_KEEP_MONTHS
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ month: string; n: string }>(
      `SELECT month, COUNT(*) AS n FROM usage_reservations
        WHERE month < $1 AND status <> 'open'
        GROUP BY month ORDER BY month`,
      [cutoff]
    );
    const result: RetentionResult = {
      cutoff,
      rows: rows.reduce((sum, r) => sum + Number(r.n), 0),
      months: rows.map((r) => r.month),
      applied: false,
    };
    if (!options.apply || result.rows === 0) {
      await client.query("ROLLBACK");
      return result;
    }

    // One statement: the rows summarized are exactly the rows deleted, even if
    // another run or a late settlement changes the table meanwhile. Added to an
    // existing summary row, so a later run (a row closed late) never overwrites
    // what an earlier run already counted.
    const pruned = await client.query<{ month: string; n: string }>(
      `WITH gone AS (
         DELETE FROM usage_reservations
          WHERE month < $1 AND status <> 'open'
          RETURNING month, user_id, status, actual_micro_usd
       ), summary AS (
         INSERT INTO usage_monthly
           (month, user_id, requests, released, charged_micro_usd)
         SELECT month, user_id,
                COUNT(*),
                COUNT(*) FILTER (WHERE status = 'released'),
                COALESCE(SUM(actual_micro_usd) FILTER (WHERE status = 'settled'), 0)
           FROM gone
          GROUP BY month, user_id
         ON CONFLICT (month, user_id) DO UPDATE
           SET requests = usage_monthly.requests + EXCLUDED.requests,
               released = usage_monthly.released + EXCLUDED.released,
               charged_micro_usd =
                 usage_monthly.charged_micro_usd + EXCLUDED.charged_micro_usd,
               updated_at = now()
       )
       SELECT month, COUNT(*) AS n FROM gone GROUP BY month ORDER BY month`,
      [cutoff]
    );
    const applied: RetentionResult = {
      cutoff,
      rows: pruned.rows.reduce((sum, r) => sum + Number(r.n), 0),
      months: pruned.rows.map((r) => r.month),
      applied: true,
    };
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource, detail)
       VALUES ($1, 'usage.prune', 'usage_reservations', $2::jsonb)`,
      [
        options.actorId,
        JSON.stringify({
          cutoff,
          rows: applied.rows,
          months: applied.months,
        }),
      ]
    );
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
