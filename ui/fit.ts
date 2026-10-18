// Fitting a recipe to a formula (docs/adr/0015-chemistry-tools.md): amounts for its materials, and
// any others to try, whose unity formula comes as near a target as they allow, changing the
// recipe as little as that does. The target is a unity formula typed in, the recipe's own to
// start from, or the recipe's moved into a limit set. Glazecalc's fitAmounts does the fitting.
import {
  fitAmounts,
  OXIDE_GROUPS,
  oxideMoles,
  type FitLine,
  type MaterialInput,
  type SelectLine,
  type Selection
} from '@glazecalc/chemistry';
import { amountOf, analyse, materialInput, numberOf, sameName, type MaterialLibrary, type RecipeLine } from './chemistry';
import { checkLimits, molesOf, type LimitsContent } from './limits';

/** An oxide of the target, in moles of a unity formula, as typed. */
export interface TargetLine {
  oxide: string;
  moles: string;
}

/** A line to fit: one of the recipe's, or a material brought in to try (amount 0). */
export interface FitChoice {
  material: string;
  amount: string;
  addition?: boolean;
  /** Whether the fit may change its amount. Additions, such as a colorant, are kept by default. */
  change: boolean;
}

export type FitOutcome =
  | { lines: RecipeLine[]; changed: boolean }
  | { problem: string };

const isFlux = (oxide: string) => OXIDE_GROUPS[oxide] === 'R2O' || OXIDE_GROUPS[oxide] === 'RO';
const round3 = (n: number) => String(Math.round(n * 1000) / 1000);

/** A unity formula as target lines, its oxides in the chemistry's order. */
export function targetFrom(umf: Record<string, number>): TargetLine[] {
  return Object.keys(OXIDE_GROUPS)
    .filter((oxide) => (umf[oxide] ?? 0) >= 0.0005)
    .map((oxide) => ({ oxide, moles: round3(umf[oxide]) }));
}

/**
 * The recipe's unity formula moved into a limit set: each oxide outside its range is brought just
 * inside it, KNaO by scaling potash and soda together. The fluxes still add up to one: those not
 * held at a bound are scaled to make room, a few times over, since that can move another out.
 * Oxides with no range stay as they were. Returns the target and the ranges it could not meet, as
 * when every flux the recipe has is at its most and they come to less than one.
 */
export function moveInto(umf: Record<string, number>, set: LimitsContent): { target: TargetLine[]; unmet: string[] } {
  const moles: Record<string, number> = { ...umf };
  const ranges = set.ranges
    .map((r) => {
      const [min, max] = [numberOf(r.min), numberOf(r.max)];
      // A step inside each bound, so the fitted recipe is within it as shown, to three places.
      const margin = 0.02 * Math.max((max ?? 0) - (min ?? 0), 0.01);
      return {
        oxide: r.oxide,
        min,
        max,
        low: min === null ? null : min + margin,
        high: max === null ? null : Math.max(min ?? 0, max - margin),
        members: r.oxide === 'KNaO' ? ['K2O', 'Na2O'] : [r.oxide]
      };
    })
    .filter((r) => r.oxide && (r.min !== null || r.max !== null));
  const set_ = (r: (typeof ranges)[number], wanted: number) => {
    const value = molesOf(moles, r.oxide);
    if (value > 0) for (const oxide of r.members) moles[oxide] = ((moles[oxide] ?? 0) * wanted) / value;
    else for (const oxide of r.members) moles[oxide] = wanted / r.members.length;
  };
  const clamp = (r: (typeof ranges)[number]) => {
    const value = molesOf(moles, r.oxide);
    if (r.min !== null && value < r.min) set_(r, r.low!);
    else if (r.max !== null && value > r.max) set_(r, r.high!);
  };
  const fluxRanges = ranges.filter((r) => r.members.every(isFlux));
  for (let round = 0; round < 50; round++) {
    fluxRanges.forEach(clamp);
    const fluxes = Object.keys(moles).filter((oxide) => isFlux(oxide) && moles[oxide] > 0);
    const total = fluxes.reduce((sum, oxide) => sum + moles[oxide], 0);
    if (!(total > 0) || Math.abs(total - 1) < 1e-9) break;
    // The fluxes at the bound they would cross are held; the others make up the difference.
    const up = total < 1;
    const held = new Set(
      fluxRanges
        .filter((r) => {
          const value = molesOf(moles, r.oxide);
          return up ? r.high !== null && value >= r.high - 1e-9 : r.low !== null && value <= r.low + 1e-9;
        })
        .flatMap((r) => r.members)
    );
    const free = fluxes.filter((oxide) => !held.has(oxide));
    const freeTotal = free.reduce((sum, oxide) => sum + moles[oxide], 0);
    if (!(freeTotal > 0)) break;
    const factor = Math.max(0, (1 - (total - freeTotal)) / freeTotal);
    for (const oxide of free) moles[oxide] *= factor;
  }
  // Where the ranges leave too little or too much flux, the fluxes are made to add up to one
  // anyway, as the fit will make them, and that range shows as unmet.
  const fluxes = Object.keys(moles).filter((oxide) => isFlux(oxide) && moles[oxide] > 0);
  const total = fluxes.reduce((sum, oxide) => sum + moles[oxide], 0);
  if (total > 0) for (const oxide of fluxes) moles[oxide] /= total;
  // The rest are moles per mole of flux, so they move without moving anything else.
  ranges.filter((r) => !r.members.every(isFlux)).forEach(clamp);
  const unmet = ranges
    .filter((r) => {
      const shown = Math.round(molesOf(moles, r.oxide) * 1000) / 1000;
      return (r.min !== null && shown < r.min) || (r.max !== null && shown > r.max);
    })
    .map((r) => r.oxide);
  return { target: targetFrom(moles), unmet };
}

