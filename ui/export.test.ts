// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { MaterialHead, RecipeHead } from './api';
import { csvField, exportCsv, exportFileName, exportInsightXml, exportJson, exportMaterialsCsv } from './export';
import { readImport } from './importFormats';

const recipe = (name: string, lines: [string, string][], notes = ''): RecipeHead => ({
  recordId: 'r-' + name,
  revisionId: 'v-' + name,
  number: 3,
  savedAt: Date.UTC(2026, 9, 14, 12),
  content: { name, notes, lines: lines.map(([material, amount]) => ({ material, amount })) }
});

const spar: MaterialHead = {
  recordId: 'm-1',
  revisionId: 'mv-1',
  number: 2,
  savedAt: Date.UTC(2026, 9, 14, 12),
  content: {
    name: 'Custer, lot 7',
    category: 'material',
    oxides: [
      { oxide: 'SiO2', percent: '68.5' },
      { oxide: 'K2O', percent: '10' },
      { oxide: 'Na2O', percent: '' }
    ],
    loi: '0.3',
    notes: 'Data sheet, March'
  }
};

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
      exportJson(
        [recipe('Shino', [['Nepheline Syenite', '50'], ['', '']])],
        [spar],
        new Date(Date.UTC(2026, 9, 14)),
        '0.2.0'
      )
    );
    expect(json.format).toBe('glaze-vault-export');
    expect(json.recipes[0].lines).toEqual([{ material: 'Nepheline Syenite', amount: '50' }]);
    expect(json.recipes[0].savedAt).toBe('2026-10-14T12:00:00.000Z');
    expect(json.materials[0]).toMatchObject({
      name: 'Custer, lot 7',
      oxides: [
        { oxide: 'SiO2', percent: '68.5' },
        { oxide: 'K2O', percent: '10' }
      ],
      loi: '0.3',
      revision: 2
    });
  });
});

describe('exportMaterialsCsv', () => {
  it('writes a row per oxide, then the loss on ignition', () => {
    expect(exportMaterialsCsv([spar]).slice(1).split('\r\n')).toEqual([
      'Material,Kind,Oxide,Percent,Moles,Notes,Revision,Saved',
      '"Custer, lot 7",Raw material,SiO2,68.5,,"Data sheet, March",2,2026-10-14T12:00:00.000Z',
      '"Custer, lot 7",,K2O,10,,,,',
      '"Custer, lot 7",,LOI,0.3,,,,',
      ''
    ]);
  });

  it('writes a formula as moles', () => {
    const kaolin: MaterialHead = {
      ...spar,
      content: {
        ...spar.content,
        name: 'Kaolin, theory',
        basis: 'formula',
        formula: [
          { oxide: 'Al2O3', moles: '1' },
          { oxide: 'SiO2', moles: '2' },
          { oxide: 'H2O', moles: '2' }
        ],
        notes: ''
      }
    };
    expect(exportMaterialsCsv([kaolin]).slice(1).split('\r\n').slice(1, 4)).toEqual([
      '"Kaolin, theory",Raw material,Al2O3,,1,,2,2026-10-14T12:00:00.000Z',
      '"Kaolin, theory",,SiO2,,2,,,',
      '"Kaolin, theory",,H2O,,2,,,'
    ]);
  });
});

it('names files by the local date', () => {
  expect(exportFileName('csv', new Date(2026, 0, 5, 23, 30))).toBe('Glaze Vault recipes 2026-01-05.csv');
  expect(exportFileName('csv', new Date(2026, 0, 5), 'materials')).toBe('Glaze Vault materials 2026-01-05.csv');
});

describe('Insight XML', () => {
  it('reads back as the same recipes, dated', () => {
    const shino = recipe('Shino & "Carbon" <trap>', [['Nepheline Syenite', '50'], ['Spodumene', ' 30.5 '], ['', '']], 'Thick.\nCone 10');
    const empty = recipe('Nothing yet', []);
    const xml = exportInsightXml([shino, empty]);
    expect(xml).toContain('<recipe name="Shino &amp; &quot;Carbon&quot; &lt;trap&gt;" keywords="" id="" date="2026-10-14" codenum="">');
    expect(xml).toContain('<recipeline material="Spodumene" amount="30.5" unitabbr="g" conversion="1.0000" added="0"/>');
    const plan = readImport('recipes.xml', xml);
    expect(plan.warnings).toEqual([]);
    expect(plan.recipes).toEqual([
      {
        name: 'Shino & "Carbon" <trap>',
        lines: [
          { material: 'Nepheline Syenite', amount: '50' },
          { material: 'Spodumene', amount: '30.5' }
        ],
        notes: 'Dated 2026-10-14\nThick.\nCone 10'
      },
      { name: 'Nothing yet', lines: [{ material: '', amount: '' }], notes: 'Dated 2026-10-14' }
    ]);
  });

  it('keeps line breaks in names, and leaves out what XML cannot hold', () => {
    const xml = exportInsightXml([recipe('Two\nlines\u0001', [['Silica', '1']])]);
    expect(readImport('r.xml', xml).recipes[0].name).toBe('Two\nlines');
  });
});
