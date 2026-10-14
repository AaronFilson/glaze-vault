'use strict';

const { problem } = require('./messages');
const oxides = require('./oxides');

// Replacing the lead in an old glaze (docs/adr/0011-replacing-lead.md, and the
// research behind it). Nothing lead-free supplies PbO, and no published rule
// converts it mole for mole, so the glaze's flux is rebuilt instead: its silica
// and alumina kept, lead's share of the fluxes handed to soda and potash,
// calcium and a little zinc, strontium or magnesium, and boron set by the
// firing temperature.

/** Orton large cones heated at 60 °C an hour: the temperature each bends at. */
const CONES = [
  { cone: '06', celsius: 999 },
  { cone: '05', celsius: 1046 },
  { cone: '04', celsius: 1060 },
  { cone: '03', celsius: 1101 },
  { cone: '02', celsius: 1120 },
  { cone: '01', celsius: 1137 },
  { cone: '1', celsius: 1154 },
  { cone: '2', celsius: 1162 },
  { cone: '3', celsius: 1168 },
  { cone: '4', celsius: 1186 },
  { cone: '5', celsius: 1196 },
  { cone: '6', celsius: 1222 }
];

/**
 * Matt Katz's rule: at least 0.1 B2O3 in the unity formula for every 50 °C
 * below 1300 °C. About 0.6 at cone 06, 0.48 at cone 04 and 0.4 at cone 03,
 * which agrees with Digitalfire's "0.5 molar parts" at cone 06.
 */
const boronFor = (celsius) => Math.max(0, (1300 - celsius) / 500);

// Lead's share of the fluxes goes first to soda and potash, up to this much of
// them together (more is less durable and crazes), then to calcium up to its
// limit, then to at most a little of each of the others, and any rest to calcium.
const ALKALI_TARGET = 0.3;
const CALCIUM_LIMIT = 0.6;
const LITTLE = 0.1;
// Lead bisilicate has almost no alumina; a lead-free melt that low devitrifies
// or turns milky ("boron blue"), so alumina is kept at least at this: 0.2 at
// low fire, and 0.25 from cone 1 or so, where the published floor is 0.2-0.275.
const LEAST_ALUMINA = 0.2;
const LEAST_ALUMINA_MID_FIRE = 0.25;
const MID_FIRE_FROM = 1150;

/**
 * The lead-free version of a glaze's oxides, to aim the amounts at: the old
 * recipe's oxide moles (oxideMoles) with PbO's share of the fluxes handed to
 * other fluxes, alumina at least 0.2 and boron at least Katz's for the firing.
 * The fluxes keep their total, so the result is on the old recipe's scale.
 *
 *   options.celsius     the firing temperature (see CONES)
 *   options.noZinc      leave zinc out: with chrome (it browns chrome greens and
 *                       spoils chrome-tin pinks), iron or copper (it muddies or
 *                       shifts their colour), or below cone 03, where it hardly melts
 *   options.noMagnesia  leave magnesia out: with chrome-tin pinks, or below cone
 *                       03, where it stiffens and mattes rather than melts
 *   options.noZincOrMagnesia  both, as before
 *   options.noStrontium leave strontium out: when nothing on offer supplies it
 */
const leadFreeTarget = function (moles, options) {
  const celsius = Number(options && options.celsius);
  if (!(celsius > 0)) throw problem('no-temperature');
  const fluxes = Object.keys(moles).reduce((sum, oxide) => {
    const group = oxides.OXIDE_GROUPS[oxide];
    return group === 'R2O' || group === 'RO' ? sum + moles[oxide] : sum;
  }, 0);
  if (!(fluxes > 0)) throw problem('no-flux-to-rebuild');

  const unity = {};
  Object.keys(moles).forEach((oxide) => (unity[oxide] = moles[oxide] / fluxes));
  let lead = unity.PbO || 0;
  delete unity.PbO;
  const give = (oxide, most) => {
    const amount = Math.max(0, Math.min(lead, most - (unity[oxide] || 0)));
    if (amount > 0) unity[oxide] = (unity[oxide] || 0) + amount;
    lead -= amount;
  };

  // Soda and potash, in the proportion the glaze already has them, or half each.
  const k = unity.K2O || 0;
  const na = unity.Na2O || 0;
  const alkali = Math.max(0, Math.min(lead, ALKALI_TARGET - k - na));
  if (alkali > 0) {
    const potash = k + na > 0 ? k / (k + na) : 0.5;
    unity.K2O = k + alkali * potash;
    unity.Na2O = na + alkali * (1 - potash);
    lead -= alkali;
  }
  give('CaO', CALCIUM_LIMIT);
  const noZinc = options.noZinc || options.noZincOrMagnesia;
  const noMagnesia = options.noMagnesia || options.noZincOrMagnesia;
  const left = { ZnO: noZinc, SrO: options.noStrontium, MgO: noMagnesia };
  const others = ['ZnO', 'SrO', 'MgO'].filter((oxide) => !left[oxide]);
  others.forEach((oxide) => give(oxide, (unity[oxide] || 0) + LITTLE));
  give('CaO', Infinity);

  unity.Al2O3 = Math.max(unity.Al2O3 || 0, celsius >= MID_FIRE_FROM ? LEAST_ALUMINA_MID_FIRE : LEAST_ALUMINA);
  unity.B2O3 = Math.max(unity.B2O3 || 0, boronFor(celsius));
  const target = {};
  Object.keys(unity).forEach((oxide) => (target[oxide] = unity[oxide] * fluxes));
  return target;
};

module.exports = { CONES, boronFor, leadFreeTarget };
