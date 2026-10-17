// Two recipes, or two revisions of one, side by side.
import type { UmfResult } from '@glazecalc/chemistry';
import { baseOf, usableLines } from './batch';
import { normalize, OXIDES, type RecipeLine } from './chemistry';

/** A material in either recipe, as a percent of each one's base; null where it is not used. */
export interface LineChange {
  material: string;
  a: number | null;
  b: number | null;
  /** Added on top of the base, in the recipe that has it (the first, if both). */
  addition: boolean;
}

type Share = { material: string; percent: number; addition: boolean };

/** Each line's share of its base, by material: the same material on two lines counts once. */
function shares(lines: RecipeLine[]): Map<string, Share> {
  const used = usableLines(lines);
  const base = baseOf(used);
  const found = new Map<string, Share>();
  for (const { material, amount, addition } of used) {
    const key = normalize(material) || material;
    const before = found.get(key);
    found.set(key, {
      material: before?.material ?? material,
      percent: (before?.percent ?? 0) + (amount / base) * 100,
      addition: before?.addition ?? addition
    });
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
    b: second.get(key)?.percent ?? null,
    addition: (first.get(key) ?? second.get(key)!).addition
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
