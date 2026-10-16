import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresUsageStore, STALE_AFTER_MINUTES } from "../cost/pg-store.js";
import { DEFAULT_LIMITS } from "../cost/limits.js";
import { usageStoreContract } from "../cost/store-contract.js";
import { PostgresAuditLog } from "./audit.js";
import { migrate } from "./migrate.js";

// Runs against a real Postgres. Set TEST_DATABASE_URL to a throwaway database
// whose name contains "test": the suite drops and recreates the public schema.
const url = process.env["TEST_DATABASE_URL"];
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations"
);

describe.skipIf(!url)("postgres", () => {
  let pool: Pool;

  beforeAll(async () => {
    const dbName = new URL(url!).pathname;
    if (!dbName.includes("test")) {
      throw new Error("refusing to reset a database whose name lacks 'test'");
    }
    pool = new Pool({ connectionString: url!, max: 20 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("migrate", () => {
    it("is idempotent", async () => {
      const again = await migrate(pool, migrationsDir);
      expect(again.applied).toEqual([]);
      expect(again.skipped).toContain("0001_init.sql");
    });
  });

  usageStoreContract("postgres", async () => {
    await pool.query("TRUNCATE usage_reservations");
    return new PostgresUsageStore(pool);
  });

  describe("PostgresUsageStore", () => {
    const limits = {
      ...DEFAULT_LIMITS,
      perRequestMicroUsd: 1_000_000,
      userDailyMicroUsd: 1000,
      userRequestsPerMinute: 100,
      maxConcurrent: 1,
    };
    const t0 = new Date("2026-10-16T03:00:00Z");

    it("frees a dead process's slot and charges it in full", async () => {
      await pool.query("TRUNCATE usage_reservations");
      const store = new PostgresUsageStore(pool);
      const dead = await store.reserve({
        userId: "u1",
        amountMicroUsd: 700,
        limits,
        now: t0,
      });
      expect(dead.ok).toBe(true);

      const later = new Date(t0.getTime() + (STALE_AFTER_MINUTES + 1) * 60_000);
      // The slot is free again, but the 700 stays charged (usage unknown).
      expect(
        await store.reserve({
          userId: "u1",
          amountMicroUsd: 400,
          limits,
          now: later,
        })
      ).toEqual({ ok: false, reason: "user_daily" });
      expect(
        await store.reserve({
          userId: "u1",
          amountMicroUsd: 300,
          limits,
          now: later,
        })
      ).toMatchObject({ ok: true });
    });

    it("rejects an inconsistent row at the database level", async () => {
      await expect(
        pool.query(
          `INSERT INTO usage_reservations
             (user_id, day, month, amount_micro_usd, status, created_at)
           VALUES ('u', '2026-10-16', '2026-10', 1, 'settled', now())`
        )
      ).rejects.toThrow();
    });
  });

  describe("PostgresAuditLog", () => {
    it("records an entry", async () => {
      await new PostgresAuditLog(pool).record({
        actorId: "u1",
        action: "conversation.create",
        resource: "conversation/1",
        detail: { model: "m1" },
      });
      const { rows } = await pool.query(
        "SELECT actor_id, action, resource, detail FROM audit_logs"
      );
      expect(rows).toEqual([
        {
          actor_id: "u1",
          action: "conversation.create",
          resource: "conversation/1",
          detail: { model: "m1" },
        },
      ]);
    });
  });
});
