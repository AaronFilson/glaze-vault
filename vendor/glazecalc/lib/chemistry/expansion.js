'use strict';

// A glaze's calculated thermal expansion, as Digitalfire's Insight and Glazy
// work it out: each fired oxide's weight percent (volatiles left out, the
// whole normalized to 100) times its coefficient, summed. The result reads as
// x10^-6 per °C, typically 5 to 8. It is for comparing glazes, not a measured
// value; which way it moves is surer than by how much.
//
// Coefficients per weight percent, from Digitalfire's oxide pages
// (https://digitalfire.com/glossary/calculated+thermal+expansion), which Glazy
// uses too (https://help.glazy.org/concepts/analyses). They follow West and
// Gerrow, with Digitalfire's own values for Li2O, MnO, Fe2O3 and SnO2. Oxides
// with no coefficient (cobalt, copper, chrome and other colorants, P2O5) add
// nothing but still count in the total, as in Glazy.
const EXPANSION = {
  Li2O: 0.068,
  Na2O: 0.387,
  K2O: 0.331,
  MgO: 0.026,
  CaO: 0.148,
  SrO: 0.13,
  BaO: 0.129,
  ZnO: 0.094,
  PbO: 0.083,
  MnO: 0.05,
  Al2O3: 0.063,
  B2O3: 0.031,
  Fe2O3: 0.125,
  SiO2: 0.035,
  TiO2: 0.144,
  ZrO2: 0.02,
  SnO2: 0.02
};

/** The calculated expansion of a fired analysis ({ oxide: weight percent }), or null with nothing to go on. */
const expansion = function (analysis) {
  const oxides = Object.keys(analysis || {});
  const total = oxides.reduce((sum, oxide) => sum + (Number(analysis[oxide]) || 0), 0);
  if (!(total > 0)) return null;
  return oxides.reduce(
    (sum, oxide) => sum + ((Number(analysis[oxide]) || 0) / total) * 100 * (EXPANSION[oxide] || 0),
    0
  );
};

module.exports = { EXPANSION, expansion };
