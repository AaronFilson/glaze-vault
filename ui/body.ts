// A clay body's chemistry (docs/research/clay-bodies.md): bodies are read by their oxide
// percentages and a formula with alumina as one, not by a glaze's unity formula, which puts the
// few fluxes a body has at one and makes everything else look huge.
import { OXIDE_GROUPS, type UmfResult } from '@glazecalc/chemistry';
import type { RecipeType } from './recipeFields';

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
