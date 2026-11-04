import { useEffect, useRef, useState } from "react";
import type { Cart, ShopApi } from "./api.ts";

const KEY = "demo-shop.cartId";

function storedId(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeId(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // A private window: the cart lasts this page only.
  }
}

export interface CartState {
  cart: Cart | undefined;
  error: string | undefined;
  add: (productId: number) => void;
  /** One more (+1) or one less (−1) of a line; at zero the line goes. */
  step: (productId: number, delta: number) => void;
  remove: (productId: number) => void;
}

/**
 * The visitor's cart: the one this browser had, else a new one. Writes run one after another,
 * each on the cart the one before returned, so quick presses all count.
 */
export function useCart(api: ShopApi): CartState {
  const [cart, setCart] = useState<Cart>();
  const [error, setError] = useState<string>();
  const latest = useRef<Cart | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const show = (next: Cart) => {
    latest.current = next;
    setCart(next);
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const id = storedId();
        const found = id ? await api.cart(id) : undefined;
        const next = found ?? (await api.createCart());
        storeId(next.id);
        if (live) show(next);
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  const run = (write: (current: Cart) => Promise<Cart> | undefined) => {
    queue.current = queue.current.then(async () => {
      const current = latest.current;
      if (!current) return;
      try {
        const next = await write(current);
        if (!next) return;
        setError(undefined);
        show(next);
      } catch (e) {
        setError(String(e));
      }
    });
  };

  return {
    cart,
    error,
    add: (productId) => run((c) => api.add(c.id, productId)),
    step: (productId, delta) =>
      run((c) => {
        const line = c.lines.find((l) => l.productId === productId);
        return line ? api.setQuantity(c.id, productId, line.quantity + delta) : undefined;
      }),
    remove: (productId) => run((c) => api.remove(c.id, productId)),
  };
}
