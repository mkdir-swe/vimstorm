import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { CartView, ProductView } from "../src/views.ts";
import { testDb, type TestDb } from "./db.ts";

let db: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  db = await testDb();
  app = buildApp({ pool: db.pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

async function products(): Promise<ProductView[]> {
  const res = await app.inject({ method: "GET", url: "/api/products" });
  expect(res.statusCode).toBe(200);
  return res.json<ProductView[]>();
}

async function newCart(): Promise<CartView> {
  const res = await app.inject({ method: "POST", url: "/api/carts" });
  expect(res.statusCode).toBe(201);
  return res.json<CartView>();
}

async function add(cartId: string, productId: number, quantity?: number) {
  return app.inject({
    method: "POST",
    url: `/api/carts/${cartId}/items`,
    payload: quantity === undefined ? { productId } : { productId, quantity },
  });
}

function product(list: ProductView[], slug: string): ProductView {
  const found = list.find((p) => p.slug === slug);
  if (!found) throw new Error(`no product ${slug}`);
  return found;
}

describe("health", () => {
  it("answers ok when the database does", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("products", () => {
  it("lists the seeded products by name with their prices", async () => {
    const list = await products();
    expect(list.length).toBeGreaterThanOrEqual(6);
    const names = list.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(product(list, "sencha-fukamushi")).toMatchObject({
      name: "Sencha Fukamushi",
      priceCents: 1450,
    });
  });
});

describe("carts", () => {
  it("starts empty", async () => {
    const cart = await newCart();
    expect(cart).toMatchObject({ lines: [], totalCents: 0 });
    const res = await app.inject({ method: "GET", url: `/api/carts/${cart.id}` });
    expect(res.json()).toEqual(cart);
  });

  it("adds a product, and adding it again raises its quantity", async () => {
    const list = await products();
    const sencha = product(list, "sencha-fukamushi");
    const cart = await newCart();

    expect((await add(cart.id, sencha.id)).statusCode).toBe(200);
    const res = await add(cart.id, sencha.id, 2);
    const view = res.json<CartView>();
    expect(view.lines).toEqual([
      {
        productId: sencha.id,
        name: sencha.name,
        unitPriceCents: 1450,
        quantity: 3,
        lineTotalCents: 4350,
      },
    ]);
  });

  it("totals one of each product", async () => {
    const list = await products();
    const sencha = product(list, "sencha-fukamushi");
    const mug = product(list, "stoneware-mug");
    const cart = await newCart();
    await add(cart.id, sencha.id);
    const view = (await add(cart.id, mug.id)).json<CartView>();
    expect(view.totalCents).toBe(sencha.priceCents + mug.priceCents);
  });

  it("sets a line's quantity, and zero takes it out", async () => {
    const [first] = await products();
    if (!first) throw new Error("no products");
    const cart = await newCart();
    await add(cart.id, first.id);

    const set = await app.inject({
      method: "PUT",
      url: `/api/carts/${cart.id}/items/${first.id}`,
      payload: { quantity: 5 },
    });
    expect(set.json<CartView>().lines[0]?.quantity).toBe(5);

    const zero = await app.inject({
      method: "PUT",
      url: `/api/carts/${cart.id}/items/${first.id}`,
      payload: { quantity: 0 },
    });
    expect(zero.json<CartView>().lines).toEqual([]);
  });

  it("removes a line", async () => {
    const [first] = await products();
    if (!first) throw new Error("no products");
    const cart = await newCart();
    await add(cart.id, first.id);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/carts/${cart.id}/items/${first.id}`,
    });
    expect(res.json<CartView>().lines).toEqual([]);
  });

  it("refuses an unknown cart, an unknown product and a bad quantity", async () => {
    const cart = await newCart();
    const missing = await app.inject({
      method: "GET",
      url: "/api/carts/00000000-0000-4000-8000-000000000000",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "cart-not-found" });

    const notUuid = await app.inject({ method: "GET", url: "/api/carts/nope" });
    expect(notUuid.statusCode).toBe(400);

    const unknown = await add(cart.id, 999_999);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "product-not-found" });

    const tooMany = await add(cart.id, (await products())[0]?.id ?? 0, 100);
    expect(tooMany.statusCode).toBe(400);
  });

  it("keeps a line at 99 at most", async () => {
    const [first] = await products();
    if (!first) throw new Error("no products");
    const cart = await newCart();
    await add(cart.id, first.id, 60);
    const res = await add(cart.id, first.id, 60);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "quantity-limit" });
  });
});
