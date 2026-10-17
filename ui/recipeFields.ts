// A recipe's optional details (type, firing, surface, colour, tags), and finding and sorting
// recipes by them. Every field may be missing: recipes saved before they existed have none, and
// nobody has to fill them in.
import type { RecipeHead } from './api';
import type { RecipeContent } from './chemistry';

export type RecipeType = 'glaze' | 'clay body' | 'slip' | 'engobe' | 'casting slip' | 'terra sigillata';
export type Atmosphere = 'oxidation' | 'neutral' | 'reduction' | 'salt or soda' | 'wood' | 'raku';
export type Surface = 'glossy' | 'semi-gloss' | 'satin' | 'matte' | 'dry';
export type Transparency = 'transparent' | 'translucent' | 'semi-opaque' | 'opaque';

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

/** The option a piece of text names, ignoring case and spacing, as other programs write them. */
export function optionNamed<Value extends string>(
  options: { value: Value; label: string; also: string[] }[],
  text: string
): Value | undefined {
  const wanted = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wanted) return undefined;
  return options.find((o) => [o.value, o.label.toLowerCase(), ...o.also].includes(wanted))?.value;
}

export function labelOf<Value extends string>(options: { value: Value; label: string }[], value?: Value): string {
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
  return kept;
}

/** Whether two recipes' details are the same, a missing field being the same as an empty one. */
export function sameDetails(a: RecipeDetails, b: RecipeDetails): boolean {
  return JSON.stringify(orderedDetails(a)) === JSON.stringify(orderedDetails(b));
}

function orderedDetails(content: RecipeDetails) {
  const kept = details(content);
  return [kept.type, kept.cone, kept.atmosphere, kept.surface, kept.transparency, kept.color, kept.tags ?? []];
}

/** The details in a line of text, for printing and comparing: "Glaze · cone 6 · oxidation · …". */
export function describeDetails(content: RecipeDetails): string {
  const kept = details(content);
  const look = [labelOf(SURFACES, kept.surface), labelOf(TRANSPARENCIES, kept.transparency).toLowerCase()]
    .filter(Boolean)
    .join(', ');
  return [
    labelOf(RECIPE_TYPES, kept.type),
    kept.cone && `Cone ${kept.cone}`,
    labelOf(ATMOSPHERES, kept.atmosphere),
    look,
    kept.color
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
