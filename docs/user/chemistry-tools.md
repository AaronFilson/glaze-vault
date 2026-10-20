# Blends, limits and costs

## Line blends

A line blend mixes two recipes in steps, from all of the first to all of the second, to test what
lies between them: a clear and a matte, a glaze with and without a colorant.

1. Open a recipe and choose **Blend…** below it.
2. Choose the **Second recipe**, how many **Steps** (3 to 11), and how much each test weighs.
3. Each column is a step, such as **75 : 25**: three parts of the first recipe to one of the second,
   each recipe's base counted as 100 parts, with its additions on top. Below the parts are each
   step's unity formula, SiO₂ : Al₂O₃ and expansion.
4. **Save 75 : 25** keeps a step as a recipe of its own, named after both, such as
   *Clear 75 · Matte 25*. **Print the weights…** prints a sheet of what to weigh for each test.

## Triaxial blends

A triaxial mixes three recipes over a triangle: each corner is all of one, and every point between
is a mixture, so one set of tiles shows how two changes interact, such as a matte, a clear and a
colorant.

1. Choose **Blend…** below a recipe, then **Triaxial of three**.
2. Choose the **Second recipe** and **Third recipe**, and the **Steps along a side**: 4 makes 15
   tests, 5 makes 21.
3. The triangle numbers each test: 1 is all of the first recipe, at the top; the bottom corners are
   all of the second and of the third. Each column below is a test, with its shares, such as
   *50 : 25 : 25*, its parts, and its unity formula.
4. **Save 7** keeps a test as a recipe, named after the recipes in it, such as
   *Clear 50 · Rutile 50*. **Print the weights…** prints the triangle with what to weigh for each.

### Blends of bodies

When every recipe in a blend is a clay body, slip or other
[body](recipes.md#a-clay-bodys-chemistry), each step is shown as a body instead of by its unity
formula: its oxides as fired weight %, its **Plastic : non-plastic** and **Added silica**, and its
formula with Al₂O₃ = 1 with KNaO. A step saved from bodies of one type is saved as that type.

## Limit formulas

A limit formula is a range of each oxide, in the unity formula, that a kind of glaze usually falls
in. Below a recipe's unity formula, **Compare with** shows where the recipe falls in a set, and
names any oxide **Above** or **Below** its range. KNaO is K₂O and Na₂O together.

Glaze Vault has one set: **Cone 6 (Digitalfire)**, Tony Hansen's
[limit formula](https://digitalfire.com/glossary/limit+formula) for cone 6. Sets are guides from
experience, not rules: published ones disagree, and a good glaze can be outside one.

To make your own, from a book or your own tests, open **Settings** › **Limit formulas**, and choose
**New limit formula**, or **Copy** a built-in set to change it. Give it a name and its source, an
oxide on each line with **At least** and **At most** (either can be empty), and **Save limit
formula**. In a [shared vault](sharing.md) your sets are shared like recipes.

## Fitting a recipe to a formula

**Fit to a formula…**, below the limit formula, works out new amounts for a recipe's materials so
that its unity formula comes as near a target as they allow, changing the recipe as little as
that does.

1. Choose the target: **Move it into a limit formula**, which brings each oxide outside the set
   just inside it, or **A unity formula I give**, which starts from the recipe's own to change.
2. Under **Materials**, clear **May change** for any the fit should leave alone. Additions, such as
   a colorant, are left alone unless you tick them. **Also try** brings in a material the recipe
   does not have, such as Talc for magnesia.
3. **Fit**. The amounts and the unity formula are shown now, as the target, and fitted. If the
   materials cannot reach the limits, it says which oxides are still outside: try another material.
4. **Use these amounts** puts them in the editor as unsaved changes, to look over and **Save** as a
   new revision; **Save as a new recipe** keeps them as *Name, fitted*.

The fit uses Glazecalc's chemistry. It keeps the batch about its size, and leaves out a material it
brings in but does not use.

### Letting it choose materials

Tick **Let it choose other materials too** before **Fit**, and it looks through your raw materials
and frits and the standard ones for the fewest that bring the recipe near the target, up to the
number under **New materials, at most** (3 unless you change it). It never brings in a colorant,
a stain or a material with lead. Choosing takes a few seconds.

The amounts then say **What it is for**: the share of each oxide a material supplies, such as
*most of the B₂O₃*. Below the status, it names materials that could stand in for one it used, and
any oxide of the target that nothing has. **Leave out** beside a material it brought in puts it
under **Not to use**; **Fit** again to choose without it, and **(use again)** to take it back.

## Costs

Open **Settings** › **Prices**. Choose the currency as you write it (`$`, `€`, `SEK`) and whether
prices are per kilogram or per pound, then type each material and what it costs you, dry, and
**Save prices**.

Each recipe then shows, below its unity formula, what a kilogram or pound of its dry batch costs,
additions included. Materials with no price are left out, and named. A printed batch sheet
(**Print…** › **A batch sheet for weighing out**) has a cost column and the batch's total.

In a [shared vault](sharing.md), each collection can have prices of its own: choose it under
**Prices for**. A recipe is costed by its own collection's prices, or, where that has none, by
the newest list you can open. Batch operators do not see prices.
