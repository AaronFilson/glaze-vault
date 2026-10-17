// Limit formulas (docs/adr/0015-chemistry-tools.md): ranges of moles in a unity formula that a
// kind of glaze usually falls in, to check a recipe against. They are guides from experience, not
// rules: published sets disagree, and a recipe outside one can be a fine glaze.

/** An oxide's range, in moles of a unity formula. KNaO is K₂O and Na₂O together. */
export interface LimitRange {
  oxide: string;
  min: string;
  max: string;
}

/** What the core keeps for a set of limits someone made. */
export interface LimitsContent {
  name: string;
  /** Where the numbers come from: a book, a page. */
  source: string;
  ranges: LimitRange[];
}

/** A set to compare with: one built in, or one of the person's own (a record id). */
export interface LimitSet extends LimitsContent {
  id: string;
  builtIn: boolean;
}

/** The oxides a limit can be given for: the unity formula's, and KNaO. */
export const LIMIT_OXIDES = [
  'KNaO',
  'Li2O',
  'Na2O',
  'K2O',
  'MgO',
  'CaO',
  'SrO',
  'BaO',
  'ZnO',
  'Al2O3',
  'B2O3',
  'SiO2',
  'TiO2',
  'ZrO2',
  'SnO2',
  'Fe2O3',
  'P2O5'
];

const range = (oxide: string, min: string, max: string): LimitRange => ({ oxide, min, max });

export const BUILT_IN_LIMITS: LimitSet[] = [
  {
    id: 'built-in:digitalfire-cone-6',
    builtIn: true,
    name: 'Cone 6 (Digitalfire)',
    source: 'Tony Hansen, Digitalfire: Limit Formula, https://digitalfire.com/glossary/limit+formula',
    ranges: [
      range('KNaO', '0', '0.375'),
      range('CaO', '0', '0.55'),
      range('MgO', '0', '0.325'),
      range('ZnO', '0', '0.3'),
      range('BaO', '0', '0.4'),
      range('B2O3', '0', '0.35'),
      range('Al2O3', '0.285', '0.64'),
      range('SiO2', '2.4', '4.7')
    ]
  }
];

export interface LimitCheck {
  oxide: string;
  value: number;
  min: number | null;
  max: number | null;
  /** Where the recipe is, if outside. */
  outside: 'below' | 'above' | null;
}

const number = (text: string) => {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() && Number.isFinite(value) ? value : null;
};

/** The recipe's moles of an oxide, with KNaO as K₂O and Na₂O together. */
export function molesOf(umf: Record<string, number>, oxide: string): number {
  if (oxide === 'KNaO') return (umf.K2O ?? 0) + (umf.Na2O ?? 0);
  return umf[oxide] ?? 0;
}

/** Each range of the set against the recipe's unity formula. */
export function checkLimits(umf: Record<string, number>, set: LimitsContent): LimitCheck[] {
  return set.ranges
    .filter((r) => r.oxide && (number(r.min) !== null || number(r.max) !== null))
    .map((r) => {
      const value = molesOf(umf, r.oxide);
      const [min, max] = [number(r.min), number(r.max)];
      // Compared as shown, to three places, so 0.2849 against a minimum of 0.285 is within.
      const shown = Math.round(value * 1000) / 1000;
      const outside = min !== null && shown < min ? 'below' : max !== null && shown > max ? 'above' : null;
      return { oxide: r.oxide, value, min, max, outside };
    });
}

/** A range as "0.285–0.64", "≤ 0.35" or "≥ 2.4". */
export function rangeText(check: { min: number | null; max: number | null }): string {
  if (check.min !== null && check.max !== null) return check.min === 0 ? `≤ ${check.max}` : `${check.min}–${check.max}`;
  if (check.max !== null) return `≤ ${check.max}`;
  return `≥ ${check.min}`;
}
