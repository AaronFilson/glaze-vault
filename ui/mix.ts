// The mix log (docs/adr/0016-mix-log.md): each batch as it was mixed, from a batch sheet or a
// recipe: when, how much, the lot of each material weighed, and for a slip, deflocculant and water
// added in steps with the readings as it ages. The core keeps mixes under the batch key, so a
// batch operator logs them and reads no more of the recipe than its batch sheet shows.
import type { Revision } from './api';
import type { BatchSheet, BatchUnit } from './batch';
import { usableLines } from './batch';
import { numberOf, type RecipeContent, type RecipeLine } from './chemistry';
import { isoDate } from './firing';

/** One step as a slip is mixed or aged: what was added, then what it measured. All as typed. */
export interface MixStep {
  /** The day, as YYYY-MM-DD. */
  on: string;
  /** Deflocculant added at this step, in the batch's unit. */
  deflocculant: string;
  /** Water added at this step, in the batch's unit. */
  water: string;
  gravity: string;
  /** Seconds through a Ford cup #4. */
  viscosity: string;
  gel: string;
}

/** What the core keeps for each revision of a mix. */
export interface MixContent {
  /** The batch sheet weighed from, and which of its revisions, when there was one. */
  sheet: string | null;
  sheetNumber: number | null;
  /** The recipe and revision mixed: the sheet's, or the recipe's own when mixed without a sheet. */
  recipe: string | null;
  recipeNumber: number | null;
  /** The sheet's name then, for when it is renamed or deleted. Empty for a recipe mixed without a
   * sheet: a batch operator reads mixes, and a recipe's name is not theirs to read. */
  name: string;
  /** The day it was mixed, as YYYY-MM-DD. */
  mixedOn: string;
  /** The weight of the dry base, as typed, and its unit. */
  size?: string;
  unit?: BatchUnit;
  /** The lot or bag of each line weighed, in the order of the lines with an amount (usableLines),
   * which is the batch sheet's order. */
  lots?: string[];
  /** Water put in at the start, in the batch's unit. */
  water?: string;
  steps?: MixStep[];
  notes: string;
}

export type Mix = Revision<MixContent>;

/** A new mix of a batch sheet, or of a recipe revision when there is no sheet, mixed today. With
 * neither, the person chooses what was mixed. */
export function newMix(
  from: { sheet: BatchSheet } | { recipe: { recordId: string; number: number } } | null,
  today: Date
): MixContent {
  const base = { mixedOn: isoDate(today), unit: 'g' as BatchUnit, notes: '' };
  if (from && 'sheet' in from) {
    const { sheet } = from;
    return {
      sheet: sheet.recordId,
      sheetNumber: sheet.number,
      recipe: sheet.content.recipe,
      recipeNumber: sheet.content.recipeNumber,
      name: sheet.content.name,
      ...base
    };
  }
  return {
    sheet: null,
    sheetNumber: null,
    recipe: from?.recipe.recordId ?? null,
    recipeNumber: from?.recipe.number ?? null,
    name: '',
    ...base
  };
}

export function emptyStep(today: Date): MixStep {
  return { on: isoDate(today), deflocculant: '', water: '', gravity: '', viscosity: '', gel: '' };
}

const stepFilled = (step: MixStep) =>
  [step.deflocculant, step.water, step.gravity, step.viscosity, step.gel].some((value) => value.trim());

/** Whether a mix is of a recipe, from one of its batch sheets or not. */
export function mixOf(content: MixContent, recipe: string): boolean {
  return content.recipe === recipe;
}

/** What a mix is called in the lists: its sheet's name, else its recipe's, if this person can
 * open it. */
export function mixName(content: MixContent, recipes: { recordId: string; content: RecipeContent }[]): string {
  if (content.name) return content.name;
  const recipe = recipes.find((r) => r.recordId === content.recipe);
  return recipe ? recipe.content.name || 'Untitled' : 'A recipe';
}

/** A mix in a line: "2026-10-19 · 5 kg". */
export function mixSummary(content: MixContent): string {
  return [content.mixedOn, content.size?.trim() && `${content.size.trim()} ${content.unit ?? 'g'}`]
    .filter(Boolean)
    .join(' · ');
}

/** Whether a mix has every word searched for. */
export function mixMatches(content: MixContent, name: string, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [name, mixSummary(content), ...(content.lots ?? []), ...(content.steps ?? []).map((s) => s.gel), content.notes]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Days from mixing to a step, or null when either day is not a date. */
export function daysAged(mixedOn: string, on: string): number | null {
  const [from, to] = [Date.parse(mixedOn), Date.parse(on)];
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** The deflocculant and water added in all, in the batch's unit, each with its share of the dry
 * base when the size is known. Water put in at the start counts. Null when none was typed as a
 * number. */
export function mixTotals(content: MixContent): {
  deflocculant: { amount: number; percent: number | null } | null;
  water: { amount: number; percent: number | null } | null;
} {
  const size = numberOf(content.size ?? '');
  const total = (values: string[]) => {
    const numbers = values.map(numberOf).filter((n): n is number => n !== null && n >= 0);
    if (!numbers.length) return null;
    const amount = numbers.reduce((a, b) => a + b, 0);
    return { amount, percent: size && size > 0 ? (amount / size) * 100 : null };
  };
  const steps = content.steps ?? [];
  return {
    deflocculant: total(steps.map((s) => s.deflocculant)),
    water: total([content.water ?? '', ...steps.map((s) => s.water)])
  };
}

/** A mix's lots in the order a firing keeps them (lotMaterials: the lines that name a material),
 * from the order of the lines weighed, which leaves out those without an amount. */
export function lotsForFiring(lines: RecipeLine[], lots: string[]): string[] {
  let weighed = 0;
  return lines
    .filter((line) => line.material.trim())
    .map((line) => (usableLines([line]).length ? (lots[weighed++] ?? '') : ''));
}

/** Compares by value, a missing field being the same as an empty one. */
export function sameMix(a: MixContent, b: MixContent): boolean {
  return JSON.stringify(tidyMix(a)) === JSON.stringify(tidyMix(b));
}

/** Leaves out what is empty, in a fixed order, so a mix is saved and compared the same way. */
export function tidyMix(content: MixContent): MixContent {
  const text = (value?: string) => (value?.trim() ? value.trim() : undefined);
  const tidy: MixContent = {
    sheet: content.sheet,
    sheetNumber: content.sheetNumber,
    recipe: content.recipe,
    recipeNumber: content.recipeNumber,
    name: content.name,
    mixedOn: content.mixedOn,
    notes: content.notes
  };
  const lots = content.lots?.map((lot) => lot.trim()) ?? [];
  while (lots.length && !lots[lots.length - 1]) lots.pop();
  const steps = (content.steps ?? []).filter(stepFilled).map((step) => ({
    on: step.on,
    deflocculant: step.deflocculant.trim(),
    water: step.water.trim(),
    gravity: step.gravity.trim(),
    viscosity: step.viscosity.trim(),
    gel: step.gel.trim()
  }));
  const optional: Partial<MixContent> = {
    size: text(content.size),
    unit: content.unit ?? 'g',
    lots: lots.length ? lots : undefined,
    water: text(content.water),
    steps: steps.length ? steps : undefined
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (tidy as unknown as Record<string, unknown>)[key] = value;
  }
  return tidy;
}
