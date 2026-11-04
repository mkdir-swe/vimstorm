import { expect, it } from "vitest";
import { formatPrice } from "../src/money.ts";

it.each([
  [0, "€0.00"],
  [990, "€9.90"],
  [1450, "€14.50"],
  [123456, "€1,234.56"],
])("formats %i cents as %s", (cents, text) => {
  expect(formatPrice(cents)).toBe(text);
});
