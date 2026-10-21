-- Operational switches read by the running server (#22).
-- Applied only by `pnpm db:migrate`, run deliberately. Never at server start.

-- One row per switch. A missing row means the switch is off. Every change is
-- written together with an audit_logs entry (src/ops/kill-switch.ts).
CREATE TABLE ops_flags (
  name text PRIMARY KEY CHECK (name IN ('kill_switch')),
  enabled boolean NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
