import { parseArgs } from "node:util";
import { Pool } from "pg";
import { PostgresKillSwitchStore } from "./kill-switch.js";

// Turns the kill switch on or off without a restart (#22). The running server
// picks the change up within a few seconds. Inside the production container:
//   node dist/ops/kill-switch-cli.js on --actor <who> --reason "<why>"
//   node dist/ops/kill-switch-cli.js off --actor <who> --reason "<why>"
//   node dist/ops/kill-switch-cli.js status

const usage =
  "usage: kill-switch-cli (on|off) --actor <who> --reason <why> | status";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { actor: { type: "string" }, reason: { type: "string" } },
});
const command = positionals[0];
const actor = values.actor?.trim() ?? "";
const reason = values.reason?.trim() ?? "";

if (command !== "on" && command !== "off" && command !== "status") {
  console.error(usage);
  process.exit(2);
}
if (command !== "status" && (!actor || !reason || reason.length > 500)) {
  console.error("--actor and --reason (at most 500 characters) are required");
  console.error(usage);
  process.exit(2);
}

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const store = new PostgresKillSwitchStore(pool);
try {
  if (command !== "status") {
    await store.set({ enabled: command === "on", actorId: actor, reason });
  }
  const on = await store.read();
  console.log(`kill switch (stored): ${on ? "ON" : "off"}`);
  if (process.env["AI_KILL_SWITCH"] === "true") {
    console.log("AI_KILL_SWITCH=true is also set: calls stay refused");
  }
} finally {
  await pool.end();
}
