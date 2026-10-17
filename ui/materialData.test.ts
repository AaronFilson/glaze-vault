import { describe, expect, it } from 'vitest';
import type { MaterialContent } from './chemistry';
import { densityOf, recipeDensity, tidySheet } from './materialData';
import { waterPer100 } from './slip';

const own = (name: string, extra: Partial<MaterialContent>): MaterialContent => ({
  name,
  category: 'material',
  oxides: [],
  loi: '',
  notes: '',
  ...extra
});

describe('material data', () => {
  it('keeps only the values typed', () => {
    expect(tidySheet({ cone: ' ', absorption: '0.5' })).toEqual({ absorption: '0.5' });
    expect(tidySheet({ cone: '' })).toBeUndefined();
  });

  it('finds a density from the data sheet, then the class, then a standard material', () => {
    const mine = [
      own('Grolleg', { class: 'kaolin', sheet: { density: '2,58' } }),
      own('Wollastonite NYAD', { class: 'wollastonite' })
    ];
    expect(densityOf('grolleg', mine)).toBe(2.58);
    expect(densityOf('Wollastonite NYAD', mine)).toBe(2.9);
    expect(densityOf('Flint', mine)).toBe(2.65);
    expect(densityOf('Zircon', mine)).toBe(4.6);
    expect(densityOf('Zirconium oxide', mine)).toBe(5.7);
    expect(densityOf('Wollastonite (NYAD 400)', [])).toBe(2.9);
    expect(densityOf('EPK', mine)).toBe(2.6);
  });

  it('works out a recipe’s solids by volume, and the water a gravity takes with them', () => {
    const lines = [
      { material: 'EPK', amount: '50' },
      { material: 'Zircon', amount: '50' }
    ];
    const { density, worked } = recipeDensity(lines, []);
    expect(worked).toBe(true);
    expect(density).toBeCloseTo(100 / (50 / 2.6 + 50 / 4.6), 9);
    // Heavier solids take more water at the same gravity.
    expect(waterPer100('1.8', density)!).toBeGreaterThan(waterPer100('1.8')!);
    expect(recipeDensity([{ material: 'EPK', amount: '' }], [])).toEqual({ density: 2.6, worked: false });
  });
});
