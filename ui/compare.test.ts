import { describe, expect, it } from 'vitest';
import { analyse } from './chemistry';
import { change, compareLines, compareUmf } from './compare';

describe('compareLines', () => {
  it('compares each material as a percent of its batch, matching names as the library does', () => {
    const a = [
      { material: 'Custer Spar', amount: '40' },
      { material: 'Silica', amount: '30' },
      { material: 'Whiting', amount: '30' }
    ];
    const b = [
      { material: 'custer spar', amount: '20' },
      { material: 'Silica', amount: '10' },
      { material: 'Silica', amount: '10' },
      { material: 'Kaolin', amount: '10' },
      { material: '', amount: '5' },
      { material: 'Rutile', amount: 'some' }
    ];
    expect(compareLines(a, b)).toEqual([
      { material: 'Custer Spar', a: 40, b: 40 },
      { material: 'Silica', a: 30, b: 40 },
      { material: 'Whiting', a: 30, b: null },
      { material: 'Kaolin', a: null, b: 20 }
    ]);
  });
});

describe('change', () => {
  it('signs a difference, and names a material added or removed', () => {
    expect(change(30, 40, 1)).toBe('+10.0');
    expect(change(0.25, 0.2, 3)).toBe('−0.050');
    expect(change(1, 1.00001, 3)).toBe('');
    expect(change(null, 5, 1)).toBe('added');
    expect(change(5, null, 1)).toBe('removed');
  });
});

describe('compareUmf', () => {
  it('lists the oxides of either unity formula in the usual order', () => {
    const a = analyse([{ material: 'Whiting', amount: '20' }, { material: 'Silica', amount: '80' }])!.result;
    const b = analyse([{ material: 'Wollastonite', amount: '100' }])!.result;
    const oxides = compareUmf(a, b).map((change) => change.oxide);
    expect(oxides).toContain('CaO');
    expect(oxides).toContain('SiO2');
    expect(oxides.indexOf('CaO')).toBeLessThan(oxides.indexOf('SiO2'));
    expect(compareUmf(a, b).find((c) => c.oxide === 'CaO')).toEqual({ oxide: 'CaO', a: 1, b: 1 });
  });
});
