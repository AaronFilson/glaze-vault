// Line blends: two recipes mixed in steps, from all of the first to all of the second, to test
// what lies between them. Each recipe counts as 100 parts, so a step's parts are its share of
// each; the same material in both is one line.
import { usableLines } from './batch';
import { normalize, type RecipeLine } from './chemistry';

export interface BlendStep {
  /** The first recipe's share, 0 to 100; the second has the rest. */
  first: number;
  lines: RecipeLine[];
}

/** The shares of the first recipe, `steps` of them from 100 to 0. */
export function blendShares(steps: number): number[] {
  const count = Math.max(2, Math.min(21, Math.round(steps)));
  return Array.from({ length: count }, (_, i) => 100 - (100 * i) / (count - 1));
}

/** Each recipe as 100 parts, mixed `first` to 100 - `first`. */
export function blendLines(a: RecipeLine[], b: RecipeLine[], first: number): RecipeLine[] {
  const mixed = new Map<string, { material: string; amount: number; addition: boolean }>();
  const add = (lines: RecipeLine[], share: number) => {
    const usable = usableLines(lines);
    const total = usable.reduce((sum, line) => sum + line.amount, 0);
    // A recipe's materials are lines at every step, at 0 where it has no share, so the steps
    // line up material by material.
    if (!total) return;
    for (const line of usable) {
      const key = normalize(line.material) || line.material;
      const before = mixed.get(key);
      mixed.set(key, {
        material: before?.material ?? line.material,
        amount: (before?.amount ?? 0) + (line.amount / total) * share,
        addition: before ? before.addition && line.addition : line.addition
      });
    }
  };
  add(a, first);
  add(b, 100 - first);
  return [...mixed.values()].map(({ material, amount, addition }) => ({
    material,
    amount: tidyAmount(amount),
    ...(addition ? { addition: true } : {})
  }));
}

export function blendSteps(a: RecipeLine[], b: RecipeLine[], steps: number): BlendStep[] {
  return blendShares(steps).map((first) => ({ first, lines: blendLines(a, b, first) }));
}

/** An amount as a recipe line shows it: at most two decimals, without trailing zeros. */
function tidyAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/** "Leach 4321 75 · Iron slip 25". */
export function blendName(a: string, b: string, first: number): string {
  const share = (n: number) => String(Math.round(n * 10) / 10);
  return `${a || 'Untitled'} ${share(first)} · ${b || 'Untitled'} ${share(100 - first)}`;
}
