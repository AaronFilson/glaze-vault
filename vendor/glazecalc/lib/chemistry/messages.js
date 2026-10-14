'use strict';

// What the chemistry tells a person: each problem and warning has a code and
// its English, with named values (docs/translating.md). The app shows it in
// the reader's language by its code (client/public/i18n/chemistry/<lang>.json,
// whose English npm run i18n:sources writes from here); elsewhere, and where
// there is no translation, the English is used. Messages are ICU
// MessageFormat, so a literal brace is quoted.

const MESSAGES = {
  // Problems that stop a calculation.
  'unknown-compound': 'Unknown compound {compound} in formula',
  'unknown-oxide': 'Unknown oxide {oxide} in material {material}',
  'invalid-oxide-amount': 'Invalid amount for {oxide} in material {material}',
  'loi-range': 'LOI of {material} must be at least 0 and less than 100',
  'no-oxides': 'Material {material} has no oxides',
  'no-name': 'Material must have a name',
  'no-analysis': 'Material {material} needs a formula or an analysis',
  'recipe-shape': "Recipe must be an array of '{ material, amount }' or a map of amounts",
  'invalid-amount': 'Invalid amount for material {material}',
  'missing-material': 'Recipe line is missing a material',
  'unknown-material': 'Unknown material {material}',
  'no-flux': 'Recipe contains no flux oxides, so the UMF is undefined',
  'no-target': 'The target has no oxides to aim for',
  'no-materials': 'There are no materials to work out',
  'no-temperature': 'The firing temperature is needed to set the boron',
  'no-flux-to-rebuild': 'The glaze has no flux to rebuild',
  'unknown-element': 'Unknown element {element} in {formula}',
  'bad-formula': 'Could not parse formula {formula}',
  // Warnings: the calculation goes on.
  'analysis-total': 'Analysis of {material} totals {total}% including LOI; expected about 100%.',
  'stored-equivalent':
    'The stored equivalent weight of {material} does not match its formula and LOI; the formula and LOI were used instead.',
  'trace-flux': 'Recipe contains only traces of flux oxides, so the UMF is not meaningful.'
};

/** The English of a message with its values in place. Numbers are written to two places. */
const english = function (code, params) {
  return MESSAGES[code]
    .replace(/\{(\w+)\}/g, (whole, name) => {
      const value = params && params[name];
      return typeof value === 'number' ? value.toFixed(2) : String(value);
    })
    .replace(/'(\{[^']*\})'/g, '$1');
};

/** An error that stops a calculation, with its code and values for the app to translate. */
const problem = function (code, params) {
  const error = new Error(english(code, params));
  error.code = code;
  error.params = params || {};
  return error;
};

/** A warning: its English, and its code and values. */
const warning = function (code, params) {
  return { code, params: params || {}, message: english(code, params) };
};

module.exports = { MESSAGES, english, problem, warning };
