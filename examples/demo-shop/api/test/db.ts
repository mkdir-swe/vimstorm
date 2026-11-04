import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/migrate.ts";
import { seed } from "../src/seed.ts";

/** The database the tests use: `TEST_DATABASE_URL`, else `DATABASE_URL`. */
function databaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "The API tests need Postgres: set DATABASE_URL (or TEST_DATABASE_URL), e.g. " +
        "postgres://shop:shop@localhost:5432/shop",
    );
  }
  return url;
}

export interface TestDb {
  pool: pg.Pool;
  drop(): Promise<void>;
}

/**
 * A schema of its own in the test database, migrated and seeded, so test files never see each
 * other's rows. Only needs CREATE on the database, not CREATEDB.
 */
export async function testDb(): Promise<TestDb> {
  const url = databaseUrl();
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  await migrate(pool);
  await seed(pool);
  return {
    pool,
    async drop() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
