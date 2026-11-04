import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * Applies the `migrations/*.sql` files not yet in `schema_migrations`, in name order, each in its
 * own transaction. Returns the names it applied.
 */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
      (r) => r.name,
    ),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(`${dir}/${file}`, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed`, { cause: error });
    } finally {
      client.release();
    }
    applied.push(file);
  }
  return applied;
}
