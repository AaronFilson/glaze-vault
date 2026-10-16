# Importing recipes and materials

Glaze Vault can add recipes and materials from other programs and from spreadsheets. Open
**Settings**, and under **Import** choose **Import from a file…**.

## What it reads

| File | From | What it holds |
| --- | --- | --- |
| `.json` | A Glaze Vault [export](backups.md#exporting-recipes) | Recipes and materials |
| `.csv` | A Glaze Vault export | Recipes, or materials |
| `.xml` | Insight-live's XML recipe export, or Glazy's Insight XML | Recipes, and Glazy's materials |
| `.glz` | GlazeChem | Recipes |
| `.mat` | GlazeChem | Materials |
| `.csv` | A spreadsheet, such as a supplier's data sheet typed up | Materials |

A spreadsheet of materials needs a column of names and a column for each oxide, headed with its
symbol: `SiO2`, `Al2O3`, `K2O` and so on (`SiO2 %` and `SiO2_percent` work too). A column headed
`LOI` is the loss on ignition, and columns headed `Kind` and `Notes` are read if they are there.
Columns may be separated by commas, semicolons or tabs. For example:

```
Name,LOI,SiO2,Al2O3,K2O,Na2O
"Custer Spar, lot 7",0.3,68.5,17,10,3
```

## Choosing what to import

Nothing is added straight away. Glaze Vault shows everything in the file, and you choose:

- Each recipe and material is imported as a new one, unless you choose **Skip**. **Import all**
  and **Import none** set the ones without a question of their own.
- If you already have a recipe or material of the same name, it is skipped unless you choose
  **Add as a new revision of yours**, which keeps your earlier revisions, or **Import as …
  (imported)**, which adds it under another name.
- A material with the same name as a standard one, such as Silica, is skipped unless you choose to
  import it, because your recipes would then use it instead of the standard one everywhere.
- Recipes that name materials Glaze Vault does not have say **not found** and the names. Import
  them, then add those materials to [your own](materials.md), or change the recipes to standard
  names.
- **Notes on reading the file** lists anything that was left out, such as a part of an analysis
  that is not an oxide Glaze Vault knows (chlorine in a wood ash, for example). The material's notes
  keep its original formula, so nothing is lost.

Choose **Import** to add them. Each is saved as revision 1, encrypted like everything else in your
vault.

GlazeChem materials given as a molar formula, rather than a percent analysis, become
[materials given as a formula](materials.md#a-material-as-a-formula). Insight recipes that mix
units, such as kilograms and grams, are converted with the factors in the file.

To take recipes the other way, to Insight-live or Glazy, use
[Export as Insight XML](backups.md#exporting-recipes).

> Coming later: Digitalfire's material files (MDT) and Glazy's data downloads.
