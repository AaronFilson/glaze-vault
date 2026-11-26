# Plan 2: Porting Glaze Vault's Clay Research & Modules into `glazecalc-core` and `glazecalc-catalog`

Accepted 2026-11-25.

## Decisions

1. **Zero-flux body analysis allowed & working:** `@glazecalc/core/body` computes fired oxide wt%, LOI, `Al2O3 = 1` formula, `KNaO` & flux `mol%`, `Fe2O3 + TiO2`, and expansion directly from oxide moles without requiring flux (`fluxMoles === 0` succeeds cleanly for pure kaolins, clay+silica slips, engobes, and refractory washes; Seger `umf` is attached when `fluxMoles > 0` and `null` otherwise).
2. **`Host.bodies` required on `Host` in `0.2.0`:** `readonly bodies: BodyTable` joins `Host` alongside `oxides`, `cones`, `limits`, `stull`, `densities`, `expansion`, and `policy`, with individual functions typed via narrow `Pick<Host, ...>`.
3. **Single `0.2.0` release bundling code + TDS data:** Both the code/tables/checks and the primary-TDS standard clay `sheet` records + body/slip additives (`Darvan 7`, `Darvan 811`, `Sodium Silicate`, `Lignosulfonate (Additive A)`, `Kyanite`, `Pyrophyllite`) ship together in `v0.2.0`.

---

## 1. Boundary Design (Glazecalc ADR 30 & ADR 31)

- **`@glazecalc/core` (`lib/core`):** stateless, nameless, wordless algorithms, unit conversions, trait keys, and coded warnings/problems (`{ code, params }`). Never reads `record.name`, holds no sourced tables, and calls no `Intl` / `formatFormula`.
- **`@glazecalc/catalog` (`lib/catalog`):** sourced reference tables (`BODIES`, `DENSITIES`), `MaterialClass` / `BodyClass` / `Forming` / `FitTest` vocabularies and aliases, standard clay `traits` and primary-source `sheet` data in `data/`, and English strings for every code.
- **Glaze Vault (`ui/`):** encrypted vault record envelopes (`RecipeContent`, `MaterialContent`, `FiringContent`, `MixContent`, `BatchSheetContent`), role/privacy rules (positional `lots` arrays, coded batch sheets), and React screens.

---

## 2. Feature Destination Map

| Clay Research / Glaze Vault Feature | Current Location | Target Destination |
| --- | --- | --- |
| Zero-flux-capable body calculation (`wt%`, `LOI`, `Al2O3 = 1`, `KNaO` & flux `mol%`, `Fe2O3 + TiO2`, expansion, optional `umf`) | `ui/body.ts`, `ui/chemistry.ts` | `@glazecalc/core/body` (`chemistry.ts`) |
| Plastic : non-plastic ratio & added silica % | `ui/body.ts` | `@glazecalc/core/body` (`makeup.ts`) + `@glazecalc/catalog/traits.ts` |
| Water basis conversion (`g/100g dry` ↔ `% wet`) & slip water per 100 g dry / SG inverse | `ui/body.ts`, `ui/slip.ts` | `@glazecalc/core/recipe` (`slurry.ts`) |
| Casting-slip step additions & ageing days | `ui/mix.ts` | `@glazecalc/core/body` (`slip.ts`) |
| SHAB bar shrinkages, boil absorption, ASTM C373 porosity & bulk density, pyroplastic sag | `ui/firing.ts`, `docs/research/clay-bodies.md` §§6–7 | `@glazecalc/core/body` (`bars.ts`) |
| Vitrification curve across cones & target-band firing range | `ui/firing.ts`, `docs/research/clay-bodies.md` §6 | `@glazecalc/core/body` (`vitrification.ts`) |
| Data-sheet & raw-analysis side-by-side comparison | `ui/materialCompare.ts`, `docs/research/clay-body-formulation.md` §7 | `@glazecalc/core/body` (`compare.ts`) |
| Body formulation cautions (porcelain `<20%` silica, drying shrink `>7.5%`, casting slip ratio/bentonite, quartz CTE caveat) | `ui/body.ts`, `ui/screens/AnalysisPanel.tsx`, `docs/research/` | `@glazecalc/core/body` (`checks.ts`) + `@glazecalc/catalog` (`bodies.ts`, `english.ts`) |
| `MaterialClass` taxonomy & solids density resolution (`2.6 g/cm³` fallback + explicit `sheet.density`) | `ui/materialData.ts` | `@glazecalc/core/traits.ts` + `core/recipe/density.ts` + `@glazecalc/catalog/densities.ts` |
| Body classes, forming methods, maturity targets, fit test kinds (`iwct`, `bwiw`, `pressure`, `gbbt`) | `ui/recipeFields.ts`, `ui/firing.ts`, `docs/research/` | `@glazecalc/catalog` (`bodies.ts`) |
| Primary-TDS standard clay `sheet` data + body/slip additives | `docs/research/clay-bodies.md`, `docs/research/clay-body-formulation.md` | `@glazecalc/catalog/data/{materials,additives}.ndjson` |
| Research citations & domain verification notes | `docs/research/` | `@glazecalc/catalog/docs/sources/clay-bodies.md` |

