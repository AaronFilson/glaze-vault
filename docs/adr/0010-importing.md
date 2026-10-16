# 10. Importing recipes and materials, formula materials, and renaming in recipes

Proposed, 2026-10-15. Renaming a material in its recipes replaces that part of
[ADR 8](0008-materials-history-drafts.md).

## Context

People arrive with recipes in other programs and spreadsheets, and with supplier data sheets.
There is no formal standard for glaze recipes. What is shared in practice:

- **Digitalfire Insight XML:** Insight-live exports it and Glazy writes it; the nearest thing to a
  common format for recipes. `<recipe name>` holds `<recipeline material amount unitabbr
  conversion added>`. Glazy also writes materials: `<material>` with `<oxide symbol percent>` and
  a `<volatile symbol="LOI">`. There is no published schema.
- **GlazeChem text** (`.glz` recipes, `.mat` materials): `key = value` lines, still widely shared
  (Linda Arbuckle's databases are the best known). A material's `formula` is a weight-percent
  analysis when it starts with `%`, otherwise a molar formula.
- **Supplier data sheets** have no machine-readable form. When typed into a spreadsheet they are a
  column of names and a column per oxide, which is also what Insight-live's materials CSV takes.
- Glazy's public data dumps (YAML, CC BY-NC-SA) and its JSON API are not import formats yet: the
  API is undocumented, and the dump is a whole library rather than one person's recipes.

## Decision

- **Import reads:** Glaze Vault's JSON export and its recipe and material CSVs; Insight XML
  recipes and Glazy's materials in it; GlazeChem `.glz` and `.mat`; and a materials CSV of names
  and oxide columns (headers matched ignoring case, with `_percent` or `%` after the oxide, an
  optional LOI, kind and notes, comma, semicolon or tab separated). The file is chosen and read by
  the Rust side (at most 50 MB; text that is not UTF-8 is read as Latin-1); the page recognises
  the format by its contents.
- **Nothing is added until the person has seen it.** A preview lists every recipe and material,
  with the notes from reading the file, and for recipes the materials they name that Glaze Vault
  does not have. Each item is imported as a new record by default, except:
  - a name already in use is skipped unless the person chooses to add the item as a new revision
    of theirs, or import it as "name (imported)";
  - a material named like a standard one is skipped unless chosen, since it would replace the
    standard material in every recipe.
- **What cannot be read is reported, not guessed:** an oxide Glaze Vault does not know (Cl₂, LiF,
  KNaO…) is left out with a note, and the material's notes keep the original formula. Insight
  amounts in mixed units are converted with the file's own factors, with a note. Additions become
  ordinary lines: the chemistry is the same.
- **Formula materials:** a material can be given as moles of each oxide, with H₂O, CO₂ and SO₃ for
  what burns off, as Glazecalc's own formula materials are. Its formula weight and loss on
  ignition are worked out. GlazeChem's molar formulas import as these.
- **Renaming a material** that recipes use offers, ticked, to put the new name in them too, each
  as a new revision; a recipe open with unsaved edits keeps them, renamed as well.
- **A vault a restore set aside** can be switched back to from Settings: the open vault locks and
  is set aside in its place.

## Consequences

- Each imported record is its own save. Hundreds take seconds in a release build; a batch command
  can come later if that is too slow.
- Insight material XML from Digitalfire's desktop program (MDT files) is not read: no real file
  was found to check its layout against.
- Glazy's dumps, GlazeMaster, HyperGlaze and Matrix are not read; docs/follow-ups.md lists them.
