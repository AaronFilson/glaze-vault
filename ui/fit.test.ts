import { describe, expect, it } from 'vitest';
import { select } from './choose';
import { analyse, fitPool, STANDARD_LIBRARY } from './chemistry';
import { chooseLines, chosenFrom, fitInto, fitRecipe, moveInto, targetFrom, type FitChoice } from './fit';
import { BUILT_IN_LIMITS, checkLimits } from './limits';

const leach: FitChoice[] = [
  { material: 'Custer Spar', amount: '40', change: true },
  { material: 'Silica', amount: '30', change: true },
  { material: 'Whiting', amount: '20', change: true },
  { material: 'EPK', amount: '10', change: true }
];

const umfOf = (lines: { material: string; amount: string }[]) => analyse(lines, STANDARD_LIBRARY)!.result!.umf;

describe('fitting a recipe to a formula', () => {
  it('leaves a recipe as it is when the target is its own formula', () => {
    const outcome = fitRecipe(leach, targetFrom(umfOf(leach)), STANDARD_LIBRARY);
    expect('lines' in outcome && outcome.lines.map((l) => [l.material, Number(l.amount)])).toEqual([
      ['Custer Spar', 40],
      ['Silica', 30],
      ['Whiting', 20],
      ['EPK', 10]
    ]);
  });

  it('moves a recipe toward more silica, at about its size', () => {
    const target = targetFrom(umfOf(leach)).map((t) => (t.oxide === 'SiO2' ? { ...t, moles: String(Number(t.moles) + 0.6) } : t));
    const outcome = fitRecipe(leach, target, STANDARD_LIBRARY);
    if (!('lines' in outcome)) throw new Error(outcome.problem);
    expect(outcome.changed).toBe(true);
    const silica = Number(outcome.lines.find((l) => l.material === 'Silica')!.amount);
    expect(silica).toBeGreaterThan(30);
    const fitted = umfOf(outcome.lines);
    expect(fitted.SiO2).toBeCloseTo(Number(target.find((t) => t.oxide === 'SiO2')!.moles), 1);
  });

  it('keeps a line the fit may not change, and brings in a material to try', () => {
    const choices: FitChoice[] = [
      ...leach.map((c) => (c.material === 'EPK' ? { ...c, change: false } : c)),
      { material: 'Talc', amount: '', change: true },
      { material: 'Red Iron Oxide', amount: '5', addition: true, change: false }
    ];
    const target = targetFrom({ ...umfOf(leach), MgO: 0.15 });
    const outcome = fitRecipe(choices, target, STANDARD_LIBRARY);
    if (!('lines' in outcome)) throw new Error(outcome.problem);
    expect(outcome.lines.find((l) => l.material === 'EPK')!.amount).toBe('10');
    expect(outcome.lines.find((l) => l.material === 'Red Iron Oxide')).toEqual({ material: 'Red Iron Oxide', amount: '5', addition: true });
    expect(Number(outcome.lines.find((l) => l.material === 'Talc')?.amount)).toBeGreaterThan(0);
  });

  it('says what is wrong with what it was given', () => {
    expect(fitRecipe(leach, [{ oxide: 'SiO2', moles: '3' }], STANDARD_LIBRARY)).toEqual({
      problem: 'The target needs some flux: an oxide such as CaO, K₂O or Na₂O.'
    });
    expect(fitRecipe([{ material: 'Unobtainium', amount: '5', change: true }], [{ oxide: 'CaO', moles: '1' }], STANDARD_LIBRARY)).toEqual({
      problem: 'Unobtainium is not a material Glaze Vault knows.'
    });
    expect(fitRecipe(leach, [{ oxide: 'CaO', moles: 'lots' }], STANDARD_LIBRARY)).toEqual({ problem: 'The target for CaO is not a number.' });
  });
});

