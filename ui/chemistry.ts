// Glazecalc's chemistry core and standard catalog (docs/adr/0002-chemistry-copy.md).
import type { DataSheet as CoreDataSheet, MaterialClass, MaterialInput, OxideGroup } from '@glazecalc/core';
import { calculateBody, effectiveSheet, type BodyResult as CoreBodyResult } from '@glazecalc/core/body';
import {
  calculateUMF,
  materialWeights,
  molesPerGram,
  type UmfResult as CoreUmfResult
} from '@glazecalc/core/chemistry';
import { MOLAR_MASS, OXIDE_GROUPS } from '@glazecalc/catalog/host';
import { readRecords } from '@glazecalc/catalog/standard';
import { FORMULA_MATERIALS, nameKey } from '@glazecalc/catalog/text';
import { HOST, inWords, wordedWarnings, type WordedWarning } from './chemistryHost';
import type { DataSheet } from './materialData';
import type { RecipeDetails } from './recipeFields';
import additivesNdjson from '../lib/catalog/data/additives.ndjson?raw';
import materialsNdjson from '../lib/catalog/data/materials.ndjson?raw';

export type { MaterialInput, OxideGroup };

export interface UmfResult extends Omit<CoreUmfResult, 'warningCodes'> {
  warnings: string[];
  warningCodes: WordedWarning[];
}

export interface BodyAnalysisResult extends Omit<CoreBodyResult, 'warningCodes'> {
  warnings: string[];
  warningCodes: WordedWarning[];
}

export interface StandardMaterial extends MaterialInput {
  name: string;
  uuid?: string;
  ownedBy?: string;
  aliases?: string[];
  category?: string;
  status?: string;
  noChemistry?: boolean;
  traits?: Record<string, unknown>;
}

export interface RecipeLine {
  material: string;
  amount: string;
  /** On top of the base: the other lines add up to 100, and this is added to them, as grog or a
   * colorant often is. Missing means part of the base. */
  addition?: boolean;
}

/** What the core stores, encrypted, for each revision of a recipe, with its optional details. */
export interface RecipeContent extends RecipeDetails {
  name: string;
  lines: RecipeLine[];
  notes: string;
}

export type MaterialCategory = 'material' | 'frit' | 'colorant' | 'additive';

export const MATERIAL_CATEGORIES: { category: MaterialCategory; label: string }[] = [
  { category: 'material', label: 'Raw material' },
  { category: 'frit', label: 'Frit' },
  { category: 'colorant', label: 'Colorant or stain' },
  { category: 'additive', label: 'Opacifier, suspender or other additive' }
];

export interface OxideLine {
  oxide: string;
  /** Weight percent of the raw material, as on a supplier's data sheet. */
  percent: string;
}

export interface FormulaLine {
  /** An oxide, or a volatile: H2O, CO2 or SO3. */
  oxide: string;
  moles: string;
}

/** What the core stores, encrypted, for each revision of a person's own material. */
export interface MaterialContent {
  name: string;
  category: MaterialCategory;
  /** How the chemistry is given: an analysis, as on a data sheet (the default), or a molar
   * formula, such as kaolin's Al2O3·2SiO2·2H2O. Both are kept while switching between them. */
  basis?: 'analysis' | 'formula';
  oxides: OxideLine[];
  /** Loss on ignition, percent. */
  loi: string;
  formula?: FormulaLine[];
  notes: string;
  /** What it is, as a body formulator sorts materials: ball clay, kaolin, grog. */
  class?: MaterialClass;
  /** Its data sheet's physical values. */
  sheet?: DataSheet;
}

/** Every oxide the chemistry knows, in the order of its columns. */
export const OXIDES: string[] = Object.keys(OXIDE_GROUPS);
/** What a formula can hold: the oxides, and what burns off. */
export const FORMULA_PARTS: string[] = [
  ...OXIDES,
  ...Object.keys(MOLAR_MASS).filter((part) => !(part in OXIDE_GROUPS))
];

export type GlazeAnalysis =
  | { result: UmfResult; problem?: undefined; noOxides: string[] }
  | { problem: string; result?: undefined }
  | null;

