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
5. Add any notes: firing, application, results.
6. Choose **Save**.

### Materials

The list has Glazecalc's standard library: 167 materials from manufacturers' data sheets (for
example Custer Spar, G-200 EU Feldspar, EPK Kaolin, Alberta Slip and many frits), and theoretical materials such
as *Potash Feldspar*, *Kaolin* and *Whiting*, worked out from their chemical formulas. A
material's other names work too: typing *ABSLIP* finds Alberta Slip.

It also has Glazecalc's colorants, opacifiers and suspenders, such as *Chromium Oxide*, *Rutile*
and *Bentonite*. Add them as lines like any other material: they are part of the batch.

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
