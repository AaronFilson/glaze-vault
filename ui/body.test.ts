import { describe, expect, it } from 'vitest';
import { bodyChemistry, isBody } from './body';
import { analyse } from './chemistry';

// A porcelain from theoretical materials: kaolin, feldspar and silica, as most begin.
const PORCELAIN = [
  { material: 'Kaolin', amount: '50' },
  { material: 'Potash Feldspar', amount: '25' },
  { material: 'Silica', amount: '25' }
];

describe('a clay body’s chemistry', () => {
  it('is for bodies and slips, not glazes', () => {
    expect(isBody('clay body')).toBe(true);
    expect(isBody('casting slip')).toBe(true);
    expect(isBody('glaze')).toBe(false);
    expect(isBody(undefined)).toBe(false);
  });

  it('gives oxide percentages, a formula with alumina as one, and fluxes in mole percent', () => {
    const result = analyse(PORCELAIN)!.result!;
    const body = bodyChemistry(result);
    const percent = Object.fromEntries(body.percent);
    expect(body.percent[0][0]).toBe('SiO2');
    expect(Object.values(percent).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(percent.K2O).toBeCloseTo(result.analysis.K2O, 9);

    const alumina = Object.fromEntries(body.alumina!);
    expect(alumina.Al2O3).toBeCloseTo(1, 9);
    expect(alumina.SiO2).toBeCloseTo(result.siAlRatio!, 9);
    expect(body.alumina!.map(([oxide]) => oxide)).toEqual(['K2O', 'Al2O3', 'SiO2']);

    // Potash is the only flux, so it is all of them.
    expect(body.knaoMol).toBeGreaterThan(0);
    expect(body.fluxMol).toBeCloseTo(body.knaoMol, 9);
    expect(body.ironTitania).toBe(0);
  });

  it('counts iron and titania together', () => {
    const body = bodyChemistry(analyse([...PORCELAIN, { material: 'Red Iron Oxide', amount: '2' }])!.result!);
    expect(body.ironTitania).toBeGreaterThan(1.5);
  });
});
