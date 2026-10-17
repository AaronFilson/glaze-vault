// Slips and glazes as they are mixed (docs/research/clay-bodies.md): a recipe's targets for
// specific gravity and viscosity, what a firing's test measured, and the water a gravity takes.
import { numberOf } from './chemistry';
import type { RecipeType } from './recipeFields';

const SLIP_TYPES: RecipeType[] = ['slip', 'engobe', 'casting slip', 'terra sigillata'];

/** Whether recipes of a type are slips, whose recipes and firings show slip readings unasked. */
export function isSlip(type: RecipeType | undefined): boolean {
  return !!type && SLIP_TYPES.includes(type);
}

/** What was measured of the slip or glaze used, as typed. */
export interface SlipReadings {
  /** Specific gravity, such as 1.78. */
  gravity: string;
  /** Seconds through a Ford cup #4. */
  viscosity: string;
  /** How it gels standing, in words: "none", "slight after an hour". */
  gel: string;
}

export const EMPTY_SLIP: SlipReadings = { gravity: '', viscosity: '', gel: '' };

/** The density of the dry materials when nothing better is known, g/cm³. */
export const SOLIDS_DENSITY = 2.6;

/** Grams of water per 100 g of dry materials for a specific gravity, from
 * SG = (D + W) / (D / density + W). Null for a gravity no slip has: at or below water's, or at or
 * above the solids'. */
export function waterPer100(gravity: string, density = SOLIDS_DENSITY): number | null {
  const sg = numberOf(gravity);
  if (sg === null || sg <= 1 || sg >= density) return null;
  return (100 * (1 - sg / density)) / (sg - 1);
}

export function hasSlipReadings(slip: SlipReadings | undefined): boolean {
  return !!slip && Object.values(slip).some((value) => value.trim());
}
