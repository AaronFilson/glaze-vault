import { describe, expect, it } from 'vitest';
import type { MaterialContent } from './chemistry';
import { compareAnalyses, compareSheets, sheetCones, weightPercents } from './materialCompare';

const material = (name: string, extra: Partial<MaterialContent> = {}): MaterialContent => ({
  name,
  category: 'material',
  oxides: [],
  loi: '',
  notes: '',
  ...extra
});

const old = material('Old fire clay', {
  class: 'fire clay',
  sheet: { cone: '10', dryingShrinkage: '6.5', firingShrinkage: '5', absorption: '4.2', mesh: '8% on 200 mesh' },
  oxides: [
    { oxide: 'Al2O3', percent: '30' },
    { oxide: 'SiO2', percent: '55' },
    { oxide: 'Fe2O3', percent: '1.5' }
  ],
  loi: '11'
});
const candidate = material('Candidate', {
  class: 'fire clay',
  sheet: { cone: '^10', dryingShrinkage: '7', firingShrinkage: '5', absorption: '3.1', mesh: '5% on 200 mesh' },
  oxides: [
    { oxide: 'Al2O3', percent: '32' },
    { oxide: 'SiO2', percent: '53.5' }
  ],
  loi: '12.5'
});

describe('materials compared by their data sheets', () => {
  it('go row by row, with each number’s difference from the first', () => {
    const rows = compareSheets([old, candidate]);
    expect(rows.map((r) => r.field)).toEqual(['dryingShrinkage', 'firingShrinkage', 'absorption', 'mesh']);
    expect(rows[0]).toMatchObject({ values: ['6.5', '7'], changes: ['', '+0.5'] });
    // The same, and in words: no difference shown.
    expect(rows[1].changes).toEqual(['', '']);
    expect(rows[2].changes).toEqual(['', '−1.1']);
    expect(rows[3].changes).toEqual(['', '']);
    expect(rows[2].fired).toBe(true);
  });

  it('show no difference where either has no number', () => {
    const rows = compareSheets([material('Bare'), candidate]);
    expect(rows[0]).toMatchObject({ values: ['', '7'], changes: ['', ''] });
  });

  it('say when fired values are at different cones', () => {
    expect(sheetCones([old, candidate])).toEqual({ cones: ['10', '10'], differ: false });
    const low = { ...candidate, sheet: { ...candidate.sheet, cone: '6' } };
    expect(sheetCones([old, low]).differ).toBe(true);
    // A sheet with fired values and no cone cannot be matched either.
    const unsaid = { ...candidate, sheet: { ...candidate.sheet, cone: undefined } };
    expect(sheetCones([old, unsaid]).differ).toBe(true);
    // One with no fired values says nothing about its cone.
    const dryOnly = material('Dry only', { sheet: { dryingShrinkage: '6' } });
    expect(sheetCones([old, dryOnly]).differ).toBe(false);
  });
});

describe('materials compared by their analyses', () => {
  it('list each oxide any of them has, then the loss on ignition', () => {
    const rows = compareAnalyses([old, candidate]);
    expect(rows.map((r) => r.oxide)).toEqual(['Al2O3', 'Fe2O3', 'SiO2', 'LOI']);
    expect(rows[0]).toMatchObject({ values: [30, 32], changes: ['', '+2.00'] });
    expect(rows[1]).toMatchObject({ values: [1.5, 0], changes: ['', '−1.50'] });
  });

  it('work a formula out as weight percent', () => {
    const kaolin = material('Kaolin', {
      basis: 'formula',
      formula: [
        { oxide: 'Al2O3', moles: '1' },
        { oxide: 'SiO2', moles: '2' },
        { oxide: 'H2O', moles: '2' }
      ]
    });
    const percents = weightPercents(kaolin)!;
    expect(percents.oxides.Al2O3).toBeCloseTo(39.5, 1);
    expect(percents.oxides.SiO2).toBeCloseTo(46.5, 1);
    expect(percents.loi).toBeCloseTo(13.95, 1);
  });

  it('leave a material with no analysis empty', () => {
    expect(weightPercents(material('Stain'))).toBeNull();
    expect(compareAnalyses([material('Stain'), candidate])[0].values).toEqual([null, 32]);
  });
});
