// Materials side by side by their data sheets and raw-basis analyses, backed by @glazecalc/core/body.
import type { DataSheet as CoreDataSheet, MaterialInput } from '@glazecalc/core';
import {
  compareAnalyses as coreCompareAnalyses,
  compareSheets as coreCompareSheets,
  rawAnalysis,
  sheetCones as coreSheetCones
} from '@glazecalc/core/body';
import { change } from './compare';
import { amountOf, numberOf, type MaterialContent } from './chemistry';
import { HOST } from './chemistryHost';
import { MATERIAL_CLASSES, SHEET_FIELDS, type DataSheet } from './materialData';

export interface SheetRow {
  field: keyof DataSheet;
  label: string;
  unit?: string;
  /** Each material's value as typed, '' where its sheet has none. */
  values: string[];
  /** Each value's difference from the first material's, '' where either is not a number. */
  changes: string[];
  /** Fired at a cone: firing shrinkage, total shrinkage and absorption. */
  fired: boolean;
}

/** Each material's data sheet values, row by row, leaving out rows none of them has. */
export function compareSheets(materials: ReadonlyArray<{ sheet?: DataSheet | CoreDataSheet }>): SheetRow[] {
  return coreCompareSheets(materials).map((row) => {
    const field = row.field as keyof DataSheet;
    const { label, unit } = SHEET_FIELDS.find((f) => f.field === field)!;
    const places = field === 'density' ? 2 : 1;
    const changes = row.deltas.map((delta) => (delta === null ? '' : change(0, delta, places)));
    return { field, label, ...(unit ? { unit } : {}), values: row.values, changes, fired: row.fired };
  });
}

/** Each material's cone, and whether the sheets that give fired values give them at different
 * cones (or one gives none), when they cannot be compared as they stand. */
export function sheetCones(materials: ReadonlyArray<{ sheet?: DataSheet | CoreDataSheet }>): {
  cones: string[];
  differ: boolean;
} {
  return coreSheetCones(materials);
}

export function classLabel(material: { class?: MaterialContent['class'] }): string {
  return MATERIAL_CLASSES.find((c) => c.value === material.class)?.label ?? '';
}

const isMaterialContent = (value: MaterialContent | MaterialInput): value is MaterialContent =>
  Array.isArray((value as MaterialContent).oxides);

function rawInput(material: MaterialContent | MaterialInput): MaterialInput {
  if (!isMaterialContent(material)) return material;
  if (material.basis === 'formula') {
    const formula: Record<string, number> = {};
    for (const line of material.formula ?? []) {
      const moles = amountOf(line.moles);
      if (line.oxide && Number.isFinite(moles) && moles > 0) {
        formula[line.oxide] = (formula[line.oxide] ?? 0) + moles;
      }
    }
    return { formula };
  }
  const analysis: Record<string, number> = {};
  for (const line of material.oxides) {
    const percent = numberOf(line.percent);
    if (line.oxide && percent !== null && percent > 0) {
      analysis[line.oxide] = (analysis[line.oxide] ?? 0) + percent;
    }
  }
  return { analysis, loi: numberOf(material.loi) ?? 0 };
}

/** A material's makeup as weight % of the raw material, with what burns off as its loss on
 * ignition: an analysis as typed, a formula from its moles. Null when it has none to give. */
export function weightPercents(
  material: MaterialContent | MaterialInput
): { oxides: Record<string, number>; loi: number } | null {
  return rawAnalysis(HOST, rawInput(material));
}

export interface OxideRow {
  oxide: string;
  /** Each material's weight %, null where it has no analysis at all. */
  values: (number | null)[];
  changes: string[];
}

/** The oxides any of the materials has, in the usual order, then the loss on ignition. */
export function compareAnalyses(materials: ReadonlyArray<MaterialContent | MaterialInput>): OxideRow[] {
  return coreCompareAnalyses(HOST, materials.map(rawInput)).map((row) => ({
    oxide: row.oxide,
    values: row.values,
    changes: row.deltas.map((delta) => (delta === null ? '' : change(0, delta, 2)))
  }));
}
