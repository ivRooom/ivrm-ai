-- Monthly usage summary, so old usage_reservations rows can be deleted (#23).
-- Applied only by `pnpm db:migrate`, run deliberately. Never at server start.

-- One row per (Japan-time) month and user. Filled by the retention job
-- (src/cost/retention.ts) from closed reservations just before it deletes them.
-- Amounts are integer micro-USD, charged as the cost gate counted them.
CREATE TABLE usage_monthly (
  month char(7) NOT NULL,
  user_id text NOT NULL,
  requests integer NOT NULL CHECK (requests >= 0),
  released integer NOT NULL CHECK (released >= 0),
  charged_micro_usd bigint NOT NULL CHECK (charged_micro_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, user_id)
);
