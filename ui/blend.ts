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

/** The letter each recipe of a blend goes by on a bar label, in the order given. */
export const RECIPE_LETTERS = ['A', 'B', 'C'];

/** The cones typed for bar labels, each once, in the order typed: "4, 5, 6" or "^04 ^02". */
export function parseCones(text: string): string[] {
  const cones: string[] = [];
  for (const word of text.split(/[\s,;]+/)) {
    const cone = word.replace(/^\^/, '');
    if (!cone || /^cones?$/i.test(cone)) continue;
    if (!cones.some((c) => c.toLowerCase() === cone.toLowerCase())) cones.push(cone);
  }
  return cones;
}

/** A step's shares as a bar label shows them, each recipe by its letter: "A 70 · B 30". A recipe
 * with no share is left out. */
export function shareLabel(shares: number[]): string {
  return shares
    .map((share, i) => ({ letter: RECIPE_LETTERS[i], share }))
    .filter((s) => s.share > 0)
    .map((s) => `${s.letter} ${shareText(s.share)}`)
    .join(' · ');
}

/** One test bar's label: the test's number, its shares, and the cone it is for. */
export interface BarLabel {
  test: number;
  shares: string;
  /** '' when no cones were given, for one to be written in. */
  cone: string;
}

/** A label for every test at every cone, cone by cone, as the bars are fired; with no cones, one
 * for each test. */
export function barLabels(steps: BlendStep[], cones: string[]): BarLabel[] {
  return (cones.length ? cones : ['']).flatMap((cone) =>
    steps.map((step, i) => ({ test: i + 1, shares: shareLabel(step.shares), cone }))
  );
}
