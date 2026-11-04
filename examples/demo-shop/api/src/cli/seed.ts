import { poolFromEnv } from "../db.ts";
import { migrate } from "../migrate.ts";
import { PRODUCTS, seed } from "../seed.ts";

const pool = poolFromEnv();
try {
  await migrate(pool);
  await seed(pool);
  console.log(`seeded ${PRODUCTS.length} products, carts emptied`);
} finally {
  await pool.end();
}
