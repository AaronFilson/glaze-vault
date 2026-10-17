// What materials cost, and so what a recipe costs (docs/adr/0015-chemistry-tools.md). Prices are
// per kilogram or per pound of the dry material, in whatever currency the person writes.
import { usableLines } from './batch';
import { normalize, type RecipeLine } from './chemistry';

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
  const prices = new Map<string, number>();
  for (const line of list.prices) {
    const price = Number(line.price.trim().replace(',', '.'));
    if (line.material.trim() && line.price.trim() && Number.isFinite(price) && price >= 0) {
      prices.set(normalize(line.material), price);
    }
  }
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

/** An amount of money as the list writes it: "$2.31". */
export function money(amount: number, list: PricesContent): string {
  const places = amount < 1 ? 3 : 2;
  const text = amount.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places });
  const currency = list.currency.trim();
  return currency.length > 1 && /^[A-Za-z]+$/.test(currency) ? `${text} ${currency}` : `${currency}${text}`;
}