export type Analysis =
  | { result: UmfResult | BodyAnalysisResult; problem?: undefined; noOxides: string[] }
  | { problem: string; result?: undefined }
  | null;

/** Names compare ignoring case, spaces, punctuation and accents, keeping letters in any script. */
export const normalize = (name: string): string => nameKey(name);

export const sameName = (a: string, b: string): boolean => normalize(a) === normalize(b);

export const STANDARD_MATERIALS: StandardMaterial[] = readRecords<StandardMaterial>(materialsNdjson);
/** Colorants, opacifiers, suspenders and other additions. A few, such as CMC gum, add no oxides. */
export const STANDARD_ADDITIVES: StandardMaterial[] = readRecords<StandardMaterial>(additivesNdjson);

const materialsByName = new Map(STANDARD_MATERIALS.map((m) => [normalize(m.name), m]));
const formulaByName = new Map(
  FORMULA_MATERIALS.map((m) => [
    normalize(m.name),
    { name: m.name, ownedBy: 'Standard', formula: m.formula } as MaterialInput & { ownedBy: string }
  ])
);
const additivesByName = new Map<string, StandardMaterial>();
for (const additive of STANDARD_ADDITIVES) {
  const key = normalize(additive.name);
  if (!materialsByName.has(key) && !formulaByName.has(key)) additivesByName.set(key, additive);
}
/** Aliases from standard materials, standard additives and formula materials (such as Flint or Quartz). */
const byAlias = new Map<string, StandardMaterial | MaterialInput>();
for (const material of [...STANDARD_MATERIALS, ...STANDARD_ADDITIVES]) {
  for (const alias of material.aliases ?? []) {
    const key = normalize(alias);
    if (key && !byAlias.has(key)) byAlias.set(key, material);
  }
}
for (const material of FORMULA_MATERIALS) {
  for (const alias of material.aliases ?? []) {
    const key = normalize(alias);
    if (key && !byAlias.has(key)) {
      byAlias.set(
        key,
        materialsByName.get(normalize(material.name)) ??
          additivesByName.get(normalize(material.name)) ?? {
            name: material.name,
            ownedBy: 'Standard',
            formula: material.formula
          }
      );
    }
  }
}

const STANDARD_NAMES = [
  ...STANDARD_MATERIALS.map((m) => m.name),
  ...FORMULA_MATERIALS.map((m) => m.name).filter((name) => !materialsByName.has(normalize(name))),
  ...[...additivesByName.values()].map((m) => m.name)
];

/**
 * A line's material: one the chemistry can use, one that adds nothing once fired, an unknown
 * reference string, or one of the person's own whose analysis cannot be used.
 */
type Resolved = MaterialInput | string | { noOxides: string } | { problem: string };

/** The materials a recipe can use: the person's own, then the standard ones. */
export interface MaterialLibrary {
  /** For the material list: every name, and whether it is the person's own. */
  names: { name: string; yours: boolean }[];
  resolve: (name: string) => Resolved;
  /** The person's own materials it was made from. */
  own: MaterialContent[];
}

const hasOxides = (material: StandardMaterial | MaterialInput): boolean => {
  if ('formula' in material && material.formula) return true;
  if ('analysis' in material && material.analysis) return true;
  const standard = material as StandardMaterial;
  return !standard.noChemistry && (standard.fields ?? []).some((field) => Number(field.amount) > 0);
};

/** A person's material as the chemistry takes it, null when it has no oxides, or what is wrong. */
function customInput(material: MaterialContent): (MaterialInput & { materialClass?: MaterialClass }) | null | { problem: string } {
  const name = material.name.trim();
  const extra = material.class ? { materialClass: material.class } : {};
  if (material.basis === 'formula') {
    const parts = (material.formula ?? []).filter((line) => line.oxide && line.moles.trim());
    const bad = parts.find((line) => !Number.isFinite(amountOf(line.moles)));
    if (bad) return { problem: `The amount of ${bad.oxide} in ${name} is not a number.` };
    // Water, carbon dioxide or sulphur alone fire away to nothing.
    if (!parts.some((line) => line.oxide in OXIDE_GROUPS && amountOf(line.moles) > 0)) return null;
    return {
      name,
      formula: Object.fromEntries(parts.map((line) => [line.oxide, amountOf(line.moles)])),
      ...extra
    };
  }
  const used = material.oxides.filter((line) => line.oxide && line.percent.trim());
  if (!used.length) return null;
  const loi = material.loi.trim() ? amountOf(material.loi) : 0;
  if (!Number.isFinite(loi)) return { problem: `The loss on ignition of ${name} is not a number.` };
  return {
    name,
    analysis: Object.fromEntries(used.map((line) => [line.oxide, amountOf(line.percent)])),
    loi,
    ...extra
  };
}

