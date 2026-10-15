// Types for the CommonJS chemistry module, used by the Angular client.

export type OxideGroup = 'R2O' | 'RO' | 'R2O3' | 'RO2';

/** An oxide amount in the app's stored material shape. */
export interface MaterialField {
  name: string;
  amount: string | number;
  amountUnity?: number;
}

/**
 * A material as a molar formula, a weight-percent analysis, or the app's
 * stored { fields, percentmole, loi } shape.
 */
export interface MaterialInput {
  name: string;
  formula?: Record<string, number>;
  analysis?: Record<string, number | string>;
  fields?: MaterialField[];
  percentmole?: 'percent' | 'molecular' | string;
  loi?: number | string | null;
  molecularweight?: number | string | null;
  equivalent?: number | string | null;
}

export interface RecipeLine {
  material: string | MaterialInput;
  amount: number | string | undefined;
}

/** A message from the chemistry: its code and values, for the app to translate, and its English (messages.js). */
export interface ChemistryMessage {
  code: string;
  params: Record<string, string | number>;
  message: string;
}

/** An error that stops a calculation carries its code and values too. */
export interface ChemistryError extends Error {
  code?: string;
  params?: Record<string, string | number>;
}

export interface UmfResult {
  umf: Record<string, number>;
  groups: Record<OxideGroup, number>;
  siAlRatio: number | null;
  analysis: Record<string, number>;
  loi: number;
  /** Calculated thermal expansion, x10^-6 per °C, as Digitalfire and Glazy work it out; null with nothing to go on. */
  expansion: number | null;
  /** In English. */
  warnings: string[];
  /** The same warnings with their codes. */
  warningCodes: ChemistryMessage[];
}

export interface MaterialWeights {
  unity: Record<string, number>;
  equivalent: number;
  firedWeight: number;
  molecularWeight: number;
  loi: number;
  /** In English. */
  warnings: string[];
  /** The same warnings with their codes. */
  warningCodes: ChemistryMessage[];
}

/** IUPAC standard atomic weights (abridged), g/mol, of the elements in the oxides. */
export const ATOMIC_WEIGHTS: Record<string, number>;
export const MOLAR_MASS: Record<string, number>;
export const OXIDE_GROUPS: Record<string, OxideGroup>;
export const FORMULA_MATERIALS: Array<{ name: string; aliases?: string[]; formula: Record<string, number> }>;

export function calculateUMF(
  recipe: RecipeLine[] | Record<string, number>,
  options?: { materials?: MaterialInput[] }
): UmfResult;

/** A molar formula's weight-percent analysis and LOI; the material's name is for its messages. */
export function formulaToAnalysis(
  formula: Record<string, number>,
  materialName?: string
): {
  analysis: Record<string, number>;
  loi: number;
  formulaWeight: number;
};

export function materialWeights(material: MaterialInput): MaterialWeights;

/** A formula for display, with its counts as subscripts: Ca3(PO4)2 → Ca₃(PO₄)₂, 2CaO•3B2O3 → 2CaO•3B₂O₃. */
export function formatFormula(text: string | null | undefined): string;

/** Moles of each fired oxide in one gram of the raw material. */
export function molesPerGram(material: MaterialInput): Record<string, number>;

/** Moles of each fired oxide in the lines. */
export function oxideMoles(
  lines: Array<{ material: MaterialInput; amount: number | string | undefined }>
): Record<string, number>;

/**
 * Amounts that bring the lines' fired oxides as near the target as the materials allow,
 * changing them from their start amounts as little as possible (see lib/chemistry/fit.js).
 */
/** A line to fit: what to stay near, and the most and least it may be; group names a shared cap. */
export interface FitLine {
  material: MaterialInput;
  start: number;
  most?: number;
  least?: number;
  group?: string;
}

/** How near the oxides should come, and shared caps (see lib/chemistry/fit.js). */
export interface FitOptions {
  near?: Record<string, number>;
  alkalis?: number;
  fluxTotal?: number;
  groups?: Record<string, number>;
}

export function fitAmounts(
  lines: FitLine[],
  target: Record<string, number>,
  options?: FitOptions
): { amounts: number[]; moles: Record<string, number>; miss: number };

/** The best match the lines can make, with no pull toward their starts: fast, for ranking choices. */
export function bestFit(
  lines: FitLine[],
  target: Record<string, number>,
  options?: FitOptions
): { amounts: number[]; miss: number };

/** Orton large cones heated at 60 °C an hour: the temperature each bends at. */
export const CONES: ReadonlyArray<{ cone: string; celsius: number }>;

/** Katz's rule: at least 0.1 B2O3 in the unity formula for every 50 °C below 1300 °C. */
export function boronFor(celsius: number): number;

/**
 * A glaze's oxides with its lead's share of the fluxes handed to other fluxes, alumina at least 0.2
 * and boron at least Katz's for the firing (see lib/chemistry/lead.js).
 */
export function leadFreeTarget(
  moles: Record<string, number>,
  options: {
    celsius: number;
    noZinc?: boolean;
    noMagnesia?: boolean;
    noZincOrMagnesia?: boolean;
    noStrontium?: boolean;
  }
): Record<string, number>;

/** Expansion coefficients per weight percent of each fired oxide (Digitalfire's, which Glazy uses too). */
export const EXPANSION: Record<string, number>;

/** The calculated expansion of a fired analysis ({ oxide: weight percent }), x10^-6 per °C, or null. */
export function expansion(analysis: Record<string, number> | null | undefined): number | null;

/**
 * Bounded least squares (lsq.js): the x within lo..hi that makes
 * |A x - b|^2 + lambda |x - pullTo|^2 + 2 cost . x smallest, with A given by its columns.
 */
export function boundedLeastSquares(problem: {
  columns: number[][];
  b: number[];
  lo: number[];
  hi: number[];
  lambda?: number;
  pullTo?: number[];
  cost?: number[];
}): number[];

/** A line offered to selectMaterials: the recipe's own (start > 0) or a material to try. */
export interface SelectLine extends FitLine {
  must?: boolean;
  avoid?: boolean;
}

export interface Selection {
  amounts: number[];
  moles: Record<string, number>;
  miss: number;
  best: number;
  chosen: number[];
  unreachable: string[];
  /** missWithout: miss, worse by what the best match within the chosen lines loses without it. */
  contributions: Array<{ index: number; supplies: Array<{ oxide: string; share: number }>; missWithout: number }>;
  /** helps: how much closer the match comes when it is added as a must and chosen again, or 0. */
  unused: Array<{ index: number; helps: number }>;
  alike: Array<{ used: number; other: number }>;
  /**
   * Caps that cost match: a line at its most, or a shared cap (group, its
   * members, named by the largest), with what it would be and the miss lifted.
   */
  capped: Array<{
    index: number;
    most: number;
    wouldBe: number;
    missLifted: number;
    group?: string;
    members?: number[];
  }>;
  countCost: number;
}

/** The fewest materials from the lines that bring the target close (see lib/chemistry/select.js). */
export function selectMaterials(
  lines: SelectLine[],
  target: Record<string, number>,
  options?: FitOptions & { closer?: boolean; extras?: number; keepOwn?: boolean }
): Selection;

/** The chemistry's messages by code, in English (lib/chemistry/messages.js). */
export const MESSAGES: Readonly<Record<string, string>>;
