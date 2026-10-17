import { describe, expect, it } from 'vitest';
import { codeProblem, knownCodes, scaleBatch, sheetFrom, usableLines, type BatchSheetContent } from './batch';

const leach = [
  { material: 'Custer Feldspar', amount: '40' },
  { material: 'Silica', amount: '30' },
  { material: 'Whiting', amount: '20' },
  { material: 'EPK Kaolin', amount: '10' }
];

describe('scaleBatch', () => {
  it('scales to the batch size and keeps the proportions', () => {
    const batch = scaleBatch(leach, 5000)!;
    expect(batch.lines.map((l) => l.weight)).toEqual([2000, 1500, 1000, 500]);
    expect(batch.lines.map((l) => l.percent)).toEqual([40, 30, 20, 10]);
    expect(batch.total).toBe(5000);
  });

  it('counts additives as part of the batch', () => {
    const batch = scaleBatch([...leach, { material: 'Red Iron Oxide', amount: '10' }], 1100)!;
    expect(batch.lines.reduce((sum, l) => sum + l.weight, 0)).toBeCloseTo(1100, 9);
    expect(batch.lines[4].weight).toBeCloseTo(100, 9);
  });

  it('skips empty and unusable lines, and reads decimal commas', () => {
    const lines = [
      { material: 'Silica', amount: '12,5' },
      { material: '', amount: '10' },
      { material: 'Whiting', amount: '' },
      { material: 'Talc', amount: 'lots' },
      { material: 'Zinc Oxide', amount: '-2' }
    ];
    expect(usableLines(lines)).toEqual([{ material: 'Silica', amount: 12.5 }]);
  });

  it('has nothing to scale without amounts or a size', () => {
    expect(scaleBatch([], 100)).toBeNull();
    expect(scaleBatch(leach, 0)).toBeNull();
    expect(scaleBatch(leach, NaN)).toBeNull();
  });
});

describe('batch sheets', () => {
  const recipe = {
    recordId: 'leach',
    revisionId: 'r2',
    number: 2,
    savedAt: 0,
    content: { name: 'Leach 4321', lines: [...leach, { material: '', amount: '' }], notes: 'Secret' }
  };
  const codes = ['M-104', 'M-200', 'M-310', 'M-401'];

  it('names the materials by their codes, and keeps out the notes', () => {
    const sheet = sheetFrom(recipe, [...codes.slice(0, 3), ' M-401 '], 'Leach', 'Sieve 80 mesh');
    expect(sheet).toEqual({
      name: 'Leach',
      notes: 'Sieve 80 mesh',
      lines: codes.map((code, i) => ({ material: code, amount: leach[i].amount })),
      recipe: 'leach',
      recipeNumber: 2
    });
  });

  it('finds the codes already given, from sheets and the recipes they were made from', () => {
    const sheet: BatchSheetContent = sheetFrom(recipe, codes, 'Leach', '');
    const known = knownCodes([{ recipe: recipe.content, sheet }]);
    expect(known).toContainEqual({ material: 'Silica', code: 'M-200' });
    // A sheet that no longer lines up with its recipe tells nothing.
    expect(knownCodes([{ recipe: { ...recipe.content, lines: leach.slice(1) }, sheet }])).toEqual([]);
  });

  it('wants a code for every material, and each code for one material only', () => {
    const materials = leach.map((l) => l.material);
    expect(codeProblem(materials, codes, [])).toBeNull();
    expect(codeProblem(materials, ['M-104', '', 'M-310', 'M-401'], [])).toBe('Give each material a code.');
    expect(codeProblem(materials, ['M-104', 'm-104', 'M-310', 'M-401'], [])).toBe(
      'M-104 is the code for Silica too. Give each material its own.'
    );
    expect(codeProblem(materials, codes, [{ material: 'Talc', code: 'M-401' }])).toBe(
      'M-401 is the code for Talc too. Give each material its own.'
    );
    // The same material twice in a recipe has one code.
    expect(codeProblem(['Silica', 'silica'], ['M-200', 'M-200'], [])).toBeNull();
  });
});