/**
 * A name finds the person's own material first, so their supplier's analysis replaces the
 * standard one. Then a standard material's own name, then a formula material (Glazecalc's
 * theoretical ones, such as Potash Feldspar (theoretical)), then a standard additive, and only
 * then another material's alias, with strict matching against @glazecalc/catalog.
 */
export function materialLibrary(custom: MaterialContent[]): MaterialLibrary {
  const yours = new Map<string, MaterialContent>();
  for (const material of custom) {
    if (normalize(material.name) && !yours.has(normalize(material.name))) yours.set(normalize(material.name), material);
  }
  const resolve = (name: string): Resolved => {
    const key = normalize(name);
    if (!key) return name.trim();
    const own = yours.get(key);
    if (own) return customInput(own) ?? { noOxides: own.name.trim() };
    const direct = materialsByName.get(key) ?? formulaByName.get(key) ?? additivesByName.get(key) ?? byAlias.get(key);
    if (!direct) return name.trim();
    return hasOxides(direct) ? direct : { noOxides: String(direct.name) };
  };
  const names = [
    ...[...yours.values()].map((material) => ({ name: material.name.trim(), yours: true })),
    ...STANDARD_NAMES.filter((name) => !yours.has(normalize(name))).map((name) => ({ name, yours: false }))
  ].sort((a, b) => a.name.localeCompare(b.name));
  return { names, resolve, own: custom };
}

export const STANDARD_LIBRARY = materialLibrary([]);

/** Every standard name a recipe line can use. */
export const MATERIAL_NAMES: string[] = STANDARD_LIBRARY.names.map((entry) => entry.name);

const isProblem = (value: unknown): value is { problem: string } =>
  typeof value === 'object' && value !== null && typeof (value as { problem?: unknown }).problem === 'string';

const isNoOxides = (value: unknown): value is { noOxides: string } =>
  typeof value === 'object' && value !== null && typeof (value as { noOxides?: unknown }).noOxides === 'string';

/**
 * The standard record a name resolves to (including no-chemistry additives and formula materials),
 * or null when the name is not a standard material's.
 */
export function standardRecord(name: string): StandardMaterial | MaterialInput | null {
  const key = normalize(name);
  if (!key) return null;
  return materialsByName.get(key) ?? formulaByName.get(key) ?? additivesByName.get(key) ?? byAlias.get(key) ?? null;
}

/**
 * The standard material a name finds, by its own name or another it is known by, such as Flint
 * for Silica. Null when the name is not a standard material's.
 */
export function standardNamed(name: string): string | null {
  const found = standardRecord(name);
  return found ? String(found.name) : null;
}

/** Whether a recipe line's material is one the library has: the person's, or a standard one. */
export function knownMaterial(library: MaterialLibrary, name: string): boolean {
  return typeof library.resolve(name) !== 'string';
}

/** Accepts 12.5 or 12,5. */
export function amountOf(text: string): number {
  return Number(text.trim().replace(',', '.'));
}

/** As amountOf, but null when nothing is typed or it is not a number. */
export function numberOf(text: string): number | null {
  const value = amountOf(text);
  return text.trim() && Number.isFinite(value) ? value : null;
}

/**
 * A line's material as the chemistry's fitting takes it: an object, not a name, so a formula
 * material is given its formula. Null when it adds nothing once fired.
 */
export function materialInput(library: MaterialLibrary, name: string): MaterialInput | null | { problem: string } {
  const material = library.resolve(name);
  if (typeof material === 'string') {
    return { problem: `${name.trim()} is not a material Glaze Vault knows.` };
  }
  if (isNoOxides(material)) return null;
  return material;
}

export { isProblem };

