import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresUsageStore, STALE_AFTER_MINUTES } from "../cost/pg-store.js";
import { DEFAULT_LIMITS } from "../cost/limits.js";
import { usageStoreContract } from "../cost/store-contract.js";
import { PostgresChatStore } from "../chat/pg-store.js";
import { chatStoreContract } from "../chat/store-contract.js";
import { PostgresAuditLog } from "./audit.js";
import { migrate } from "./migrate.js";
import { PostgresKillSwitchStore } from "../ops/kill-switch.js";
import { pruneUsage } from "../cost/retention.js";

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
      expect(again.skipped).toContain("0002_ops_flags.sql");
      expect(again.skipped).toContain("0003_usage_monthly.sql");
    });
  });

  usageStoreContract("postgres", async () => {
    await pool.query("TRUNCATE usage_reservations");
    return new PostgresUsageStore(pool);
  });

  chatStoreContract("postgres", async () => {
    await pool.query("TRUNCATE projects, conversations, messages CASCADE");
    return new PostgresChatStore(pool);
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
  describe("PostgresKillSwitchStore", () => {
    it("is off without a row, and records every change", async () => {
      await pool.query("TRUNCATE ops_flags, audit_logs");
      const store = new PostgresKillSwitchStore(pool);
      expect(await store.read()).toBe(false);

      await store.set({ enabled: true, actorId: "op1", reason: "cost spike" });
      expect(await store.read()).toBe(true);
      await store.set({ enabled: false, actorId: "op2", reason: "resolved" });
      expect(await store.read()).toBe(false);

      const { rows } = await pool.query(
        `SELECT actor_id, action, resource, detail FROM audit_logs
          WHERE resource = 'ops_flags/kill_switch' ORDER BY id`
      );
      expect(rows).toEqual([
        {
          actor_id: "op1",
          action: "ops.kill_switch.on",
          resource: "ops_flags/kill_switch",
          detail: { reason: "cost spike" },
        },
        {
          actor_id: "op2",
          action: "ops.kill_switch.off",
          resource: "ops_flags/kill_switch",
          detail: { reason: "resolved" },
        },
      ]);
    });

    it("rejects an unknown switch at the database level", async () => {
      await expect(
        pool.query(
          `INSERT INTO ops_flags (name, enabled, updated_by)
           VALUES ('other', true, 'op')`
        )
      ).rejects.toThrow();
    });
  });
  describe("pruneUsage", () => {
    const now = new Date("2026-10-21T03:00:00Z"); // keeps 2026-08 and later

    async function seed() {
      await pool.query(
        "TRUNCATE usage_reservations, usage_monthly, audit_logs"
      );
      await pool.query(
        `INSERT INTO usage_reservations
           (user_id, day, month, amount_micro_usd, actual_micro_usd, status,
            created_at, closed_at)
         VALUES
           ('u1', '2026-06-01', '2026-06', 100, 40, 'settled', now(), now()),
           ('u1', '2026-06-02', '2026-06', 100, NULL, 'released', now(), now()),
           ('u2', '2026-07-03', '2026-07', 300, 250, 'settled', now(), now()),
           ('u1', '2026-08-01', '2026-08', 100, 90, 'settled', now(), now())`
      );
      // A dead process's row from an old month stays until the gate heals it.
      await pool.query(
        `INSERT INTO usage_reservations
           (user_id, day, month, amount_micro_usd, status, created_at)
         VALUES ('u3', '2026-07-31', '2026-07', 50, 'open', now())`
      );
    }

    it("only reports without --apply", async () => {
      await seed();
      const result = await pruneUsage(pool, { now, apply: false, actorId: "" });
      expect(result).toEqual({
        cutoff: "2026-08",
        rows: 3,
        months: ["2026-06", "2026-07"],
        applied: false,
      });
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM usage_reservations"
      );
      expect(rows[0].n).toBe(5);
    });

    it("summarizes, deletes old closed rows and records it", async () => {
      await seed();
      const result = await pruneUsage(pool, {
        now,
        apply: true,
        actorId: "op1",
      });
      expect(result.applied).toBe(true);
      expect(result.rows).toBe(3);

      const left = await pool.query(
        "SELECT month, status FROM usage_reservations ORDER BY month"
      );
      expect(left.rows).toEqual([
        { month: "2026-07", status: "open" },
        { month: "2026-08", status: "settled" },
      ]);
      const summary = await pool.query(
        `SELECT month, user_id, requests, released, charged_micro_usd::int AS charged
           FROM usage_monthly ORDER BY month, user_id`
      );
      expect(summary.rows).toEqual([
        {
          month: "2026-06",
          user_id: "u1",
          requests: 2,
          released: 1,
          charged: 40,
        },
        {
          month: "2026-07",
          user_id: "u2",
          requests: 1,
          released: 0,
          charged: 250,
        },
      ]);
      const audit = await pool.query(
        "SELECT actor_id, action, detail FROM audit_logs"
      );
      expect(audit.rows).toEqual([
        {
          actor_id: "op1",
          action: "usage.prune",
          detail: {
            cutoff: "2026-08",
            rows: 3,
            months: ["2026-06", "2026-07"],
          },
        },
      ]);
    });

    it("adds a late row to an existing summary instead of overwriting it", async () => {
      await seed();
      await pruneUsage(pool, { now, apply: true, actorId: "op1" });
      await pool.query(
        `INSERT INTO usage_reservations
           (user_id, day, month, amount_micro_usd, actual_micro_usd, status,
            created_at, closed_at)
         VALUES ('u1', '2026-06-30', '2026-06', 10, 10, 'settled', now(), now())`
      );
      await pruneUsage(pool, { now, apply: true, actorId: "op1" });
      const { rows } = await pool.query(
        `SELECT requests, charged_micro_usd::int AS charged FROM usage_monthly
          WHERE month = '2026-06' AND user_id = 'u1'`
      );
      expect(rows).toEqual([{ requests: 3, charged: 50 }]);
    });
  });
});
