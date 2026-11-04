import pg from "pg";

/** A pool on `$DATABASE_URL`; throws a clear message when it is not set. */
export function poolFromEnv(): pg.Pool {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set, e.g. postgres://shop:shop@localhost:5432/shop");
  }
  return new pg.Pool({ connectionString: url });
}
