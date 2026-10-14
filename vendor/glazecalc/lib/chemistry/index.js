'use strict';

const expansionOf = require('./expansion');
const fit = require('./fit');
const formula = require('./formula');
const lead = require('./lead');
const lsq = require('./lsq');
const select = require('./select');
const oxides = require('./oxides');
const materials = require('./materials');
const umf = require('./umf');
const messages = require('./messages');

module.exports = exports = {
  ATOMIC_WEIGHTS: oxides.ATOMIC_WEIGHTS,
  CONES: lead.CONES,
  EXPANSION: expansionOf.EXPANSION,
  MESSAGES: messages.MESSAGES,
  MOLAR_MASS: oxides.MOLAR_MASS,
  OXIDE_GROUPS: oxides.OXIDE_GROUPS,
  FORMULA_MATERIALS: materials.FORMULA_MATERIALS,
  boronFor: lead.boronFor,
  boundedLeastSquares: lsq.boundedLeastSquares,
  calculateUMF: umf.calculateUMF,
  expansion: expansionOf.expansion,
  bestFit: fit.bestFit,
  fitAmounts: fit.fitAmounts,
  formatFormula: formula.formatFormula,
  formulaToAnalysis: materials.formulaToAnalysis,
  leadFreeTarget: lead.leadFreeTarget,
  materialWeights: materials.materialWeights,
  molesPerGram: fit.molesPerGram,
  oxideMoles: fit.oxideMoles,
  selectMaterials: select.selectMaterials
};
