import { describe, expect, it } from 'vitest';
import { blendLines, blendName, blendShares, blendSteps, mixLines, triaxialShares, triaxialSteps } from './blend';

const clear = [
  { material: 'Custer Feldspar', amount: '40' },
  { material: 'Silica', amount: '30' },
  { material: 'Whiting', amount: '30' }
];
const iron = [
  { material: 'Custer Feldspar', amount: '20' },
  { material: 'silica', amount: '20' },
  { material: 'Red Iron Oxide', amount: '10', addition: true }
];

describe('line blends', () => {
  it('steps from all of the first to all of the second', () => {
    expect(blendShares(5)).toEqual([100, 75, 50, 25, 0]);
    expect(blendShares(1)).toEqual([100, 0]);
  });

  it('mixes the recipes as 100 parts of base each, one line per material', () => {
    expect(blendLines(clear, iron, 50)).toEqual([
      { material: 'Custer Feldspar', amount: '45' },
      { material: 'Silica', amount: '40' },
      { material: 'Whiting', amount: '15' },
      { material: 'Red Iron Oxide', amount: '12.5', addition: true }
    ]);
  });

  it('keeps additions on top of the base, as a batch does', () => {
    // All of the iron recipe is that recipe, its 40 parts of base made 100.
    expect(blendLines(clear, iron, 0).map((l) => l.amount)).toEqual(['50', '50', '0', '25']);
  });

  it('keeps every material at every step, so the steps line up', () => {
    const steps = blendSteps(clear, iron, 3);
    expect(steps.map((s) => s.lines.map((l) => l.material))).toEqual(
      Array(3).fill(['Custer Feldspar', 'Silica', 'Whiting', 'Red Iron Oxide'])
    );
    expect(steps[0].lines.map((l) => l.amount)).toEqual(['40', '30', '30', '0']);
    expect(steps[2].lines.map((l) => l.amount)).toEqual(['50', '50', '0', '25']);
  });

  it('names a step by its shares', () => {
    expect(blendName(['Clear', 'Iron'], [62.5, 37.5])).toBe('Clear 62.5 · Iron 37.5');
    expect(blendName(['Clear', 'Iron'], [100, 0])).toBe('Clear 100 · Iron 0');
    // A triaxial's name leaves out the recipes not in it.
    expect(blendName(['Clear', 'Iron', 'Rutile'], [50, 0, 50])).toBe('Clear 50 · Rutile 50');
  });
});

describe('triaxial blends', () => {
  const rutile = [{ material: 'Rutile', amount: '100' }];

  it('covers the triangle row by row, every point adding up to 100', () => {
    const points = triaxialShares(2);
    expect(points).toEqual([
      [100, 0, 0],
      [50, 50, 0],
      [50, 0, 50],
      [0, 100, 0],
      [0, 50, 50],
      [0, 0, 100]
    ]);
    expect(triaxialShares(4)).toHaveLength(15);
    expect(triaxialShares(5).every((p) => Math.abs(p[0] + p[1] + p[2] - 100) < 1e-9)).toBe(true);
  });

  it('mixes three recipes as a line blend mixes two', () => {
    expect(mixLines([clear, iron], [50, 50])).toEqual(blendLines(clear, iron, 50));
    const steps = triaxialSteps(clear, iron, rutile, 2);
    expect(steps[4].shares).toEqual([0, 50, 50]);
    expect(steps[4].lines.map((l) => [l.material, l.amount])).toEqual([
      ['Custer Feldspar', '25'],
      ['Silica', '25'],
      ['Whiting', '0'],
      ['Red Iron Oxide', '12.5'],
      ['Rutile', '50']
    ]);
  });
});
