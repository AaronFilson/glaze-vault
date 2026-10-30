// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { MaterialHead, RecipeHead } from './api';
import { csvField, exportCsv, exportFileName, exportFiringsCsv, exportInsightXml, exportJson, exportMaterialsCsv, exportMixesCsv } from './export';
import type { Mix } from './mix';
import { EMPTY_BAR, type Firing } from './firing';
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
      'Recipe,Material,Amount,Percent,Added,Type,Cone,Atmosphere,Surface,Transparency,Color,Tags,Gravity,Viscosity,' +
        'Body,Forming,Absorption from,Absorption to,Shrinkage from,Shrinkage to,Water,Water basis,Notes,Revision,Saved',
      'Leach 4321,Custer Feldspar,40,40.00,,,,,,,,,,,,,,,,,,,"Cone 10, reduction",3,2026-10-14T12:00:00.000Z',
      'Leach 4321,Silica,60,60.00,,,,,,,,,,,,,,,,,,,,,',
      ''
    ]);
  });

  it('keeps a recipe with no materials', () => {
    expect(exportCsv([recipe('Empty', [])]).split('\r\n')[1]).toBe('Empty,,,,,,,,,,,,,,,,,,,,,,,3,2026-10-14T12:00:00.000Z');
  });

  it('writes details on the first row, and additions as a percent of the base', () => {
    const body = recipe('Stoneware', [['Ball clay', '60'], ['Silica', '40'], ['Grog', '10']]);
    body.content.lines[2].addition = true;
    Object.assign(body.content, {
      type: 'clay body',
      cone: '6',
      atmosphere: 'reduction',
      color: 'Toasty',
      tags: ['throwing', 'R&D'],
      bodyClass: 'stoneware',
      forming: 'throwing',
      absorptionMax: '2',
      shrinkageMin: '11',
      shrinkageMax: '13',
      water: '21',
      waterBasis: 'wet'
    });
    const rows = exportCsv([body]).slice(1).split('\r\n');
    expect(rows[1]).toBe(
      'Stoneware,Ball clay,60,60.00,,Clay body,6,Reduction,,,Toasty,"throwing, R&D",,,' +
        'Stoneware,Throwing,,2,11,13,21,% of the wet clay,,3,2026-10-14T12:00:00.000Z'
    );
    expect(rows[3]).toBe('Stoneware,Grog,10,10.00,yes,,,,,,,,,,,,,,,,,,,,');
    // And back again.
    expect(readImport('recipes.csv', exportCsv([body])).recipes[0]).toEqual({
      name: 'Stoneware',
      lines: [
        { material: 'Ball clay', amount: '60' },
        { material: 'Silica', amount: '40' },
        { material: 'Grog', amount: '10', addition: true }
      ],
      notes: '',
      type: 'clay body',
      cone: '6',
      atmosphere: 'reduction',
      color: 'Toasty',
      tags: ['throwing', 'R&D'],
      bodyClass: 'stoneware',
      forming: 'throwing',
      absorptionMax: '2',
      shrinkageMin: '11',
      shrinkageMax: '13',
      water: '21',
      waterBasis: 'wet'
    });
  });
});

