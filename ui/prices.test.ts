import { describe, expect, it } from 'vitest';
import { money, recipeCost, type PricesContent } from './prices';

const list: PricesContent = {
  currency: '$',
  unit: 'kg',
  prices: [
    { material: 'Custer Feldspar', price: '1.20' },
    { material: 'silica', price: '0,40' },
    { material: 'Whiting', price: '' }
  ]
};

describe('costs', () => {
  it('weights each material by its share of the batch, and says which have no price', () => {
    const cost = recipeCost(
      [
        { material: 'Custer Feldspar', amount: '50' },
        { material: 'Silica', amount: '30' },
        { material: 'Whiting', amount: '20' }
      ],
      list
    )!;
    expect(cost.perUnit).toBeCloseTo(0.6 + 0.12, 9);
    expect(cost.missing).toEqual(['Whiting']);
  });

  it('has nothing to say without prices for any of it', () => {
    expect(recipeCost([{ material: 'Talc', amount: '10' }], list)).toBeNull();
    expect(recipeCost([{ material: 'Silica', amount: '10' }], null)).toBeNull();
  });

  it('writes money with its currency', () => {
    expect(money(2.314, list)).toBe('$2.31');
    expect(money(0.4567, list)).toBe('$0.457');
    expect(money(12, { ...list, currency: 'SEK' })).toBe('12.00 SEK');
  });
});
