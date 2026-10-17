# Clay bodies: what formulating them needs

Research notes, 2026-10-16, for the recipe fields, firing log and chemistry tools that follow
teams in the plan. Sources are linked; Digitalfire's reference library is the main one. Glazy
figures come from its public data export (CC BY-NC-SA), read for counts only, not imported.

## How bodies are written

- **Materials by job** ([Digitalfire: clay body](https://digitalfire.com/glossary/clay+body)):
  - Ball clay and bentonite give plasticity and dry strength. A plastic body needs about 50%
    clay, or about 40% with bentonite ([plasticity](https://digitalfire.com/glossary/plasticity)).
  - Kaolin gives whiteness and structure; stoneware and fire clays give tooth and workability.
  - Feldspar or nepheline syenite is the flux. Silica is the filler, and raises expansion for
    glaze fit.
  - Grog, sand and molochite give tooth and cut shrinkage. Talc fluxes low-fire and flameware.
  - Bentonite, Macaloid and Veegum plasticize at 2–5%. About 0.35% barium carbonate stops
    scumming from soluble salts
    ([soluble salts](https://digitalfire.com/glossary/soluble+salts)).
- **Typical recipes:**
  - Cone 10 porcelain: kaolin 55, silica 20, feldspar 25, plus 2 plasticizer. Cone 6
    porcelain: 50/20/30.
  - "50/50" porcelain: 25 each of kaolin, ball clay, silica and feldspar. Stoneware: ball clay,
    feldspar and silica, 60:20:20.
  - Sources: [Ceramics Monthly, Porcelain Bodies 201](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Porcelain-Bodies-201),
    [Digitalfire: porcelaineous stoneware](https://digitalfire.com/glossary/porcelaineous+stoneware).
- **Additions on top:** the base adds up to 100 of dry batch, and grog, bentonite, colorants,
  barium, deflocculant and water are listed on top.
  - In Glazy's export, 37% of clay bodies (520 of 1,416) have lines marked as additions.
  - The most common additions are bentonite, grog, Veegum T, molochite, silica sand, red iron
    oxide, barium carbonate, Epsom salts, sodium silicate, water and Darvan.
  - Water for casting is often only in the notes.
- **How bodies differ from glazes:**
  - Far more clay.
  - The forming method (throwing, casting, jigger, press, hand-building) shapes the recipe.
  - A body is judged by measured behaviour across a range of firings, not by one calculated
    melt.

## Chemistry

- **Unity formula:** the Seger unity formula is not the main view. With fluxes set to 1, a
  kaolin-rich body's Al2O3 and SiO2 numbers are inflated, so Digitalfire normalizes clays to
  Al2O3 = 1 instead; the ratios are the same ([article 235](https://digitalfire.com/article/235)).
- **What formulators use:**
  - Oxide weight percent, as on data sheets. Glazy's export gives only this, and leaves the
    unity formula out "as there are differing opinions"
    ([glazy-data](https://github.com/derekphilipau/glazy-data)).
  - KNaO (K2O + Na2O) in mol%: about 4.7 for a Grolleg cone 10 porcelain, about 5.3 at cone 6,
    and 5.6 or more for translucency.
  - SiO2 : Al2O3 of about 4 : 1, molar, for porcelain.
  - Fe2O3 + MgO under 0.30 mol% and TiO2 under 0.10 mol% for white or translucent bodies
    ([Porcelain Bodies 201](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Porcelain-Bodies-201)).
  - Fe2O3 and TiO2 percent as a predictor of fired colour, and the batch's loss on ignition.
- **Calculated expansion misleads for bodies:** it assumes all glass, but bodies keep quartz,
  which expands a lot and inverts at 573 °C. Total SiO2 is not free quartz
  ([Insight FAQ](https://digitalfire.com/insightfaq.php),
  [residual quartz](https://digitalfire.com/glossary/residual+quartz)).
- **Cristobalite** grows from fine quartz in high-silica, low-feldspar stoneware fired slowly. It
  inverts at about 100–270 °C, which dunts ovenware
  ([cristobalite](https://digitalfire.com/glossary/cristobalite)). Neither cristobalite nor free
  silica can be worked out from oxides alone.

## Tests and their numbers

**Shrinkage and absorption bars** ([Digitalfire SHAB test](https://digitalfire.com/test/shab)):
plastic bars marked 100 mm apart. The readings are the dry and fired lengths (mm), the fired
weight, and the weight after boiling for 5 hours and soaking for 19 (g).

| Result | Formula | Typical |
|---|---|---|
| Drying shrinkage | (wet − dry) / wet × 100 | under about 7.5% to avoid cracking ([simple testing](https://digitalfire.com/article/simple+physical+testing+of+clays)) |
| Firing shrinkage | (dry − fired) / dry × 100 | earthenware 3–4%, stoneware 5–6%, whiteware 7–8%, porcelain over 10% ([firing shrinkage](https://digitalfire.com/glossary/firing+shrinkage)) |
| Total shrinkage | (wet − fired) / wet × 100 | stoneware 10–13%, porcelain up to 14–15% |
| Absorption | (boiled − fired) / fired × 100 | see below |

**ASTM C373** (boil method; the current edition is C373-18) also weighs the bar hanging in water,
which gives porosity and density. With D dry, M saturated and S suspended:
V = M − S, absorption = (M − D) / D, apparent porosity = (M − D) / V, bulk density = D / V.
These are the long-standing formulas; check them against the current edition before relying on
them.

**Absorption at maturity** ([vitrification](https://digitalfire.com/glossary/vitrification)):

| Body | Absorption |
|---|---|
| Porcelain | 0.5% or less |
| Functional stoneware | under 2%; coarse ones bottom out at 2–3% before bloating |
| Terra cotta, vitreous at cone 1 | 3–5% |
| Low-fire earthenware | 10–15% or more |

**Other tests:**

| Property | Units, method | Who |
|---|---|---|
| Loss on ignition | % of dry weight; clays 4–8%, kaolin 13–15% ([LDW](https://digitalfire.com/test/ldw)) | both |
| Water content, plastic | (wet − dry) / wet %; throwing bodies about 20–22% | both |
| Water of plasticity | g per 100 g ([WOPL](https://digitalfire.com/test/wopl)) | industry |
| Plasticity | by hand or wheel; Pfefferkorn in labs | studio, by feel |
| Particle size | % retained on 35–325 mesh; % finer than 1 or 2 µm | industry |
| Soluble salts, drying cracks | drying-disk tests | both |
| Fired colour, warping, bloating, blistering | looking, and photos per cone and atmosphere | studio especially |
| Fired strength (MOR) | psi, kgf/cm² or MPa ([MOR](https://digitalfire.com/test/mor)) | industry |
| Thermal expansion | dilatometer, × 10⁻⁶/°C | industry |

Studio potters care most about:
- shrinkage and absorption at each cone
- fired colour
- warping and bloating
- how it throws
- glaze fit

Industry adds:
- strength
- particle size
- measured expansion
- slip rheology
- soluble salts

## Material data

A clay's data sheet (for example [Hyplas 71](https://valentineclays.co.uk/cdn/shop/files/Hyplas_71_Powdered_Ball_Clay_Technical_Data_Sheet.pdf),
[OM-4](https://digitalfire.com/material/om+%234+ball+clay)) gives:
- the oxide analysis and loss on ignition, carbon
- particle size (% coarser than 125 µm, % finer than 5, 2, 1 and 0.5 µm), specific surface
- dry strength, pH, water of plasticity, methylene blue index
- drying shrinkage
- fired shrinkage and absorption at stated cones: OM-4 is 11.3% and 11.1% at cone 5, and 13.6%
  and 4.2% at cone 10
- fired colour

Mineralogy is on industrial sheets but rarely used in studios.

## Slips, engobes and casting

- **Casting slip** ([deflocculation](https://digitalfire.com/glossary/deflocculation)):
  - Specific gravity 1.70–1.80, often 1.75–1.79; water about 28–42% of dry weight.
  - Darvan 7 at about 0.3–0.75% of dry weight, or sodium silicate with soda ash
    ([slip testing](https://ceramicninja.com/test-evaluating-ceramic-slip)).
  - Viscosity as Ford cup #4 seconds (about 40) or by Brookfield; gel checked over time.
- **Engobe** ([engobe](https://digitalfire.com/glossary/engobe)):
  - Its drying and firing shrinkage must match the body's; a two-clay strip shows it.
  - Applied at leather-hard, or with CMC on dry or bisque ware.
  - Specific gravity about 1.45–1.6. Expansion goes glaze < engobe < body.
- These need water per 100 dry, a target specific gravity, deflocculant and flocculant (Epsom
  salts) as additions, measured gravity and viscosity, and the stage applied.

## Sharing formats

- **Insight XML:** marks additions with `added` on each line. Glaze Vault's export writes
  `added="0"` today.
- **Insight-live:** keeps raw bar readings on recipes and charts them, but has no documented
  format for sharing them ([video](https://digitalfire.com/video/entering+testdata+into+insight-live)).
- **Glazy:**
  - Types: Clay Body (Stoneware, Porcelain, Earthenware, Flameware; then Throwing, Slipcasting,
    Hand-building, Sculpture, Raku, Salt), and Slip & Engobe (Slip, Engobe, Terra Sigillata).
  - Fields: a cone range as text ("9 - 10"), surface, transparency and atmospheres.
  - Each line has an `Additional` flag.
  - No shrinkage or absorption fields.
- Test results otherwise travel as spreadsheets.

## What Glaze Vault needs, in order

**Recipe fields** (all optional):
1. An "addition" mark on a line: the base adds to 100 and additions go on top. This is the
   biggest gap, and maps to Insight's `added` and Glazy's `Additional`.
2. Type: glaze, clay body, slip, engobe, casting slip, terra sigillata.
3. For a body: its class (earthenware, stoneware, porcelain, flameware) and forming method,
   following Glazy's types.
4. A cone range and atmosphere.
5. For slips: water per 100 dry, target specific gravity, and the stage an engobe is applied.

**Firing log, per test:**
1. Cone, temperature and atmosphere.
2. Bar readings: mark length (default 100 mm), dry length, fired length, fired weight and
   soaked weight. The suspended weight is optional, for porosity and density.
3. Fired colour and photos; warped, bloated and blistered as checkboxes; notes on glaze fit and
   crazing.
4. For slips: measured specific gravity, viscosity (Ford cup seconds) and gel.

**Calculations:**
1. Shrinkages and absorption from the readings, with porosity and density when there is a
   suspended weight.
2. A vitrification curve: absorption and shrinkage against cone, across the log.
3. For bodies: oxide percent as the main view, and a formula with Al2O3 = 1.
4. KNaO and total flux in mol%, SiO2 : Al2O3, Fe2O3 + TiO2, and loss on ignition.
5. Slip specific gravity and water: SG = (D + W) / (D / 2.6 + W), with 2.6 g/cc as the default
   density of the solids.
6. Expansion for a body only with a note that it leaves residual quartz out.

**Material data:**
1. A class (ball clay, kaolin, fire clay, stoneware clay, feldspar, silica, grog, plasticizer,
   deflocculant and so on).
2. Data-sheet values, all optional: drying shrinkage, fired shrinkage and absorption at a
   stated cone, water of plasticity, % finer than 1 µm or mesh, dry strength.
3. Additions with no chemistry (Darvan, Epsom salts, water) kept out of the oxide totals; the
   kinds of material Glaze Vault already has cover most of this.
4. Mineralogy last, if at all.
