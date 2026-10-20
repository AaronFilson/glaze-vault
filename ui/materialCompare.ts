// Materials side by side by their data sheets, as a substitute for a clay is chosen
// (docs/research/clay-body-formulation.md, section 7): what it does first (shrinkage, absorption,
// plasticity, particle size), then what it is made of.
import { MOLAR_MASS } from '@glazecalc/chemistry';
import { change } from './compare';
import { amountOf, numberOf, OXIDES, type MaterialContent } from './chemistry';
import { MATERIAL_CLASSES, SHEET_FIELDS, type DataSheet } from './materialData';

/** The data sheet's values in the order a substitute is matched on, the cone left out. */
const COMPARED: (keyof DataSheet)[] = [
  'dryingShrinkage',
  'firingShrinkage',
  'absorption',
  'waterOfPlasticity',
  'finer1um',
  'mesh',
  'dryStrength',
  'density'
];

/** The values only a cone makes sense of. */
const FIRED: (keyof DataSheet)[] = ['firingShrinkage', 'absorption'];

/** Values typed in words, with their own units, which are shown but not subtracted. */
const IN_WORDS: (keyof DataSheet)[] = ['mesh', 'dryStrength'];

export interface SheetRow {
  field: keyof DataSheet;
  label: string;
  unit?: string;
  /** Each material's value as typed, '' where its sheet has none. */
  values: string[];
  /** Each value's difference from the first material's, '' where either is not a number. */
  changes: string[];
  /** Fired at a cone: firing shrinkage and absorption. */
  fired: boolean;
}

/** Each material's data sheet values, row by row, leaving out rows none of them has. */
export function compareSheets(materials: MaterialContent[]): SheetRow[] {
  return COMPARED.map((field) => {
    const { label, unit } = SHEET_FIELDS.find((f) => f.field === field)!;
    const values = materials.map((m) => m.sheet?.[field]?.trim() ?? '');
    const first = numberOf(values[0] ?? '');
    const changes = values.map((value, i) => {
      const n = numberOf(value);
      if (i === 0 || IN_WORDS.includes(field) || first === null || n === null) return '';
      return change(first, n, field === 'density' ? 2 : 1);
    });
    return { field, label, unit, values, changes, fired: FIRED.includes(field) };
  }).filter((row) => row.values.some(Boolean));
}

/** Each material's cone, and whether the sheets that give fired values give them at different
 * cones (or one gives none), when they cannot be compared as they stand. */
export function sheetCones(materials: MaterialContent[]): { cones: string[]; differ: boolean } {
  const cones = materials.map((m) => m.sheet?.cone?.trim().replace(/^\^/, '') ?? '');
  const fired = materials
    .map((m, i) => ({ cone: cones[i].toLowerCase(), has: FIRED.some((field) => m.sheet?.[field]?.trim()) }))
    .filter((m) => m.has);
  return { cones, differ: new Set(fired.map((m) => m.cone)).size > 1 };
}

export function classLabel(material: MaterialContent): string {
  return MATERIAL_CLASSES.find((c) => c.value === material.class)?.label ?? '';
}

/** A material's makeup as weight % of the raw material, with what burns off as its loss on
 * ignition: an analysis as typed, a formula from its moles. Null when it has none to give. */
export function weightPercents(material: MaterialContent): { oxides: Record<string, number>; loi: number } | null {
  const oxides: Record<string, number> = {};
  let loi = 0;
  if (material.basis === 'formula') {
    const weighed = (material.formula ?? [])
      .map((line) => ({ part: line.oxide, weight: amountOf(line.moles) * (MOLAR_MASS[line.oxide] ?? NaN) }))
      .filter((line) => line.weight > 0);
    const total = weighed.reduce((sum, line) => sum + line.weight, 0);
    if (!(total > 0)) return null;
    for (const { part, weight } of weighed) {
      if (OXIDES.includes(part)) oxides[part] = (oxides[part] ?? 0) + (weight / total) * 100;
      else loi += (weight / total) * 100;
    }
  } else {
    for (const line of material.oxides) {
      const percent = numberOf(line.percent);
      if (percent !== null && percent > 0) oxides[line.oxide] = (oxides[line.oxide] ?? 0) + percent;
    }
    loi = numberOf(material.loi) ?? 0;
  }
  return Object.keys(oxides).length || loi > 0 ? { oxides, loi } : null;
}

export interface OxideRow {
  oxide: string;
  /** Each material's weight %, null where it has no analysis at all. */
  values: (number | null)[];
  changes: string[];
}

/** The oxides any of the materials has, in the usual order, then the loss on ignition. */
export function compareAnalyses(materials: MaterialContent[]): OxideRow[] {
  const percents = materials.map(weightPercents);
  const row = (oxide: string, value: (p: NonNullable<(typeof percents)[number]>) => number): OxideRow => {
    const values = percents.map((p) => (p ? value(p) : null));
    const changes = values.map((v, i) => (i === 0 || values[0] === null || v === null ? '' : change(values[0], v, 2)));
    return { oxide, values, changes };
  };
  const oxides = OXIDES.filter((oxide) => percents.some((p) => (p?.oxides[oxide] ?? 0) > 0));
  const rows = oxides.map((oxide) => row(oxide, (p) => p.oxides[oxide] ?? 0));
  if (percents.some((p) => (p?.loi ?? 0) > 0)) rows.push(row('LOI', (p) => p.loi));
  return rows;
}
