import { describe, expect, it } from 'vitest';
import type { RecipeHead } from './api';
import { csvField, exportCsv, exportFileName, exportJson } from './export';

const recipe = (name: string, lines: [string, string][], notes = ''): RecipeHead => ({
  recordId: 'r-' + name,
  revisionId: 'v-' + name,
  number: 3,
  savedAt: Date.UTC(2026, 9, 14, 12),
  content: { name, notes, lines: lines.map(([material, amount]) => ({ material, amount })) }
});

describe('exportCsv', () => {
  it('writes a row per material with percentages, notes on the first row', () => {
    const csv = exportCsv([recipe('Leach 4321', [['Custer Feldspar', '40'], ['Silica', '60']], 'Cone 10, reduction')]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Recipe,Material,Amount,Percent,Notes,Revision,Saved',
      'Leach 4321,Custer Feldspar,40,40.00,"Cone 10, reduction",3,2026-10-14T12:00:00.000Z',
      'Leach 4321,Silica,60,60.00,,,',
      ''
    ]);
  });

  it('keeps a recipe with no materials', () => {
    expect(exportCsv([recipe('Empty', [])]).split('\r\n')[1]).toBe('Empty,,,,,3,2026-10-14T12:00:00.000Z');
  });
});

describe('csvField', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a "b"')).toBe('"a ""b"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
  });

  it('defuses text a spreadsheet would run as a formula, but not negative numbers', () => {
    expect(csvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('-2.5')).toBe('-2.5');
  });
});

describe('exportJson', () => {
  it('names its format and leaves out empty lines', () => {
    const json = JSON.parse(
      exportJson([recipe('Shino', [['Nepheline Syenite', '50'], ['', '']])], new Date(Date.UTC(2026, 9, 14)), '0.2.0')
    );
    expect(json.format).toBe('glaze-vault-export');
    expect(json.recipes[0].lines).toEqual([{ material: 'Nepheline Syenite', amount: '50' }]);
    expect(json.recipes[0].savedAt).toBe('2026-10-14T12:00:00.000Z');
  });
});

it('names files by the local date', () => {
  expect(exportFileName('csv', new Date(2026, 0, 5, 23, 30))).toBe('Glaze Vault recipes 2026-01-05.csv');
});
