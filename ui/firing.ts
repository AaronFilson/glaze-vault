// The firing log (docs/adr/0014-firing-log-and-photos.md): each firing of a recipe, how it was
// fired, what came out, a fired bar's measurements and photos. What a firing shows is worked out
// here from what was measured; only the measurements are kept.
import type { Revision } from './api';
import { amountOf, numberOf, type RecipeLine } from './chemistry';
import { coneNumber, type Atmosphere, type RecipeDetails, type Surface, type Transparency } from './recipeFields';
import { hasSlipReadings, type SlipReadings } from './slip';

export const FLAWS = [
  { value: 'crazed', label: 'Crazed' },
  { value: 'shivered', label: 'Shivered' },
  { value: 'crawled', label: 'Crawled' },
  { value: 'pinholed', label: 'Pinholed' },
  { value: 'blistered', label: 'Blistered' },
  { value: 'ran', label: 'Ran' },
  { value: 'bloated', label: 'Bloated' },
  { value: 'warped', label: 'Warped' }
] as const;

export type Flaw = (typeof FLAWS)[number]['value'];

/** A photo the firing names: the attachment holding it, and what it shows. */
export interface Photo {
  id: string;
  mediaType: string;
  caption: string;
}

/** Readings from a test bar, as typed: lengths in mm between marks, weights in grams. The
 * suspended weight is optional, for porosity and density. A bar fired spanned between two supports
 * shows warping: its bow when dry and its sag fired, in mm. A drying disk's cracks go with them. */
export interface BarReadings {
  mark: string;
  dry: string;
  fired: string;
  firedWeight: string;
  soakedWeight: string;
  suspendedWeight: string;
  span?: string;
  bow?: string;
  sag?: string;
  /** The drying disk's crack code, or its cracks in words. */
  disk?: string;
}

/** Tests of how a glaze fits the body it was fired on (docs/research/clay-body-formulation.md). */
export const FIT_TESTS = [
  { value: 'iwct', label: '300 °F to ice water (IWCT)' },
  { value: 'bwiw', label: 'Boiling to ice water (BWIW)' },
  { value: 'pressure', label: 'Pressure cooker or autoclave' },
  { value: 'other', label: 'Another test' }
] as const;

export const FIT_RESULTS = [
  { value: 'passed', label: 'Passed' },
  { value: 'crazed', label: 'Crazed' },
  { value: 'shivered', label: 'Shivered' }
] as const;

export type FitTestKind = (typeof FIT_TESTS)[number]['value'];
export type FitResult = (typeof FIT_RESULTS)[number]['value'];

export interface FitTest {
  test: FitTestKind;
  result?: FitResult;
  /** How it was done, as typed: "at 325 °F", "3 cycles". */
  detail?: string;
}

/** The body a glaze was fired on: one of the recipes, or a clay by its name. */
export interface FiredOn {
  recipe: string | null;
  name: string;
}

/** What the core keeps for each revision of a firing. */
export interface FiringContent {
  /** The recipe fired, and which of its revisions. */
  recipe: string | null;
  recipeNumber: number | null;
  /** Its name then, for when it is renamed, erased, or not this person's to open. */
  recipeName: string;
  /** The day it was fired, as YYYY-MM-DD. */
  firedOn: string;
  cone?: string;
  atmosphere?: Atmosphere;
  kiln?: string;
  /** The peak temperature, with its unit. */
  peak?: string;
  peakUnit?: 'C' | 'F';
  schedule?: string;
  surface?: Surface;
  transparency?: Transparency;
  color?: string;
  flaws?: Flaw[];
  bar?: BarReadings;
  /** The slip or glaze as it was applied. */
  slip?: SlipReadings;
  /** The lot or bag of each material of the revision fired, in the order of its materials
   * (lotMaterials), so a role that reads firings without chemistry sees no material names. */
  lots?: string[];
  /** For a glaze: the body it was fired on, and how it fit. */
  body?: FiredOn;
  fit?: FitTest;
  notes: string;
  photos: Photo[];
}

export type Firing = Revision<FiringContent>;

export const EMPTY_BAR: BarReadings = { mark: '100', dry: '', fired: '', firedWeight: '', soakedWeight: '', suspendedWeight: '' };

/** A new firing of a recipe revision, fired today. */
export function newFiring(recipe: { recordId: string; number: number; name: string } | null, today: Date): FiringContent {
  return {
    recipe: recipe?.recordId ?? null,
    recipeNumber: recipe?.number ?? null,
    recipeName: recipe?.name ?? '',
    firedOn: isoDate(today),
    notes: '',
    photos: []
  };
}

