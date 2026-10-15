'use strict';

const { problem } = require('./messages');

// IUPAC standard atomic weights (abridged), g/mol.
const ATOMIC_WEIGHTS = {
  H: 1.008,
  Li: 6.94,
  B: 10.81,
  C: 12.011,
  O: 15.999,
  Na: 22.99,
  Mg: 24.305,
  Al: 26.982,
  Si: 28.085,
  P: 30.974,
  S: 32.06,
  K: 39.098,
  Ca: 40.078,
  Ti: 47.867,
  V: 50.942,
  Cr: 51.996,
  Mn: 54.938,
  Fe: 55.845,
  Co: 58.933,
  Ni: 58.693,
  Cu: 63.546,
  Zn: 65.38,
  Sr: 87.62,
  Zr: 91.224,
  Sn: 118.71,
  Sb: 121.76,
  Ba: 137.327,
  Ce: 140.116,
  Pr: 140.908,
  Pb: 207.2
};

// Seger / UMF column for each oxide. R2O and RO together are the fluxes
// that the unity formula normalizes to 1.0.
const OXIDE_GROUPS = {
  Li2O: 'R2O',
  Na2O: 'R2O',
  K2O: 'R2O',
  MgO: 'RO',
  CaO: 'RO',
  SrO: 'RO',
  BaO: 'RO',
  ZnO: 'RO',
  PbO: 'RO',
  FeO: 'RO',
  MnO: 'RO',
  CuO: 'RO',
  CoO: 'RO',
  NiO: 'RO',
  Al2O3: 'R2O3',
  B2O3: 'R2O3',
  Fe2O3: 'R2O3',
  Cr2O3: 'R2O3',
  // Colorants and opacifiers, counted when a recipe includes its additives.
  Sb2O3: 'R2O3',
  Pr2O3: 'R2O3',
  SiO2: 'RO2',
  TiO2: 'RO2',
  ZrO2: 'RO2',
  SnO2: 'RO2',
  P2O5: 'RO2',
  V2O5: 'RO2',
  CeO2: 'RO2'
};

// Compounds driven off during firing; they count toward loss on ignition.
const VOLATILES = ['H2O', 'CO2', 'SO3'];

const FLUX_GROUPS = ['R2O', 'RO'];

const molarMass = function (formula) {
  let mass = 0;
  let matched = '';
  formula.replace(/([A-Z][a-z]?)(\d*)/g, (token, element, count) => {
    if (!ATOMIC_WEIGHTS[element]) throw problem('unknown-element', { element, formula });
    mass += ATOMIC_WEIGHTS[element] * (count ? parseInt(count, 10) : 1);
    matched += token;
  });
  if (matched !== formula) throw problem('bad-formula', { formula });
  return mass;
};

const MOLAR_MASS = {};
Object.keys(OXIDE_GROUPS)
  .concat(VOLATILES)
  .forEach((formula) => {
    MOLAR_MASS[formula] = molarMass(formula);
  });

const isOxide = (formula) => Object.hasOwn(OXIDE_GROUPS, formula);
const isVolatile = (formula) => VOLATILES.indexOf(formula) !== -1;
const isFlux = (formula) => FLUX_GROUPS.indexOf(OXIDE_GROUPS[formula]) !== -1;

module.exports = exports = {
  ATOMIC_WEIGHTS,
  FLUX_GROUPS,
  MOLAR_MASS,
  OXIDE_GROUPS,
  VOLATILES,
  isFlux,
  isOxide,
  isVolatile,
  molarMass
};
