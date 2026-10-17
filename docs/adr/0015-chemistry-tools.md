# 15. Chemistry tools: line blends, limit formulas and costs

Proposed, 2026-10-16.

## Context

With recipes, their chemistry and a firing log in place, the next questions are what lies between
two recipes, whether a recipe's formula is in the range that usually works, and what it costs.
Glazecalc's chemistry (ADR 2) already works out unity formulas for any lines, so these tools are
mostly in the app.

## Decision

- **Line blends** mix two recipes in 3 to 11 steps, each recipe counted as 100 parts, the same
  material in both as one line. Every step shows its parts, unity formula, SiO₂ : Al₂O₃ and
  expansion. A step can be saved as a recipe of its own, and the weights for small test batches
  printed. Nothing about a blend is kept but the recipes saved from it.
- **Limit formulas** are ranges of moles in a unity formula, KNaO counting K₂O and Na₂O together.
  One set is built in, with its source: Digitalfire's cone 6 limit formula, checked against the
  page. Published sets disagree (Hesselberth and Roy's alumina for cone 6 is quoted as both
  0.25–0.35 and 0.25–0.5), so the app ships only what it could check, says each set is a guide
  and not a rule, and lets people make their own: records of kind `limits`, which a team shares
  like recipes. The unity formula can be compared with any set; oxides outside are named, as
  shown to three places.
- **Costs** come from one price list, a record of kind `prices`: a currency as written, a unit
  (kg or lb) and a price per material, matched to recipe lines by name as materials are. A recipe
  shows its cost per unit of dry batch, additions included, and names the materials with no
  price. In a team, whoever may read the list's collection sees prices.
- **Not yet:** working out a recipe from a target formula. Glazecalc's chemistry can fit amounts
  to target oxides (its `fitAmounts`), which this can use later; triaxial blends; and costs on
  printed batch sheets.

## Consequences

- The built-in set is one source's view; the guide says where it is from and to check others.
- A price list is per vault for now: the newest the person can open. Different prices per
  collection, and price histories, wait until someone needs them.
