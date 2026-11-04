/** The API's JSON shapes. */

import type { Refusal } from "./store.ts";

export interface ProductView {
  id: number;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
}

export interface CartLineView {
  productId: number;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface CartView {
  id: string;
  lines: CartLineView[];
  totalCents: number;
}

export interface ErrorView {
  error: Refusal;
}
