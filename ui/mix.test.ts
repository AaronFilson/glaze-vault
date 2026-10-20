import { describe, expect, it } from 'vitest';
import type { BatchSheet } from './batch';
import { daysAged, emptyStep, lotsForFiring, mixMatches, mixName, mixTotals, newMix, sameMix, tidyMix, type MixContent } from './mix';

const today = new Date(2026, 9, 19);

const sheet = {
  recordId: 'sheet-1',
  revisionId: 'sheet-1-r2',
  number: 2,
  collectionId: 'shared',
  savedAt: 0,
  content: { name: 'Porcelain slip', notes: '', lines: [], recipe: 'recipe-1', recipeNumber: 4 }
} as unknown as BatchSheet;

describe('a mix', () => {
  it('starts from a batch sheet, keeping its name and the recipe revision it was made from', () => {
    expect(newMix({ sheet }, today)).toEqual({
      sheet: 'sheet-1',
      sheetNumber: 2,
      recipe: 'recipe-1',
      recipeNumber: 4,
      name: 'Porcelain slip',
      mixedOn: '2026-10-19',
      unit: 'g',
      notes: ''
    });
  });

  it('starts from a recipe without its name, which a batch operator may not read', () => {
    const mix = newMix({ recipe: { recordId: 'recipe-1', number: 4 } }, today);
    expect(mix).toMatchObject({ sheet: null, recipe: 'recipe-1', recipeNumber: 4, name: '' });
    const recipes = [{ recordId: 'recipe-1', content: { name: 'Grolleg body', lines: [], notes: '' } }];
    expect(mixName(mix, recipes)).toBe('Grolleg body');
    expect(mixName(mix, [])).toBe('A recipe');
    expect(mixName(newMix({ sheet }, today), [])).toBe('Porcelain slip');
  });

  it('is saved without what is empty, and compared the same way', () => {
    const mix: MixContent = {
      ...newMix({ sheet }, today),
      size: ' 5 ',
      unit: 'kg',
      lots: ['L-1', ' ', ''],
      water: '',
      steps: [{ ...emptyStep(today), gravity: ' 1.78 ' }, emptyStep(today)]
    };
    expect(tidyMix(mix)).toEqual({
      sheet: 'sheet-1',
      sheetNumber: 2,
      recipe: 'recipe-1',
      recipeNumber: 4,
      name: 'Porcelain slip',
      mixedOn: '2026-10-19',
      notes: '',
      size: '5',
      unit: 'kg',
      lots: ['L-1'],
      steps: [{ on: '2026-10-19', deflocculant: '', water: '', gravity: '1.78', viscosity: '', gel: '' }]
    });
    expect(sameMix(mix, tidyMix(mix))).toBe(true);
    expect(sameMix(mix, { ...mix, notes: 'Mixed overnight' })).toBe(false);
  });

  it('adds up the deflocculant and water put in, as a share of the dry base', () => {
    const mix: MixContent = {
      ...newMix({ sheet }, today),
      size: '5000',
      water: '1900',
      steps: [
        { ...emptyStep(today), deflocculant: '25', water: '' },
        { ...emptyStep(today), deflocculant: '12,5', water: '100' },
        { ...emptyStep(today), deflocculant: 'a little', gravity: '1.76' }
      ]
    };
    const totals = mixTotals(mix);
    expect(totals.deflocculant?.amount).toBeCloseTo(37.5, 9);
    expect(totals.deflocculant?.percent).toBeCloseTo(0.75, 9);
    expect(totals.water).toEqual({ amount: 2000, percent: 40 });
    expect(mixTotals({ ...mix, size: '' }).water).toEqual({ amount: 2000, percent: null });
    expect(mixTotals(newMix({ sheet }, today))).toEqual({ deflocculant: null, water: null });
  });

  it('counts the days a slip has aged', () => {
    expect(daysAged('2026-10-19', '2026-10-22')).toBe(3);
    expect(daysAged('2026-10-19', '2026-10-19')).toBe(0);
    expect(daysAged('2026-10-19', '')).toBeNull();
  });

  it('gives its lots in the order a firing keeps them', () => {
    const lines = [
      { material: 'Grolleg', amount: '50' },
      { material: 'Custer Feldspar', amount: '' },
      { material: '', amount: '5' },
      { material: 'Silica', amount: '25' }
    ];
    // Weighed: Grolleg and Silica. A firing's lots: Grolleg, Custer Feldspar and Silica.
    expect(lotsForFiring(lines, ['G-12', 'S-3'])).toEqual(['G-12', '', 'S-3']);
    expect(lotsForFiring(lines, [])).toEqual(['', '', '']);
  });

  it('is found by its name, day, lots and notes', () => {
    const mix: MixContent = { ...newMix({ sheet }, today), lots: ['G-12'], notes: 'Mixed overnight' };
    expect(mixMatches(mix, 'Porcelain slip', 'porcelain g-12')).toBe(true);
    expect(mixMatches(mix, 'Porcelain slip', '2026-10 overnight')).toBe(true);
    expect(mixMatches(mix, 'Porcelain slip', 'stoneware')).toBe(false);
  });
});
