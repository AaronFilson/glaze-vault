# 13. Recipe details, additions, and finding recipes

Proposed, 2026-10-16. Follows the research in [clay bodies](../research/clay-bodies.md).

## Context

A recipe so far was a name, lines and notes. Potters and factories sort and choose recipes by
what they are, how they are fired and how they look, and write clay bodies and many glazes as a
base of 100 with materials added on top. Without fields for these, they end up in the notes, where
they cannot be searched or sorted, and a batch sheet weighs additions as part of the base.

## Decision

- **Details are optional fields of the recipe content,** kept in each revision like the name and
  notes: type (glaze, clay body, slip, engobe, casting slip, terra sigillata), cone as text (one
  cone or a range), atmosphere, surface, transparency, colour as free text, and tags. The fixed
  lists follow Glazy's, so imports can match them. Nothing is required, an empty field is left out
  of the content, and a recipe saved before the fields existed is unchanged.
- **The core does not look inside** (ADR 3): details are encrypted with the rest, and searching
  and sorting happen in the app over the recipes it has opened.
- **An addition is a mark on a line.** Percentages are of the base (the lines not marked), so the
  base adds to 100. A batch sheet scales the base to the batch size and weighs the additions on
  top. The unity formula counts every line, as Insight does: what is in the bucket is what melts.
  If every line is marked, there is no base, and all of them are counted as one.
- **Searching** finds recipes with every word typed, in the name, details, tags, materials and
  notes. **Sorting** is by last change, name or cone, with cones below 1 (022 to 01) before cone 1.
- **Formats:** Glaze Vault's JSON and CSV carry the details and additions; Insight XML carries
  additions as `added` and tags as `keywords`; GlazeChem's additions and details are read where
  they match.

## Consequences

- A recipe's cone is text, so "6" and "cone 6" are both kept as typed; sorting reads the first
  number.
- Clay-body fields from the research (body class, forming method, water and specific gravity for
  slips) are left for the firing log and chemistry tools, which use them.
