import { describe, expect, it } from 'vitest';
import { bodyChemistry, bodyMakeup, bodyPart, isBody, otherBasis } from './body';
import { analyse, type MaterialContent } from './chemistry';

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

describe('what a body is made of', () => {
  const own = (name: string, more: Partial<MaterialContent> = {}): MaterialContent => ({
    name,
    category: 'material',
    oxides: [],
    loi: '',
    notes: '',
    ...more
  });

  it('knows plastic clays and silica among the standard materials, and that calcined clay is not plastic', () => {
    expect(bodyPart('EPK Kaolin', [])).toBe('plastic');
    expect(bodyPart('OM-4 Ball Clay', [])).toBe('plastic');
    expect(bodyPart('Bentonite', [])).toBe('plastic');
    expect(bodyPart('Molochite', [])).toBe('other');
    expect(bodyPart('Calcined Kaolin (theoretical)', [])).toBe('other');
    expect(bodyPart('Flint', [])).toBe('silica');
    expect(bodyPart('Custer Spar', [])).toBe('other');
  });

  it('takes the class of the person’s own material first, and knows when there is none', () => {
    expect(bodyPart('Local red', [own('Local red', { class: 'earthenware clay' })])).toBe('plastic');
    expect(bodyPart('EPK Kaolin', [own('EPK Kaolin', { class: 'grog' })])).toBe('other');
    expect(bodyPart('Local red', [own('Local red')])).toBeNull();
    // Theirs, without a class, but by a standard name: the standard material's.
    expect(bodyPart('Silica', [own('Silica')])).toBe('silica');
  });

  it('gives the plastic share and added silica of all the dry materials', () => {
    const makeup = bodyMakeup(
      [
        { material: 'EPK Kaolin', amount: '50' },
        { material: 'Custer Spar', amount: '25' },
        { material: 'Silica', amount: '20' },
        { material: 'Local red', amount: '5' }
      ],
      [own('Local red')]
    )!;
    expect(makeup.plastic).toBeCloseTo(50, 9);
    expect(makeup.silica).toBeCloseTo(20, 9);
    expect(makeup.unknown).toEqual(['Local red']);
    expect(bodyMakeup([{ material: 'Silica', amount: '' }], [])).toBeNull();
  });

  it('turns water per 100 g dry into a share of the wet clay, and back', () => {
    // 21% of the wet weight is 26.6 g per 100 g dry (the research, section 5).
    expect(otherBasis({ water: '21', waterBasis: 'wet' })).toBeCloseTo(26.58, 2);
    expect(otherBasis({ water: '26.58' })).toBeCloseTo(21, 2);
    expect(otherBasis({ water: '' })).toBeNull();
    expect(otherBasis({ water: '100', waterBasis: 'wet' })).toBeNull();
  });
});
