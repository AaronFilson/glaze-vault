import { describe, expect, it } from 'vitest';
import {
  analyse,
  amountOf,
  checkMaterial,
  MATERIAL_NAMES,
  materialLibrary,
  oxideLabel,
  oxidesByGroup,
  sameName,
  standardAnalysis,
  standardNamed,
  STANDARD_MATERIALS,
  type MaterialContent
} from './chemistry';

// The values Glazecalc's own chemistry tests check by hand (server/test/chemistry_tests.ts).
const LEACH_4321 = [
  { material: 'Potash Feldspar', amount: '40' },
  { material: 'Silica', amount: '30' },
  { material: 'Whiting', amount: '20' },
  { material: 'Kaolin', amount: '10' }
];

// Glazecalc's tests allow 0.0001 either side.
const near = (actual: number, expected: number, within = 0.0001) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(within);

describe('chemistry', () => {
  it('works out Leach 4321 through the copied library', () => {
    const analysis = analyse(LEACH_4321);
    const umf = analysis!.result!.umf;
    near(umf.K2O, 0.2645);
    near(umf.CaO, 0.7355);
    near(umf.Al2O3, 0.4071);
    near(umf.SiO2, 3.7099);
    near(analysis!.result!.expansion!, 7.49, 0.005);
  });

  it('loads the standard library and finds materials by alias', () => {
    expect(STANDARD_MATERIALS.length).toBe(167);
    expect(MATERIAL_NAMES).toContain('Alberta Slip');
    expect(MATERIAL_NAMES).toContain('Potash Feldspar');
    const byAlias = analyse([{ material: 'ABSLIP', amount: '100' }]);
    expect(byAlias!.result!.umf.SiO2).toBeGreaterThan(0);
  });

  it('skips empty lines and reports unknown materials', () => {
    expect(analyse([{ material: '', amount: '' }])).toBeNull();
    expect(analyse([{ material: 'Unobtainium', amount: '10' }])!.problem).toMatch(/Unobtainium/);
  });

  it('groups oxides and writes them with subscripts', () => {
    const groups = oxidesByGroup(analyse(LEACH_4321)!.result!);
    expect(groups.RO[0][0]).toBe('CaO');
    expect(groups.RO2.map(([oxide]) => oxide)).toEqual(['SiO2']);
    expect(oxideLabel('Al2O3')).toBe('Al₂O₃');
    expect(amountOf('12,5')).toBe(12.5);
  });
});

const own = (name: string, oxides: [string, string][], loi = '', category: MaterialContent['category'] = 'material') => ({
  name,
  category,
  oxides: oxides.map(([oxide, percent]) => ({ oxide, percent })),
  loi,
  notes: ''
});

describe('your own materials', () => {
  it('replace a standard material of the same name', () => {
    const potash = own('Potash Feldspar', [['Na2O', '16.9'], ['Al2O3', '18.1'], ['SiO2', '65']]);
    const library = materialLibrary([potash]);
    const umf = analyse(LEACH_4321, library)!.result!.umf;
    expect(umf.K2O).toBeUndefined();
    expect(umf.Na2O).toBeGreaterThan(0);
    expect(library.names.filter((n) => n.name === 'Potash Feldspar')).toEqual([{ name: 'Potash Feldspar', yours: true }]);
    // Without it, the standard one is used again.
    expect(analyse(LEACH_4321)!.result!.umf.K2O).toBeGreaterThan(0);
  });

  it('are found by name whatever the case and spacing, and listed as yours', () => {
    const library = materialLibrary([own('Spar, lot 7', [['K2O', '12'], ['Al2O3', '18'], ['SiO2', '70']])]);
    const analysis = analyse([{ material: 'spar lot7', amount: '100' }], library);
    expect(analysis!.result!.umf.K2O).toBe(1);
    expect(library.names).toContainEqual({ name: 'Spar, lot 7', yours: true });
  });

  it('report a bad amount with the material named', () => {
    const library = materialLibrary([own('Smudge', [['SiO2', 'lots']])]);
    expect(analyse([{ material: 'Smudge', amount: '10' }, { material: 'Whiting', amount: '10' }], library)!.problem).toMatch(
      /Smudge/
    );
  });

  it('report a loss on ignition that is not a number, rather than take it as none', () => {
    const library = materialLibrary([own('Smudge', [['SiO2', '90']], '4.5%')]);
    expect(analyse([{ material: 'Smudge', amount: '10' }, { material: 'Whiting', amount: '10' }], library)!.problem).toBe(
      'The loss on ignition of Smudge is not a number.'
    );
    expect(checkMaterial(own('Smudge', [['SiO2', '90']], 'abc'))).toMatchObject({
      problem: 'The loss on ignition of Smudge is not a number.'
    });
  });

  it('with no oxides count in the batch but not in the unity formula', () => {
    const library = materialLibrary([own('Mason 6600', [], '', 'colorant')]);
    const analysis = analyse([...LEACH_4321, { material: 'Mason 6600', amount: '5' }, { material: 'CMC gum', amount: '0.5' }], library);
    expect(analysis!.result!.umf.K2O).toBeCloseTo(0.2645, 4);
    expect(analysis && 'noOxides' in analysis && analysis.noOxides).toEqual(['Mason 6600', 'CMC gum']);
  });
});

