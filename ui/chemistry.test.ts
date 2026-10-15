import { describe, expect, it } from 'vitest';
import { analyse, amountOf, MATERIAL_NAMES, oxideLabel, oxidesByGroup, STANDARD_MATERIALS } from './chemistry';

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
