import type { Pool } from "pg";

/** Where the kill switch is kept, so it can change without a restart. */
export interface KillSwitchStore {
  /** `true` when every model call must be refused. A missing row is off. */
  read(): Promise<boolean>;
  /** Changes the switch and records who did it and why, together. */
  set(change: KillSwitchChange): Promise<void>;
}

export type KillSwitchChange = {
  enabled: boolean;
  actorId: string;
  reason: string;
};

export class PostgresKillSwitchStore implements KillSwitchStore {
  constructor(private readonly pool: Pool) {}

  async read(): Promise<boolean> {
    const { rows } = await this.pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM ops_flags WHERE name = 'kill_switch'"
    );
    return rows[0]?.enabled ?? false;
  }

  async set(change: KillSwitchChange): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ops_flags (name, enabled, reason, updated_by, updated_at)
         VALUES ('kill_switch', $1, $2, $3, now())
         ON CONFLICT (name) DO UPDATE
           SET enabled = EXCLUDED.enabled, reason = EXCLUDED.reason,
               updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [change.enabled, change.reason, change.actorId]
      );
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, resource, detail)
         VALUES ($1, $2, 'ops_flags/kill_switch', $3::jsonb)`,
        [
          change.actorId,
          change.enabled ? "ops.kill_switch.on" : "ops.kill_switch.off",
          JSON.stringify({ reason: change.reason }),
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export type KillSwitchOptions = {
  store: KillSwitchStore;
  /** `AI_KILL_SWITCH` from the environment. When true, nothing turns it off. */
  forcedOn: boolean;
  /** How often the store is read. */
  refreshMs?: number;
  /** A value older than this is not trusted, and the switch counts as on. */
  maxAgeMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

export const DEFAULT_REFRESH_MS = 5_000;
export const DEFAULT_MAX_AGE_MS = 30_000;

/**
 * The kill switch the cost gate reads on every call. The stored value is
 * refreshed in the background; `isOn()` stays synchronous and cheap.
 *
 * Fail closed: before the first successful read, or when the store has not
 * answered for `maxAgeMs`, every call is refused.
 */
export class KillSwitch {
  private readonly refreshMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private value: boolean | undefined;
  private readAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: KillSwitchOptions) {
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  isOn(): boolean {
    if (this.options.forcedOn) return true;
    if (this.value === undefined) return true;
    if (this.now() - this.readAt > this.maxAgeMs) return true;
    return this.value;
  }

  /** Reads the store once. A failure keeps the old value until it is too old. */
  async refresh(): Promise<void> {
    try {
      const value = await this.options.store.read();
      if (value !== this.value) {
        console.log(`kill switch (stored): ${value ? "ON" : "off"}`);
      }
      this.value = value;
      this.readAt = this.now();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** Reads once, then keeps refreshing until `stop()`. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
