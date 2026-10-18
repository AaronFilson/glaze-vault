// A recipe's optional details (type, firing, surface, colour, tags, a slip's targets, a body's class,
// forming, targets and water), and finding and sorting
// recipes by them. Every field may be missing: recipes saved before they existed have none, and
// nobody has to fill them in.
import type { RecipeHead } from './api';
import type { RecipeContent } from './chemistry';

export type RecipeType = 'glaze' | 'clay body' | 'slip' | 'engobe' | 'casting slip' | 'terra sigillata';
export type Atmosphere = 'oxidation' | 'neutral' | 'reduction' | 'salt or soda' | 'wood' | 'raku';
export type Surface = 'glossy' | 'semi-gloss' | 'satin' | 'matte' | 'dry';
export type Transparency = 'transparent' | 'translucent' | 'semi-opaque' | 'opaque';
/** What kind of body (docs/research/clay-body-formulation.md, section 4). */
export type BodyClass =
  | 'terra cotta'
  | 'white earthenware'
  | 'stoneware'
  | 'porcelain'
  | 'flameware'
  | 'sculpture or raku'
  | 'paper clay';
export type Forming = 'throwing' | 'handbuilding' | 'casting' | 'pressing' | 'jiggering' | 'extruding' | 'sculpture';
/** What a water figure is a share of: 100 g of the dry materials, or the wet clay. */
export type WaterBasis = 'dry' | 'wet';

/** The details, as RecipeContent holds them. */
export interface RecipeDetails {
  type?: RecipeType;
  /** One cone, or a range: "6", "04", "9-10". */
  cone?: string;
  atmosphere?: Atmosphere;
  surface?: Surface;
  transparency?: Transparency;
  color?: string;
  tags?: string[];
  /** For a slip or glaze as mixed: the specific gravity aimed for, and Ford cup #4 seconds. */
  gravity?: string;
  viscosity?: string;
  /** For a body: its class and how it is formed. */
  bodyClass?: BodyClass;
  forming?: Forming;
  /** For a body: what its fired bars aim for at its cone, in percent. Either end may be open. */
  absorptionMin?: string;
  absorptionMax?: string;
  shrinkageMin?: string;
  shrinkageMax?: string;
  /** For a body: the water that makes it workable, and what it is a share of (dry unless said). */
  water?: string;
  waterBasis?: WaterBasis;
}

const option = <Value extends string>(value: Value, label: string, ...also: string[]) => ({ value, label, also });

export const RECIPE_TYPES = [
  option<RecipeType>('glaze', 'Glaze'),
  option<RecipeType>('clay body', 'Clay body', 'body', 'clay', 'porcelain', 'stoneware', 'earthenware'),
  option<RecipeType>('slip', 'Slip'),
  option<RecipeType>('engobe', 'Engobe'),
  option<RecipeType>('casting slip', 'Casting slip', 'slipcasting', 'slip casting'),
  option<RecipeType>('terra sigillata', 'Terra sigillata', 'terra sig')
];

export const ATMOSPHERES = [
  option<Atmosphere>('oxidation', 'Oxidation', 'ox', 'electric'),
  option<Atmosphere>('neutral', 'Neutral'),
  option<Atmosphere>('reduction', 'Reduction', 'red', 'gas'),
  option<Atmosphere>('salt or soda', 'Salt or soda', 'salt', 'soda', 'salt & soda', 'salt and soda'),
  option<Atmosphere>('wood', 'Wood', 'wood fired', 'wood-fired'),
  option<Atmosphere>('raku', 'Raku')
];

export const SURFACES = [
  option<Surface>('glossy', 'Glossy', 'gloss', 'shiny'),
  option<Surface>('semi-gloss', 'Semi-gloss', 'semi gloss', 'glossy-semi', 'semi-matte', 'semi matte'),
  option<Surface>('satin', 'Satin', 'satin matte', 'satin-matte'),
  option<Surface>('matte', 'Matte', 'matt', 'mat'),
  option<Surface>('dry', 'Dry', 'matte-dry', 'dry matte')
];