/**
 * A recipe fitted into a limit set: fitted to the formula moved inside it, then, since a fit
 * comes near its target and not exactly, the target moved further in for any oxide the result is
 * still outside, and fitted again, a few times. Returns the last fit and the ranges it is outside.
 */
export function fitInto(
  choices: FitChoice[],
  set: LimitsContent,
  library: MaterialLibrary
): { problem: string } | { lines: RecipeLine[]; changed: boolean; outside: string[] } {
  const start = analyse(choices, library);
  if (!start?.result) return { problem: start?.problem ?? 'The recipe has nothing to fit.' };
  const target: Record<string, number> = Object.fromEntries(
    moveInto(start.result.umf, set).target.map((t) => [t.oxide, Number(t.moles)])
  );
  let outcome: FitOutcome = { problem: '' };
  let outside: ReturnType<typeof checkLimits> = [];
  for (let round = 0; round < 6; round++) {
    outcome = fitRecipe(choices, targetFrom(target), library);
    if (!('lines' in outcome)) return outcome;
    const fitted = analyse(outcome.lines, library)?.result?.umf;
    if (!fitted) return { problem: 'The fitted recipe has no unity formula.' };
    outside = checkLimits(fitted, set).filter((c) => c.outside);
    if (!outside.length) break;
    for (const check of outside) {
      // Past the bound by the miss, and as far again.
      const bound = check.outside === 'above' ? check.max! : check.min!;
      const shift = 2 * (bound - check.value);
      const members = check.oxide === 'KNaO' ? ['K2O', 'Na2O'] : [check.oxide];
      const now = molesOf(target, check.oxide);
      for (const oxide of members) {
        target[oxide] = now > 0 ? Math.max(0, (target[oxide] ?? 0) * (1 + shift / now)) : Math.max(0, shift / members.length);
      }
    }
  }
  if (!('lines' in outcome)) return outcome;
  return { ...outcome, outside: outside.map((c) => c.oxide) };
}

/** Amounts as a recipe shows them: two decimals, a token amount as none. */
const tidy = (amount: number, size: number) => (amount < size * 0.0005 ? 0 : Math.round(amount * 100) / 100);

/** A fit set up: the lines it changes or holds, and the target in moles for the batch's size. */
interface Prepared {
  /** In the recipe's order: the lines kept as they are, and those fitted. */
  used: FitChoice[];
  fitted: { choice: FitChoice; input: MaterialInput; start: number }[];
  /** The target, scaled to the recipe's own moles of flux. */
  absolute: Record<string, number>;
}

function prepare(choices: FitChoice[], target: TargetLine[], library: MaterialLibrary): Prepared | { problem: string } {
  const wanted: Record<string, number> = {};
  for (const line of target) {
    const moles = numberOf(line.moles);
    if (!line.oxide) continue;
    if (moles === null || moles < 0) return { problem: `The target for ${line.oxide} is not a number.` };
    if (moles > 0) wanted[line.oxide] = (wanted[line.oxide] ?? 0) + moles;
  }
  const targetFluxes = Object.keys(wanted).filter(isFlux).reduce((sum, oxide) => sum + wanted[oxide], 0);
  if (!(targetFluxes > 0)) return { problem: 'The target needs some flux: an oxide such as CaO, K₂O or Na₂O.' };

  const fitted: Prepared['fitted'] = [];
  const used: FitChoice[] = [];
  for (const choice of choices.filter((c) => c.material.trim())) {
    const start = choice.amount.trim() ? amountOf(choice.amount) : 0;
    if (!Number.isFinite(start) || start < 0) return { problem: `The amount of ${choice.material.trim()} is not a number.` };
    const input = materialInput(library, choice.material);
    if (input && 'problem' in input) return { problem: input.problem };
    // A material that adds nothing once fired, such as CMC gum, stays as it is.
    if (!input) {
      if (start > 0) used.push(choice);
    } else if (start > 0 || choice.change) {
      used.push(choice);
      fitted.push({ choice, input, start });
    }
  }
  const own = oxideMoles(fitted.map((f) => ({ material: f.input, amount: f.start })));
  const ownFluxes = Object.keys(own).filter(isFlux).reduce((sum, oxide) => sum + own[oxide], 0);
  // With no fluxes to start from, a batch the size the recipe had.
  const scale = ownFluxes > 0 ? ownFluxes : 0.003 * Math.max(100, fitted.reduce((sum, f) => sum + f.start, 0));
  const absolute = Object.fromEntries(Object.entries(wanted).map(([oxide, m]) => [oxide, (m / targetFluxes) * scale]));
  return { used, fitted, absolute };
}

