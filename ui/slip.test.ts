import { describe, expect, it } from 'vitest';
import { hasSlipReadings, isSlip, waterPer100 } from './slip';

describe('slips', () => {
  it('works out the water a specific gravity takes, per 100 g dry', () => {
    // A casting slip at 1.78: about 40 g of water to 100 g of clay.
    expect(waterPer100('1.78')).toBeCloseTo(40.43, 2);
    expect(waterPer100('1,45', 2.5)).toBeCloseTo(93.33, 2);
  });

  it('gives nothing for a gravity no slip has', () => {
    expect(waterPer100('')).toBeNull();
    expect(waterPer100('1')).toBeNull();
    expect(waterPer100('2.6')).toBeNull();
    expect(waterPer100('thick')).toBeNull();
  });

  it('knows which types are slips, and when a firing has readings', () => {
    expect(isSlip('engobe')).toBe(true);
    expect(isSlip('glaze')).toBe(false);
    expect(isSlip(undefined)).toBe(false);
    expect(hasSlipReadings({ gravity: ' ', viscosity: '', gel: '' })).toBe(false);
    expect(hasSlipReadings({ gravity: '1.5', viscosity: '', gel: '' })).toBe(true);
  });
});
