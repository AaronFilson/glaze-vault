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

If a theoretical material and a commercial one share a name, the name you type means the
theoretical one; choose the commercial one by its own name.

> Coming later: your own materials, from a chemical formula or a supplier's analysis, and
> colorants and opacifiers on top of a base glaze.

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
material Glaze Vault does not know is named in red instead of a formula.

## Saving and revisions

Every save keeps the recipe as it was before, and adds a new **revision**: nothing you save is
ever overwritten. Below the Save button you see when the recipe was saved and its revision
number. If you switch to another recipe or lock the vault with unsaved changes, Glaze Vault asks
first: **Save**, **Discard changes**, or **Keep editing**.

> Coming later: looking through a recipe's earlier revisions, comparing two recipes, and
> printing a recipe or a batch sheet.