const fitLine = ({ input, start, choice }: Prepared['fitted'][number]): FitLine =>
  choice.change ? { material: input, start } : { material: input, start, least: start, most: start };

/** The fitted amounts as recipe lines, in the recipe's order, and whether any changed. */
function linesOf({ used, fitted }: Prepared, amounts: number[]): { lines: RecipeLine[]; changed: boolean } {
  const size = fitted.reduce((sum, f) => sum + f.start, 0) || amounts.reduce((sum, a) => sum + a, 0);
  const result: RecipeLine[] = [];
  let changed = false;
  for (const choice of used) {
    const at = fitted.findIndex((f) => f.choice === choice);
    if (at < 0) {
      result.push(line(choice, choice.amount));
      continue;
    }
    const amount = tidy(amounts[at], size);
    if (amount !== tidy(fitted[at].start, size)) changed = true;
    if (amount > 0) result.push(line(choice, String(amount)));
  }
  return { lines: result, changed };
}

/**
 * New amounts for the choices whose unity formula comes nearest the target. The target is scaled
 * to the recipe's own fluxes, so the batch stays about its size. Lines that may not change, and
 * materials that add nothing once fired, keep their amounts; a material brought in that the fit
 * does not use is left out, and so is one of the recipe's that it takes out.
 */
export function fitRecipe(choices: FitChoice[], target: TargetLine[], library: MaterialLibrary): FitOutcome {
  const prepared = prepare(choices, target, library);
  if ('problem' in prepared) return prepared;
  if (!prepared.fitted.some((f) => f.choice.change)) return { problem: 'Let the fit change at least one material.' };
  let amounts: number[];
  try {
    amounts = fitAmounts(prepared.fitted.map(fitLine), prepared.absolute).amounts;
  } catch (e) {
    return { problem: (e as Error).message };
  }
  return linesOf(prepared, amounts);
}

/** What choosing from the library found, beyond the lines: what each material used is there for. */
export interface Chosen {
  lines: RecipeLine[];
  changed: boolean;
  /** For each material used, the oxides it supplies most of: "most of the B₂O₃". */
  supplies: Record<string, { oxide: string; share: number }[]>;
  /** A material used, and another from the pool that could stand in for it. */
  alike: [string, string][];
  /** Oxides of the target that nothing in the pool has. */
  unreachable: string[];
}

/** The most new materials choosing may add, unless asked for fewer. */
export const MOST_EXTRAS = 3;

/**
 * The recipe's lines, and the fewest of the pool's materials, that bring the unity formula near the
 * target, with Glazecalc's selectMaterials: it drops what the match does not need, the materials
 * brought in first, and fits the amounts of what is left. The pool is everything a recipe could be
 * made of; those named in avoid are not used.
 */
export function chooseLines(
  choices: FitChoice[],
  target: TargetLine[],
  library: MaterialLibrary,
  pool: string[],
  { extras = MOST_EXTRAS, avoid = [] }: { extras?: number; avoid?: string[] } = {}
): ChooseJob | { problem: string } {
  const offered = pool
    .filter((name) => !choices.some((c) => sameName(c.material, name)) && !avoid.some((a) => sameName(a, name)))
    .map((name) => ({ material: name, amount: '', change: true }));
  const prepared = prepare([...choices, ...offered], target, library);
  if ('problem' in prepared) return prepared;
  if (!prepared.fitted.some((f) => f.choice.change)) return { problem: 'Let the fit change at least one material.' };
  return {
    prepared,
    lines: prepared.fitted.map((f) => ({ ...fitLine(f), ...(f.start === 0 ? {} : { must: !f.choice.change }) })),
    target: prepared.absolute,
    options: { extras }
  };
}

/** What selectMaterials is given: plain data, so it can run in a worker. */
export interface ChooseJob {
  prepared: Prepared;
  lines: SelectLine[];
  target: Record<string, number>;
  options: { extras: number };
}

/** The selection as recipe lines, and what each material used is there for. */
export function chosenFrom(job: ChooseJob, selection: Selection): Chosen {
  const { fitted } = job.prepared;
  const name = (index: number) => fitted[index].choice.material;
  return {
    ...linesOf(job.prepared, selection.amounts),
    supplies: Object.fromEntries(selection.contributions.map((c) => [name(c.index), c.supplies])),
    alike: selection.alike.map((pair) => [name(pair.used), name(pair.other)]),
    unreachable: selection.unreachable
  };
}

const line = (choice: FitChoice, amount: string): RecipeLine => ({
  material: choice.material,
  amount,
  ...(choice.addition ? { addition: true } : {})
});
