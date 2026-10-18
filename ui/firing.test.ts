import { describe, expect, it } from 'vitest';
import {
  barResults,
  EMPTY_BAR,
  firingMatches,
  firingOf,
  fitSummary,
  insideTargets,
  lotMaterials,
  newFiring,
  sameFiring,
  targetsOf,
  tidyFiring,
  vitrification,
  type Firing
} from './firing';
import { imageType } from './photos';

describe('a test bar', () => {
  it('gives shrinkage, absorption, porosity and density from what was measured', () => {
    const results = barResults({
      mark: '100',
      dry: '94',
      fired: '88,5',
      firedWeight: '50',
      soakedWeight: '51',
      suspendedWeight: '30'
    });
    expect(results.dryingShrinkage).toBeCloseTo(6, 9);
    expect(results.firingShrinkage).toBeCloseTo((5.5 / 94) * 100, 9);
    expect(results.totalShrinkage).toBeCloseTo(11.5, 9);
    expect(results.absorption).toBeCloseTo(2, 9);
    expect(results.porosity).toBeCloseTo((1 / 21) * 100, 9);
    expect(results.density).toBeCloseTo(50 / 21, 9);
  });

  it('leaves out what it cannot work out', () => {
    expect(barResults(undefined)).toEqual({});
    expect(barResults({ ...EMPTY_BAR, dry: '95' })).toEqual({ dryingShrinkage: 5 });
    // Soaked lighter than fired is a mistake in the readings, not negative absorption.
    expect(barResults({ ...EMPTY_BAR, firedWeight: '50', soakedWeight: '49' })).toEqual({});
  });
});

describe('a firing', () => {
  const fired = newFiring({ recordId: 'r1', number: 2, name: 'Leach 4321' }, new Date(2026, 9, 16));

  it('starts today, from the recipe revision', () => {
    expect(fired).toEqual({
      recipe: 'r1',
      recipeNumber: 2,
      recipeName: 'Leach 4321',
      firedOn: '2026-10-16',
      notes: '',
      photos: []
    });
  });

  it('keeps only what was filled in, the same way each time', () => {
    const edited = { ...fired, cone: ' 10 ', kiln: '', flaws: [], bar: { ...EMPTY_BAR }, peak: '1285' };
    expect(tidyFiring(edited)).toEqual({ ...fired, cone: '10', peak: '1285', peakUnit: 'C' });
    expect(sameFiring(fired, { ...fired, kiln: ' ', flaws: [] })).toBe(true);
    expect(sameFiring(fired, { ...fired, flaws: ['crazed'] })).toBe(false);
  });

  it('is found by its recipe, firing, flaws and notes', () => {
    const content = { ...fired, cone: '10', atmosphere: 'reduction' as const, flaws: ['crazed' as const], notes: 'Thick' };
    expect(firingMatches(content, 'leach reduction crazed thick')).toBe(true);
    expect(firingMatches(content, 'oxidation')).toBe(false);
  });
});