describe('exportFiringsCsv', () => {
  const firing = (firedOn: string, more: Partial<Firing['content']> = {}): Firing => ({
    recordId: 'f-' + firedOn,
    revisionId: 'fv-' + firedOn,
    number: 2,
    savedAt: Date.UTC(2026, 9, 16, 9),
    content: { recipe: 'r-1', recipeNumber: 4, recipeName: 'Shino', firedOn, notes: '', photos: [], ...more }
  });

  it('writes a firing a row, oldest first, with what the bar shows', () => {
    const rows = exportFiringsCsv([
      firing('2026-10-16', {
        cone: '10',
        atmosphere: 'reduction',
        peak: '1300',
        flaws: ['crazed', 'pinholed'],
        bar: { mark: '100', dry: '94', fired: '88', firedWeight: '50', soakedWeight: '51', suspendedWeight: '30' },
        slip: { gravity: '1.45', viscosity: '', gel: 'none' },
        photos: [
          { id: 'a', mediaType: 'image/jpeg', caption: 'Front' },
          { id: 'b', mediaType: 'image/jpeg', caption: '' }
        ],
        notes: 'Thick, by the rim'
      }),
      firing('2026-09-01')
    ])
      .slice(1)
      .split('\r\n');
    expect(rows[0].split(',').slice(0, 3)).toEqual(['Recipe', 'Recipe revision', 'Fired on']);
    expect(rows[1]).toBe('Shino,4,2026-09-01,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,2,2026-10-16T09:00:00.000Z');
    expect(rows[2]).toBe(
      'Shino,4,2026-10-16,10,Reduction,,1300 °C,,,,,"Crazed, Pinholed",100,94,88,50,51,30,' +
        '6.00,6.38,12.00,2.00,4.76,2.381,1.45,,none,,,,,,,,,,,Front; Photo 2,"Thick, by the rim",2,2026-10-16T09:00:00.000Z'
    );
  });

  it('writes warping, the drying disk, lots and glaze fit', () => {
    const [header, row] = exportFiringsCsv([
      firing('2026-10-17', {
        bar: { ...EMPTY_BAR, span: '100', bow: '0.5', sag: '3', disk: '2' },
        lots: ['bag 3', '', 'lot 7731'],
        body: { recipe: 'r-2', name: 'Cone 6 porcelain' },
        fit: { test: 'iwct', result: 'crazed', detail: 'at 325 °F' }
      })
    ])
      .slice(1)
      .split('\r\n')
      .map((line) => line.split(','));
    const at = (column: string) => row[header.indexOf(column)];
    expect(at('Span mm')).toBe('100');
    expect(at('Deformation mm')).toBe('3.5');
    expect(at('Drying disk')).toBe('2');
    expect(at('Lots')).toBe('1: bag 3; 3: lot 7731');
    expect(at('On body')).toBe('Cone 6 porcelain');
    expect(at('Fit test')).toBe('300 °F to ice water (IWCT)');
    expect(at('Fit result')).toBe('Crazed');
    expect(at('Fit test how')).toBe('at 325 °F');
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

describe('exportMixesCsv', () => {
  it('writes a mix a row, oldest first, with its lots, steps and last readings', () => {
    const mix = (mixedOn: string, more: Partial<Mix['content']> = {}): Mix => ({
      recordId: 'm-' + mixedOn,
      revisionId: 'mv-' + mixedOn,
      number: 1,
      savedAt: Date.UTC(2026, 9, 20, 9),
      content: { sheet: 's', sheetNumber: 2, recipe: 'r', recipeNumber: 3, name: 'CP-1', mixedOn, notes: '', ...more }
    });
    const rows = exportMixesCsv(
      [
        mix('2026-10-19', {
          size: '5000',
          unit: 'g',
          lots: ['G-12', '', 'S-3'],
          water: '1900',
          steps: [
            { on: '2026-10-19', deflocculant: '25', water: '', gravity: '1.80', viscosity: '', gel: '' },
            { on: '2026-10-21', deflocculant: '12.5', water: '100', gravity: '', viscosity: '41', gel: 'slight' }
          ],
          notes: 'Overnight, covered'
        }),
        mix('2026-10-01', { sheet: null, sheetNumber: null, name: '' })
      ],
      [{ recordId: 'r', revisionId: 'r-3', number: 3, savedAt: 1, content: { name: 'Casting porcelain', notes: '', lines: [] } }]
    )
      .slice(1)
      .split('\r\n');
    expect(rows[0].split(',').slice(0, 4)).toEqual(['Mixed', 'Mixed from', 'Its revision', 'Mixed on']);
    expect(rows[1]).toBe('Casting porcelain,Recipe,3,2026-10-01,,,,,,,,,,,,1,2026-10-20T09:00:00.000Z');
    expect(rows[2]).toBe(
      'CP-1,Batch sheet,2,2026-10-19,5000,g,1: G-12; 3: S-3,1900,37.5,2000,' +
        '"2026-10-19, deflocculant 25, SG 1.80; 2026-10-21, deflocculant 12.5, water 100, 41 s, gel slight",' +
        '1.80,41,slight,"Overnight, covered",1,2026-10-20T09:00:00.000Z'
    );
  });
});
