import { describe, expect, it } from 'vitest';
import { scaleBatch, usableLines } from './batch';

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
