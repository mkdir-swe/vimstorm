import { buildApp } from "./app.ts";
import { poolFromEnv } from "./db.ts";

const port = Number(process.env["API_PORT"] ?? 3001);
const host = process.env["API_HOST"] ?? "127.0.0.1";

const pool = poolFromEnv();
const app = buildApp({ pool, logger: true });

const stop = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

await app.listen({ port, host });
