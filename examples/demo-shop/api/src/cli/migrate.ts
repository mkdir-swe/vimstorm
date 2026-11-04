import { poolFromEnv } from "../db.ts";
import { migrate } from "../migrate.ts";

const pool = poolFromEnv();
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `applied ${applied.join(", ")}` : "migrations up to date");
} finally {
  await pool.end();
}
