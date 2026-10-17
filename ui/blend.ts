// Blends: recipes mixed in steps to test what lies between them. A line blend goes from all of
// one recipe to all of another; a triaxial mixes three, over a triangle of points. Each recipe's
// base counts as 100 parts, its additions on top as everywhere else, so a step's parts are its
// share of each; the same material in more than one is one line.
import { baseOf, usableLines } from './batch';
import { normalize, type RecipeLine } from './chemistry';

export interface BlendStep {
  /** Each recipe's share, in the order given, adding up to 100. */
  shares: number[];
  lines: RecipeLine[];
}

/** The shares of the first recipe, `steps` of them from 100 to 0. */
export function blendShares(steps: number): number[] {
  const count = Math.max(2, Math.min(21, Math.round(steps)));
  return Array.from({ length: count }, (_, i) => 100 - (100 * i) / (count - 1));
}

/** The points of a triaxial with `divisions` steps along each side, row by row from all of the
 * first recipe down to the side between the second and the third, each row from the second's end
 * to the third's: (divisions + 1)(divisions + 2) / 2 of them. */
export function triaxialShares(divisions: number): number[][] {
  const n = Math.max(1, Math.min(10, Math.round(divisions)));
  const points: number[][] = [];
  for (let row = 0; row <= n; row++) {
    for (let k = 0; k <= row; k++) {
      const [a, b, c] = [n - row, row - k, k];
      points.push([a, b, c].map((parts) => (100 * parts) / n));
    }
  }
  return points;
}

/** Each recipe's base as 100 parts, mixed in `shares`. */
export function mixLines(recipes: RecipeLine[][], shares: number[]): RecipeLine[] {
  const mixed = new Map<string, { material: string; amount: number; addition: boolean }>();
  recipes.forEach((lines, r) => {
    const usable = usableLines(lines);
    const base = baseOf(usable);
    // A recipe's materials are lines at every step, at 0 where it has no share, so the steps
    // line up material by material.
    if (!base) return;
    for (const line of usable) {
      const key = normalize(line.material) || line.material;
      const before = mixed.get(key);
      mixed.set(key, {
        material: before?.material ?? line.material,
        amount: (before?.amount ?? 0) + (line.amount / base) * shares[r],
        addition: before ? before.addition && line.addition : line.addition
      });
    }
  });
  return [...mixed.values()].map(({ material, amount, addition }) => ({
    material,
    amount: tidyAmount(amount),
    ...(addition ? { addition: true } : {})
  }));
}

/** Two recipes mixed `first` to 100 - `first`. */
export function blendLines(a: RecipeLine[], b: RecipeLine[], first: number): RecipeLine[] {
  return mixLines([a, b], [first, 100 - first]);
}

export function blendSteps(a: RecipeLine[], b: RecipeLine[], steps: number): BlendStep[] {
  return blendShares(steps).map((first) => ({ shares: [first, 100 - first], lines: blendLines(a, b, first) }));
}

export function triaxialSteps(a: RecipeLine[], b: RecipeLine[], c: RecipeLine[], divisions: number): BlendStep[] {
  return triaxialShares(divisions).map((shares) => ({ shares, lines: mixLines([a, b, c], shares) }));
}

/** An amount as a recipe line shows it: at most two decimals, without trailing zeros. */
function tidyAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/** A share as a step's name shows it: to one decimal, without a trailing zero. */
export const shareText = (n: number) => String(Math.round(n * 10) / 10);

/** "Leach 4321 75 · Iron slip 25"; with three recipes, the recipes with no share are left out. */
export function blendName(names: string[], shares: number[]): string {
  const parts = names.map((name, i) => ({ name: name || 'Untitled', share: shares[i] }));
  const shown = names.length > 2 ? parts.filter((p) => p.share > 0) : parts;
  return shown.map((p) => `${p.name} ${shareText(p.share)}`).join(' · ');
}
