'use strict';

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

// A chemical formula for display, with its counts as subscripts:
// Ca3(PO4)2 becomes Ca₃(PO₄)₂. Only the digits right after an element or a
// closing bracket are counts. Coefficients and amounts stay as they are, so
// 2CaO•3B2O3 becomes 2CaO•3B₂O₃ and "CaO: 0.304" is unchanged. Text that
// already has subscripts is left as it is.
const formatFormula = function (text) {
  return String(text ?? '').replace(/([A-Za-z)\]])(\d+(?:\.\d+)?)/g, (match, before, count) => {
    return before + count.replace(/\d/g, (digit) => SUBSCRIPT_DIGITS[digit]);
  });
};

module.exports = exports = { formatFormula };
