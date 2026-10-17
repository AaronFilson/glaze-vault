# 14. The firing log, and photos kept as attachments

Proposed, 2026-10-16. Follows the research in [clay bodies](../research/clay-bodies.md).

## Context

A recipe is only as good as its last firing. Potters and labs keep test results in notebooks and
spreadsheets: when and how a recipe was fired, what came out, the flaws, a test bar's shrinkage and
absorption, and photos of the tiles. These belong beside the recipe, encrypted like it, and photos
are far larger than anything the vault kept before.

## Decision

- **A firing is a record of its own,** of kind `firing`, in its recipe's collection, with revisions
  like any other. It names the recipe and the revision fired, and keeps the recipe's name then, so
  it still reads well if the recipe is renamed or erased.
- **What it holds,** all optional but the recipe and the date: cone, atmosphere, kiln, peak
  temperature and schedule; surface, transparency, colour and flaws (crazed, shivered, crawled,
  pinholed, blistered, ran, bloated, warped); a test bar's readings; notes; and photos.
- **The bar's readings are kept, the results worked out:** length between marks (100 mm unless
  changed), dry and fired lengths, fired, soaked and suspended weights give drying, firing and total
  shrinkage, absorption, and, with the suspended weight, apparent porosity and bulk density, as
  Digitalfire's SHAB and porosity tests do.
- **Photos are attachments,** in a table of their own (schema 4): each encrypted with its record's
  collection key, bound by associated data to its id, record, kind, collection and media type, and
  never changed. A firing's revisions name its photos with a caption each. A photo left out of a
  later revision stays for the history; erasing the firing removes its photos. Changing a
  collection's key re-encrypts its attachments, one at a time.
- **The page makes photos smaller** before the core keeps them: at most 2,400 pixels across, as
  JPEG, which is plenty to see crazing and a fraction of a camera's file. The file is chosen in a
  native dialog, read by the core and handed to the page as bytes; the page decodes it, which
  reads HEIC on a Mac. Bytes travel as raw IPC bodies, not JSON.
- **Backups stream** (ADR 7, format 2) so a vault of photos is never held in memory.
- **Who:** anyone who may change records in the recipe's collection logs its firings; anyone who
  may read it reads them. A batch operator sees none.

## Consequences

- A vault with many photos grows by a few hundred kilobytes a photo, and so do its backups.
- Firings are deleted and erased in one step, photos and all, so a mistaken photo does not linger.
- Unsaved edits to a firing are kept in the draft with recipes and materials (ADR 8). Locking by
  hand keeps them without asking, since the firing's editor may not be on screen to save from.
- Added after: a vitrification chart (absorption and total shrinkage against cone, averaged per
  cone, on one percent axis, with a table of the same numbers); the slip as applied (specific
  gravity, Ford cup seconds, gel) against a recipe's targets; and the log as CSV.
