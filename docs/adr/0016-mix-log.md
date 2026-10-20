# 16. The mix log: batches as they were mixed

Proposed, 2026-10-20. Follows the research in
[clay body formulation](../research/clay-body-formulation.md) (items 3 and 9 of section 12).

## Context

A firing could keep the lot of each material (ADR 14, built 2026-10-18), but lots belong to a
batch as it is mixed, and one batch is fired many times. The printed batch sheet had a blank Lot
column to write in, and nowhere to put it back. A casting slip is tuned as it is mixed: water
first, deflocculant added a little at a time, then specific gravity and viscosity read again over
a few days of ageing. None of that had a place either.

The person who weighs a batch is often a batch operator, who reads only batch sheets (ADR 12).

## Decision

- **A mix is a record of its own,** of kind `mix`, in the collection of what was mixed, with
  revisions like any other: readings over days of ageing are later revisions of the same mix.
- **What it holds,** all optional but what was mixed and the day: the dry batch's size and unit;
  the lot of each line weighed, by the order of the lines with an amount (the batch sheet's
  order), without the materials' names; water put in at the start; steps, each with a day,
  deflocculant and water added, specific gravity, Ford cup seconds and gel; and notes. The page
  adds up the deflocculant and water as a share of the dry batch.
- **From a batch sheet or a recipe.** A mix of a batch sheet names the sheet and its revision, the
  recipe and revision the sheet was made from, and the sheet's name. A mix of a recipe without a
  sheet, as in a one-person vault, names the recipe and its revision but not its name.
- **Under the batch key** (ADR 12), so a batch operator reads and logs mixes, and a role that
  reads without chemistry, which holds only the summary key, sees none. Since a batch operator
  reads mixes, a mix says nothing the sheet does not: no material names, and no recipe name for
  a mix made without a sheet.
- **Who logs mixes:** batch operators, testers, formulators and admins; roles admins make, when
  ticked and when they read chemistry. Before, a batch operator changed nothing and a tester only
  firings.
- **Schema 7** changes no table: it marks a vault that may hold mixes, so an older app refuses it
  ("saved by a newer version") instead of failing on a kind it does not know.
- **A firing takes its lots from a mix** of the same recipe revision, mapped from the order of the
  lines weighed to the firing's order (the lines that name a material).
- **Mixes move with their recipe** to another collection, as firings and batch sheets do, and are
  deleted and erased in one step, as firings are.

## Consequences

- Lots are kept twice when a firing takes them from a mix: the firing keeps its own copy, so it
  still reads well when the mix is erased. A firing does not name the mix it came from.
- An operator's mixes of a recipe show under it for whoever reads the recipe, with the materials'
  names in place of the sheet's codes.
- A batch operator sees every mix in their collections, including those a formulator made from a
  recipe without a sheet: lots and readings, but not what the recipe is.
- With the LAN host (ADR 5), mixes sync as batch sheets do: to devices holding the collection's
  key or its batch key.
