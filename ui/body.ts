// A clay body's chemistry (docs/research/clay-bodies.md): bodies are read by their oxide
// percentages and a formula with alumina as one, not by a glaze's unity formula, which puts the
// few fluxes a body has at one and makes everything else look huge.
import { OXIDE_GROUPS, type UmfResult } from '@glazecalc/chemistry';
import { usableLines } from './batch';
import {
  normalize,
  numberOf,
  STANDARD_ADDITIVES,
  STANDARD_MATERIALS,
  standardNamed,
  type MaterialContent,
  type RecipeLine
} from './chemistry';
import { isClay } from './materialData';
import type { RecipeDetails, RecipeType } from './recipeFields';

/** Recipes made mostly of clay, which the chemistry shows as a body. */
const BODY_TYPES: RecipeType[] = ['clay body', 'slip', 'engobe', 'casting slip', 'terra sigillata'];

export function isBody(type: RecipeType | undefined): boolean {
  return !!type && BODY_TYPES.includes(type);
}

export interface BodyChemistry {
  /** Fired weight percent of each oxide, largest first. */
  percent: [string, number][];
  /** Moles of each oxide per mole of Al2O3, in the chemistry's order; null with no alumina. */
  alumina: [string, number][] | null;
  /** Mole percent of all the fired oxides. */
  knaoMol: number;
  fluxMol: number;
  /** Weight percent of the oxides that colour a fired body most. */
  ironTitania: number;
}

const isFlux = (oxide: string) => OXIDE_GROUPS[oxide] === 'R2O' || OXIDE_GROUPS[oxide] === 'RO';
/** Below this the oxide is a trace, and not shown. */
const TRACE = 0.005;

export function bodyChemistry(result: UmfResult): BodyChemistry {
  const percent = Object.entries(result.analysis)
    .filter(([, p]) => p >= TRACE)
    .sort((a, b) => b[1] - a[1]);
  const moles = Object.entries(result.umf).filter(([oxide, m]) => oxide in OXIDE_GROUPS && m > 0);
  const total = moles.reduce((sum, [, m]) => sum + m, 0);
  const molPercent = (oxides: string[]) =>
    total > 0 ? (100 * moles.filter(([oxide]) => oxides.includes(oxide)).reduce((sum, [, m]) => sum + m, 0)) / total : 0;
  const al = result.umf.Al2O3 ?? 0;
  const order = Object.keys(OXIDE_GROUPS);
  return {
    percent,
    alumina:
      al > 0
        ? moles
            .map(([oxide, m]) => [oxide, m / al] as [string, number])
            .filter(([, m]) => m >= TRACE / 10)
            .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
        : null,
    knaoMol: molPercent(['K2O', 'Na2O']),
    fluxMol: molPercent(moles.map(([oxide]) => oxide).filter(isFlux)),
    ironTitania: (result.analysis.Fe2O3 ?? 0) + (result.analysis.TiO2 ?? 0)
  };
}

/** What a material is to a body: a plastic clay, added silica, or something else. */
export type BodyPart = 'plastic' | 'silica' | 'other';

const PLASTICIZERS = /bentonit|veegum|macaloid|hectorit/;

/**
 * What a material is to a body: from the class of the person's own material, else from the
 * standard material of that name. A calcined clay, such as molochite, is not plastic. Null for a
 * material of the person's with no class and no standard name.
 */
export function bodyPart(name: string, own: MaterialContent[]): BodyPart | null {
  const mine = own.find((m) => normalize(m.name) === normalize(name));
  if (mine?.class) return isClay(mine.class) ? 'plastic' : mine.class === 'silica' ? 'silica' : 'other';
  const standard = standardNamed(name);
  const found = standard && [...STANDARD_MATERIALS, ...STANDARD_ADDITIVES].find((m) => m.name === standard);
  if (!found) return mine ? null : 'other';
  const lower = found.name.toLowerCase();
  if (found.category === 'clay') return /calcined|molochite/.test(lower) ? 'other' : 'plastic';
  if (PLASTICIZERS.test(lower)) return 'plastic';
  return found.category === 'silica' ? 'silica' : 'other';
}

/** What a body is made of, in percent of all its dry materials. */
export interface BodyMakeup {
  plastic: number;
  silica: number;
  /** The person's materials that have no class, and are counted as not plastic. */
  unknown: string[];
}

export function bodyMakeup(lines: RecipeLine[], own: MaterialContent[]): BodyMakeup | null {
  const usable = usableLines(lines);
  const total = usable.reduce((sum, line) => sum + line.amount, 0);
  if (!(total > 0)) return null;
  const makeup: BodyMakeup = { plastic: 0, silica: 0, unknown: [] };
  for (const line of usable) {
    const part = bodyPart(line.material, own);
    if (part === 'plastic') makeup.plastic += (100 * line.amount) / total;
    if (part === 'silica') makeup.silica += (100 * line.amount) / total;
    if (part === null && !makeup.unknown.includes(line.material)) makeup.unknown.push(line.material);
  }
  return makeup;
}

/** Below this much added silica a porcelain tends to craze glazes (the research, section 12). */
export const PORCELAIN_SILICA = 20;

/** The same water on the other basis: g per 100 g dry as a share of the wet clay, or back. Null
 * for what is not a share of anything. */
export function otherBasis(content: Pick<RecipeDetails, 'water' | 'waterBasis'>): number | null {
  const water = numberOf(content.water ?? '');
  if (water === null || water <= 0) return null;
  if (content.waterBasis === 'wet') return water < 100 ? (100 * water) / (100 - water) : null;
  return (100 * water) / (100 + water);
}
