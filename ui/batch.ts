// Scaling a recipe to a batch, for the batch sheet, and batch sheets kept for a batch operator.
import type { RecipeHead, Revision } from './api';
import { amountOf, sameName, type RecipeContent, type RecipeLine } from './chemistry';

export type BatchUnit = 'g' | 'kg' | 'lb' | 'oz';

export const BATCH_UNITS: { unit: BatchUnit; label: string; decimals: number }[] = [
  { unit: 'g', label: 'grams', decimals: 1 },
  { unit: 'kg', label: 'kilograms', decimals: 3 },
  { unit: 'lb', label: 'pounds', decimals: 3 },
  { unit: 'oz', label: 'ounces', decimals: 2 }
];

export interface BatchLine {
  material: string;
  percent: number;
  weight: number;
}

export interface Batch {
  lines: BatchLine[];
  total: number;
}

/** The lines that have a material and a positive amount, with the amounts as numbers. */
export function usableLines(lines: RecipeLine[]): { material: string; amount: number }[] {
  return lines
    .map((line) => ({ material: line.material.trim(), amount: amountOf(line.amount) }))
    .filter((line) => line.material && Number.isFinite(line.amount) && line.amount > 0);
}

/** Every line's share of the recipe, and its weight in a batch of `size`. The lines' weights add up
 * to `size`, so colorants and additives are part of the batch, not added on top. */
export function scaleBatch(lines: RecipeLine[], size: number): Batch | null {
  const usable = usableLines(lines);
  const sum = usable.reduce((total, line) => total + line.amount, 0);
  if (!sum || !(size > 0)) return null;
  return {
    lines: usable.map((line) => ({
      material: line.material,
      percent: (line.amount / sum) * 100,
      weight: (line.amount / sum) * size
    })),
    total: size
  };
}

export function formatWeight(weight: number, unit: BatchUnit): string {
  const decimals = BATCH_UNITS.find((u) => u.unit === unit)?.decimals ?? 2;
  return weight.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** What the core keeps for a batch sheet (ADR 12): a recipe's lines with each material named by
 * its in-house code, and the recipe and revision it was made from. A batch operator can open
 * these and nothing else. */
export interface BatchSheetContent extends RecipeContent {
  recipe: string | null;
  recipeNumber: number | null;
}

export type BatchSheet = Revision<BatchSheetContent>;

/** A code a material has been given on a batch sheet. */
export interface CodePair {
  material: string;
  code: string;
}

/** A recipe's batch sheet, with `codes` in the order of its lines that have an amount. */
export function sheetFrom(recipe: RecipeHead, codes: string[], name: string, notes: string): BatchSheetContent {
  return {
    name,
    notes,
    lines: usableLines(recipe.content.lines).map((line, i) => ({
      material: codes[i].trim(),
      amount: String(line.amount)
    })),
    recipe: recipe.recordId,
    recipeNumber: recipe.number
  };
}

/** The codes on sheets, matched to the materials of the revisions they were made from. */
export function knownCodes(pairs: { recipe: RecipeContent; sheet: BatchSheetContent }[]): CodePair[] {
  const found: CodePair[] = [];
  for (const { recipe, sheet } of pairs) {
    const lines = usableLines(recipe.lines);
    if (lines.length !== sheet.lines.length) continue;
    lines.forEach((line, i) => {
      const code = sheet.lines[i].material.trim();
      if (code && !found.some((k) => sameName(k.material, line.material))) found.push({ material: line.material, code });
    });
  }
  return found;
}

const sameCode = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What is wrong with the codes typed for `materials`, if anything: each needs one, and a code
 * stands for one material, here and on the sheets already made. */
export function codeProblem(materials: string[], codes: string[], known: CodePair[]): string | null {
  if (codes.some((code) => !code.trim())) return 'Give each material a code.';
  for (const [i, code] of codes.entries()) {
    const other =
      materials.find((material, j) => j < i && sameCode(codes[j], code) && !sameName(material, materials[i])) ??
      known.find((k) => sameCode(k.code, code) && !sameName(k.material, materials[i]))?.material;
    if (other) return `${code.trim()} is already the code for ${other}. Give each material its own.`;
  }
  return null;
}