---

## 3. `v0.2.0` Implementation Steps

1. **Extend `Host`, `Traits`, `Slurry`, and `Density` in `glazecalc-core`:**
   - Add `MaterialClass`, `plasticizer`, and `unclassified` to `Traits`; support explicit `DensityTrait.sg` in `materialSg` and add `bodySolidsSg(host, lines, defaultSg = 2.6)`.
   - Add required `readonly bodies: BodyTable` on `Host` with narrow `Pick<Host, ...>` function signatures.
   - Add `waterPer100`, `sgFromWaterPer100`, and `convertWaterBasis` to `recipe/slurry.ts`.
2. **Add `@glazecalc/core/body` (`lib/core/body/index.ts`):**
   - `calculateBody(host, recipe, options)` (succeeds when `fluxMoles === 0`, returning `analysis`, `percent`, `alumina`, `siAlRatio`, `molePercent`, `knaoMol`, `fluxMol`, `ironTitania`, `loi`, `expansion`, optional `umf`/`groups`, and `warningCodes`), plus `bodyChemistry` and `aluminaFormula`.
   - `bodyMakeup`, `bodyPart`, and `isPlasticClass` driven purely by `Traits`.
   - `barResults`, `vitrification`, `insideTargets`, `maturityRange`, `slipMixTotals`, `daysBetween`, `compareSheets`, `sheetCones`, `compareAnalyses`, and `bodyChecks`.
3. **Add `BODIES`, traits, English strings, and primary-TDS data in `glazecalc-catalog`:**
   - Export `BODIES` from `catalog/host/index.ts`; update `densities.ts`, `traits.ts`, and `english.ts`.
   - Populate primary-TDS `sheet` values (`dryingShrinkage`, `waterOfPlasticity`, `finer1um`, `finer2um`, `mesh`, `dryStrength`, `density`, `fired[]`) and `materialClass` on ~20 standard clays in `data/materials.ndjson`.
   - Add `Darvan 7`, `Darvan 811`, `Sodium Silicate`, `Lignosulfonate (Additive A)`, `Kyanite`, and `Pyrophyllite` to `data/`, and archive citations in `docs/sources/clay-bodies.md`.
4. **Tag `v0.2.0` & adopt across both apps:**
   - Pass coverage (`core` ≥99/98/99, `catalog` 100/100/100), `boundary.test.js`, TS 6 & 7, ESLint/Prettier, `outputs.mjs`, and 3-engine equivalence; tag `v0.2.0` on both repos.
   - Advance submodules in `glazecalc` and `glaze-vault`, switch body/slip analysis in Glaze Vault to `calculateBody` (unlocking zero-flux clay/slip/engobe recipes), and thin `ui/body.ts`, `ui/slip.ts`, `ui/materialData.ts`, `ui/materialCompare.ts`, and `ui/firing.ts` into wrappers over `@glazecalc/core/body` and `@glazecalc/catalog`.
