'use strict';

const oxides = require('./oxides');
const { prepare, fitAmounts, molesPerGram } = require('./fit');

// Choosing among any number of materials (docs/adr/0012-choosing-materials.md):
// offered a pool, propose the fewest that bring the glaze close, and say what
// each one does. Three stages, after the research report "Extra materials in
// glaze substitution":
//   A  the best match the whole pool can make (no pull toward the old amounts);
//   B  drop materials one at a time, the one whose loss matters least, while the
//      match stays under GOOD_ENOUGH (or within SLACK of the best when it cannot
//      get there), new materials before the recipe's own; then try swaps;
//   C  fitAmounts on the few chosen: as few amounts changed as possible.

// A miss of 1 is about one oxide off by the whole of "near" (fit.js).
const GOOD_ENOUGH = 1;
const SLACK = 0.5;
// "Closer" adds materials back while each improves the miss by at least this:
// the room fitAmounts itself gives away to change fewer amounts.
const WORTH_ADDING = 0.1;
// A material not used is worth offering if adding it brings the match at least this much closer.
const WORTH_OFFERING = 0.05;
// An oxide is something to aim for if the target has at least this much of it, in the unity formula.
const TRACE = 0.005;
// A pull so slight it only settles ties: when several mixes match equally well,
// the one nearest the recipe as it was, its own materials kept.
const TIE_BREAK = 1e-3;
// Two materials whose oxides per gram point the same way within this are near-identical.
const SAME_DIRECTION = 0.98;
// An oxide worth naming in what a material supplies: not a trace of magnesium in a feldspar.
const WORTH_NAMING = 0.02;
// A material's share of an oxide worth saying: "most of the potash", not "2% of the silica".
const SHARE_WORTH_SAYING = 0.2;
// A material the potter said to use stays in at no less than this share of the batch.
const MUST_SHARE = 0.01;

const isFlux = (oxide) => oxides.OXIDE_GROUPS[oxide] === 'R2O' || oxides.OXIDE_GROUPS[oxide] === 'RO';

/** The unity formula of oxide moles: per mole of the fluxes. */
const unityOf = (moles) => {
  const fluxes = Object.keys(moles).reduce((sum, oxide) => (isFlux(oxide) ? sum + moles[oxide] : sum), 0);
  const unity = {};
  if (fluxes > 0) Object.keys(moles).forEach((oxide) => (unity[oxide] = moles[oxide] / fluxes));
  return unity;
};

/** How nearly two vectors point the same way: 1 for the same direction. */
const cosine = (p, q) => {
  let dot = 0;
  let pp = 0;
  let qq = 0;
  p.forEach((value, r) => {
    dot += value * q[r];
    pp += value * value;
    qq += q[r] * q[r];
  });
  return pp > 0 && qq > 0 ? dot / Math.sqrt(pp * qq) : 0;
};

/**
 * The fewest materials from the lines that bring their oxides close to the
 * target, at amounts that change the recipe as little as possible.
 *
 *   lines    [{ material, start, most, least, group, must, avoid }]: start > 0
 *            for the recipe's own lines (dropped last), 0 for materials offered;
 *            must, never dropped; avoid, never used (the potter's "don't use");
 *            least, the smallest useful amount if it is used at all
 *   options  as fitAmounts' (near, alkalis, fluxTotal, groups), and
 *            { closer: add back materials worth WORTH_ADDING each,
 *              extras: the most new materials to use,
 *              keepOwn: never drop the recipe's own lines (fitAmounts may still
 *              take one to nothing when the match has no use for it) }
 *
 * Returns {
 *   amounts, moles, miss       the chosen recipe (amounts for every line, 0 if unused)
 *   best                       the best miss the whole pool can make
 *   chosen                     indexes of the lines used
 *   unreachable                oxides the target has that no line supplies
 *   contributions              for each line used: the share of each oxide it supplies, and the
 *                              miss without it: miss, worse by what the best match within the
 *                              chosen lines loses without it
 *   unused                     for each line offered but not used: how much closer the match comes
 *                              when it is added (as a must) and chosen again, or 0
 *   alike                      near-identical pairs: a line used and one that could stand in
 *   capped                     caps that cost match, a line's or a shared one: what lifting it gains
 *   countCost                  how much worse the match is for the extras limit, if any
 * }
 */
