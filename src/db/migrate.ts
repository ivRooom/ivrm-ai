import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const LOCK_KEY = 7_265_100_001; // arbitrary, unique to ivrm-ai migrations

export type MigrationResult = { applied: string[]; skipped: string[] };

/**
 * Applies `migrations/*.sql` in name order, each in its own transaction, once.
 * Serialized by an advisory lock so two runners cannot race. Run deliberately
 * (`pnpm db:migrate`); production application needs operator approval.
 */
export async function migrate(
  pool: Pool,
  dir: string
): Promise<MigrationResult> {
  const names = (await readdir(dir)).filter((n) => /^\d+_.+\.sql$/.test(n));
  names.sort();

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const done = new Set(
      (await client.query("SELECT name FROM schema_migrations")).rows.map(
        (r: { name: string }) => r.name
      )
    );

    for (const name of names) {
      if (done.has(name)) {
        skipped.push(name);
        continue;
      }
      const sql = await readFile(path.join(dir, name), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          name,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration failed: ${name}`, { cause: error });
      }
      applied.push(name);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
  return { applied, skipped };
}
