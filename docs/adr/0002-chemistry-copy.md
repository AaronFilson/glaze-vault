# 2. Glazecalc's chemistry, copied in until it settles

Proposed, 2026-10-14.

## Context

Glazecalc's `lib/chemistry/` turns a recipe into its unity formula and does the rest of the
arithmetic: analyses from formulas, thermal expansion, suggested amounts, material choice and
replacing lead. It is plain JavaScript (CommonJS) with a hand-written `index.d.ts`, checked
against values worked out by hand, and it depends on nothing outside itself. Its `data/` holds
the standard library of materials and additives. Both are MIT, by the same author.

The chemistry is being expanded in Glazecalc now, so its API will change. Glaze Vault should end
up with one shared copy, but tying the two repositories together while the code moves would cost
more than it saves.

## Decision

- For now, `vendor/glazecalc/lib/chemistry/` and `vendor/glazecalc/data/` are a straight copy of
  Glazecalc's files. `vendor/glazecalc/SOURCE.md` names the commit they came from. They are not
  edited here: a fix goes to Glazecalc first and is copied back.
- The UI imports the chemistry as `@glazecalc/chemistry`, an alias for
  `vendor/glazecalc/lib/chemistry`, typed by its `index.d.ts`.
- **To do later:** once Glazecalc's chemistry has settled, replace the copy with a git submodule
  at the same path, `vendor/glazecalc`, pinned to a tag. Because the paths stay the same, nothing
  that imports the code changes ([follow-ups](../follow-ups.md)).

## Alternatives

- **A submodule now:** the right end state, but every chemistry change in Glazecalc would mean a
  pin to move and an API to catch up with while it is still changing.
- **An npm package (`@glazecalc/chemistry`):** the cleanest end state, with versions and only the
  library. It is worth doing after user acceptance testing.
- **Porting it to Rust:** two implementations to keep in step, against what Glazecalc's ADR 4 set
  out to do.

## Consequences

- The copy drifts from Glazecalc until it is copied again or replaced with the submodule.
- Chemistry runs in the UI, as it does in Glazecalc. The core stores what the UI worked out, and
  checks access to it, but does not recalculate it.
