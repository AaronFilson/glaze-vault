# Your own materials

The standard list's analyses are typical ones. Your feldspar, clay or frit comes from one supplier
and one lot, and its data sheet may differ: a material of your own makes every recipe use your
numbers. You can also add a colorant, stain or additive the list does not have.

Your materials are encrypted in your vault like your recipes, and are in your backups.

## Adding a material

1. Choose **Materials** at the top of the window, then **New material**.
2. Give it a name. If it is the same as a standard material's, such as *Custer Spar*, or
   another name one is known by, such as *Quartz* for Silica, your recipes use yours instead
   wherever they use that name; the panel on the right says so. To keep both, give yours another
   name, such as *Custer Spar, lot 7*, and use that name in recipes.
3. Choose its **Kind**: raw material, frit, colorant or stain, or another additive. This only sorts
   the list.
4. Enter the analysis from the data sheet: each oxide and its percent of the raw material, and the
   **Loss on ignition**. **Add oxide** adds a line, and **×** removes one. The **Total** should
   come to about 100. An amount that is not a number, such as *4.5%*, is pointed out on the right,
   and recipes that use the material show it instead of a unity formula.
5. Add notes, such as the supplier, the lot and the data sheet's date.
6. Choose **Save**.

To start from a standard material, type its name under **Start from a standard material** and
choose **Copy its analysis**. Its analysis and kind are copied in, and its name too if yours has
none yet. Then change what your data sheet says differently.

Names are matched ignoring capitals, spaces, punctuation and accents, so *Spar, lot 7* and
*spar lot7* are the same material. Names in other alphabets, such as Cyrillic or Japanese, work
too.

The panel on the right shows the material's own unity formula, warns if the analysis does not
add up to 100, and lists the recipes that use it.

## Colorants and stains with no analysis

A commercial stain's makeup is often secret. Save it with no oxides: recipes can use it, it is
part of the batch when you [print a batch sheet](printing.md), and it is left out of the unity
formula, with a note saying so. The standard CMC gum and silicon carbide work the same way.

## Changing a material

Open it, change it, and save. Like a recipe, every save adds a revision and keeps the one before:
see [earlier revisions](recipes.md#earlier-revisions).

Recipes use a material by its name. If you rename one, recipes that used the old name no longer
find it, and the panel on the right lists them so you can change them.

A recipe's earlier revisions are worked out with your materials as they are now.

## Deleting a material

Delete, restore and erase a material as you would [a recipe](recipes.md#deleting-a-recipe).
Before deleting, Glaze Vault says how many recipes use it. They are not changed: they use the
standard material of the same name instead, if there is one, or show it as unknown, until you
restore it.

> Coming later: importing materials from a file.
