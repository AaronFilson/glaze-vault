// What a material is and what its data sheet says, beyond its chemistry
// (docs/research/clay-bodies.md): a class, such as ball clay or grog, and the physical values a
// clay's supplier gives. All optional. The density of the solids also works out the water a slip
// takes at a specific gravity.
import { amountOf, normalize, numberOf, standardNamed, type MaterialContent, type RecipeLine } from './chemistry';
import { SOLIDS_DENSITY } from './slip';

export type MaterialClass =
  | 'ball clay'
  | 'kaolin'
  | 'fire clay'
  | 'stoneware clay'
  | 'earthenware clay'
  | 'plasticizer'
  | 'feldspar'
  | 'nepheline syenite'
  | 'silica'
  | 'talc'
  | 'wollastonite'
  | 'grog'
  | 'deflocculant'
  | 'flocculant'
  | 'other';

/** Each class with a typical density of its solids, g/cm³, when the data sheet gives none. */
export const MATERIAL_CLASSES: { value: MaterialClass; label: string; density: number }[] = [
  { value: 'ball clay', label: 'Ball clay', density: 2.6 },
  { value: 'kaolin', label: 'Kaolin', density: 2.6 },
  { value: 'fire clay', label: 'Fire clay', density: 2.6 },
  { value: 'stoneware clay', label: 'Stoneware clay', density: 2.6 },
  { value: 'earthenware clay', label: 'Earthenware or red clay', density: 2.6 },
  { value: 'plasticizer', label: 'Bentonite or other plasticizer', density: 2.5 },
  { value: 'feldspar', label: 'Feldspar', density: 2.6 },
  { value: 'nepheline syenite', label: 'Nepheline syenite', density: 2.61 },
  { value: 'silica', label: 'Silica', density: 2.65 },
  { value: 'talc', label: 'Talc', density: 2.75 },
  { value: 'wollastonite', label: 'Wollastonite', density: 2.9 },
  { value: 'grog', label: 'Grog or molochite', density: 2.6 },
  { value: 'deflocculant', label: 'Deflocculant', density: 2.6 },
  { value: 'flocculant', label: 'Flocculant', density: 2.6 },
  { value: 'other', label: 'Other', density: 2.6 }
];

const CLAYS: MaterialClass[] = ['ball clay', 'kaolin', 'fire clay', 'stoneware clay', 'earthenware clay', 'plasticizer'];

export function isClay(materialClass: MaterialClass | undefined): boolean {
  return !!materialClass && CLAYS.includes(materialClass);
}

/** A data sheet's values, as typed. The fired ones are at its cone. */
export interface DataSheet {
  cone?: string;
  /** Percent, of a bar's plastic length. */
  dryingShrinkage?: string;
  firingShrinkage?: string;
  absorption?: string;
  /** Percent water of the dry weight that makes it plastic. */
  waterOfPlasticity?: string;
  /** Percent of the particles finer than one micron. */
  finer1um?: string;
  /** In words, as the sheet gives it: "0.5% on 325 mesh". */
  mesh?: string;
  /** In words, with its unit: "550 psi". */
  dryStrength?: string;
  /** Of the solids, g/cm³. */
  density?: string;
}

export const SHEET_FIELDS: { field: keyof DataSheet; label: string; unit?: string; placeholder?: string }[] = [
  { field: 'cone', label: 'Fired at cone', placeholder: '10' },
  { field: 'dryingShrinkage', label: 'Drying shrinkage', unit: '%' },
  { field: 'firingShrinkage', label: 'Firing shrinkage', unit: '%' },
  { field: 'absorption', label: 'Absorption', unit: '%' },
  { field: 'waterOfPlasticity', label: 'Water of plasticity', unit: '%' },
  { field: 'finer1um', label: 'Finer than 1 µm', unit: '%' },
  { field: 'mesh', label: 'Particle size', placeholder: '0.5% on 325 mesh' },
  { field: 'dryStrength', label: 'Dry strength', placeholder: '550 psi' },
  { field: 'density', label: 'Density of the solids', unit: 'g/cm³', placeholder: '2.6' }
];

export function hasSheet(sheet: DataSheet | undefined): boolean {
  return !!sheet && Object.values(sheet).some((value) => value?.trim());
}

/** A data sheet with its empty values left out, or nothing when none are left. */
export function tidySheet(sheet: DataSheet): DataSheet | undefined {
  const kept = Object.fromEntries(Object.entries(sheet).filter(([, value]) => value?.trim()));
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Typical densities of standard materials far from the default, g/cm³, by the start of their
 * standard names, so Wollastonite (NYAD 400) is a wollastonite.
 */
const STANDARD_DENSITIES: Record<string, number> = Object.fromEntries(
  (
    [
      ['Silica', 2.65],
      ['Flint', 2.65],
      ['Quartz', 2.65],
      ['Whiting', 2.71],
      ['Dolomite', 2.85],
      ['Talc', 2.75],
      ['Wollastonite', 2.9],
      ['Nepheline Syenite', 2.61],
      ['Barium Carbonate', 4.3],
      ['Strontium Carbonate', 3.7],
      ['Lithium Carbonate', 2.11],
      ['Zinc Oxide', 5.6],
      ['Bone Ash', 3.1],
      ['Fluorspar', 3.18],
      ['Calcined Alumina', 3.95],
      ['Alumina Hydrate', 2.42],
      ['Zircon', 4.6],
      ['Zirconium oxide', 5.7],
      ['Tin oxide', 6.95],
      ['Titanium dioxide', 4.2],
      ['Rutile', 4.2],
      ['Red iron oxide', 5.24],
      ['Black iron oxide', 5.2],
      ['Cobalt Oxide', 6.1],
      ['Chromium Oxide', 5.2],
      ['Copper oxide', 6.3],
      ['Copper carbonate', 4.0],
      ['Manganese dioxide', 5.0]
    ] as const
  ).map(([name, density]) => [normalize(name), density])
);

/**
 * The density of a material's solids: its data sheet's, then its class's, then a standard
 * material's typical one, then the default.
 */
export function densityOf(name: string, own: MaterialContent[]): number {
  const material = own.find((m) => normalize(m.name) === normalize(name));
  const sheet = numberOf(material?.sheet?.density ?? '');
  if (sheet !== null && sheet > 1) return sheet;
  const byClass = MATERIAL_CLASSES.find((c) => c.value === material?.class);
  if (byClass) return byClass.density;
  const key = normalize(standardNamed(name) ?? name);
  // The longest start that fits, so Zirconium oxide is not a zircon.
  const known = Object.keys(STANDARD_DENSITIES)
    .filter((start) => key.startsWith(start))
    .sort((a, b) => b.length - a.length)[0];
  return known ? STANDARD_DENSITIES[known] : SOLIDS_DENSITY;
}

/**
 * The density of a recipe's dry solids, from each material's by its share of the volume. The
 * default when the recipe has no amounts.
 */
export function recipeDensity(lines: RecipeLine[], own: MaterialContent[]): { density: number; worked: boolean } {
  let weight = 0;
  let volume = 0;
  for (const line of lines) {
    const amount = amountOf(line.amount);
    if (!line.material.trim() || !(amount > 0)) continue;
    weight += amount;
    volume += amount / densityOf(line.material, own);
  }
  return volume > 0 ? { density: weight / volume, worked: true } : { density: SOLIDS_DENSITY, worked: false };
}