describe('standard additives', () => {
  it('are in the list and the chemistry', () => {
    expect(MATERIAL_NAMES).toContain('Chromium Oxide');
    expect(MATERIAL_NAMES).toContain('Bentonite');
    const analysis = analyse([...LEACH_4321, { material: 'Chromium Oxide', amount: '1' }]);
    expect(analysis!.result!.umf.Cr2O3).toBeGreaterThan(0);
  });

  it('do not replace a theoretical material of the same name', () => {
    // Glazecalc's additives include a "Tin oxide" with 99% SnO2; the formula one is pure.
    const tin = analyse([{ material: 'Whiting', amount: '50' }, { material: 'Tin oxide', amount: '50' }]);
    expect(tin!.result!.loi).toBeCloseTo(22, 0);
    expect(MATERIAL_NAMES.filter((name) => name.toLowerCase() === 'tin oxide')).toHaveLength(1);
  });

  it('every standard material and additive with oxides works', () => {
    for (const name of MATERIAL_NAMES) {
      const analysis = analyse([{ material: name, amount: '10' }, { material: 'Whiting', amount: '10' }]);
      expect(analysis?.problem, name).toBeUndefined();
    }
  });
});

describe('checkMaterial', () => {
  it('totals the analysis and works out the material’s own unity formula', () => {
    const check = checkMaterial(own('Wollastonite, lot 2', [['CaO', '48.3'], ['SiO2', '51.7']], '0'));
    expect(check.total).toBeCloseTo(100);
    expect('unity' in check && check.unity.CaO).toBeCloseTo(1, 2);
    expect('unity' in check && check.warnings).toEqual([]);
  });

  it('warns when it does not add up to 100', () => {
    const check = checkMaterial(own('Short', [['CaO', '40'], ['SiO2', '40']]));
    expect('unity' in check && check.warnings.join()).toMatch(/80/);
  });

  it('says when there are no oxides', () => {
    expect(checkMaterial(own('Gum', [['SiO2', '']]))).toEqual({ noOxides: true, total: 0 });
  });
});

describe('standardAnalysis', () => {
  it('gives a formula material as a data sheet would', () => {
    // Whiting, CaCO3: 56.03% CaO and 43.97% CO2.
    expect(standardAnalysis('Whiting')).toEqual({
      oxides: [{ oxide: 'CaO', percent: '56.03' }],
      loi: '43.97',
      category: 'material'
    });
  });

  it('gives the kind of material, and finds one by another of its names', () => {
    expect(standardAnalysis('Chromium Oxide')!.category).toBe('colorant');
    expect(standardAnalysis('Veegum T')!.category).toBe('additive');
    expect(standardAnalysis('Ferro Frit 3134')!.category).toBe('frit');
    expect(standardAnalysis('quartz')!.oxides).toEqual([{ oxide: 'SiO2', percent: '100' }]);
  });

  it('gives a commercial material its oxides in the usual order', () => {
    const custer = standardAnalysis('Custer Spar')!;
    expect(custer.oxides[0].oxide).toBe('Na2O');
    const total = custer.oxides.reduce((sum, line) => sum + Number(line.percent), Number(custer.loi));
    expect(total).toBeCloseTo(100, 0);
  });

  it('has nothing for an unknown material or one with no oxides', () => {
    expect(standardAnalysis('Unobtainium')).toBeNull();
    expect(standardAnalysis('CMC gum')).toBeNull();
  });
});

describe('standardNamed', () => {
  it('finds a standard material by its name or another it is known by', () => {
    expect(standardNamed('custer spar')).toBe('Custer Spar');
    expect(standardNamed('Quartz')).toBe('Silica');
    expect(standardNamed('CMC gum')).toBe('CMC gum');
    expect(standardNamed('Mason 6600')).toBeNull();
    expect(standardNamed('')).toBeNull();
  });
});

it('compares names as the library does, keeping other scripts apart', () => {
  expect(sameName('Spar, lot 7', 'SPAR lot7')).toBe(true);
  expect(sameName('Spar, lot 7', 'Spar, lot 8')).toBe(false);
  expect(sameName('Bentonit (Jäger)', 'bentonit jager')).toBe(true);
  expect(sameName('長石', '珪石')).toBe(false);
  // Glazecalc lists Улексит as another name for Ulexite; a name in another script is not it.
  expect(standardNamed('長石')).toBeNull();
  expect(standardNamed('Улексит')).toBe('Ulexite (Etimine)');
});
