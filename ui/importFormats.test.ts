// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { exportCsv, exportJson, exportMaterialsCsv } from './export';
import { ImportError, parseCsv, readImport } from './importFormats';
import type { MaterialHead, RecipeHead } from './api';

const shino: RecipeHead = {
  recordId: 'r-1',
  revisionId: 'v-1',
  number: 2,
  savedAt: Date.UTC(2026, 9, 14),
  content: {
    name: 'Shino, "carbon trap"',
    lines: [
      { material: 'Nepheline Syenite', amount: '50' },
      { material: 'Spodumene', amount: '30' }
    ],
    notes: 'Thick.\nCone 10'
  }
};
const spar: MaterialHead = {
  recordId: 'm-1',
  revisionId: 'mv-1',
  number: 1,
  savedAt: Date.UTC(2026, 9, 14),
  content: {
    name: 'Custer, lot 7',
    category: 'material',
    oxides: [
      { oxide: 'SiO2', percent: '68.5' },
      { oxide: 'K2O', percent: '10' }
    ],
    loi: '0.3',
    notes: 'Data sheet'
  }
};
const kaolin: MaterialHead = {
  ...spar,
  recordId: 'm-2',
  content: {
    name: 'Kaolin, theory',
    category: 'material',
    basis: 'formula',
    oxides: [],
    loi: '',
    formula: [
      { oxide: 'Al2O3', moles: '1' },
      { oxide: 'SiO2', moles: '2' },
      { oxide: 'H2O', moles: '2' }
    ],
    notes: ''
  }
};

describe('Glaze Vault exports', () => {
  it('read back from JSON', () => {
    const plan = readImport('export.json', exportJson([shino], [spar, kaolin], new Date(), '0.1.0'));
    expect(plan.format).toBe('Glaze Vault export (JSON)');
    expect(plan.recipes).toEqual([shino.content]);
    expect(plan.materials).toEqual([spar.content, kaolin.content]);
  });

  it('read back from CSV', () => {
    expect(readImport('recipes.csv', exportCsv([shino])).recipes).toEqual([shino.content]);
    expect(readImport('materials.csv', exportMaterialsCsv([spar, kaolin])).materials).toEqual([
      spar.content,
      { ...kaolin.content, oxides: [] }
    ]);
  });

  it('refuse JSON from elsewhere', () => {
    expect(() => readImport('x.json', '{"recipes": []}')).toThrow(ImportError);
    expect(() => readImport('x.json', '{oops')).toThrow(/not JSON/);
  });
});

