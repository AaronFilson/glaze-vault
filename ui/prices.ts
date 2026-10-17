// What materials cost, and so what a recipe costs (docs/adr/0015-chemistry-tools.md). Prices are
// per kilogram or per pound of the dry material, in whatever currency the person writes.
import { usableLines, type BatchUnit } from './batch';
import { normalize, numberOf, type RecipeLine } from './chemistry';

export interface PriceLine {
  material: string;
  price: string;
}

/** What the core keeps for the price list. */
export interface PricesContent {
  /** As it is written before an amount: $, €, £, kr. */
  currency: string;
  unit: 'kg' | 'lb';
  prices: PriceLine[];
}

export const EMPTY_PRICES: PricesContent = { currency: '$', unit: 'kg', prices: [] };

export interface RecipeCost {
  /** For one kg or lb of the dry batch, additions and all, from the materials that have prices. */
  perUnit: number;
  /** Materials with no price, left out. */
  missing: string[];
}

/** A recipe's cost per unit of its dry batch; null if none of its materials has a price. */
export function recipeCost(lines: RecipeLine[], list: PricesContent | null): RecipeCost | null {
  if (!list) return null;
  const prices = priceMap(list);
  const usable = usableLines(lines);
  const total = usable.reduce((sum, line) => sum + line.amount, 0);
  if (!total) return null;
  let perUnit = 0;
  let priced = 0;
  const missing: string[] = [];
  for (const line of usable) {
    const price = prices.get(normalize(line.material));
    if (price === undefined) {
      if (!missing.includes(line.material)) missing.push(line.material);
    } else {
      perUnit += (line.amount / total) * price;
      priced += 1;
    }
  }
  return priced ? { perUnit, missing } : null;
}

/** The price list a recipe in `collection` is costed by: that collection's own, or else the newest
 * this person can open. `lists` are newest first, as the core lists them. */
export function priceListFor<List extends { collectionId?: string }>(
  lists: List[],
  collection: string | null | undefined
): List | null {
  return lists.find((list) => !!collection && list.collectionId === collection) ?? lists[0] ?? null;
}

/** Each material's price, by its name as recipes are matched to materials. */
function priceMap(list: PricesContent): Map<string, number> {
  const prices = new Map<string, number>();
  for (const line of list.prices) {
    const price = numberOf(line.price);
    if (line.material.trim() && price !== null && price >= 0) prices.set(normalize(line.material), price);
  }
  return prices;
}

/** How many of the price list's unit one unit of a batch weighs. */
const PER: Record<PricesContent['unit'], Record<BatchUnit, number>> = {
  kg: { g: 0.001, kg: 1, lb: 0.45359237, oz: 0.028349523125 },
  lb: { g: 1 / 453.59237, kg: 1 / 0.45359237, lb: 1, oz: 1 / 16 }
};

export interface BatchCosts {
  /** Each line's cost, in the batch's order; null for a material with no price. */
  lines: (number | null)[];
  total: number;
  missing: string[];
}

/** What each weighed line of a batch costs; null if none of its materials has a price. */
export function batchCosts(
  lines: { material: string; weight: number }[],
  unit: BatchUnit,
  list: PricesContent | null
): BatchCosts | null {
  if (!list) return null;
  const prices = priceMap(list);
  const missing: string[] = [];
  const costs = lines.map((line) => {
    const price = prices.get(normalize(line.material));
    if (price === undefined) {
      if (!missing.includes(line.material)) missing.push(line.material);
      return null;
    }
    return line.weight * PER[list.unit][unit] * price;
  });
  if (costs.every((cost) => cost === null)) return null;
  return { lines: costs, total: costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0), missing };
}

/** An amount of money as the list writes it: "$2.31". */
export function money(amount: number, list: PricesContent): string {
  const places = amount < 1 ? 3 : 2;
  const text = amount.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places });
  const currency = list.currency.trim();
  return currency.length > 1 && /^[A-Za-z]+$/.test(currency) ? `${text} ${currency}` : `${currency}${text}`;
}
