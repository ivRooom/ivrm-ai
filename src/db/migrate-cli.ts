import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { migrate } from "./migrate.js";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations"
);
const pool = new Pool({ connectionString: url });
try {
  const result = await migrate(pool, dir);
  console.log(
    `applied: ${result.applied.join(", ") || "(none)"}; already applied: ${result.skipped.length}`
  );
} finally {
  await pool.end();
}
