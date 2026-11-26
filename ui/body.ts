// A clay body's chemistry (docs/research/clay-bodies.md), backed by @glazecalc/core/body and
// @glazecalc/catalog: bodies are read by their oxide percentages and a formula with alumina as
// one, succeeding cleanly even when a body, slip or wash has no flux oxides.
import {
  bodyChemistry as coreBodyChemistry,
  bodyMakeup as coreBodyMakeup,
  bodyPart as coreBodyPart,
  type BodyChemistry,
  type BodyPart
} from '@glazecalc/core/body';
import { convertWaterBasis } from '@glazecalc/core/recipe';
import { BODIES } from '@glazecalc/catalog/host';
import { usableLines } from './batch';
import {
  normalize,
  numberOf,
  standardRecord,
  type BodyAnalysisResult,
  type MaterialContent,
  type RecipeLine,
  type UmfResult
} from './chemistry';
import { HOST, type VaultTraitsRecord } from './chemistryHost';
import type { RecipeDetails, RecipeType } from './recipeFields';

export type { BodyChemistry, BodyPart };

/** Recipes made mostly of clay, which the chemistry shows as a body. */
const BODY_TYPES: RecipeType[] = ['clay body', 'slip', 'engobe', 'casting slip', 'terra sigillata'];

export function isBody(type: RecipeType | undefined): boolean {
  return !!type && BODY_TYPES.includes(type);
}

export function bodyChemistry(result: UmfResult | BodyAnalysisResult): BodyChemistry {
  if ('percent' in result) {
    return {
      percent: result.percent,
      alumina: result.alumina,
      knaoMol: result.knaoMol,
      fluxMol: result.fluxMol,
      ironTitania: result.ironTitania
    };
  }
  return coreBodyChemistry(HOST, result);
}

function recordForBody(name: string, own: MaterialContent[]): (VaultTraitsRecord & { id?: string; category?: string }) | null {
  const mine = own.find((m) => normalize(m.name) === normalize(name));
  if (mine?.class) return { id: name, name: mine.name, materialClass: mine.class };
  const found = standardRecord(name);
  if (found) return found as VaultTraitsRecord & { category?: string };
  return mine ? { id: name, name, unclassified: true } : { id: name, name };
}

/**
 * What a material is to a body: from the class of the person's own material, else from the
 * standard material of that name. A calcined clay, such as molochite, is not plastic. Null for a
 * material of the person's with no class and no standard name.
 */
export function bodyPart(name: string, own: MaterialContent[]): BodyPart | null {
  return coreBodyPart(HOST, recordForBody(name, own));
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
  const makeup = coreBodyMakeup(
    HOST,
    usable.map((line) => ({ material: recordForBody(line.material, own), amount: line.amount }))
  );
  if (!makeup) return null;
  return { plastic: makeup.plastic, silica: makeup.silica, unknown: makeup.unknown.map(String) };
}

/** Below this much added silica a porcelain tends to craze glazes (BODIES.checks.porcelainSilicaMin). */
export const PORCELAIN_SILICA = BODIES.checks.porcelainSilicaMin;

/** The same water on the other basis: g per 100 g dry as a share of the wet clay, or back. Null
 * for what is not a share of anything. */
export function otherBasis(content: Pick<RecipeDetails, 'water' | 'waterBasis'>): number | null {
  const water = numberOf(content.water ?? '');
  if (water === null) return null;
  return convertWaterBasis(water, content.waterBasis === 'wet' ? 'wet' : 'dry');
}
