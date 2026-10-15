# 8. Your own materials, earlier revisions, and drafts that outlast closing

Proposed, 2026-10-15.

## Context

Mined materials vary by supplier and lot, so a recipe calculated with the standard Custer Spar is
only as right as the standard's analysis. Glazecalc's own advice is to enter those from the
supplier's data sheet. Colorants, stains and suspenders were missing from the list too: the
standard additives were not loaded, and a proprietary stain has no published analysis at all.

Every save already kept the revision before it (ADR 5), but nothing showed them.

Unsaved edits were kept only when the vault locked by itself (ADR 7). Closing the window, quitting
or a crash lost them.

## Decision

### Your own materials

- **A material is a record of its own kind** (`material`), stored exactly as a recipe is: an
  encrypted revision chain in the vault's collection, with the kind bound into each revision's
  associated data, so a material's ciphertext cannot be passed off as a recipe. The core's
  record commands take the kind; the core still does not look inside the content.
- **Content:** a name, a kind for sorting (raw material, frit, colorant or stain, other
  additive), the analysis as weight percent of the raw material with its loss on ignition, as a
  data sheet gives it, and notes. Amounts are kept as typed, like a recipe's. A loss on ignition
  that is not a number is a problem to show, not none: Glazecalc would read it as none.
- **A material of your own is found before the standard library.** A name the same as a standard
  material's, or another name it is known by (Quartz for Silica), replaces it in every recipe
  that names it; the editor says so. Names compare as Glazecalc's library does, ignoring case,
  spaces and punctuation, and also accents; unlike Glazecalc, letters in other scripts are kept,
  so names in Cyrillic or Japanese do not all compare as one empty name. Two of your own may not
  share one.
- **Start from a standard material:** its analysis, as weight percent and loss on ignition, and
  its kind are copied in to edit.
- **A material with no oxides counts in the batch and is left out of the unity formula,** with a
  note. That covers a stain with no published analysis, and the standard CMC gum and silicon
  carbide.
- Renaming a material does not rename it in recipes; the editor lists the recipes that use the
  old name.
- **Glazecalc's standard additives are loaded** after the theoretical materials, so an additive
  that shares a theoretical material's name (Tin oxide, Zircon) does not change recipes that
  already use it.
- Exports include your materials: a CSV of their own, and the JSON export's `materials`.

### Earlier revisions

- The editor lists a record's earlier revisions on request. Choosing one shows it read-only, with
  the unity formula and printing as it was. **Use this revision** puts it in the editor as unsaved
  changes; saving adds it as the newest revision. Nothing is overwritten or removed.
- A recipe's earlier revision is calculated with the materials as they are now, not as they were.

### Drafts

- **Unsaved edits are kept as an encrypted draft a second after the last change,** not only on
  locking by itself, so closing, quitting or a crash keeps them too. The draft holds a recipe
  and a material, each with the record and revision it started from, and is cleared as soon as
  nothing is unsaved.
- **On unlocking,** the edits go back on top of the newest revision of their record. A draft that
  is already saved (kept just before a save, with the app closed before it was cleared) is
  dropped, so it cannot be saved twice.
- Draft writes go to the core one after another, so a draft kept just before it was cleared
  cannot come back.
- Locking by hand still asks to save or discard first.

## Consequences

- One storage path serves recipes and materials, so materials get revisions, backups and future
  sync for free.
- Calculating an old recipe revision with today's materials can give a different unity formula
  than it had when saved. Keeping the analysis in each recipe revision would fix that, at the
  cost of recipes no longer following a corrected material; for now the guide says so.
- Records cannot be deleted yet. Deleting a revision chain conflicts with "revisions are only
  added" and with replicas (ADR 5), and a hidden record is not erased, so it needs its own
  decision: see docs/follow-ups.md.
- The draft is written to the encrypted database about once a second while typing, which is
  small next to a save.