const selectMaterials = function (lines, target, options = {}) {
  const { fit, within, everything, columns, best, chosen, mustLeast, result, amounts, countCost } = choose(
    lines,
    target,
    options
  );
  const finalUse = new Set(chosen.filter((i) => amounts[i] > 0));
  const finalMiss = result.miss;
  // The best match within the final recipe: what leaving a material out or
  // adding one is measured against, since finalMiss gives some match away to
  // change fewer amounts.
  const base = within(finalUse).miss;

  // Oxides the target has that nothing offered supplies.
  const targetUnity = unityOf(target);
  const unreachable = Object.keys(targetUnity).filter(
    (oxide) =>
      targetUnity[oxide] >= TRACE && !columns.some((column, i) => everything.has(i) && (column[oxide] || 0) > 0)
  );

  // Measured within the final recipe: against the whole pool, a near-identical
  // material would stand in and everything would look free.
  // What each material supplies of the glaze's oxides (as Digitalfire shows it),
  // and how much worse the match is without it, refitted within the final recipe.
  const resultUnity = unityOf(result.moles);
  const contributions = [...finalUse].map((i) => {
    const supplies = Object.keys(result.moles)
      .map((oxide) => ({ oxide, share: ((columns[i][oxide] || 0) * amounts[i]) / result.moles[oxide] }))
      .filter((part) => part.share > 0 && (resultUnity[part.oxide] || 0) >= WORTH_NAMING)
      // Largest share first; of shares within 5%, the oxide the glaze has most of.
      .sort((p, q) => Math.round(20 * (q.share - p.share)) || resultUnity[q.oxide] - resultUnity[p.oxide])
      // Its main part, however small, then the others worth saying.
      .filter((part, k) => k === 0 || part.share >= SHARE_WORTH_SAYING);
    const without = new Set(finalUse);
    without.delete(i);
    const missWithout = without.size ? finalMiss + Math.max(0, within(without).miss - base) : Infinity;
    return { index: i, supplies, missWithout };
  });
  // What adding each would really give, chosen again with it a must, as the
  // report's Add does. That is slow, so it is tried only for those the best
  // match within the final recipe gains at least WORTH_OFFERING from.
  const unused = [...everything]
    .filter((j) => !finalUse.has(j))
    .map((j) => {
      if (base - within(new Set([...finalUse, j])).miss < WORTH_OFFERING) return { index: j, helps: 0 };
      const added = choose(
        lines.map((line, i) => (i === j ? { ...line, must: true } : line)),
        target,
        options
      );
      return { index: j, helps: Math.max(0, finalMiss - added.result.miss) };
    });
  // Alike in the fit's own terms: each row weighted by how near it should come,
  // so silica, which every material has, does not make flint look like feldspar.
  const root = fit.problem.w.map(Math.sqrt);
  const direction = fit.problem.a.map((column) => column.map((value, r) => value * root[r]));
  const alike = [];
  for (const i of finalUse) {
    for (const j of everything) {
      if (finalUse.has(j) || j === i) continue;
      if (cosine(direction[i], direction[j]) >= SAME_DIRECTION) alike.push({ used: i, other: j });
    }
  }
  // Caps that cost match: what lifting each alone would give, every other bound
  // kept (each line's least, a must's share), against the best match within
  // the chosen lines as they are.
  const leastKept = (j) => (amounts[j] > 0 ? Math.max(Number(lines[j].least) || 0, mustLeast(j)) : 0);
  const withCaps = (change) =>
    prepare(
      chosen.map((j) => change({ ...lines[j], least: leastKept(j) }, j)),
      target,
      options
    ).solve(0);
  let capBase;
  const asTheyAre = () => (capBase ??= withCaps((line) => line).miss);
  const capped = [];
  chosen.forEach((i, k) => {
    const most = Number(lines[i].most);
    if (!(most >= 0) || amounts[i] < most * (1 - 1e-6)) return;
    const lifted = withCaps((line, j) => (j === i ? { ...line, most: undefined, group: undefined } : line));
    if (asTheyAre() - lifted.miss >= WORTH_ADDING) {
      capped.push({ index: i, most, wouldBe: lifted.x[k], missLifted: lifted.miss });
    }
  });
  // And shared caps: what lifting the group's would give, named by its largest member.
  const groups = options.groups || {};
  Object.keys(groups).forEach((name) => {
    const most = Number(groups[name]);
    const members = chosen.filter((i) => lines[i].group === name && amounts[i] > 0);
    const total = members.reduce((sum, i) => sum + amounts[i], 0);
    if (!members.length || !(most >= 0) || total < most * (1 - 1e-6)) return;
    const lifted = withCaps((line) => (line.group === name ? { ...line, group: undefined } : line));
    if (asTheyAre() - lifted.miss < WORTH_ADDING) return;
    const largest = members.reduce((p, q) => (amounts[q] > amounts[p] ? q : p));
    const wouldBe = members.reduce((sum, i) => sum + lifted.x[chosen.indexOf(i)], 0);
    capped.push({ index: largest, group: name, members, most, wouldBe, missLifted: lifted.miss });
  });

  return {
    amounts,
    moles: result.moles,
    miss: finalMiss,
    best: best.miss,
    chosen: [...finalUse].sort((p, q) => p - q),
    unreachable,
    contributions,
    unused,
    alike,
    capped,
    countCost
  };
};

/**
 * Stages A to C: the lines chosen and their amounts (result is fitAmounts' on
 * them), with what the report measures against.
 */
