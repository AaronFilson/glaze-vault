// What a material is and what its data sheet says, beyond its chemistry: a class, such as ball
// clay or grog, and the physical values a clay's supplier gives, backed by @glazecalc/core and
// @glazecalc/catalog.
import type { MaterialClass, MaterialInput } from '@glazecalc/core';
import { isPlasticClass } from '@glazecalc/core/body';
import { bodySolidsSg, lineSolidsSg, type SgMaterial } from '@glazecalc/core/recipe';
import {
  MATERIAL_CLASSES as CATALOG_MATERIAL_CLASSES,
  SHEET_FIELDS as CATALOG_SHEET_FIELDS
} from '@glazecalc/catalog';
import { amountOf, normalize, numberOf, standardRecord, type MaterialContent, type RecipeLine } from './chemistry';
import { HOST, type VaultTraitsRecord } from './chemistryHost';
import { SOLIDS_DENSITY } from './slip';

export type { MaterialClass };

/** Each class with a typical density of its solids, g/cm³, when the data sheet gives none. */
export const MATERIAL_CLASSES: { value: MaterialClass; label: string; density: number }[] =
  CATALOG_MATERIAL_CLASSES.map(({ value, label, density }) => ({ value, label, density }));

export function isClay(materialClass: MaterialClass | undefined): boolean {
  return isPlasticClass(materialClass);
}

/** A data sheet's values, as typed. The fired ones are at its cone. */
export interface DataSheet {
  cone?: string;
  /** Percent, of a bar's plastic length. */
  dryingShrinkage?: string;
  firingShrinkage?: string;
  totalShrinkage?: string;
  absorption?: string;
  /** Percent water of the dry weight that makes it plastic. */
  waterOfPlasticity?: string;
  /** Percent of the particles finer than one or two microns. */
  finer1um?: string;
  finer2um?: string;
  /** In words, as the sheet gives it: "0.5% on 325 mesh". */
  mesh?: string;
  /** In words, with its unit: "550 psi". */
  dryStrength?: string;
  /** Of the solids, g/cm³. */
  density?: string;
}

export const SHEET_FIELDS: { field: keyof DataSheet; label: string; unit?: string; placeholder?: string }[] =
  CATALOG_SHEET_FIELDS.map(({ field, label, unit, placeholder }) => ({
    field: field as keyof DataSheet,
    label,
    ...(unit ? { unit } : {}),
    ...(placeholder ? { placeholder } : {})
  }));

export function hasSheet(sheet: DataSheet | undefined): boolean {
  return !!sheet && Object.values(sheet).some((value) => value?.trim());
}

/** A data sheet with its empty values left out, or nothing when none are left. */
export function tidySheet(sheet: DataSheet): DataSheet | undefined {
  const kept = Object.fromEntries(Object.entries(sheet).filter(([, value]) => value?.trim()));
  return Object.keys(kept).length ? kept : undefined;
}

function sgRecord(name: string, own: MaterialContent[]): SgMaterial & VaultTraitsRecord {
  const mine = own.find((m) => normalize(m.name) === normalize(name));
  const sheet = numberOf(mine?.sheet?.density ?? '');
  if (sheet !== null && sheet > 1) return { sheet: { density: sheet } };
  if (mine?.class) return { materialClass: mine.class };
  const found = standardRecord(name);
  return (found as (MaterialInput & SgMaterial & VaultTraitsRecord) | null) ?? {};
}

/**
 * The density of a material's solids: its data sheet's, then its class's, then a standard
 * material's mineral/kind/glass SG from @glazecalc/catalog, then the default.
 */
export function densityOf(name: string, own: MaterialContent[]): number {
  return lineSolidsSg(HOST, sgRecord(name, own), SOLIDS_DENSITY);
}

/**
 * The density of a recipe's dry solids, from each material's by its share of the volume. The
 * default when the recipe has no amounts.
 */
export function recipeDensity(lines: RecipeLine[], own: MaterialContent[]): { density: number; worked: boolean } {
  const { sg, worked } = bodySolidsSg(
    HOST,
    lines
      .filter((line) => line.material.trim())
      .map((line) => ({ ...sgRecord(line.material, own), amount: amountOf(line.amount) })),
    SOLIDS_DENSITY
  );
  return { density: sg, worked };
}
