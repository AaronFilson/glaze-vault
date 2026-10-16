// Two recipes, or two revisions of one, side by side.
import type { UmfResult } from '@glazecalc/chemistry';
import { amountOf, normalize, OXIDES, type RecipeLine } from './chemistry';

/** A material in either recipe, as a percent of each one's batch; null where it is not used. */
export interface LineChange {
  material: string;
  a: number | null;
  b: number | null;
}

/** Each line's share of its batch, by material: the same material on two lines counts once. */
function shares(lines: RecipeLine[]): Map<string, { material: string; percent: number }> {
  const used = lines
    .map((line) => ({ material: line.material.trim(), amount: amountOf(line.amount) }))
    .filter((line) => line.material && Number.isFinite(line.amount) && line.amount > 0);
  const total = used.reduce((sum, line) => sum + line.amount, 0);
  const found = new Map<string, { material: string; percent: number }>();
  for (const { material, amount } of used) {
    const key = normalize(material) || material;
    const share = (found.get(key)?.percent ?? 0) + (amount / total) * 100;
    found.set(key, { material: found.get(key)?.material ?? material, percent: share });
  }
  return found;
}

/** The materials of both recipes, in the first one's order, then the second's new ones. */
export function compareLines(a: RecipeLine[], b: RecipeLine[]): LineChange[] {
  const first = shares(a);
  const second = shares(b);
  const keys = [...first.keys(), ...[...second.keys()].filter((key) => !first.has(key))];
  return keys.map((key) => ({
    material: first.get(key)?.material ?? second.get(key)!.material,
    a: first.get(key)?.percent ?? null,
    b: second.get(key)?.percent ?? null
  }));
}

export interface OxideChange {
  oxide: string;
  a: number;
  b: number;
}

/** The unity formulas' oxides, in the usual order, leaving out ones neither has. */
export function compareUmf(a: UmfResult | undefined, b: UmfResult | undefined): OxideChange[] {
  return OXIDES.map((oxide) => ({ oxide, a: a?.umf[oxide] ?? 0, b: b?.umf[oxide] ?? 0 })).filter(
    (change) => change.a > 0 || change.b > 0
  );
}

/** A change as a signed number, or a word when one side has nothing. */
export function change(a: number | null, b: number | null, places: number): string {
  if (a === null && b === null) return '';
  if (a === null) return 'added';
  if (b === null) return 'removed';
  const difference = Number((b - a).toFixed(places));
  if (difference === 0) return '';
  return `${difference > 0 ? '+' : '−'}${Math.abs(difference).toFixed(places)}`;
}