export const TRANSPARENCIES = [
  option<Transparency>('transparent', 'Transparent', 'clear'),
  option<Transparency>('translucent', 'Translucent'),
  option<Transparency>('semi-opaque', 'Semi-opaque', 'semi opaque'),
  option<Transparency>('opaque', 'Opaque')
];

export const BODY_CLASSES = [
  option<BodyClass>('terra cotta', 'Terra cotta or red earthenware', 'terracotta', 'red earthenware', 'earthenware'),
  option<BodyClass>('white earthenware', 'White earthenware', 'whiteware', 'talc body'),
  option<BodyClass>('stoneware', 'Stoneware'),
  option<BodyClass>('porcelain', 'Porcelain'),
  option<BodyClass>('flameware', 'Flameware', 'ovenware'),
  option<BodyClass>('sculpture or raku', 'Sculpture or raku', 'sculpture', 'raku'),
  option<BodyClass>('paper clay', 'Paper clay', 'paperclay')
];

export const FORMINGS = [
  option<Forming>('throwing', 'Throwing', 'thrown', 'wheel'),
  option<Forming>('handbuilding', 'Handbuilding', 'hand building', 'handbuilt'),
  option<Forming>('casting', 'Slip casting', 'casting', 'cast'),
  option<Forming>('pressing', 'Pressing', 'press molding', 'press moulding'),
  option<Forming>('jiggering', 'Jiggering or jollying', 'jigger', 'jolly'),
  option<Forming>('extruding', 'Extruding', 'extrusion'),
  option<Forming>('sculpture', 'Sculpture', 'sculpting')
];

export const WATER_BASES: { value: WaterBasis; label: string }[] = [
  { value: 'dry', label: 'g per 100 g dry' },
  { value: 'wet', label: '% of the wet clay' }
];

/** Recipes that are bodies to form, which have a class, a forming method and targets. */
const FORMED: RecipeType[] = ['clay body', 'casting slip'];

export function isFormed(type: RecipeType | undefined): boolean {
  return !!type && FORMED.includes(type);
}

/** The option a piece of text names, ignoring case and spacing, as other programs write them. */
export function optionNamed<Value extends string>(
  options: { value: Value; label: string; also: string[] }[],
  text: string
): Value | undefined {
  const wanted = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wanted) return undefined;
  return options.find((o) => [o.value, o.label.toLowerCase(), ...o.also].includes(wanted))?.value;
}

export function labelOf<Value extends string>(options: readonly { value: Value; label: string }[], value?: Value): string {
  return options.find((o) => o.value === value)?.label ?? '';
}

