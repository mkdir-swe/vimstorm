const euros = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

/** 1450 → "€14.50". */
export function formatPrice(cents: number): string {
  return euros.format(cents / 100);
}
