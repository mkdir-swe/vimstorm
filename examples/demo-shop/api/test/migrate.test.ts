import { readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { seed } from "../src/seed.ts";
import { testDb, type TestDb } from "./db.ts";

let db: TestDb;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.drop();
});

it("applies each migration once", async () => {
  expect(await migrate(db.pool)).toEqual([]);
  const { rows } = await db.pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  expect(rows.map((r) => r.name)).toEqual(files);
});

it("seeds again from scratch, emptying carts", async () => {
  await db.pool.query("INSERT INTO carts DEFAULT VALUES");
  await seed(db.pool);
  const carts = await db.pool.query("SELECT 1 FROM carts");
  const products = await db.pool.query("SELECT 1 FROM products");
  expect(carts.rowCount).toBe(0);
  expect(products.rowCount).toBe(6);
});
