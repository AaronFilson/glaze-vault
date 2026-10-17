import { describe, expect, it } from 'vitest';
import { blendLines, blendName, blendShares, blendSteps } from './blend';

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

  it('mixes the recipes as 100 parts each, one line per material', () => {
    expect(blendLines(clear, iron, 50)).toEqual([
      { material: 'Custer Feldspar', amount: '40' },
      { material: 'Silica', amount: '35' },
      { material: 'Whiting', amount: '15' },
      { material: 'Red Iron Oxide', amount: '10', addition: true }
    ]);
  });

  it('keeps every material at every step, so the steps line up', () => {
    const steps = blendSteps(clear, iron, 3);
    expect(steps.map((s) => s.lines.map((l) => l.material))).toEqual(
      Array(3).fill(['Custer Feldspar', 'Silica', 'Whiting', 'Red Iron Oxide'])
    );
    expect(steps[0].lines.map((l) => l.amount)).toEqual(['40', '30', '30', '0']);
    expect(steps[2].lines.map((l) => l.amount)).toEqual(['40', '40', '0', '20']);
  });

  it('names a step by its shares', () => {
    expect(blendName('Clear', 'Iron', 62.5)).toBe('Clear 62.5 · Iron 37.5');
  });
});
