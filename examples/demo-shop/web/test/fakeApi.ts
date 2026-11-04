import type { Cart, Product, ShopApi } from "../src/api.ts";

export const PRODUCTS: Product[] = [
  { id: 1, slug: "assam", name: "Assam Breakfast", description: "Malty.", priceCents: 990 },
  { id: 2, slug: "mug", name: "Stoneware Mug", description: "350 ml.", priceCents: 1600 },
];

/** An in-memory shop API; the total is whatever `total` says, so tests show what the UI prints. */
export function fakeApi(total: (cart: Cart) => number = sum): ShopApi & { carts: Map<string, Cart> } {
  const carts = new Map<string, Cart>();
  let next = 1;

  const save = (cart: Cart): Cart => {
    const fixed = { ...cart, totalCents: total(cart) };
    carts.set(cart.id, fixed);
    return structuredClone(fixed);
  };
  const get = (id: string): Cart => {
    const cart = carts.get(id);
    if (!cart) throw new Error(`no cart ${id}`);
    return structuredClone(cart);
  };
  const withQuantity = (cart: Cart, productId: number, quantity: number): Cart => {
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) throw new Error(`no product ${productId}`);
    const others = cart.lines.filter((l) => l.productId !== productId);
    const line = {
      productId,
      name: product.name,
      unitPriceCents: product.priceCents,
      quantity,
      lineTotalCents: product.priceCents * quantity,
    };
    const existing = cart.lines.findIndex((l) => l.productId === productId);
    if (quantity === 0) return { ...cart, lines: others };
    const lines = [...cart.lines];
    if (existing >= 0) lines[existing] = line;
    else lines.push(line);
    return { ...cart, lines };
  };

  return {
    carts,
    products: () => Promise.resolve(structuredClone(PRODUCTS)),
    createCart: () => Promise.resolve(save({ id: `cart-${next++}`, lines: [], totalCents: 0 })),
    cart: (id) => Promise.resolve(carts.has(id) ? get(id) : undefined),
    add: (cartId, productId) => {
      const cart = get(cartId);
      const had = cart.lines.find((l) => l.productId === productId)?.quantity ?? 0;
      return Promise.resolve(save(withQuantity(cart, productId, had + 1)));
    },
    setQuantity: (cartId, productId, quantity) =>
      Promise.resolve(save(withQuantity(get(cartId), productId, quantity))),
    remove: (cartId, productId) => Promise.resolve(save(withQuantity(get(cartId), productId, 0))),
  };
}

function sum(cart: Cart): number {
  return cart.lines.reduce((s, l) => s + l.lineTotalCents, 0);
}

/** The same API, each write answering only after a moment, as a real one does. */
export function slow<T extends ShopApi>(api: T, ms = 30): T {
  const later = <R>(value: Promise<R>) =>
    value.then((v) => new Promise<R>((resolve) => setTimeout(() => resolve(v), ms)));
  return {
    ...api,
    add: (cartId, productId) => later(api.add(cartId, productId)),
    setQuantity: (cartId, productId, quantity) =>
      later(api.setQuantity(cartId, productId, quantity)),
    remove: (cartId, productId) => later(api.remove(cartId, productId)),
  };
}
