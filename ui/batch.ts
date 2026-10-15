// Scaling a recipe to a batch, for the batch sheet.
import { amountOf, type RecipeLine } from './chemistry';

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
