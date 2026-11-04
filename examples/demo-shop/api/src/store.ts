import type pg from "pg";
import { MAX_QUANTITY, type CartLine } from "./cart.ts";
import type { ProductView } from "./views.ts";

export type Refusal = "cart-not-found" | "product-not-found" | "quantity-limit";
export type Outcome = { ok: true } | { ok: false; refusal: Refusal };

const ok: Outcome = { ok: true };
const refused = (refusal: Refusal): Outcome => ({ ok: false, refusal });

/** The shop's rows: products, carts and what is in them. */
export class Store {
  constructor(private readonly pool: pg.Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async products(): Promise<ProductView[]> {
    const { rows } = await this.pool.query<ProductView>(
      `SELECT id, slug, name, description, price_cents AS "priceCents"
         FROM products ORDER BY name`,
    );
    return rows;
  }

  async createCart(): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      "INSERT INTO carts DEFAULT VALUES RETURNING id",
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("no cart id returned");
    return id;
  }

  /** The cart's lines, oldest first, or undefined for no such cart. */
  async lines(cartId: string): Promise<CartLine[] | undefined> {
    if (!(await this.cartExists(cartId))) return undefined;
    const { rows } = await this.pool.query<CartLine>(
      `SELECT p.id AS "productId", p.name, p.price_cents AS "unitPriceCents", i.quantity
         FROM cart_items i JOIN products p ON p.id = i.product_id
        WHERE i.cart_id = $1
        ORDER BY i.added_at, p.name`,
      [cartId],
    );
    return rows;
  }

  /** Puts `quantity` more of a product in the cart. */
  async add(cartId: string, productId: number, quantity: number): Promise<Outcome> {
    const missing = await this.missing(cartId, productId);
    if (missing) return refused(missing);
    const { rowCount } = await this.pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
       WHERE cart_items.quantity + EXCLUDED.quantity <= $4`,
      [cartId, productId, quantity, MAX_QUANTITY],
    );
    return rowCount === 0 ? refused("quantity-limit") : ok;
  }

  /** Sets a line's quantity; zero takes the product out. */
  async set(cartId: string, productId: number, quantity: number): Promise<Outcome> {
    if (quantity === 0) return this.remove(cartId, productId);
    const missing = await this.missing(cartId, productId);
    if (missing) return refused(missing);
    await this.pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cartId, productId, quantity],
    );
    return ok;
  }

  async remove(cartId: string, productId: number): Promise<Outcome> {
    if (!(await this.cartExists(cartId))) return refused("cart-not-found");
    await this.pool.query("DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2", [
      cartId,
      productId,
    ]);
    return ok;
  }

  private async cartExists(cartId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("SELECT 1 FROM carts WHERE id = $1", [cartId]);
    return rowCount === 1;
  }

  private async missing(cartId: string, productId: number): Promise<Refusal | undefined> {
    if (!(await this.cartExists(cartId))) return "cart-not-found";
    const { rowCount } = await this.pool.query("SELECT 1 FROM products WHERE id = $1", [
      productId,
    ]);
    return rowCount === 1 ? undefined : "product-not-found";
  }
}
