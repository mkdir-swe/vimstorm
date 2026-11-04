/** One product in a cart, at the product's current price. */
export interface CartLine {
  productId: number;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

/** Most of one product a cart can hold. */
export const MAX_QUANTITY = 99;

export function lineTotal(line: CartLine): number {
  return line.unitPriceCents * line.quantity;
}

/** What the whole cart costs, in cents. */
export function cartTotal(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.unitPriceCents, 0);
}
