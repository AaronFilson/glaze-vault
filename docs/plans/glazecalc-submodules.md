# Plan 1: Integrating `glazecalc-core` and `glazecalc-catalog` Submodules

Accepted 2026-11-25.

## Decisions

1. **Mount path:** Mount `https://github.com/AaronFilson/glazecalc-core` at `lib/core` and `https://github.com/AaronFilson/glazecalc-catalog` at `lib/catalog`, matching Glazecalc's `.gitmodules`; remove `vendor/glazecalc/` completely.
2. **Material naming:** Strict match with `@glazecalc/catalog`—no legacy fallback for bare `'Kaolin'` or `'Nepheline Syenite'`. Stoichiometric formulas use their explicit `(theoretical)` names (`'Kaolin (theoretical)'`, `'Potash Feldspar (theoretical)'`, etc.), keeping chemistry resolution identical across Glazecalc and Glaze Vault.

---

## 1. Architecture Overview

Mounting at `lib/core` and `lib/catalog` satisfies `glazecalc-catalog`'s relative `../core/...` boundary (`lib/catalog/test/boundary.test.js` and `lib/catalog/tsconfig.json`) and allows Glaze Vault's submodule-check and worktree scripts to match Glazecalc's verbatim.

- `lib/core` (`@glazecalc/core` `v0.1.0`): nameless, stateless, wordless ESM TypeScript core.
- `lib/catalog` (`@glazecalc/catalog` `v0.1.0`): sourced tables, standard NDJSON records, English wording, and text/paste helpers.
- `ui/chemistryHost.ts`: Glaze Vault's frozen `Host` plus wording helpers (`inWords`, `worded`, `wordedWarnings`) and `traitsOf` reader supporting custom `MaterialContent` classes.
- `ui/chemistry.ts`, `ui/fit.ts`, `ui/choose.ts`, `ui/chooseWorker.ts`, `ui/body.ts`, `ui/compare.ts`, `ui/materialCompare.ts`: migrated from `@glazecalc/chemistry` to `@glazecalc/core` + `@glazecalc/catalog`.

---

## 2. Upstream Changes (`2026-10-14` Snapshot → `v0.1.0`)

1. **Functional `Host` first argument (Glazecalc ADR 31):**
   - `calculateUMF`, `materialWeights`, `formulaToAnalysis`, `molesPerGram`, `oxideMoles`, `fitAmounts`, `bestFit`, and `selectMaterials` take `host: Host` first and keep zero module state, so `ui/chooseWorker.ts` imports `HOST` directly with no per-realm setup.
2. **Codes as API, English in catalog (Glazecalc ADR 30):**
   - `@glazecalc/core` throws `Problem` (`{ code, params }`, `error.message === code`) and returns `warningCodes: Warning[]`.
   - `@glazecalc/catalog/locale` (`inWords`, `worded`, `wordedWarnings`, `english`, `formatFormula`) turns codes into English strings.
3. **Strict disambiguated names & expanded standard library:**
   - Nine stoichiometric entries in `FORMULA_MATERIALS` carry `(theoretical)`: `'Kaolin (theoretical)'`, `'Potash Feldspar (theoretical)'`, `'Soda Feldspar (theoretical)'`, `'Wollastonite (theoretical)'`, `'Alumina (theoretical)'`, `'Tin Oxide (theoretical)'`, `'Red Iron Oxide (theoretical)'`, `'Cobalt Carbonate (theoretical)'`, and `'Copper Carbonate (theoretical)'`.
   - `'Nepheline Syenite'` in `materials.ndjson` is `'Nepheline Syenite (typical)'`; bare `'Kaolin'` and `'Nepheline Syenite'` sit in `GENERIC_NAMES` rather than silently picking one product; bare `'Potash Feldspar'`, `'Soda Feldspar'`, `'Wollastonite'`, `'Alumina'`, `'Tin oxide'`, `'Red iron oxide'`, `'Cobalt carbonate'`, and `'Copper carbonate'` resolve to their commercial records in `data/`.
   - Standard records grew from **167** to **182** materials + **37** additives (219 total; `advice.ndjson` removed), each carrying a fixed `uuid` and `traits`.
4. **Stricter input contract & bounded selection:**
   - `calculateUMF` takes `{ lookup }` rather than `{ materials }`, enforces plain decimal numbers and `'percent' | 'molecular'`, and adds `'colorant-flux'` and `'silica-high'` warnings.
   - `selectMaterials` screens pools `> 60` materials down to `40`, scales its `WORK` budget up to `4×`, and returns `cutShort: boolean`.

---

## 3. Implementation Steps

1. **Mount submodules & guard scripts:**
   - `git rm -r vendor/glazecalc`
   - `git submodule add -b main https://github.com/AaronFilson/glazecalc-core.git lib/core`
   - `git submodule add -b main https://github.com/AaronFilson/glazecalc-catalog.git lib/catalog`
   - Add `scripts/check-submodules.mjs` and `scripts/worktree.mjs`; wire `check-submodules.mjs` into `predev`, `predev:ui`, `prebuild`, `prebuild:ui`, `pretypecheck`, `pretest`, and `pretest:submodules`.
2. **Configure TypeScript 7, Vite 8, and `package.json`:**
   - `tsconfig.json`: add `"noEmit": true` and `"allowImportingTsExtensions": true`, and map `@glazecalc/core` / `@glazecalc/catalog` index subpaths to `./lib/core/...` and `./lib/catalog/...`.
   - `vite.config.ts`: alias `@glazecalc/core` → `./lib/core` and `@glazecalc/catalog` → `./lib/catalog`; drop `optimizeDeps: { include: ['@glazecalc/chemistry'] }`.
   - `package.json`: run `tsc -p lib/core && tsc -p lib/catalog` in `"typecheck"` and add `"test:submodules"` running both submodule `node:test` suites with their coverage gates.
3. **Create `ui/chemistryHost.ts` and migrate `ui/` consumers:**
   - Build frozen `HOST` from `@glazecalc/catalog/host` with Vault-aware `traitsOf`.
   - Migrate `ui/chemistry.ts`, `ui/fit.ts`, `ui/choose.ts`, `ui/chooseWorker.ts`, `ui/body.ts`, `ui/compare.ts`, and `ui/materialCompare.ts`.
4. **Update tests, CI, Dependabot, notices & ADRs:**
   - Update theoretical names in tests where stoichiometric formulas are tested (`'Kaolin (theoretical)'`, `'Potash Feldspar (theoretical)'`, `'Tin Oxide (theoretical)'`, `'Nepheline Syenite (typical)'`) and update standard count (`167` → `182`).
   - Add `submodules: true` to `actions/checkout@v5` in `.github/workflows/ci.yml` and `.github/workflows/release.yml`, run `npm run test:submodules` in CI, add `.github/dependabot.yml` for `gitsubmodule`, include `lib/catalog/NOTICE` attribution, and update `docs/adr/0002-chemistry-copy.md`, `README.md`, and `docs/follow-ups.md`.
