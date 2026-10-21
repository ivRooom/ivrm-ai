import { parseArgs } from "node:util";
import { Pool } from "pg";
import { DEFAULT_KEEP_MONTHS, pruneUsage } from "../cost/retention.js";

// Summarizes and deletes old usage_reservations rows (#23). Without --apply it
// only reports. Deleting production rows needs the operator's approval:
//   node dist/ops/usage-retention-cli.js
//   node dist/ops/usage-retention-cli.js --apply --actor <who>

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    actor: { type: "string" },
    "keep-months": { type: "string" },
  },
});
const actor = values.actor?.trim() ?? "";
if (values.apply && !actor) {
  console.error("--actor is required with --apply");
  process.exit(2);
}
const keepMonths = values["keep-months"]
  ? Number(values["keep-months"])
  : DEFAULT_KEEP_MONTHS;

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
try {
  const result = await pruneUsage(pool, {
    now: new Date(),
    keepMonths,
    apply: values.apply,
    actorId: actor,
  });
  const months = result.months.join(", ") || "(none)";
  console.log(
    `${result.applied ? "deleted" : "would delete"} ${result.rows} rows before ${result.cutoff} (months: ${months})`
  );
} finally {
  await pool.end();
}