describe('photos', () => {
  it('knows images by how they start', () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    const text = (value: string) => new Uint8Array([...value].map((c) => c.charCodeAt(0)));
    expect(imageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(imageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe('image/png');
    expect(imageType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageType(text('\0\0\0\x18ftypheic'))).toBe('image/heic');
    expect(imageType(text('<svg xmlns='))).toBeNull();
  });
});

describe('vitrification', () => {
  const fired = (cone: string | undefined, fired: string, soaked: string, savedAt = 1): Firing => ({
    recordId: `f-${cone}-${fired}`,
    revisionId: 'v',
    number: 1,
    savedAt,
    content: {
      ...newFiring({ recordId: 'r', number: 1, name: 'Body' }, new Date(2026, 9, 16)),
      cone,
      bar: { mark: '100', dry: '95', fired, firedWeight: '50', soakedWeight: soaked, suspendedWeight: '' }
    }
  });

  it('averages each cone, lowest cone first, cone 04 below cone 1', () => {
    const points = vitrification([
      fired('6', '89', '51'),
      fired('04', '94', '56'),
      fired('6', '87', '50.5'),
      fired('^10', '86', '50')
    ]);
    expect(points.map((p) => p.cone)).toEqual(['04', '6', '10']);
    expect(points[1]).toEqual({ cone: '6', firings: 2, absorption: 1.5, shrinkage: 12 });
    expect(points[2].absorption).toBe(0);
  });

  it('leaves out firings without a cone or results', () => {
    const none = fired('6', '', '');
    expect(vitrification([fired(undefined, '90', '52'), none])).toEqual([]);
  });
});

describe('a body’s tests', () => {
  const fired = newFiring({ recordId: 'glaze', number: 3, name: 'Clear' }, new Date(2026, 9, 18));

  it('add the dry bow to the fired sag, and need the sag', () => {
    expect(barResults({ ...EMPTY_BAR, span: '100', bow: '0.5', sag: '3' }).deformation).toBeCloseTo(3.5, 9);
    expect(barResults({ ...EMPTY_BAR, sag: '2' }).deformation).toBe(2);
    expect(barResults({ ...EMPTY_BAR, bow: '1' }).deformation).toBeUndefined();
  });

  it('keep lots by the order of the fired revision’s materials, without empty ones at the end', () => {
    expect(lotMaterials([{ material: ' Redart ', amount: '50' }, { material: '', amount: '' }, { material: 'Grog', amount: '10' }])).toEqual([
      'Redart',
      'Grog'
    ]);
    expect(tidyFiring({ ...fired, lots: [' bag 3 ', '', ''] }).lots).toEqual(['bag 3']);
    expect(tidyFiring({ ...fired, lots: ['', ' '] }).lots).toBeUndefined();
  });

  it('keep a glaze’s body and fit test, and a fit test only once it says something', () => {
    const tidy = tidyFiring({
      ...fired,
      body: { recipe: 'porcelain', name: ' Cone 6 porcelain ' },
      fit: { test: 'iwct', result: 'crazed', detail: ' at 325 °F ' }
    });
    expect(tidy.body).toEqual({ recipe: 'porcelain', name: 'Cone 6 porcelain' });
    expect(tidy.fit).toEqual({ test: 'iwct', result: 'crazed', detail: 'at 325 °F' });
    expect(tidyFiring({ ...fired, fit: { test: 'bwiw' } }).fit).toBeUndefined();
    expect(tidyFiring({ ...fired, body: { recipe: null, name: '  ' } }).body).toBeUndefined();
    expect(fitSummary(tidy.fit)).toBe('IWCT: crazed, at 325 °F');
    expect(fitSummary({ test: 'pressure', result: 'passed' })).toBe('Pressure cooker or autoclave: passed');
  });

  it('are found from the glaze and from the body', () => {
    const content = { ...fired, body: { recipe: 'porcelain', name: 'Cone 6 porcelain' }, fit: { test: 'iwct' as const, result: 'crazed' as const }, lots: ['lot 7731'] };
    expect(firingOf(content, 'glaze')).toBe(true);
    expect(firingOf(content, 'porcelain')).toBe(true);
    expect(firingOf(content, 'other')).toBe(false);
    expect(firingMatches(content, 'porcelain iwct crazed 7731')).toBe(true);
  });
});

describe('a body’s targets', () => {
  it('are read from its details, either end open', () => {
    expect(targetsOf({})).toBeNull();
    expect(targetsOf({ absorptionMax: '2', shrinkageMin: '11', shrinkageMax: '13' })).toEqual({
      absorption: { max: 2 },
      shrinkage: { min: 11, max: 13 }
    });
    expect(targetsOf({ absorptionMin: 'lots' })).toBeNull();
  });

  it('say whether a cone is inside them all, or that it was not measured', () => {
    const targets = targetsOf({ absorptionMax: '2', shrinkageMin: '11', shrinkageMax: '13' })!;
    expect(insideTargets({ cone: '6', firings: 1, absorption: 1.5, shrinkage: 12 }, targets)).toBe(true);
    expect(insideTargets({ cone: '5', firings: 1, absorption: 3, shrinkage: 12 }, targets)).toBe(false);
    expect(insideTargets({ cone: '7', firings: 1, absorption: 0.5, shrinkage: 13.5 }, targets)).toBe(false);
    expect(insideTargets({ cone: '4', firings: 1, absorption: 1 }, targets)).toBeNull();
    expect(insideTargets({ cone: '4', firings: 1, absorption: 1 }, { absorption: { max: 2 } })).toBe(true);
  });
});
