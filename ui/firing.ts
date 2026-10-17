// The firing log (docs/adr/0014-firing-log-and-photos.md): each firing of a recipe, how it was
// fired, what came out, a fired bar's measurements and photos. What a firing shows is worked out
// here from what was measured; only the measurements are kept.
import type { Revision } from './api';
import { amountOf } from './chemistry';
import type { Atmosphere, Surface, Transparency } from './recipeFields';

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
 * suspended weight is optional, for porosity and density. */
export interface BarReadings {
  mark: string;
  dry: string;
  fired: string;
  firedWeight: string;
  soakedWeight: string;
  suspendedWeight: string;
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
  return results;
}

/** Whether a firing has any bar readings beyond the default mark length. */
export function hasReadings(bar: BarReadings | undefined): boolean {
  return !!bar && Object.entries(bar).some(([key, value]) => value.trim() && !(key === 'mark' && value.trim() === '100'));
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
    bar: hasReadings(content.bar) ? content.bar : undefined
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (tidy as unknown as Record<string, unknown>)[key] = value;
  }
  return tidy;
}