/** Oxides fitting never brings in: lead, which no glaze needs. */
const NEVER_CHOSEN = ['PbO'];

/**
 * What fitting may choose from: the raw materials and frits the library has, the person's own
 * first, and none with lead. Colorants and other additions are left out, as nobody wants a fit to
 * reach for iron oxide to make up its iron.
 */
export function fitPool(library: MaterialLibrary): string[] {
  const nonBase = new Set([
    ...STANDARD_ADDITIVES.map((m) => normalize(m.name)),
    ...STANDARD_MATERIALS.filter((m) => categoryOf(m) !== 'material' && categoryOf(m) !== 'frit').map((m) =>
      normalize(m.name)
    ),
    ...FORMULA_MATERIALS.filter((m) => formulaCategoryOf(m.name) !== 'material').map((m) => normalize(m.name))
  ]);
  return library.names
    .filter(({ name, yours }) => {
      if (yours) {
        const category = library.own.find((m) => sameName(m.name, name))?.category;
        if (category !== 'material' && category !== 'frit') return false;
      } else if (nonBase.has(normalize(name))) {
        return false;
      }
      const input = materialInput(library, name);
      if (!input || isProblem(input)) return false;
      try {
        const moles = molesPerGram(HOST, input);
        return !NEVER_CHOSEN.some((oxide) => (moles[oxide] ?? 0) > 0);
      } catch {
        return false;
      }
    })
    .map(({ name }) => name);
}

export function analyse(lines: RecipeLine[], library?: MaterialLibrary): GlazeAnalysis;
export function analyse(
  lines: RecipeLine[],
  library: MaterialLibrary | undefined,
  options: { body?: boolean }
): Analysis;
export function analyse(
  lines: RecipeLine[],
  library: MaterialLibrary = STANDARD_LIBRARY,
  options?: { body?: boolean }
): Analysis {
  const used = lines.filter((line) => line.material.trim() && line.amount.trim());
  if (!used.length) return null;
  const noOxides: string[] = [];
  const counted: { material: MaterialInput | string; amount: number }[] = [];
  for (const line of used) {
    const material = library.resolve(line.material);
    if (isProblem(material)) return { problem: material.problem };
    if (isNoOxides(material)) {
      if (!noOxides.includes(material.noOxides)) noOxides.push(material.noOxides);
    } else {
      counted.push({ material, amount: amountOf(line.amount) });
    }
  }
  if (!counted.length) return null;
  try {
    if (options?.body) {
      const { warningCodes, ...figures } = inWords(calculateBody)(HOST, counted);
      return { result: { ...figures, ...wordedWarnings(warningCodes, { once: true }) }, noOxides };
    }
    const { warningCodes, ...figures } = inWords(calculateUMF)(HOST, counted);
    return { result: { ...figures, ...wordedWarnings(warningCodes, { once: true }) }, noOxides };
  } catch (e) {
    return { problem: (e as Error).message };
  }
}

/**
 * A person's material checked: what its analysis adds up to, and its own unity formula. A
 * formula's total is its formula weight, and its loss on ignition what burns off.
 */
export type MaterialCheck =
  | { noOxides: true; total: number }
  | { noOxides: false; total: number; unity: Record<string, number>; warnings: string[]; loi: number }
  | { noOxides: false; total: number; problem: string };

export function checkMaterial(material: MaterialContent): MaterialCheck {
  const input = customInput({ ...material, name: material.name.trim() || 'This material' });
  const total =
    material.basis === 'formula'
      ? (material.formula ?? [])
          .filter((line) => line.moles.trim())
          .reduce((sum, line) => sum + amountOf(line.moles) * (MOLAR_MASS[line.oxide] ?? NaN), 0)
      : [...material.oxides.map((line) => line.percent), material.loi]
          .filter((text) => text.trim())
          .reduce((sum, text) => sum + amountOf(text), 0);
  if (!input) return { noOxides: true, total };
  if (isProblem(input)) return { noOxides: false, total, problem: input.problem };
  try {
    const { unity, warningCodes, loi } = inWords(materialWeights)(HOST, input);
    const { warnings } = wordedWarnings(warningCodes, { once: false });
    return { noOxides: false, total, unity, warnings, loi };
  } catch (e) {
    return { noOxides: false, total, problem: (e as Error).message };
  }
}

