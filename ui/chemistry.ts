// Glazecalc's chemistry with its standard materials (docs/adr/0002-chemistry-copy.md).
import {
  calculateUMF,
  FORMULA_MATERIALS,
  materialWeights,
  MOLAR_MASS,
  molesPerGram,
  OXIDE_GROUPS,
  type ChemistryError,
  type MaterialInput,
  type OxideGroup,
  type UmfResult
} from '@glazecalc/chemistry';
import type { DataSheet, MaterialClass } from './materialData';
import type { RecipeDetails } from './recipeFields';
import additivesNdjson from '../vendor/glazecalc/data/additives.ndjson?raw';
import materialsNdjson from '../vendor/glazecalc/data/materials.ndjson?raw';

export interface StandardMaterial extends MaterialInput {
  aliases?: string[];
  category?: string;
  status?: string;
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

export type Analysis =
  | { result: UmfResult; problem?: undefined; noOxides: string[] }
  | { problem: string; result?: undefined }
  | null;

/**
 * Names compare ignoring case, spaces, punctuation and accents, as Glazecalc's library does,
 * except that letters in other scripts are kept: Glazecalc keeps only a to z and digits, so
 * every name in Cyrillic or Japanese would be the same, empty, name.
 */
export const normalize = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

export const sameName = (a: string, b: string) => normalize(a) === normalize(b);

const parse = (ndjson: string) =>
  ndjson
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as StandardMaterial);

export const STANDARD_MATERIALS: StandardMaterial[] = parse(materialsNdjson);
/** Colorants, opacifiers, suspenders and other additions. A few, such as CMC gum, add no oxides. */
export const STANDARD_ADDITIVES: StandardMaterial[] = parse(additivesNdjson);

const materialsByName = new Map(STANDARD_MATERIALS.map((m) => [normalize(m.name), m]));
const formulaNames = new Set(FORMULA_MATERIALS.map((m) => normalize(m.name)));
/** Formula materials by their names and the others they are known by, such as Flint. */
const formulasByName = new Map<string, (typeof FORMULA_MATERIALS)[number]>();
for (const material of FORMULA_MATERIALS) {
  for (const name of [material.name, ...(material.aliases ?? [])]) {
    if (!formulasByName.has(normalize(name))) formulasByName.set(normalize(name), material);
  }
}
const additivesByName = new Map<string, StandardMaterial>();
for (const additive of STANDARD_ADDITIVES) {
  const key = normalize(additive.name);
  if (!materialsByName.has(key) && !formulaNames.has(key)) additivesByName.set(key, additive);
}
const byAlias = new Map<string, StandardMaterial>();
for (const material of [...STANDARD_MATERIALS, ...STANDARD_ADDITIVES]) {
  for (const alias of material.aliases ?? []) {
    if (normalize(alias) && !byAlias.has(normalize(alias))) byAlias.set(normalize(alias), material);
  }
}

const STANDARD_NAMES = [
  ...STANDARD_MATERIALS.map((m) => m.name),
  ...FORMULA_MATERIALS.map((m) => m.name).filter((name) => !materialsByName.has(normalize(name))),
  ...[...additivesByName.values()].map((m) => m.name)
];

/**
 * A line's material: one the chemistry can use, one that adds nothing once fired, or one of the
 * person's own whose analysis cannot be used.
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

const hasOxides = (material: StandardMaterial) =>
  (material.fields ?? []).some((field) => Number(field.amount) > 0);

/** A person's material as the chemistry takes it, null when it has no oxides, or what is wrong. */
function customInput(material: MaterialContent): MaterialInput | null | { problem: string } {
  const name = material.name.trim();
  if (material.basis === 'formula') {
    const parts = (material.formula ?? []).filter((line) => line.oxide && line.moles.trim());
    const bad = parts.find((line) => !Number.isFinite(amountOf(line.moles)));
    if (bad) return { problem: `The amount of ${bad.oxide} in ${name} is not a number.` };
    // Water, carbon dioxide or sulphur alone fire away to nothing.
    if (!parts.some((line) => line.oxide in OXIDE_GROUPS && amountOf(line.moles) > 0)) return null;
    return { name, formula: Object.fromEntries(parts.map((line) => [line.oxide, amountOf(line.moles)])) };
  }
  const used = material.oxides.filter((line) => line.oxide && line.percent.trim());
  if (!used.length) return null;
  // Glazecalc reads a loss on ignition that is not a number as none, so it is checked here.
  const loi = material.loi.trim() ? amountOf(material.loi) : 0;
  if (!Number.isFinite(loi)) return { problem: `The loss on ignition of ${name} is not a number.` };
  return {
    name,
    analysis: Object.fromEntries(used.map((line) => [line.oxide, amountOf(line.percent)])),
    loi
  };
}

