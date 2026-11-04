/**
 * The box sizes, smallest first: the box template's `size` options (abe-org's
 * `terraform/modules/teams` lists the same and offers them only up to the largest team's
 * `limits.maxBoxSize`). A box starts at the first. No imports: settings and cloud both read it.
 */
export const BOX_SIZES = [
  'm8g.large',
  'm8g.xlarge',
  'm8g.2xlarge',
  'm8g.4xlarge',
  'm8g.8xlarge',
  'm8g.12xlarge',
  'm8g.16xlarge',
] as const;
export type BoxSize = (typeof BOX_SIZES)[number];

export const DEFAULT_BOX_SIZE = BOX_SIZES[0];

/** Where a size stands among `BOX_SIZES`; -1 for one that is not a box size. */
export const boxSizeRank = (size: string): number => BOX_SIZES.findIndex((s) => s === size);

/** The region the boxes run in, whose prices `BOX_HOURLY_USD` are. */
export const BOX_PRICE_REGION = 'eu-west-1';

/**
 * Each box size's on-demand hourly price in `BOX_PRICE_REGION` (Linux, shared tenancy, USD), from
 * AWS's public price list (`ec2-ondemand-without-sec-sel`, EU (Ireland), published 2026-10-23).
 * Today's cost of a box is an estimate from it, never AWS's bill.
 */
export const BOX_HOURLY_USD: Readonly<Record<BoxSize, number>> = {
  'm8g.large': 0.10004,
  'm8g.xlarge': 0.20008,
  'm8g.2xlarge': 0.40016,
  'm8g.4xlarge': 0.80032,
  'm8g.8xlarge': 1.60064,
  'm8g.12xlarge': 2.40096,
  'm8g.16xlarge': 3.20128,
};

/**
 * gp3's price per GB-month in `BOX_PRICE_REGION` (AWS's public price list, EU (Ireland)): a box's
 * root disk is billed asleep too (ADR 0022).
 */
export const BOX_DISK_GB_MONTH_USD = 0.088;

/** A box's root disk as the box launch template makes it (it grows by itself, ADR 0022). */
export const BOX_ROOT_GB = 60;

/** The hours AWS's monthly prices are of. */
const HOURS_A_MONTH = 730;

/** A root disk of `gb`'s hourly price (`BOX_DISK_GB_MONTH_USD`). */
export const diskHourlyPrice = (gb: number): number =>
  (Math.max(0, gb) * BOX_DISK_GB_MONTH_USD) / HOURS_A_MONTH;

/** A size's hourly price (`BOX_HOURLY_USD`); null for one that is not a box size. */
export const hourlyPrice = (size: string): number | null => {
  const rank = boxSizeRank(size);
  const known = BOX_SIZES[rank];

  return rank === -1 || known === undefined ? null : BOX_HOURLY_USD[known];
};
