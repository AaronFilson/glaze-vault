# Copied from Glazecalc

`lib/chemistry/`, `data/` and `LICENSE` are a straight copy from
[AaronFilson/glazecalc](https://github.com/AaronFilson/glazecalc) at commit
`e489b21f43061fb7c0b1d2660654edc10b1ed945` (2026-10-14).

Do not edit them here: fix Glazecalc, then copy the files again and update the commit above.
They will be replaced by a git submodule at this same path once Glazecalc's chemistry settles
([ADR 2](../../docs/adr/0002-chemistry-copy.md), [follow-ups](../../docs/follow-ups.md)).

`data/index.js` needs Mongoose and is not used here; the app reads the `.ndjson` files directly.
