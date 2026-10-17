import { describe, expect, it } from 'vitest';
import type { RecipeHead } from './api';
import type { RecipeContent } from './chemistry';
import {
  ATMOSPHERES,
  coneNumber,
  describeDetails,
  details,
  matchesSearch,
  optionNamed,
  parseTags,
  sameDetails,
  sortRecipes
} from './recipeFields';

const content = (name: string, more: Partial<RecipeContent> = {}): RecipeContent => ({
  name,
  lines: [{ material: 'Custer Feldspar', amount: '40' }],
  notes: '',
  ...more
});

const head = (name: string, savedAt: number, more: Partial<RecipeContent> = {}): RecipeHead => ({
  recordId: name,
  revisionId: name,
  number: 1,
  savedAt,
  content: content(name, more)
});

describe('recipe details', () => {
  it('reads tags as typed, each once', () => {
    expect(parseTags(' blue,  celadon ; Blue,,test tile ')).toEqual(['blue', 'celadon', 'test tile']);
  });

  it('keeps only what is filled in, so an old recipe is the same without them', () => {
    expect(details({ cone: ' ', color: '', tags: [] })).toEqual({});
    expect(sameDetails({}, { cone: '', tags: [] })).toBe(true);
    expect(sameDetails({ cone: '6' }, { cone: '6 ' })).toBe(true);
    expect(sameDetails({ tags: ['a'] }, {})).toBe(false);
  });

  it('knows the names other programs give', () => {
    expect(optionNamed(ATMOSPHERES, 'Salt & Soda')).toBe('salt or soda');
    expect(optionNamed(ATMOSPHERES, ' Reduction ')).toBe('reduction');
    expect(optionNamed(ATMOSPHERES, 'pit fired')).toBeUndefined();
  });

  it('describes them in a line', () => {
    expect(
      describeDetails({ type: 'glaze', cone: '6', atmosphere: 'oxidation', surface: 'satin', transparency: 'opaque', color: 'Blue' })
    ).toBe('Glaze · Cone 6 · Oxidation · Satin, opaque · Blue');
    expect(describeDetails({})).toBe('');
  });
});

describe('finding recipes', () => {
  const celadon = content('Celadon', { cone: '10', atmosphere: 'reduction', tags: ['green', 'production'], notes: 'Thick' });

  it('matches every word, in any field', () => {
    expect(matchesSearch(celadon, '')).toBe(true);
    expect(matchesSearch(celadon, 'celadon reduction')).toBe(true);
    expect(matchesSearch(celadon, 'PRODUCTION custer thick')).toBe(true);
    expect(matchesSearch(celadon, 'cone10')).toBe(true);
    expect(matchesSearch(celadon, '^10')).toBe(true);
    expect(matchesSearch(celadon, 'celadon oxidation')).toBe(false);
  });

  it('orders cones as kilns do, with 04 below 1', () => {
    expect(['6', '04', '10', '022', '1', '9-10', ''].map(coneNumber)).toEqual([6, -4, 10, -22, 1, 9, Infinity]);
  });

  it('sorts by last change, name or cone, recipes without a cone last', () => {
    const recipes = [head('b', 2, { cone: '6' }), head('A', 1), head('c', 3, { cone: '04' })];
    const names = (order: 'changed' | 'name' | 'cone') => sortRecipes(recipes, order).map((r) => r.content.name);
    expect(names('changed')).toEqual(['c', 'b', 'A']);
    expect(names('name')).toEqual(['A', 'b', 'c']);
    expect(names('cone')).toEqual(['c', 'b', 'A']);
  });
});