describe('moving a formula into a limit set', () => {
  const cone6 = BUILT_IN_LIMITS[0];

  it('brings each oxide just inside its range, the fluxes still adding up to one', () => {
    // Too much calcium and too little silica for cone 6.
    const umf = { CaO: 0.75, MgO: 0.05, K2O: 0.12, Na2O: 0.08, Al2O3: 0.25, SiO2: 2.0 };
    const { target, unmet } = moveInto(umf, cone6);
    expect(unmet).toEqual([]);
    const moles = Object.fromEntries(target.map((t) => [t.oxide, Number(t.moles)]));
    expect(moles.CaO).toBeLessThanOrEqual(0.55);
    expect(moles.SiO2).toBeGreaterThanOrEqual(2.4);
    expect(moles.CaO + moles.MgO + moles.K2O + moles.Na2O).toBeCloseTo(1, 2);
    expect(checkLimits(moles, cone6).filter((c) => c.outside)).toEqual([]);
  });

  it('says which ranges no unity formula of these fluxes can meet', () => {
    // Only calcium and potash, and cone 6 allows at most 0.55 and 0.375 of them: 0.925 in all.
    expect(moveInto({ CaO: 0.9, K2O: 0.1, Al2O3: 0.3, SiO2: 3 }, cone6).unmet).toEqual(['KNaO', 'CaO']);
  });

  it('fits a recipe into the set, as near as its materials allow', () => {
    const recipe: FitChoice[] = [
      { material: 'Custer Spar', amount: '25', change: true },
      { material: 'Silica', amount: '20', change: true },
      { material: 'Whiting', amount: '35', change: true },
      { material: 'EPK', amount: '20', change: true },
      // Calcium and the alkalis alone cannot add up to one within cone 6: magnesia has to come in.
      { material: 'Talc', amount: '', change: true }
    ];
    const before = checkLimits(umfOf(recipe), cone6).filter((c) => c.outside);
    expect(before.length).toBeGreaterThan(0);
    const outcome = fitInto(recipe, cone6, STANDARD_LIBRARY);
    if (!('lines' in outcome)) throw new Error(outcome.problem);
    expect(outcome.outside).toEqual([]);
    expect(checkLimits(umfOf(outcome.lines), cone6).filter((c) => c.outside)).toEqual([]);
  });
});

describe('choosing materials for a fit', () => {
  // Leach 4321 with boron and magnesia it has no material for.
  const target = targetFrom({ ...umfOf(leach), B2O3: 0.3, MgO: 0.15 });
  const pool = ['Gerstley Borate', 'Ferro Frit 3134', 'Talc', 'Dolomite', 'Silica', 'Nepheline Syenite'];

  it('brings in what the target needs from the pool, and says what each is for', async () => {
    const job = chooseLines(leach, target, STANDARD_LIBRARY, pool, { extras: 2 });
    if ('problem' in job) throw new Error(job.problem);
    const chosen = chosenFrom(job, await select(job));
    const brought = chosen.lines.filter((l) => !leach.some((c) => c.material === l.material)).map((l) => l.material);
    expect(brought.length).toBeGreaterThan(0);
    expect(brought.length).toBeLessThanOrEqual(2);
    const boron = Object.entries(chosen.supplies).find(([, s]) => s.some((part) => part.oxide === 'B2O3'))?.[0];
    expect(boron && brought).toContain(boron);
    expect(umfOf(chosen.lines).B2O3).toBeGreaterThan(0.15);
  });

  it('leaves out what it is told not to use, and names what nothing has', async () => {
    const job = chooseLines(leach, [...target, { oxide: 'Li2O', moles: '0.05' }], STANDARD_LIBRARY, pool, {
      avoid: ['Ferro Frit 3134', 'gerstley borate']
    });
    if ('problem' in job) throw new Error(job.problem);
    const chosen = chosenFrom(job, await select(job));
    expect(chosen.lines.some((l) => /3134|Gerstley/.test(l.material))).toBe(false);
    expect(chosen.unreachable).toEqual(expect.arrayContaining(['Li2O', 'B2O3']));
  });

  it('chooses from raw materials and frits, never colorants or lead', () => {
    const pool = fitPool(STANDARD_LIBRARY);
    expect(pool).toContain('Ferro Frit 3134');
    expect(pool).not.toContain('Red iron oxide');
    expect(pool).not.toContain('Potassium Bichromate');
    expect(STANDARD_LIBRARY.names.some((n) => n.name === 'Litharge')).toBe(true);
    expect(pool.some((name) => /^lead|litharge/i.test(name))).toBe(false);
  });
});
