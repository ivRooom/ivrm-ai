-- ivrm-ai initial schema (#5, #14).
-- Applied only by `pnpm db:migrate`, run deliberately. Never at server start.

-- Projects group conversations and carry shared instructions.
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  instructions text NOT NULL DEFAULT '',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_idx ON projects (owner_id, archived_at);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  project_id uuid REFERENCES projects (id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 300),
  model_id text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner_idx
  ON conversations (owner_id, archived_at, updated_at DESC);
CREATE INDEX conversations_project_idx ON conversations (project_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  model_id text,
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cost_micro_usd bigint CHECK (cost_micro_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, seq);

-- Cost gate bookkeeping (src/cost). Amounts are integer micro-USD. Sums are
-- computed from rows, not kept in counters, so they cannot drift.
CREATE TABLE usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  -- Japan-time windows, computed by the application.
  day date NOT NULL,
  month char(7) NOT NULL,
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd >= 0),
  actual_micro_usd bigint CHECK (actual_micro_usd >= 0),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'settled', 'released')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'settled') = (actual_micro_usd IS NOT NULL))
);
CREATE INDEX usage_user_day_idx ON usage_reservations (user_id, day);
CREATE INDEX usage_month_idx ON usage_reservations (month);
CREATE INDEX usage_open_idx ON usage_reservations (created_at)
  WHERE status = 'open';
CREATE INDEX usage_user_recent_idx ON usage_reservations (user_id, created_at);

-- Append-only record of who did what (conversation start, tool calls, writes,
-- cost settlement). No secrets or message bodies in `detail`.
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, at DESC);