export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** What a fired bar's readings show, each only when what it needs was measured. */
export interface BarResults {
  /** From the marks to dry, % of the marks. */
  dryingShrinkage?: number;
  /** From dry to fired, % of dry. */
  firingShrinkage?: number;
  /** From the marks to fired, % of the marks. */
  totalShrinkage?: number;
  /** Water taken up by the fired bar, % of its fired weight. */
  absorption?: number;
  /** Open pores, % of the bar's volume; needs the suspended weight. */
  porosity?: number;
  /** Bulk density, g/cm³; needs the suspended weight. */
  density?: number;
  /** Dry bow plus fired sag, mm; needs the sag. */
  deformation?: number;
}

export function barResults(bar: BarReadings | undefined): BarResults {
  if (!bar) return {};
  const value = (text: string) => {
    const n = amountOf(text);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const [mark, dry, fired] = [value(bar.mark), value(bar.dry), value(bar.fired)];
  const [weight, soaked, suspended] = [value(bar.firedWeight), value(bar.soakedWeight), value(bar.suspendedWeight)];
  const results: BarResults = {};
  if (mark && dry) results.dryingShrinkage = ((mark - dry) / mark) * 100;
  if (dry && fired) results.firingShrinkage = ((dry - fired) / dry) * 100;
  if (mark && fired) results.totalShrinkage = ((mark - fired) / mark) * 100;
  if (weight && soaked && soaked >= weight) results.absorption = ((soaked - weight) / weight) * 100;
  if (weight && soaked && suspended && soaked > suspended && soaked >= weight) {
    results.porosity = ((soaked - weight) / (soaked - suspended)) * 100;
    results.density = weight / (soaked - suspended);
  }
  const [bow, sag] = [numberOf(bar.bow ?? ''), numberOf(bar.sag ?? '')];
  if (sag !== null && sag >= 0) results.deformation = sag + (bow !== null && bow >= 0 ? bow : 0);
  return results;
}

/** Whether a firing has any bar readings beyond the default mark length. */
export function hasReadings(bar: BarReadings | undefined): boolean {
  return (
    !!bar && Object.entries(bar).some(([key, value]) => value?.trim() && !(key === 'mark' && value.trim() === '100'))
  );
}

/** The materials a firing's lots are for: the fired revision's lines that name one, in order. */
export function lotMaterials(lines: RecipeLine[]): string[] {
  return lines.map((line) => line.material.trim()).filter(Boolean);
}

/** A fit test in a line: "IWCT: crazed, at 325 °F". */
export function fitSummary(fit: FitTest | undefined): string {
  if (!fit) return '';
  const test = FIT_TESTS.find((t) => t.value === fit.test);
  const short = test?.value === 'iwct' ? 'IWCT' : test?.value === 'bwiw' ? 'BWIW' : (test?.label ?? '');
  const result = FIT_RESULTS.find((r) => r.value === fit.result)?.label.toLowerCase();
  return [short, [result, fit.detail?.trim()].filter(Boolean).join(', ')].filter(Boolean).join(': ');
}

/** Whether a firing is of a recipe, or of a glaze fired on it, so a body's firings include its
 * glaze fit tests. */
export function firingOf(content: FiringContent, recipe: string): boolean {
  return content.recipe === recipe || content.body?.recipe === recipe;
}

/** A firing in a line: "Cone 10 · Reduction · 2026-10-16". */
export function firingSummary(content: FiringContent): string {
  return [content.cone && `Cone ${content.cone}`, content.atmosphere && capitalized(content.atmosphere), content.firedOn]
    .filter(Boolean)
    .join(' · ');
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Whether a firing has every word searched for. */
export function firingMatches(content: FiringContent, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [
    content.recipeName,
    firingSummary(content),
    content.kiln,
    content.schedule,
    content.surface,
    content.color,
    ...(content.flaws ?? []),
    content.slip?.gel,
    ...(content.lots ?? []),
    content.body?.name,
    fitSummary(content.fit),
    content.bar?.disk,
    content.notes,
    ...content.photos.map((photo) => photo.caption)
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Compares by value, a missing field being the same as an empty one. */
export function sameFiring(a: FiringContent, b: FiringContent): boolean {
  return JSON.stringify(tidyFiring(a)) === JSON.stringify(tidyFiring(b));
}

/** Leaves out what is empty, in a fixed order, so a firing is saved and compared the same way. */
export function tidyFiring(content: FiringContent): FiringContent {
  const text = (value?: string) => (value?.trim() ? value.trim() : undefined);
  const tidy: FiringContent = {
    recipe: content.recipe,
    recipeNumber: content.recipeNumber,
    recipeName: content.recipeName,
    firedOn: content.firedOn,
    notes: content.notes,
    photos: content.photos
  };
  const optional: Partial<FiringContent> = {
    cone: text(content.cone),
    atmosphere: content.atmosphere,
    kiln: text(content.kiln),
    peak: text(content.peak),
    peakUnit: text(content.peak) ? (content.peakUnit ?? 'C') : undefined,
    schedule: text(content.schedule),
    surface: content.surface,
    transparency: content.transparency,
    color: text(content.color),
    flaws: content.flaws?.length ? FLAWS.map((f) => f.value).filter((f) => content.flaws!.includes(f)) : undefined,
    bar: hasReadings(content.bar) ? tidyBar(content.bar!) : undefined,
    slip: hasSlipReadings(content.slip) ? content.slip : undefined,
    lots: content.lots?.some((lot) => lot.trim()) ? trimEnd(content.lots.map((lot) => lot.trim())) : undefined,
    body: content.body?.name.trim() ? { recipe: content.body.recipe, name: content.body.name.trim() } : undefined,
    // A fit test says something once it is not the one the form starts on, or has a result.
    fit:
      content.fit && (content.fit.test !== 'iwct' || content.fit.result || content.fit.detail?.trim())
        ? tidyFit(content.fit)
        : undefined
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (tidy as unknown as Record<string, unknown>)[key] = value;
  }
  return tidy;
}

/** A bar's readings without the warping and disk ones left empty, which firings from before them
 * do not have. */
function tidyBar(bar: BarReadings): BarReadings {
  const tidy: BarReadings = { ...bar };
  for (const key of ['span', 'bow', 'sag', 'disk'] as const) {
    if (!tidy[key]?.trim()) delete tidy[key];
  }
  return tidy;
}

/** Lots without the empty ones at the end, which belong to no material. */
function trimEnd(lots: string[]): string[] {
  let end = lots.length;
  while (end > 0 && !lots[end - 1]) end -= 1;
  return lots.slice(0, end);
}

function tidyFit(fit: FitTest): FitTest {
  const tidy: FitTest = { test: fit.test };
  if (fit.result) tidy.result = fit.result;
  if (fit.detail?.trim()) tidy.detail = fit.detail.trim();
  return tidy;
}

/** A body's targets, as numbers: absorption and total shrinkage, each with an open end or none. */
export interface Targets {
  absorption?: { min?: number; max?: number };
  shrinkage?: { min?: number; max?: number };
}

/** The targets a recipe's details set, or null when it sets none. */
export function targetsOf(details: RecipeDetails): Targets | null {
  const range = (min?: string, max?: string) => {
    let [low, high] = [numberOf(min ?? ''), numberOf(max ?? '')];
    if (low === null && high === null) return undefined;
    // Typed the wrong way round, it is still a range.
    if (low !== null && high !== null && low > high) [low, high] = [high, low];
    return { ...(low === null ? {} : { min: low }), ...(high === null ? {} : { max: high }) };
  };
  const targets: Targets = {};
  const absorption = range(details.absorptionMin, details.absorptionMax);
  const shrinkage = range(details.shrinkageMin, details.shrinkageMax);
  if (absorption) targets.absorption = absorption;
  if (shrinkage) targets.shrinkage = shrinkage;
  return absorption || shrinkage ? targets : null;
}

const within = (value: number, range: { min?: number; max?: number }) =>
  (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);

/** Whether a cone's averages are inside every target set, or null when one of them was not
 * measured there. */
export function insideTargets(point: VitrificationPoint, targets: Targets): boolean | null {
  let inside = true;
  for (const key of ['absorption', 'shrinkage'] as const) {
    const range = targets[key];
    if (!range) continue;
    const value = point[key];
    if (value === undefined) return null;
    inside &&= within(value, range);
  }
  return inside;
}

/** One cone on a vitrification chart: the average of the firings at that cone that measured each. */
export interface VitrificationPoint {
  cone: string;
  /** How many firings at this cone had either result. */
  firings: number;
  absorption?: number;
  shrinkage?: number;
}

/** Absorption and total shrinkage against cone, across a recipe's firings, lowest cone first.
 * Firings without a cone, or without either result, are left out. */
export function vitrification(firings: Firing[]): VitrificationPoint[] {
  const byCone = new Map<string, { cone: string; absorption: number[]; shrinkage: number[]; firings: number }>();
  for (const firing of firings) {
    const cone = firing.content.cone?.trim();
    const results = barResults(firing.content.bar);
    if (!cone || (results.absorption === undefined && results.totalShrinkage === undefined)) continue;
    const key = cone.toLowerCase().replace(/^\^/, '');
    const point = byCone.get(key) ?? { cone: key, absorption: [], shrinkage: [], firings: 0 };
    point.firings += 1;
    if (results.absorption !== undefined) point.absorption.push(results.absorption);
    if (results.totalShrinkage !== undefined) point.shrinkage.push(results.totalShrinkage);
    byCone.set(key, point);
  }
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);
  return [...byCone.values()]
    .sort((a, b) => coneNumber(a.cone) - coneNumber(b.cone) || a.cone.localeCompare(b.cone))
    .map((p) => ({ cone: p.cone, firings: p.firings, absorption: mean(p.absorption), shrinkage: mean(p.shrinkage) }));
}