describe('Insight XML', () => {
  it('reads recipes as Digitalfire and Glazy write them', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<recipes version="1.0" encoding="UTF-8">
<recipe name="Cone 6 Ultraclear" keywords="clear, base" id="106" date="2015-10-30" codenum="G1216M">
<recipelines>
<recipeline material="Minspar 200" amount="8.600" unitabbr="kg" conversion="1.0000" added="0"/>
<recipeline material="Ferro Frit 3134" amount="20.000" unitabbr="kg" conversion="1.0000" added="0"/>
<recipeline material="Zircopax" amount="5" unitabbr="kg" conversion="1.0000" added="true"/>
</recipelines>
<url url="https://digitalfire.com/recipe/g1216m" descrip="Recipe page"/>
<notes>Our base clear.</notes>
</recipe>
</recipes>`;
    const plan = readImport('recipes.xml', xml);
    expect(plan.format).toBe('Insight XML');
    expect(plan.recipes).toEqual([
      {
        name: 'Cone 6 Ultraclear',
        lines: [
          { material: 'Minspar 200', amount: '8.6' },
          { material: 'Ferro Frit 3134', amount: '20' },
          { material: 'Zircopax', amount: '5' }
        ],
        notes: 'Code: G1216M\nKeywords: clear, base\nDated 2015-10-30\nOur base clear.\nRecipe page: https://digitalfire.com/recipe/g1216m'
      }
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('converts amounts in mixed units, and says so', () => {
    const xml = `<recipes><recipe name="Mixed"><recipelines>
<recipeline material="Silica" amount="2" unitabbr="kg" conversion="1000"/>
<recipeline material="Whiting" amount="500" unitabbr="g" conversion="1"/>
</recipelines></recipe></recipes>`;
    const plan = readImport('mixed.xml', xml);
    expect(plan.recipes[0].lines.map((l) => l.amount)).toEqual(['2000', '500']);
    expect(plan.warnings[0]).toMatch(/mixes units/);
  });

  it("reads Glazy's materials", () => {
    const xml = `<materials><material name="Custer Feldspar" descrip="Potash feldspar" loi="">
<oxides><oxide symbol="SiO2" percent="68.5" tolerance=""/><oxide symbol="K2O" percent="10"/><oxide symbol="Xx" percent="1"/></oxides>
<volatiles><volatile symbol="LOI" name="Loss on Ignition" percent="0.3"/></volatiles>
</material></materials>`;
    const plan = readImport('materials.xml', xml);
    expect(plan.materials).toEqual([
      {
        name: 'Custer Feldspar',
        category: 'material',
        oxides: [
          { oxide: 'SiO2', percent: '68.5' },
          { oxide: 'K2O', percent: '10' }
        ],
        loi: '0.3',
        notes: 'Potash feldspar'
      }
    ]);
    expect(plan.warnings).toEqual(['Custer Feldspar: Xx is not an oxide Glaze Vault knows, so it was left out.']);
  });

  it('refuses a damaged file', () => {
    expect(() => readImport('bad.xml', '<recipes><recipe name="x">')).toThrow(/damaged or not XML/);
  });
});

describe('GlazeChem', () => {
  it('reads recipes, with their additions and notes', () => {
    const glz = [
      'filetype = GlazeChem Glazes',
      'version =  2',
      '',
      'dbname  = Raku',
      '',
      'name   = 1 2 3 Clear',
      'date   = 7/19/95',
      'range  = 08 - 06',
      'firetype     = Raku',
      'color        = Transparent Clear',
      'by_vol    = n',
      'component = Gerstley borate',
      'amount    = 50',
      'component = EPK',
      'amount    = 33.33',
      'addition = Copper carbonate',
      'addamount = 2',
      'note = |quantities are given in parts',
      'note = |  by weight',
      'note = |',
      '',
      'name   = Second',
      'component = Silica',
      'amount    = 10'
    ].join('\r\n');
    const plan = readImport('Raku.glz', glz);
    expect(plan.format).toBe('GlazeChem');
    expect(plan.recipes).toEqual([
      {
        name: '1 2 3 Clear',
        lines: [
          { material: 'Gerstley borate', amount: '50' },
          { material: 'EPK', amount: '33.33' },
          { material: 'Copper carbonate', amount: '2' }
        ],
        notes: 'Cone 08 - 06. Raku. Transparent Clear. Dated 7/19/95\n\nquantities are given in parts\n  by weight'
      },
      { name: 'Second', lines: [{ material: 'Silica', amount: '10' }], notes: '' }
    ]);
  });

  it('reads materials as an analysis or a formula, and says what it leaves out', () => {
    const mat = [
      'filetype = GlazeChem Materials',
      'I = | about this list',
      'name      = Ajax P kaolin',
      'type      = clay',
      'formula   = % 0.04 K2O  0.30 MgO  38.14 Al2O3  45.41 SiO2  13.45 LOI',
      'annote = |Ajax P kaolin supplies SiO2',
      'note = | Mined in Idaho',
      '',
      'name      = Gibbsite',
      'type      = alumina',
      'formula   = Al2O3  3 H2O',
      '',
      'name      = Wood ash',
      'type      = ash',
      'formula   = % 41.38 CaO  7.3 H2O  29.07 CO2  0.26 SO3  0.25 Cl2',
      '',
      'name      = Red stain',
      'type      = colorant',
      'formula   = PbCrO4'
    ].join('\n');
    const plan = readImport('materials.mat', mat);
    expect(plan.materials[0]).toEqual({
      name: 'Ajax P kaolin',
      category: 'material',
      oxides: [
        { oxide: 'K2O', percent: '0.04' },
        { oxide: 'MgO', percent: '0.3' },
        { oxide: 'Al2O3', percent: '38.14' },
        { oxide: 'SiO2', percent: '45.41' }
      ],
      loi: '13.45',
      notes: 'Ajax P kaolin supplies SiO2\n\nMined in Idaho'
    });
    expect(plan.materials[1]).toMatchObject({
      name: 'Gibbsite',
      basis: 'formula',
      formula: [
        { oxide: 'Al2O3', moles: '1' },
        { oxide: 'H2O', moles: '3' }
      ]
    });
    expect(plan.materials[2]).toMatchObject({ oxides: [{ oxide: 'CaO', percent: '41.38' }], loi: '36.63' });
    expect(plan.materials[2].notes).toContain('GlazeChem formula: % 41.38 CaO');
    expect(plan.materials[3]).toMatchObject({ category: 'colorant', formula: [] });
    expect(plan.warnings).toEqual([
      'Wood ash: 0.25 Cl2 is not an oxide Glaze Vault knows, so left out.',
      'Red stain: 1 PbCrO4 is not an oxide Glaze Vault knows, so left out.'
    ]);
  });
});

describe('materials CSV', () => {
  it("reads Insight-live's layout: a blank corner, LOI, then oxides", () => {
    const csv = ',LOI,SiO2,Al2O3,K2O,Na2O\r\nCuster Feldspar,0.3,68.5,17,10,3\r\nNo name row,,,,,\r\n';
    const plan = readImport('materials.csv', csv);
    expect(plan.format).toBe('Materials (CSV)');
    expect(plan.materials).toEqual([
      {
        name: 'Custer Feldspar',
        category: 'material',
        oxides: [
          { oxide: 'SiO2', percent: '68.5' },
          { oxide: 'Al2O3', percent: '17' },
          { oxide: 'K2O', percent: '10' },
          { oxide: 'Na2O', percent: '3' }
        ],
        loi: '0.3',
        notes: ''
      },
      { name: 'No name row', category: 'material', oxides: [], loi: '', notes: '' }
    ]);
  });

  it("reads Glazy's column names, a kind, notes and semicolons, and says what it skipped", () => {
    const csv = 'Name;Type;SiO2_percent;cao_percent;loi;Cost;Notes\nWollastonite;Raw material;51,7;48,3;0;1.20;"Lot 2; March"\n';
    const plan = readImport('glazy.csv', csv);
    expect(plan.materials[0]).toEqual({
      name: 'Wollastonite',
      category: 'material',
      oxides: [
        { oxide: 'SiO2', percent: '51,7' },
        { oxide: 'CaO', percent: '48,3' }
      ],
      loi: '0',
      notes: 'Lot 2; March'
    });
    expect(plan.warnings).toEqual(['These columns were not read: Cost.']);
  });

  it('says what a CSV needs when it has no oxide columns', () => {
    expect(() => readImport('list.csv', 'Name,Price\nSilica,1\n')).toThrow(/a column for each oxide/);
  });

  it('keeps the first of two materials with one name', () => {
    const plan = readImport('twice.csv', 'Name,SiO2\nSilica,100\nsilica,99\n');
    expect(plan.materials.map((m) => m.oxides[0].percent)).toEqual(['100']);
    expect(plan.warnings).toEqual(['silica is in the file twice: the first was kept.']);
  });
});

it('parses quoted CSV fields, and takes off a spreadsheet guard', () => {
  expect(parseCsv('a,"b, ""c""",\'=1+1\'\r\n\r\n"multi\nline",x,y\n')).toEqual([
    ['a', 'b, "c"', "=1+1'"],
    ['multi\nline', 'x', 'y']
  ]);
});

it('says when a file has nothing to import', () => {
  expect(() => readImport('empty.glz', 'filetype = GlazeChem Glazes\n')).toThrow(/No recipes or materials/);
});