const choose = function (lines, target, options) {
  // Each line's least is applied only once it is chosen, since a candidate may be
  // left out; but a must is always in, so its least holds from the start (or the
  // choosing would count on less of it than it will have).
  const pool = lines.map((line) => ({ ...line, least: line.must && !line.avoid ? line.least : 0 }));
  const fit = prepare(pool, target, options);
  const n = lines.length;
  const avoided = new Set(lines.map((line, i) => (line.avoid ? i : -1)).filter((i) => i >= 0));
  const must = new Set(lines.map((line, i) => (line.must && !line.avoid ? i : -1)).filter((i) => i >= 0));
  const own = (i) => (Number(lines[i].start) || 0) > 0;
  // The best match with only the lines in `use` (the rest at nothing).
  const within = (use) => {
    const off = new Set();
    for (let i = 0; i < n; i++) if (!use.has(i)) off.add(i);
    return fit.solve(TIE_BREAK, new Map(), off);
  };

  // A: the whole pool, but what the potter said not to use.
  const everything = new Set([...Array(n).keys()].filter((i) => !avoided.has(i)));
  const best = within(everything);
  const threshold = best.miss < GOOD_ENOUGH ? GOOD_ENOUGH : best.miss + SLACK;

  // B: start from what the best match used, and the musts (and, with keepOwn, the recipe's own).
  const used = new Set(
    [...everything].filter((i) => best.x[i] > 1e-9 * fit.size || must.has(i) || (options.keepOwn && own(i)))
  );
  let current = within(used);
  const drop = () => {
    // The removal that matters least, new materials before the recipe's own.
    let choice = null;
    for (const pass of [false, true]) {
      for (const i of used) {
        if (must.has(i) || own(i) !== pass || (pass && options.keepOwn)) continue;
        const without = new Set(used);
        without.delete(i);
        const tried = within(without);
        if (tried.miss <= threshold && (!choice || tried.miss < choice.tried.miss)) choice = { i, tried };
      }
      if (choice) return choice;
    }
    return null;
  };
  for (let step = drop(); step; step = drop()) {
    used.delete(step.i);
    current = step.tried;
  }
  // Swaps: trade a chosen new material for one not chosen, while that improves the match.
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (const i of [...used]) {
      if (must.has(i) || own(i)) continue;
      for (const j of everything) {
        if (used.has(j)) continue;
        const swapped = new Set(used);
        swapped.delete(i);
        swapped.add(j);
        const tried = within(swapped);
        if (tried.miss < current.miss - 1e-9) {
          used.delete(i);
          used.add(j);
          current = tried;
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
  // Closer: add back materials while each is worth it.
  if (options.closer) {
    for (;;) {
      let choice = null;
      for (const j of everything) {
        if (used.has(j)) continue;
        const tried = within(new Set([...used, j]));
        if (current.miss - tried.miss >= WORTH_ADDING && (!choice || tried.miss < choice.tried.miss))
          choice = { j, tried };
      }
      if (!choice) break;
      used.add(choice.j);
      current = choice.tried;
    }
  }
  // The limit on new materials: drop the least useful until it holds, noting the cost.
  let countCost = 0;
  const extrasLimit = Number.isFinite(options.extras) ? options.extras : Infinity;
  const extrasUsed = () => [...used].filter((i) => !own(i) && !must.has(i));
  while (extrasUsed().length > extrasLimit) {
    let choice = null;
    for (const i of extrasUsed()) {
      const without = new Set(used);
      without.delete(i);
      const tried = within(without);
      if (!choice || tried.miss < choice.tried.miss) choice = { i, tried };
    }
    countCost += choice.tried.miss - current.miss;
    used.delete(choice.i);
    current = choice.tried;
  }

  // C: the chosen few, as few amounts changed as possible; each at least its
  // least, and a must at least a token amount, so it stays in.
  const chosen = [...used].sort((p, q) => p - q);
  const mustLeast = (i) => (must.has(i) ? Math.max(Number(lines[i].least) || 0, MUST_SHARE * fit.size) : 0);
  const run = (indexes, leastOf) =>
    fitAmounts(
      indexes.map((i) => ({ ...lines[i], least: Math.max(leastOf(i), mustLeast(i)) })),
      target,
      options
    );
  let result = run(chosen, () => 0);
  // A material under its least: tried at nothing and at its least, keeping the better.
  for (let k = 0; k < chosen.length; k++) {
    const i = chosen[k];
    const least = Number(lines[i].least) || 0;
    const amount = result.amounts[k];
    if (!(least > 0) || amount <= 0 || amount >= least || must.has(i)) continue;
    const without = chosen.filter((j) => j !== i);
    const atNothing = without.length ? run(without, () => 0) : null;
    const atLeast = run(chosen, (j) => (j === i ? least : 0));
    if (atNothing && atNothing.miss <= atLeast.miss) {
      chosen.splice(k, 1);
      result = atNothing;
      k = -1;
    } else {
      result = atLeast;
    }
  }
  const amounts = new Array(n).fill(0);
  chosen.forEach((i, k) => (amounts[i] = result.amounts[k]));
  const columns = lines.map((line) => molesPerGram(line.material));
  return { fit, within, everything, columns, best, chosen, mustLeast, result, amounts, countCost };
};

module.exports = { selectMaterials, unityOf, GOOD_ENOUGH, WORTH_ADDING };
