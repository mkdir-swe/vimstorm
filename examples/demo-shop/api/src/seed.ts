import type pg from "pg";

interface SeedProduct {
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  stock: number;
}

/** The demo catalogue: a small tea shop. */
export const PRODUCTS: readonly SeedProduct[] = [
  {
    slug: "sencha-fukamushi",
    name: "Sencha Fukamushi",
    description: "Deep-steamed green tea, grassy and sweet. 100 g loose leaf.",
    priceCents: 1450,
    stock: 24,
  },
  {
    slug: "assam-breakfast",
    name: "Assam Breakfast",
    description: "Malty black tea that takes milk well. 125 g loose leaf.",
    priceCents: 990,
    stock: 40,
  },
  {
    slug: "rooibos-vanilla",
    name: "Rooibos Vanilla",
    description: "Caffeine-free red bush with vanilla. 100 g loose leaf.",
    priceCents: 850,
    stock: 3,
  },
  {
    slug: "oolong-milk",
    name: "Milk Oolong",
    description: "Creamy, lightly oxidised Taiwanese oolong. 50 g loose leaf.",
    priceCents: 1890,
    stock: 0,
  },
  {
    slug: "stoneware-mug",
    name: "Stoneware Mug",
    description: "Hand-glazed, 350 ml, dishwasher safe.",
    priceCents: 1600,
    stock: 12,
  },
  {
    slug: "glass-teapot",
    name: "Glass Teapot",
    description: "Borosilicate, 800 ml, with a steel infuser.",
    priceCents: 3200,
    stock: 5,
  },
];

/** Empties the shop and loads the demo catalogue. Carts go too. */
export async function seed(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE cart_items, carts, products RESTART IDENTITY");
    for (const p of PRODUCTS) {
      await client.query(
        `INSERT INTO products (slug, name, description, price_cents, stock)
         VALUES ($1, $2, $3, $4, $5)`,
        [p.slug, p.name, p.description, p.priceCents, p.stock],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