/** The kind of a standard material, from Glazecalc's finer categories. */
function categoryOf(material: StandardMaterial | undefined): MaterialCategory {
  switch (material?.category) {
    case 'frit':
      return 'frit';
    case 'colorant':
      return 'colorant';
    case 'opacifier':
    case 'suspender':
    case 'other':
      return 'additive';
    default:
      return 'material';
  }
}

/** Category for a FORMULA_MATERIALS entry, matching any commercial counterpart in data/. */
function formulaCategoryOf(name: string): MaterialCategory {
  const baseKey = normalize(name.replace(/\s*\(theoretical\)$/i, ''));
  const match = materialsByName.get(normalize(name)) ?? additivesByName.get(normalize(name)) ?? additivesByName.get(baseKey);
  return categoryOf(match);
}

function typedSheetOf(raw: CoreDataSheet | undefined): DataSheet | undefined {
  const resolved = effectiveSheet(raw);
  if (!resolved) return undefined;
  const keys = [
    'cone',
    'dryingShrinkage',
    'firingShrinkage',
    'totalShrinkage',
    'absorption',
    'waterOfPlasticity',
    'finer1um',
    'finer2um',
    'mesh',
    'dryStrength',
    'density'
  ] as const;
  const entries = keys.flatMap((key) => {
    const val = resolved[key];
    return val !== undefined && val !== null && String(val).trim() ? [[key, String(val).trim()] as const] : [];
  });
  return entries.length ? (Object.fromEntries(entries) as DataSheet) : undefined;
}

/** A standard material's analysis as a data sheet gives it, and its kind, to start a person's own from. */
export function standardAnalysis(name: string): {
  oxides: OxideLine[];
  loi: string;
  category: MaterialCategory;
  class?: MaterialClass;
  sheet?: DataSheet;
} | null {
  const found = STANDARD_LIBRARY.resolve(name);
  if (typeof found === 'string' || isNoOxides(found) || isProblem(found)) return null;
  const percents = Object.entries(inWords(molesPerGram)(HOST, found)).map(
    ([oxide, moles]) => [oxide, moles * MOLAR_MASS[oxide] * 100] as const
  );
  const fired = percents.reduce((sum, [, percent]) => sum + percent, 0);
  const round = (n: number) => String(Number(n.toFixed(2)));
  const category = 'category' in found ? categoryOf(found as StandardMaterial) : formulaCategoryOf(String(found.name));
  const std = found as StandardMaterial;
  const materialClass = (std.traits as { materialClass?: MaterialClass } | undefined)?.materialClass;
  const sheet = typedSheetOf(std.sheet);
  return {
    oxides: percents
      .filter(([, percent]) => percent >= 0.005)
      .sort((a, b) => OXIDES.indexOf(a[0]) - OXIDES.indexOf(b[0]))
      .map(([oxide, percent]) => ({ oxide, percent: round(percent) })),
    loi: round(Math.max(0, 100 - fired)),
    category,
    ...(materialClass ? { class: materialClass } : {}),
    ...(sheet ? { sheet } : {})
  };
}

export const GROUP_TITLES: Record<OxideGroup, string> = {
  R2O: 'Fluxes (R₂O)',
  RO: 'Fluxes (RO)',
  R2O3: 'Stabilizers (R₂O₃)',
  RO2: 'Glass formers (RO₂)'
};

/** The unity formula's oxides, in their columns, largest first. */
export function oxidesByGroup(result: Pick<CoreUmfResult, 'umf'>): Record<OxideGroup, [string, number][]> {
  const groups: Record<OxideGroup, [string, number][]> = { R2O: [], RO: [], R2O3: [], RO2: [] };
  for (const [oxide, moles] of Object.entries(result.umf)) {
    const group = OXIDE_GROUPS[oxide];
    if (group && moles > 0) groups[group].push([oxide, moles]);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b[1] - a[1]);
  return groups;
}

/** K2O → K₂O */
export function oxideLabel(oxide: string): string {
  return oxide.replace(/\d/g, (d) => String.fromCharCode(0x2080 + Number(d)));
}
