import { describe, expect, it } from "vitest";
import { cartTotal, lineTotal, type CartLine } from "../src/cart.ts";

const tea: CartLine = { productId: 1, name: "Sencha", unitPriceCents: 1250, quantity: 1 };
const mug: CartLine = { productId: 2, name: "Mug", unitPriceCents: 900, quantity: 1 };

describe("lineTotal", () => {
  it("is the unit price times the quantity", () => {
    expect(lineTotal({ ...tea, quantity: 3 })).toBe(3750);
  });
});

describe("cartTotal", () => {
  it("is zero for an empty cart", () => {
    expect(cartTotal([])).toBe(0);
  });

  it("adds up one of each product", () => {
    expect(cartTotal([tea, mug])).toBe(2150);
  });

  // Skipped on purpose: the demo's known bug (card "The cart total ignores quantity").
  // Unskip it with the fix; it is the bug's expected behaviour.
  it.skip("counts each line's quantity (known bug: the total ignores quantity)", () => {
    expect(cartTotal([{ ...tea, quantity: 3 }, mug])).toBe(4650);
  });
});
