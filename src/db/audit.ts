import type { Pool } from "pg";

export type AuditEntry = {
  actorId: string;
  /** e.g. `conversation.create`, `tool.call`, `cost.settle`. */
  action: string;
  resource?: string;
  /** Small, non-secret facts only. Never message bodies, tokens or cookies. */
  detail?: Record<string, unknown>;
};

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export class PostgresAuditLog implements AuditLog {
  constructor(private readonly pool: Pool) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (actor_id, action, resource, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        entry.actorId,
        entry.action,
        entry.resource ?? "",
        JSON.stringify(entry.detail ?? {}),
      ]
    );
  }
}
