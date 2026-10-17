# 15. Chemistry tools: line blends, limit formulas and costs

Proposed, 2026-10-16.

## Context

With recipes, their chemistry and a firing log in place, the next questions are what lies between
two recipes, whether a recipe's formula is in the range that usually works, and what it costs.
Glazecalc's chemistry (ADR 2) already works out unity formulas for any lines, so these tools are
mostly in the app.

## Decision

- **Line blends** mix two recipes in 3 to 11 steps, each recipe's base counted as 100 parts and
  its additions on top, as batches and comparisons count them, the same material in both as one
  line. Every step shows its parts, unity formula, SiO₂ : Al₂O₃ and
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
- **Fitting to a formula** uses Glazecalc's `fitAmounts`: the target, a unity formula, is scaled
  to the recipe's own moles of flux so the batch keeps its size, and the fit changes the amounts
  as little as the match allows. Lines can be held, additions are held unless asked, and
  materials can be brought in to try. Moving into a limit set clamps each oxide just inside its
  range and scales the fluxes not at a bound so they still add up to one; since a fit comes near
  and not exactly, the target is moved further in for any oxide the result is still outside, and
  fitted again, up to six times. What is found goes into the editor as unsaved changes, or is
  saved as a new recipe; nothing is changed by fitting alone.
- Added after: **triaxial blends** of three recipes, over a triangle with 2 to 6 steps along a side,
  numbered row by row from the first recipe's corner, mixed as line blends are; a test is named
  after the recipes with a share in it. And printed batch sheets show each line's cost and the batch's, converting the batch's
  unit to the list's; and each collection can have its own price list, a recipe being costed by
  its collection's list or else the newest the person can open.
- Added after, from [the clay body research](../research/clay-bodies.md): **a body's chemistry.**
  A recipe typed as a clay body, slip, engobe, casting slip or terra sigillata shows fired oxide
  weight percent, a formula with Al₂O₃ = 1, KNaO and all fluxes in mole percent and Fe₂O₃ + TiO₂,
  with a note that calculated expansion leaves free quartz and cristobalite out; its unity
  formula is folded below. A person's materials can have a **class** (ball clay, kaolin, grog
  and so on) and optional **data-sheet values**, kept as text like other fields. A slip's water
  per 100 dry is worked out with its solids' density by volume, each material's from its data
  sheet, its class, a short table of typical standard ones, or 2.6 g/cm³.

## Consequences

- The built-in set is one source's view; the guide says where it is from and to check others.
- Price histories wait until someone needs them; a list's revisions keep its earlier prices.
