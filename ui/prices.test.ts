import { describe, expect, it } from 'vitest';
import { batchCosts, money, priceListFor, recipeCost, type PricesContent } from './prices';

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

  it('prices each weighed line, converting the batch unit to the list unit', () => {
    const lines = [
      { material: 'Custer Feldspar', weight: 500 },
      { material: 'Whiting', weight: 200 },
      { material: 'Silica', weight: 300 }
    ];
    const costs = batchCosts(lines, 'g', list)!;
    expect(costs.lines[0]).toBeCloseTo(0.6, 9);
    expect(costs.lines[1]).toBeNull();
    expect(costs.lines[2]).toBeCloseTo(0.12, 9);
    expect(costs.total).toBeCloseTo(0.72, 9);
    expect(costs.missing).toEqual(['Whiting']);
    // A pound of feldspar at $1.20 a kilogram.
    expect(batchCosts([{ material: 'Custer Feldspar', weight: 1 }], 'lb', list)!.total).toBeCloseTo(0.5443, 4);
    expect(batchCosts([{ material: 'Talc', weight: 1 }], 'kg', list)).toBeNull();
  });

  it('costs a recipe by its collection’s list, or else the newest', () => {
    const lists = [{ collectionId: 'b' }, { collectionId: 'a' }];
    expect(priceListFor(lists, 'a')).toBe(lists[1]);
    expect(priceListFor(lists, 'c')).toBe(lists[0]);
    expect(priceListFor(lists, null)).toBe(lists[0]);
    expect(priceListFor([], 'a')).toBeNull();
  });

  it('writes money with its currency', () => {
    expect(money(2.314, list)).toBe('$2.31');
    expect(money(0.4567, list)).toBe('$0.457');
    expect(money(12, { ...list, currency: 'SEK' })).toBe('12.00 SEK');
  });
});
