// Glazecalc's chemistry with its standard materials (docs/adr/0002-chemistry-copy.md).
import {
  calculateUMF,
  FORMULA_MATERIALS,
  OXIDE_GROUPS,
  type ChemistryError,
  type MaterialInput,
  type OxideGroup,
  type UmfResult
} from '@glazecalc/chemistry';
import materialsNdjson from '../vendor/glazecalc/data/materials.ndjson?raw';

export interface StandardMaterial extends MaterialInput {
  aliases?: string[];
  category?: string;
  status?: string;
}

export interface RecipeLine {
  material: string;
  amount: string;
}

/** What the core stores, encrypted, for each revision of a recipe. */
export interface RecipeContent {
  name: string;
  lines: RecipeLine[];
  notes: string;
}

export type Analysis = { result: UmfResult; problem?: undefined } | { problem: string; result?: undefined } | null;

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export const STANDARD_MATERIALS: StandardMaterial[] = materialsNdjson
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as StandardMaterial);

// A name finds a standard material's own name first, then a formula material (Glazecalc's
// theoretical ones, such as Potash Feldspar), and only then another material's alias, so a
// theoretical material is never quietly swapped for a commercial one that lists it as an alias.
const byName = new Map(STANDARD_MATERIALS.map((m) => [normalize(m.name), m]));
const formulaNames = new Set(FORMULA_MATERIALS.map((m) => normalize(m.name)));
const byAlias = new Map<string, StandardMaterial>();
for (const material of STANDARD_MATERIALS) {
  for (const alias of material.aliases ?? []) {
    if (!byAlias.has(normalize(alias))) byAlias.set(normalize(alias), material);
  }
}

function resolve(name: string): StandardMaterial | string {
  const key = normalize(name);
  if (byName.has(key)) return byName.get(key)!;
  if (formulaNames.has(key)) return name.trim();
  return byAlias.get(key) ?? name.trim();
}

/** Every name a recipe line can use: the standard library and the formula materials. */
export const MATERIAL_NAMES: string[] = [
  ...STANDARD_MATERIALS.map((m) => m.name),
  ...FORMULA_MATERIALS.map((m) => m.name).filter((name) => !byName.has(normalize(name)))
].sort((a, b) => a.localeCompare(b));

/** Accepts 12.5 or 12,5. */
export function amountOf(text: string): number {
  return Number(text.trim().replace(',', '.'));
}

export function analyse(lines: RecipeLine[]): Analysis {
  const used = lines.filter((line) => line.material.trim() && line.amount.trim());
  if (!used.length) return null;
  try {
    const result = calculateUMF(
      used.map((line) => ({
        material: resolve(line.material),
        amount: amountOf(line.amount)
      }))
    );
    return { result };
  } catch (e) {
    return { problem: (e as ChemistryError).message };
  }
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
