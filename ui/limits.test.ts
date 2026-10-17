import { describe, expect, it } from 'vitest';
import { BUILT_IN_LIMITS, checkLimits, molesOf, rangeText } from './limits';

describe('limit formulas', () => {
  const umf = { K2O: 0.2, Na2O: 0.1, CaO: 0.7, Al2O3: 0.2849, SiO2: 3, B2O3: 0.1 };

  it('counts K2O and Na2O together as KNaO', () => {
    expect(molesOf(umf, 'KNaO')).toBeCloseTo(0.3, 9);
    expect(molesOf(umf, 'ZnO')).toBe(0);
  });

  it('says which oxides are outside, as shown to three places', () => {
    const [cone6] = BUILT_IN_LIMITS;
    const outside = checkLimits(umf, cone6).filter((c) => c.outside);
    expect(outside.map((c) => [c.oxide, c.outside])).toEqual([['CaO', 'above']]);
    expect(checkLimits({ ...umf, Al2O3: 0.2 }, cone6).find((c) => c.oxide === 'Al2O3')?.outside).toBe('below');
  });

  it('skips ranges with no numbers, and reads decimal commas', () => {
    const checks = checkLimits(umf, {
      name: 'Mine',
      source: '',
      ranges: [
        { oxide: 'SiO2', min: '3,5', max: '' },
        { oxide: 'MgO', min: '', max: '' }
      ]
    });
    expect(checks).toEqual([{ oxide: 'SiO2', value: 3, min: 3.5, max: null, outside: 'below' }]);
  });

  it('writes a range as people read it', () => {
    expect(rangeText({ min: 0.285, max: 0.64 })).toBe('0.285–0.64');
    expect(rangeText({ min: 0, max: 0.35 })).toBe('≤ 0.35');
    expect(rangeText({ min: 2.4, max: null })).toBe('≥ 2.4');
  });
});
