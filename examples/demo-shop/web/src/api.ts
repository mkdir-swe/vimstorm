/** The shop API as the front end sees it. Shapes match `api/src/views.ts`. */

export interface Product {
  id: number;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
}

export interface CartLine {
  productId: number;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Cart {
  id: string;
  lines: CartLine[];
  totalCents: number;
}

export interface ShopApi {
  products(): Promise<Product[]>;
  createCart(): Promise<Cart>;
  /** The cart, or undefined when the API no longer knows it (a reseeded database). */
  cart(id: string): Promise<Cart | undefined>;
  add(cartId: string, productId: number): Promise<Cart>;
  setQuantity(cartId: string, productId: number, quantity: number): Promise<Cart>;
  remove(cartId: string, productId: number): Promise<Cart>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

/** The real API, over `fetch` on the same origin (Vite proxies `/api` in development). */
export const httpApi: ShopApi = {
  products: () => call<Product[]>("/api/products"),
  createCart: () => call<Cart>("/api/carts", { method: "POST" }),
  cart: async (id) => {
    try {
      return await call<Cart>(`/api/carts/${id}`);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
        return undefined;
      }
      throw error;
    }
  },
  add: (cartId, productId) =>
    call<Cart>(`/api/carts/${cartId}/items`, {
      method: "POST",
      body: JSON.stringify({ productId }),
    }),
  setQuantity: (cartId, productId, quantity) =>
    call<Cart>(`/api/carts/${cartId}/items/${productId}`, {
      method: "PUT",
      body: JSON.stringify({ quantity }),
    }),
  remove: (cartId, productId) =>
    call<Cart>(`/api/carts/${cartId}/items/${productId}`, { method: "DELETE" }),
};