/**
 * A name finds the person's own material first, so their supplier's analysis replaces the
 * standard one. Then a standard material's own name, then a formula material (Glazecalc's
 * theoretical ones, such as Potash Feldspar), then a standard additive, and only then another
 * material's alias, so a theoretical material is never quietly swapped for a commercial one that
 * lists it as an alias.
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
    if (materialsByName.has(key)) return materialsByName.get(key)!;
    if (formulaNames.has(key)) return name.trim();
    const standard = additivesByName.get(key) ?? byAlias.get(key);
    if (!standard) return name.trim();
    return hasOxides(standard) ? standard : { noOxides: standard.name };
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

/**
 * The standard material a name finds, by its own name or another it is known by, such as Flint
 * for Silica. Null when the name is not a standard material's.
 */
export function standardNamed(name: string): string | null {
  const found = STANDARD_LIBRARY.resolve(name);
  if (typeof found === 'string') return formulasByName.get(normalize(found))?.name ?? null;
  if ('problem' in found) return null;
  return 'noOxides' in found ? found.noOxides : found.name;
}

/** Whether a recipe line's material is one the library has: the person's, or a standard one. */
export function knownMaterial(library: MaterialLibrary, name: string): boolean {
  const found = library.resolve(name);
  return typeof found !== 'string' || formulasByName.has(normalize(found));
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
    const formula = formulasByName.get(normalize(material));
    return formula ? { name: formula.name, formula: formula.formula } : { problem: `${name.trim()} is not a material Glaze Vault knows.` };
  }
  if ('noOxides' in material) return null;
  return material;
}

/** Oxides fitting never brings in: lead, which no glaze needs. */
const NEVER_CHOSEN = ['PbO'];

/**
 * What fitting may choose from: the raw materials and frits the library has, the person's own
 * first, and none with lead. Colorants and other additions are left out, as nobody wants a fit to
 * reach for iron oxide to make up its iron.
 */
export function fitPool(library: MaterialLibrary): string[] {
  const additives = new Set(STANDARD_ADDITIVES.map((m) => normalize(m.name)));
  return library.names
    .filter(({ name, yours }) => {
      if (yours) {
        const category = library.own.find((m) => sameName(m.name, name))?.category;
        if (category !== 'material' && category !== 'frit') return false;
      } else if (additives.has(normalize(name))) {
        return false;
      }
      const input = materialInput(library, name);
      if (!input || 'problem' in input) return false;
      try {
        const moles = molesPerGram(input);
        return !NEVER_CHOSEN.some((oxide) => (moles[oxide] ?? 0) > 0);
      } catch {
        return false;
      }
    })
    .map(({ name }) => name);
}

export function analyse(lines: RecipeLine[], library: MaterialLibrary = STANDARD_LIBRARY): Analysis {
  const used = lines.filter((line) => line.material.trim() && line.amount.trim());
  if (!used.length) return null;
  const noOxides: string[] = [];
  const counted: { material: MaterialInput | string; amount: number }[] = [];
  for (const line of used) {
    const material = library.resolve(line.material);
    if (typeof material === 'object' && 'problem' in material) return { problem: material.problem };
    if (typeof material === 'object' && 'noOxides' in material) {
      if (!noOxides.includes(material.noOxides)) noOxides.push(material.noOxides);
    } else {
      counted.push({ material, amount: amountOf(line.amount) });
    }
  }
  if (!counted.length) return null;
  try {
    return { result: calculateUMF(counted), noOxides };
  } catch (e) {
    return { problem: (e as ChemistryError).message };
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
  if ('problem' in input) return { noOxides: false, total, problem: input.problem };
  try {
    const { unity, warnings, loi } = materialWeights(input);
    return { noOxides: false, total, unity, warnings, loi };
  } catch (e) {
    return { noOxides: false, total, problem: (e as ChemistryError).message };
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

/** A standard material's analysis as a data sheet gives it, and its kind, to start a person's own from. */
export function standardAnalysis(
  name: string
): { oxides: OxideLine[]; loi: string; category: MaterialCategory } | null {
  const found = STANDARD_LIBRARY.resolve(name);
  if (typeof found === 'object' && ('noOxides' in found || 'problem' in found)) return null;
  const input = typeof found === 'string' ? formulasByName.get(normalize(found)) : found;
  if (!input) return null;
  const percents = Object.entries(molesPerGram(input)).map(
    ([oxide, moles]) => [oxide, moles * MOLAR_MASS[oxide] * 100] as const
  );
  const fired = percents.reduce((sum, [, percent]) => sum + percent, 0);
  const round = (n: number) => String(Number(n.toFixed(2)));
  return {
    oxides: percents
      .filter(([, percent]) => percent >= 0.005)
      .sort((a, b) => OXIDES.indexOf(a[0]) - OXIDES.indexOf(b[0]))
      .map(([oxide, percent]) => ({ oxide, percent: round(percent) })),
    loi: round(Math.max(0, 100 - fired)),
    category: categoryOf(typeof found === 'string' ? undefined : found)
  };
}

export const GROUP_TITLES: Record<OxideGroup, string> = {
  R2O: 'Fluxes (R₂O)',
  RO: 'Fluxes (RO)',
  R2O3: 'Stabilizers (R₂O₃)',
  RO2: 'Glass formers (RO₂)'
};

/** The unity formula's oxides, in their columns, largest first. */
export function oxidesByGroup(result: UmfResult): Record<OxideGroup, [string, number][]> {
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