/** Tags from what a person types: separated by commas, each once, in the order given. */
export function parseTags(text: string): string[] {
  const tags: string[] = [];
  for (const tag of text.split(/[,;]/).map((t) => t.trim().replace(/\s+/g, ' '))) {
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags;
}

/** The details that are filled in, without empty ones, so a recipe without them stays as it was. */
export function details(content: RecipeDetails): RecipeDetails {
  const kept: RecipeDetails = {};
  if (content.type) kept.type = content.type;
  if (content.cone?.trim()) kept.cone = content.cone.trim();
  if (content.atmosphere) kept.atmosphere = content.atmosphere;
  if (content.surface) kept.surface = content.surface;
  if (content.transparency) kept.transparency = content.transparency;
  if (content.color?.trim()) kept.color = content.color.trim();
  if (content.tags?.length) kept.tags = content.tags;
  if (content.gravity?.trim()) kept.gravity = content.gravity.trim();
  if (content.viscosity?.trim()) kept.viscosity = content.viscosity.trim();
  if (content.bodyClass) kept.bodyClass = content.bodyClass;
  if (content.forming) kept.forming = content.forming;
  for (const key of ['absorptionMin', 'absorptionMax', 'shrinkageMin', 'shrinkageMax', 'water'] as const) {
    if (content[key]?.trim()) kept[key] = content[key]!.trim();
  }
  // The basis says what the water is a share of, so it goes with a water figure.
  if (kept.water && content.waterBasis === 'wet') kept.waterBasis = 'wet';
  return kept;
}

/** Whether two recipes' details are the same, a missing field being the same as an empty one. */
export function sameDetails(a: RecipeDetails, b: RecipeDetails): boolean {
  return JSON.stringify(orderedDetails(a)) === JSON.stringify(orderedDetails(b));
}

function orderedDetails(content: RecipeDetails) {
  const kept = details(content);
  return [
    kept.type,
    kept.cone,
    kept.atmosphere,
    kept.surface,
    kept.transparency,
    kept.color,
    kept.tags ?? [],
    kept.gravity,
    kept.viscosity,
    kept.bodyClass,
    kept.forming,
    kept.absorptionMin,
    kept.absorptionMax,
    kept.shrinkageMin,
    kept.shrinkageMax,
    kept.water,
    kept.waterBasis
  ];
}

/** "0–2%", "at most 2%", "at least 11%", or nothing. */
export function rangeText(min?: string, max?: string): string {
  if (min && max) return `${min}–${max}%`;
  if (max) return `at most ${max}%`;
  if (min) return `at least ${min}%`;
  return '';
}

/** A body's water, as given: "26 g per 100 g dry" or "21% of the wet clay". */
export function waterText(content: RecipeDetails): string {
  if (!content.water?.trim()) return '';
  return content.waterBasis === 'wet'
    ? `${content.water.trim()}% of the wet clay`
    : `${content.water.trim()} g per 100 g dry`;
}

/** The details in a line of text, for printing and comparing: "Glaze · cone 6 · oxidation · …". */
export function describeDetails(content: RecipeDetails): string {
  const kept = details(content);
  const look = [labelOf(SURFACES, kept.surface), labelOf(TRANSPARENCIES, kept.transparency).toLowerCase()]
    .filter(Boolean)
    .join(', ');
  const absorption = rangeText(kept.absorptionMin, kept.absorptionMax);
  const shrinkage = rangeText(kept.shrinkageMin, kept.shrinkageMax);
  return [
    labelOf(RECIPE_TYPES, kept.type),
    labelOf(BODY_CLASSES, kept.bodyClass),
    labelOf(FORMINGS, kept.forming).toLowerCase(),
    kept.cone && `Cone ${kept.cone}`,
    labelOf(ATMOSPHERES, kept.atmosphere),
    look,
    kept.color,
    kept.gravity && `SG ${kept.gravity}`,
    kept.viscosity && `Ford cup ${kept.viscosity} s`,
    absorption && `absorption ${absorption}`,
    shrinkage && `shrinkage ${shrinkage}`,
    kept.water && `water ${waterText(kept)}`
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Whether a recipe has every word searched for, in its name, details, tags, materials or notes. */
export function matchesSearch(content: RecipeContent, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const kept = details(content);
  const text = [
    content.name,
    describeDetails(content),
    kept.cone && `cone${kept.cone} ^${kept.cone}`,
    ...(kept.tags ?? []),
    ...content.lines.map((line) => line.material),
    content.notes
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

export type RecipeOrder = 'changed' | 'name' | 'cone';

export const RECIPE_ORDERS: { value: RecipeOrder; label: string }[] = [
  { value: 'changed', label: 'Last changed' },
  { value: 'name', label: 'Name' },
  { value: 'cone', label: 'Cone' }
];

/** A cone as a number to sort by: 022 to 01 are below 1 (cone 04 is lower than cone 1), and a
 * range sorts by its lowest. Recipes without a cone go last. */
export function coneNumber(cone?: string): number {
  const first = /^\s*\^?\s*(0?)(\d+)/.exec(cone ?? '');
  if (!first) return Infinity;
  const value = Number(first[2]);
  return first[1] === '0' ? -value : value;
}

export function sortRecipes(recipes: RecipeHead[], order: RecipeOrder): RecipeHead[] {
  const byName = (a: RecipeHead, b: RecipeHead) =>
    (a.content.name || 'Untitled').localeCompare(b.content.name || 'Untitled', undefined, { sensitivity: 'base' });
  const sorted = [...recipes];
  if (order === 'name') sorted.sort(byName);
  else if (order === 'cone') {
    sorted.sort((a, b) => {
      const [x, y] = [coneNumber(a.content.cone), coneNumber(b.content.cone)];
      return x === y ? byName(a, b) : x === Infinity ? 1 : y === Infinity ? -1 : x - y;
    });
  } else sorted.sort((a, b) => b.savedAt - a.savedAt);
  return sorted;
}
