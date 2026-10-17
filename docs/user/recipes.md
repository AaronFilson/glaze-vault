# Recipes and their chemistry

When your vault is open, your recipes are listed on the left, the recipe you are working on is in
the middle, and its unity formula is on the right. On a narrow window they are stacked instead.

## Writing a recipe

1. Choose **New recipe**.
2. Give it a name.
3. For each material, start typing its name and choose it from the list, then type its amount.
   Amounts can be grams, pounds, parts or percent: the calculation only uses the proportions.
   Decimals can be written `12.5` or `12,5`.
4. **Add material** adds a line, and **×** removes one.
5. Tick **Added** on a line that goes on top of the rest, such as grog, a colorant or a
   suspender: see [Additions](#additions).
6. Add any notes: application, results.
7. Choose **Save**.

### Details

Under the name are details you can fill in or leave empty, in any recipe:

- **Type:** glaze, clay body, slip, engobe, casting slip or terra sigillata.
- **Cone:** one cone, such as `6` or `04`, or a range, such as `9-10`.
- **Atmosphere:** oxidation, neutral, reduction, salt or soda, wood, or raku.
- **Surface** and **Transparency**, and the **Color** in your own words.
- **Tags:** any words you sort recipes by, separated by commas: `production, celadon, R&D`.
- For a glaze or slip, the **Specific gravity** it is mixed to and its **Ford cup #4** seconds. With
  a gravity, the editor says about how much water that takes per 100 g of dry materials, taking
  the materials' density as 2.6 g/cm³. [Firings](firing-log.md) show these beside what was
  measured.

They are kept with each revision, printed with the recipe, and go with it in exports.

### Additions

Clay bodies and many glazes are written as a base that adds up to 100, with some materials
added on top: grog, bentonite, a stain, iron oxide. Tick **Added** on those lines.

- The percentages printed and compared are then of the base, so the base adds up to 100 and the
  additions show as their percentage on top.
- A batch sheet weighs the base to the batch size, and the additions on top of it.
- The unity formula counts every line, additions too, as Insight does.

## Finding a recipe

With more than one recipe, **Search** above the list finds recipes that have every word you
type, in their name, details, tags, materials or notes: `celadon production`, `reduction`,
`^6` or `cone6` for cone 6. **Sort by** orders the list by when each recipe last changed, by
name, or by cone, from the coolest; recipes with no cone come last.

### Materials

The list has Glazecalc's standard library: 167 materials from manufacturers' data sheets (for
example Custer Spar, G-200 EU Feldspar, EPK Kaolin, Alberta Slip and many frits), and theoretical materials such
as *Potash Feldspar*, *Kaolin* and *Whiting*, worked out from their chemical formulas. A
material's other names work too: typing *ABSLIP* finds Alberta Slip.

It also has Glazecalc's colorants, opacifiers and suspenders, such as *Chromium Oxide*, *Rutile*
and *Bentonite*. Add them as lines like any other material, and tick **Added** if they go on top
of the base.

If a theoretical material and a commercial one share a name, the name you type means the
theoretical one; choose the commercial one by its own name.

To use your supplier's analysis, or a material the list does not have, add
[your own material](materials.md). Yours are marked *Your material* in the list, and one with the
same name as a standard material is used instead of it.

## Reading the unity formula

The panel on the right updates as you type:

- **Fluxes (R₂O and RO)**: the oxides that melt the glaze. They add up to 1.000; that is what
  *unity* means.
- **Stabilizers (R₂O₃)**: mostly alumina, which makes the melt stiff enough to stay on the pot.
- **Glass formers (RO₂)**: mostly silica.
- **SiO₂ : Al₂O₃**: the silica to alumina ratio. Higher tends to glossier, lower to matte.
- **Expansion**: calculated thermal expansion, for comparing glazes' fit to a clay body.
- **Loss on ignition**: the share of the raw batch that burns off in the kiln.

Warnings, such as a material's analysis that does not add up to 100%, are listed below. A
material Glaze Vault does not know is named in red instead of a formula. A material with no
oxides, such as CMC gum or a stain with no analysis, is left out of the formula, with a note.

## Saving and revisions

Every save keeps the recipe as it was before, and adds a new **revision**: nothing you save is
ever overwritten. Below the Save button you see when the recipe was saved and its revision
number. If you switch to another recipe or lock the vault with unsaved changes, Glaze Vault asks
first: **Save**, **Discard changes**, or **Keep editing**.

Unsaved changes are kept, encrypted, a second after you stop typing. If the vault
[locks by itself](settings.md#locking-by-itself), Glaze Vault is closed, or the computer stops,
they are back in the editor the next time you unlock, with a note: save them, or choose
**Discard changes**. If they are changes to [a material](materials.md), the note's
**Show them** opens it.

To print a recipe or a batch sheet, see [Printing](printing.md).

### Earlier revisions

Once a recipe has been saved more than once, **Earlier revisions** below the Save button lists
them, with when each was saved. Choose one to see it as it was, with its unity formula; you can
print it too. It cannot be changed.

- **Use this revision** puts it back in the editor. Saving it adds it as the newest revision, so
  the revisions after it are kept too.
- **Back to the newest** returns to the recipe as it is now.

An earlier revision is worked out with [your materials](materials.md) as they are now, so if you
have changed a material since, its unity formula may differ from what it was.

> Coming later: comparing two recipes or two revisions, and deleting a recipe.

## Comparing recipes

**Compare…**, beside Save, puts two recipes side by side: each material as a percent of its
batch, their unity formulas, the SiO₂ : Al₂O₃ ratio, expansion and loss on ignition, with the
change from the first to the second, and their notes if they differ.

It starts with what you are most likely to want:

- with unsaved changes, the recipe as saved, then your changes;
- otherwise the revision before this one, then this one;
- or, for a recipe saved once, this recipe and another.

Change either side's **Recipe** and **Revision** to compare anything else. While you look at an
[earlier revision](#earlier-revisions), **Compare with the newest** compares the two. Choose
**Done** to go back to the editor; nothing is changed.

## Deleting a recipe

Open it and choose **Delete…**, then **Delete**. It moves to **Deleted**, below the list of
recipes, and is kept there until you restore or erase it. Unsaved changes to it are lost.

Under **Deleted**, choose a recipe to see it as it was. Then:

- **Restore** puts it back in the list, with all its revisions.
- **Erase permanently…** removes it and every revision of it from this vault. It cannot be
  brought back. [Backups](backups.md) made before still have it: to be rid of it everywhere,
  make a new backup afterwards and delete the older ones.
