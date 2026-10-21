# Clay body formulation, for a glaze formulator

Research notes, 2026-10-17. Written for someone who knows glaze chemistry well and has never
built a clay body. The earlier notes, [clay bodies](clay-bodies.md), cover the fields, tests and
calculations the app needs: the SHAB formulas, absorption at maturity per class, ASTM C373, slip
gravity, data-sheet fields and sharing formats. They are not repeated here. This file goes into
the craft and the science.

Digitalfire's reference library is the main source. Ceramics Monthly's Techno File columns and a
few papers and books fill gaps. Where sources disagree, both are given.

## 1. Where glaze habits mislead

Start here. Each of these is a habit that works for glazes and goes wrong for bodies.

- **The unity formula is not the main view.** A glaze is mostly glass at peak, so its oxides
  predict it well. A body is mostly unmelted crystals in a little glass. What matters is which
  minerals are there, how fine they are, and how much of each reacts in the time it has.
  Chemistry is a check, not the design tool
  ([residual quartz](https://digitalfire.com/glossary/residual+quartz)).
- **Silica works the other way.** Adding silica to a glaze lowers its expansion. Adding silica to
  a body raises the body's expansion, because much of it stays as quartz. Both fix crazing
  ([glaze crazing](https://digitalfire.com/trouble/glaze+crazing)).
- **Calculated expansion misses free quartz and cristobalite.** It treats every oxide as glass.
  Two bodies with the same chemistry can expand quite differently
  ([residual quartz](https://digitalfire.com/glossary/residual+quartz)).
- **Same chemistry is not same material.** Swapping one clay for another of similar analysis
  can change plasticity, drying, shrinkage and maturity a lot. Substitution is matched on
  physical tests, not oxides ([Duplicating AP Green Fireclay](https://digitalfire.com/article/duplicating+ap+green+fireclay)).
- **One test tile at one cone is not enough.** A glaze is often judged at its cone. A body is
  judged by curves of absorption and shrinkage over several cones, above and below the target
  ([formulating a porcelain](https://digitalfire.com/article/formulating+a+porcelain)).
- **Heat-work and time matter more.** Bodies are far from equilibrium. A longer soak, a slower
  cool or a refire changes how much quartz dissolves, how much cristobalite grows, and whether
  the body bloats ([bloating](https://digitalfire.com/trouble/bloating),
  [cristobalite](https://digitalfire.com/glossary/cristobalite)).
- **Water matters before firing.** In a glaze, water only sets how it applies. In a body, water
  content sets drying shrinkage and cracking. A soft body that shrinks 6% when stiff can shrink
  7% or more ([drying shrinkage](https://digitalfire.com/glossary/drying+shrinkage)).
- **Small steps.** Glaze line blends often move 10% at a time. Body flux moves in 5% steps, and
  talc in 1% steps: 1% talc can move a body a full cone
  ([talc](https://digitalfire.com/material/talc)).
- **Bigger batches.** 100 g makes a glaze test. A body test wants 1–5 kg, made plastic and
  wedged, so you can make bars, disks and a few thrown pieces
  ([Clay Bodies for Soda](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-clay-bodies-for-soda),
  [Clay Body Building](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Technofile-Clay-Body-Building)).
- **Lots vary more.** Clays are mined, not made. A new load of the same kaolin, or a new seam of
  the same red clay, can behave differently
  ([testing a new load of EPK](https://digitalfire.com/project/testing+a+new+load+of+ep+kaolin),
  [Redart seam change](https://www.theceramicshop.com/product/299/red-art-clay-cedar-heights/)).

What carries over well: the habit of testing in series, changing one thing at a time, keeping
records, and fitting glaze to body by measured expansion rather than hope.

## 2. What a body has to do

A body is a set of trade-offs. Each lever that fixes one property costs another.

### Plasticity and workability, against drying shrinkage and cracking

- Plasticity comes mainly from fine clay particles, and from the kind of clay mineral. Finer
  particles hold more water between them ([plasticity](https://digitalfire.com/glossary/plasticity)).
- That same water leaves on drying. So more plasticity means more drying shrinkage and more
  cracking ([drying shrinkage](https://digitalfire.com/glossary/drying+shrinkage)).
- Numbers:
  - Typical plastic pottery clay shrinks about 6% on drying.
  - About 7.5% is the practical limit before cracks are hard to avoid.
  - Below about 5%, forming gets difficult.
  - A 50:50 bentonite and ball clay mix shrank 14%.
- What helps both: a wide spread of particle sizes. A coarse stoneware at 7% drying shrinkage
  dried without cracking, while a porcelain at 6% cracked at handles. The coarse particles stop
  micro-cracks ([particle size distribution](https://digitalfire.com/glossary/particle+size+distribution)).
- The cost: wide-range grog and sand cut plasticity and dry strength. Narrow-range grog keeps
  more of both ([grog](https://digitalfire.com/glossary/grog)).

### Vitrification and absorption, against warping, slumping and bloating

- Lower absorption needs more glass. Glass comes from flux: feldspar, nepheline, talc, frit,
  iron.
- More glass means the body softens near peak. It warps under its own weight, and it shrinks
  more, which warps more ([warping](https://digitalfire.com/trouble/warping)).
- Warping is mostly about feldspar content. Porcelains warp most. Higher-kaolin bodies resist
  it, helped by mullite needles.
- As the surface seals, gas still leaving the body is trapped. It bloats. Bodies with carbon,
  carbonates or lignite can start bloating while porosity is still 1–2%
  ([bloating](https://digitalfire.com/trouble/bloating)).
- So the target is often not zero absorption. Digitalfire's advice for coarse stoneware is to
  stop at about 1.5–3%, not lower ([vitrification](https://digitalfire.com/glossary/vitrification)).
- A functional body should not claim more than about a two-cone firing range
  ([Clay Body Shopping](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Clay-Body-Shopping)).

### Fired strength

- Strength rises with vitrification, and with interlocking mullite needles in the glass
  ([mullite](https://digitalfire.com/material/mullite)).
- Past maturity, strength falls again: a dense terra cotta bowl fired to cone 02 broke after a
  few taps ([terra cotta](https://digitalfire.com/glossary/terra+cotta)).
- Glaze fit changes strength a lot. A poorly fitting glaze can cut a bar to a third of its
  unglazed strength ([glaze fit and strength](https://digitalfire.com/article/the+effect+of+glaze+fit+on+fired+ware+strength)).

### Thermal shock

- Dense, glassy bodies fail suddenly. Porous, grogged bodies fail slowly, because pores and grog
  stop cracks.
- Digitalfire's flame tests, seconds before cracking
  ([earthenware](https://digitalfire.com/glossary/earthenware),
  [flameware](https://digitalfire.com/glossary/flameware)):
  - Super-vitreous porcelain: about 5 s.
  - Typical porcelain and stoneware: about 10 s.
  - Glazed terra cotta cup at cone 03: 25 s.
  - Grogged talc and ball clay body, 35 mesh grog: 90 s, with a crack near the rim.
- So thermal shock and vitrification pull against each other. Flameware solves this either by
  low expansion or by staying porous (section 4).

### Glaze fit

- The body sets the glaze's compression. Residual quartz is the main source of body expansion
  ([residual quartz](https://digitalfire.com/glossary/residual+quartz)).
- A body with 24% silica fit a glaze that crazed on a 17% silica porcelain. Adding 5% silica to
  the glaze barely moved its calculated expansion ([glaze crazing](https://digitalfire.com/trouble/glaze+crazing)).
- Raising body silica costs plasticity, and needs more feldspar to stay mature. Section 9 has
  the full list of body-side fixes.

### Colour and translucency

- Colour comes from iron and titanium, from the kind of clay, and from atmosphere. Reduction
  turns iron to FeO, a strong flux, so the same body is darker and denser in reduction
  ([black coring](https://digitalfire.com/trouble/black+coring)).
- Translucency needs a lot of glass, very little iron and titanium, and no ball clay. Ball clay
  makes porcelain opaque
  ([Badenhorst, Ceramics Monthly 2016](https://www.aic-iac.org/wp-content/uploads/TechnoFile_PorcelainBadenhorst.pdf)).
- Feldspar sets the trade: 25% gives less warping and less translucency; 35% gives the most
  translucency and the least stability ([formulating a porcelain](https://digitalfire.com/article/formulating+a+porcelain)).
- The chemistry targets for translucency (KNaO mol%, Fe₂O₃ + TiO₂) are in
  [clay bodies](clay-bodies.md#chemistry).

### Summary of the levers

| Lever | Helps | Costs |
|---|---|---|
| More ball clay | plasticity, dry strength | drying shrinkage, cracking, iron, slower casting |
| More kaolin | whiteness, stability against warping | plasticity, more firing shrinkage |
| Bentonite 1–5% | plasticity, dry strength | slow drying, iron, more shrinkage |
| More feldspar or nepheline | lower absorption, translucency | warping, bloating margin, narrower firing range |
| 1–3% talc | a cone of maturity | narrow range; talc supply and health concerns |
| More silica | glaze fit (body expansion) | plasticity; needs more flux; cristobalite and dunting risk |
| Grog or sand | less shrinkage, tooth, thermal shock | plasticity, dry strength, rough surface |
| Finer grinding | fewer specks, less bloating | cost; fine quartz dissolves or turns to cristobalite |

## 3. Materials and their jobs

### Plastic clays

| Clay | What it is | What it gives | Watch for |
|---|---|---|---|
| Ball clay | fine secondary kaolinitic clay, with mica and 10–20% quartz | plasticity, dry strength | carbon, iron, soluble salts, drying cracks |
| Kaolin | coarser, purer kaolinite | whiteness, alumina, stability | low plasticity, high firing shrinkage |
| Fire clay | refractory secondary clay, coarse | tooth, stand-up, resists warping | iron specks, lignite, pinholes |
| Stoneware clay | natural blend of clay, quartz and some flux | the base of many stonewares | varies by seam |
| Red or earthenware clay | iron-rich, often illitic, fluxed | colour, low maturity | soluble salts, bloating if overfired |
| Bentonite | colloidal smectite | plasticity at 2–5% | very slow drying, iron, swelling |

Notes, with numbers:

- **Ball clay** ([ball clay](https://digitalfire.com/material/ball+clay)):
  - Kentucky analysis about SiO₂ 59, Al₂O₃ 25, LOI 12, Fe₂O₃ 1, TiO₂ 1.
  - Tennessee ball clays carry 10–20% mica and quartz. That quartz counts toward glaze fit, so
    a high-ball-clay body needs less added silica.
  - Typical PCE 28–34: not vitreous alone at cone 10.
  - Rarely more than about 30% of a body where colour matters. Stonewares and whitewares often
    use 50% or more.
  - About 5% bentonite gives plasticity and dry strength close to about 25% ball clay.
- **Kaolin** ([EPK](https://digitalfire.com/material/ep+kaolin), [porcelain](https://digitalfire.com/glossary/porcelain)):
  - LOI about 13–14%, about double a ball clay's.
  - EPK: Fe₂O₃ 0.79, TiO₂ 0.37. Grolleg and other porcelain kaolins have TiO₂ near 0.05, which
    is why they fire whiter and more translucent.
  - Kaolin bodies need 2–5% bentonite or another plasticizer to throw.
  - Kaolins differ in built-in flux. Grolleg needs 5–10% less feldspar than an American kaolin
    to reach zero porosity ([warping](https://digitalfire.com/trouble/warping)).
- **Fire clay** ([fireclay](https://digitalfire.com/glossary/fireclay)):
  - High alumina, low flux. Super duty grades have PCE 30 or more and 35%+ Al₂O₃.
  - A good fire clay is 10–12% porous at cone 10R with 3–4% firing shrinkage.
  - Many fire clays are 4–6% porous at cone 10 and need only about 10% feldspar to become a
    stoneware.
  - Fire clays carry coarse quartz, so they are a poor base for low-expansion flameware
    ([flameware](https://digitalfire.com/glossary/flameware)).
- **Stoneware clays** such as Goldart are natural mixes. Their particle range gives good drying.
  Their composition is set by the mine, so they are where discontinuation problems start
  ([Goldart](https://digitalfire.com/material/goldart)).

### Fluxes

- **Feldspar** is the body's melter. Potash feldspar first gives liquid near 1150 ± 20 °C, as
  leucite plus a silica-rich melt
  ([American Mineralogist, 1966](https://msaweb.org/AmMin/AM51/AM51_1793.pdf)). In a body it melts
  sooner with other materials. Sodium feldspars are a little more active
  ([warping](https://digitalfire.com/trouble/warping)).
- **Nepheline syenite** has about 15% flux oxides against about 12% in a typical feldspar, less
  silica and more alumina. It brings no free quartz
  ([nepheline syenite](https://digitalfire.com/material/nepheline+syenite)):
  - Cone 6 vitreous porcelain needs 25–35% nepheline; cone 4 needs up to 50%.
  - It can make deflocculated slips harder to keep stable, and pugged bodies stiffen with age.
- **Talc** ([talc](https://digitalfire.com/material/talc)):
  - At 1–3% in stoneware or porcelain it greatly improves vitrification. 1% can drop a body one
    cone.
  - At 40–60% in low-fire white bodies it raises expansion so glazes do not craze.
  - With kaolin, at high levels and very high temperature, it forms low-expansion cordierite.
  - Asbestos concerns led many North American body makers to drop talc around 2020.
- **Wollastonite** ([wollastonite](https://digitalfire.com/material/wollastonite)):
  - About 10% is common in low-fire earthenware. 2–5% cuts shrinkage in vitreous bodies.
  - Its needles vent gases, and it has no LOI, so it suits fast-fired tile.
  - It can lower expansion and moisture expansion. Above 1100 °C it becomes a strong flux.
- **Frit in bodies** ([fritware](https://digitalfire.com/glossary/fritware), [porcelain](https://digitalfire.com/glossary/porcelain)):
  - Frit replaces part or all of the feldspar to lower maturity. With a high-soda, low-boron frit
    such as Ferro 3110, a porcelain can mature as low as cone 06.
  - About 3% Frit 3110 densified a terra cotta at cone 04–03, but darkened it
    ([terra cotta](https://digitalfire.com/glossary/terra+cotta)).
  - Digitalfire's rule of thumb: frit in place of feldspar at about 10% at cone 10 and 20% at
    cone 6 ([formulating a porcelain](https://digitalfire.com/article/formulating+a+porcelain)).
  - Costs: frits are much dearer, and the bisque must stay low enough not to vitrify
    ([Clay Body Building](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Technofile-Clay-Body-Building)).
- **Iron** is a flux, especially in reduction. More than about 2% added red iron oxide can make
  a body brittle and prone to slumping
  ([Deconstruct a Clay Body](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file--deconstruct-a-clay-body)).

### Fillers and aggregates

- **Silica (quartz)**: filler, and the body's expansion source. Usually 200 mesh in pottery
  bodies; sanitaryware uses 325 mesh and slow cooling to avoid dunting
  ([quartz inversion](https://digitalfire.com/glossary/quartz+inversion)). Porcelains typically
  add 20–30% ([residual quartz](https://digitalfire.com/glossary/residual+quartz)).
- **Grog**: fired, crushed clay ([grog](https://digitalfire.com/glossary/grog)):
  - Throwing bodies: under about 20%.
  - Sculpture: 20–30%, more with a very plastic base.
  - Tile: up to about 50%. Investment-casting bodies: over 90%.
  - Grog cuts shrinkage less than people expect. 10% grog cut drying shrinkage by only
    0.5–0.75% in one stoneware. 20% barely changed fired shrinkage in another.
  - Its real job is tooth, stand-up, faster drying of thick work, and stopping cracks.
- **Molochite**: calcined kaolin, about 95% mullite, white. Grades from 8 to 325 mesh. The
  porcelain grog, and a low-expansion aggregate
  ([molochite](https://digitalfire.com/material/molochite)).
- **Kyanite, pyrophyllite, mullite grog**: used for thermal shock. Pyrophyllite can replace
  silica for thermal shock and fired strength
  ([Clay Body Building](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Technofile-Clay-Body-Building),
  [kyanite](https://digitalfire.com/material/kyanite)).
- **Sand**: smoother and finer than coarse grog, and gives more surface area for re-wetting. In
  soda bodies, 30–60 mesh sand pits the surface; about 1% of 10-mesh sand gives a lively surface
  and 10% a very busy one
  ([Clay Bodies for Soda](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-clay-bodies-for-soda)).

### Plasticizers and small additions

- **Bentonite** ([bentonite](https://digitalfire.com/material/bentonite)):
  - About ten times finer than ball clay. Surface area near 1,000 m²/g.
  - 2% gives a marked gain. Up to 5% is common. Some terra cottas use 5–7.5%.
  - One part plasticizes about ten parts kaolin.
  - 5% bentonite adds about 0.25% iron to a body.
  - Dry-blend it with the other powders; it cannot be mixed into water alone easily.
  - Bodies with it dry slowly and can look dry while still holding water.
- **Macaloid, Veegum T, hectorite**: whiter than bentonite, at 10–20 times the price. 3–4% makes
  a body very plastic. Hectorite burns whiter but is weaker: 50% Hectalite was less plastic than
  25% bentonite ([bentonite](https://digitalfire.com/material/bentonite),
  [plasticity](https://digitalfire.com/glossary/plasticity)).
- **CMC, Additive A (lignosulphonate), vinegar**: organic plasticizers at about 0.1–2%
  ([Deconstruct a Clay Body](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file--deconstruct-a-clay-body)).
- **Epsom salts**: a flocculant, about 0.3% in the mixing water of a plastic body.
- **Barium carbonate**: 0.2–0.5% to lock up soluble sulfates
  ([efflorescence](https://digitalfire.com/glossary/efflorescence)). It is toxic as a powder.

### The plastic to non-plastic ratio

This is the first number a body formulator looks at. It is clay against everything else.

- Casting slips: 50:50, within about five parts either way. Throwing bodies run 60:40 up to
  90:10 ([Casting-Slip Design](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-casting-slip-design)).
- A plastic body needs about 50% clay, or about 40% with bentonite
  ([plasticity](https://digitalfire.com/glossary/plasticity)).
- Thomas Anderson found most stonewares he studied near 80% clay, 10% silica and 10% feldspar
  ([SSA Clay Formulation](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-SSA-Clay-Formulation)).

## 4. Body classes and typical ranges

Approximate cone temperatures: cone 06 about 1000 °C, cone 04 about 1060 °C, cone 6 about
1220 °C, cone 10 about 1285 °C. Absorption at maturity per class is in
[clay bodies](clay-bodies.md#tests-and-their-numbers).

| Class | Cone | Typical make-up | Absorption aimed for |
|---|---|---|---|
| Terra cotta, red earthenware | 06–02 | red clay, some ball clay, maybe frit or talc | 10–12% at cone 04; 6% at cone 02 |
| White earthenware | 06–04 | 40–60% talc, ball clay | 10%+ |
| Mid-fire stoneware | 5–6 | stoneware and fire clays, ball clay, 10–25% flux, silica | 1–3% |
| High-fire stoneware | 9–11 | fire clay, ball clay, kaolin, about 10–20% feldspar | 1–3% |
| Cone 10 porcelain | 9–11 | 50% clay, 25% feldspar, 25% silica | 0–0.5% |
| Cone 6 porcelain | 5–7 | 40–50% kaolin, 30–40% flux, 20% silica | 0–0.5% |
| Flameware | varies | lithium minerals with clay, or porous grogged body | low expansion, or deliberately porous |
| Sculpture, raku | varies | stoneware with 20–30% grog, kyanite | often porous |
| Casting slip | any | 50:50 plastic to non-plastic, deflocculated | as its class |

### Terra cotta and red earthenware

- Normal range cone 06–04. Bisque no hotter than cone 04, to stay porous
  ([terra cotta](https://digitalfire.com/glossary/terra+cotta)).
- One body: 11% porosity and 2% shrinkage at cone 04, about 6% at cone 02, under 4% at cone 2,
  zero at cone 5 but warped.
- Colour runs light red at cone 06, deep red near cone 02, then brown and chocolate when
  overfired.
- Bloating, blistering and warping begin around cone 01; melting by cone 2.
- Firing a bit higher (cone 02–03) gives much more strength and less leaking, if glazes do not
  bubble ([native clays article](https://digitalfire.com/article/formulating+a+body+using+clays+native+to+your+area)).
- Glaze fit is hard because the body is porous and low in expansion. Moisture expansion causes
  delayed crazing (section 9).

### White earthenware and low-fire talc bodies

- 50:50 ball clay and talc was long the hobby casting body at cone 06–04
  ([talc](https://digitalfire.com/material/talc)).
- Talc up to about 60% raises expansion so commercial glazes fit.
- Jonathan Kaplan gives 60 ball clay to 40 talc for a low-fire white casting body
  ([Casting-Slip Design](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-casting-slip-design)).
  The sources differ on 50:50 or 60:40.
- Cristobalite does not form at cone 04 or below, by Ron Roy's account, so the cause of the
  expansion is not fully settled.

### Mid-fire stoneware (cone 5–6)

- Built from a stoneware clay (Goldart), a fire clay (Hawthorn Bond), a little ball clay and
  kaolin, feldspar, silica, and maybe 10% grog
  ([Deconstruct a Clay Body](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file--deconstruct-a-clay-body)):
  - Ball clay over about 20% makes the body gummy and cracks handles.
  - 10% grog cuts fired shrinkage by about 0.75%.
  - Target under 2% absorption.
- Unmodified cone 6 stonewares are often 4–5% porous. 10% or more means a refractory body
  ([vitrification](https://digitalfire.com/glossary/vitrification)).
- Iron-rich mid-fire bodies are the most bloating-prone: one was 1.1% porous at cone 4 and
  bloated badly at cone 6 ([bloating](https://digitalfire.com/trouble/bloating)).
- **Sources disagree on feldspar.** Anderson puts stoneware at 10–13% feldspar
  ([Clay Body Shopping](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Clay-Body-Shopping)).
  The classic stoneware is ball clay, feldspar and silica at 60:20:20 ([clay bodies](clay-bodies.md)).
  Casey Beck's high-alumina soda bodies use about 25% flux
  ([Clay Bodies for Soda](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-clay-bodies-for-soda)).
  They differ because natural stoneware and fire clays already carry flux. Measure, then adjust.

### High-fire stoneware (cone 9–11)

- Fire clays and stoneware clays do much of the work. Some natural stoneware clays already
  over-fire at cone 10 and need refractory material added
  ([warping](https://digitalfire.com/trouble/warping)).
- In reduction, iron becomes a flux, so the same body is denser at cone 10R than at cone 10
  oxidation. One 50:50 kaolin and ball clay body was 5% porous in oxidation and 2% in reduction
  ([ball clay](https://digitalfire.com/material/ball+clay)).
- For soda and wood, the SiO₂ : Al₂O₃ ratio (Al₂O₃ = 1) of the body steers the surface: about
  4–5 for glossy soda; 3–4 for high-alumina bodies that flash; below 3 for stronger flashing.
  A starting split is about 50% plastic clays, 25% flux, 25% fillers
  ([Clay Bodies for Soda](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-clay-bodies-for-soda)).

### Porcelain

- **Cone 10** ([formulating a porcelain](https://digitalfire.com/article/formulating+a+porcelain), [porcelain](https://digitalfire.com/glossary/porcelain)):
  - "Universal 25": ball clay, kaolin, feldspar and silica at 25 each. Plastic, near zero
    porosity, not very white.
  - Whiter: 50% kaolin, 25% feldspar, 25% silica, plus 2–4% plasticizer.
  - Feldspar range 15–30%. 15% pushes maturity to about cone 12.
  - Silica 20–25%. 15% may craze glazes.
  - Use as much kaolin and as little ball clay as possible, and blend more than one kaolin.
- **Cone 6**:
  - About 35% feldspar, and up to 50% with a typical American kaolin.
  - Or 25–35% nepheline syenite.
  - 1–2% talc with 35% feldspar acts like about 50% feldspar
    ([warping](https://digitalfire.com/trouble/warping)).
  - Digitalfire's translucent cone 6 start: 20% silica, 40% feldspar, 40% whitest kaolin, 3–5%
    Veegum.
- **Plasticity**: NZ kaolin bodies needed about 4% bentonite, Grolleg about 3%
  ([Digitalfire](https://digitalfire.com/url/1708)). Macaloid adds less grey than
  bentonite.
- **Fire to the bottom of the curve.** Fire where porosity reaches its minimum and fired
  shrinkage its maximum, or a little past it
  ([maturity](https://digitalfire.com/glossary/maturity)).

### Flameware

There are three different strategies. Sources mix them up, so name which one you mean.

1. **Low expansion from lithium minerals.** Petalite and spodumene have very low expansion.
   Bodies with large amounts survive direct flame. Glaze fit becomes the hard part: almost every
   glaze crazes on them, and you need special low-expansion glazes
   ([flameware](https://digitalfire.com/glossary/flameware),
   [David Pier's flameware body](https://ceramicartsnetwork.org/ceramic-recipes/recipe/Flameware-Clay-Body-143686)).
   Digitalfire warns this needs lab equipment and that firing about 10 degrees too high can
   lose the low expansion.
2. **Cordierite.** Talc and kaolin react to cordierite, but only above about 1300 °C (Digitalfire
   cites cone 14 for a talc body). Bought cordierite can be bonded at lower cones with a frit,
   but is not as good.
3. **Porous and grogged.** This is the cazuela and donabe approach. The body is not low in
   expansion. Pores and coarse grog stop cracks. One talc, ball clay and 35 mesh grog body was
   about 12.5% porous ([grog](https://digitalfire.com/glossary/grog)).

Feldspar works against all three: it dissolves into the glass and raises expansion. Fire clay
brings quartz, which also raises it.

### Sculpture and raku

- Sculpture: 20–30% grog; Digitalfire's vitreous cone 10R sculpture body is 40 ball clay,
  10 kaolin, 20 Redart, 5 quartz and 25 grog of 20×48 mesh ([grog](https://digitalfire.com/glossary/grog)).
- Large work also uses perlite, sawdust or paper to lighten and open the body.
- Raku: usually a white or buff stoneware with extra grog, kyanite or pyrophyllite. **Sources
  differ on kyanite**: up to 20%, in Watershed Ceramics' raku tutorial (its
  [PDF link](https://www.watershedceramics.org/wp-content/uploads/2020/12/Raku-Tutorial.pdf) no
  longer loads), against up to 30%, with 35–48 mesh preferred
  ([kyanite](https://digitalfire.com/material/kyanite)). Watershed also advises against
  earthenware for raku.
- These bodies are fired far below their maturity, so they stay porous. That is the point: an
  open body survives the shock of pulling it hot.

### Casting slips

- See section 8. The body is the same class as its plastic cousin, re-balanced to 50:50 plastic
  to non-plastic, and with little or no bentonite (at most about 1%)
  ([casting slip](https://digitalfire.com/glossary/casting+slip)).
- Digitalfire's L4807 cone 6 whiteware casting body: 30 OptiKast kaolin, 25 silica, 20 KT1-4
  ball clay, 25 nepheline syenite, 0.5 talc.

### Paper clay

- Paper pulp added to a slip. Rosette Gault suggests 20–50% pulp **by volume**, and 30–35% to
  start ([Gault, Ceramics Monthly 1992](https://grahamhay.com.au/gault1992cm.html)).
- More pulp gives a lighter, more porous fired body and raises maturity.
- Add wet pulp to a slip rather than wedging it into plastic clay.
- Strength falls with fibre. One Finnish study measured bending strength down 17% at 2% fibre and
  60% at 10%, by weight ([Juvonen 1997](https://www.grahamhay.com.au/juvonen1997.html)).
- Volume and weight figures are not interchangeable, and sources mix them. Record which.
- The point is green strength and joining dry to wet, not fired properties.

### Terra sigillata

- The finest fraction of a deflocculated clay slurry, burnished on to a body.
- About 0.5% deflocculant (sodium silicate with soda ash), on the dry clay
  ([Ceramic Arts Network sig recipes](https://ceramicartsnetwork.org/docs/default-source/uploadedfiles/wp-content/uploads/2015/06/terrasigilatta-ja15recipes.pdf)).
- Settle 12–24 hours, then siphon. **Sources differ on what to keep**: the middle layer
  ([Pinnell](https://ceramicartsnetwork.org/ceramic-recipes/recipe/pete-pinnells-real-authentic-lip-smackin-smooth-easy-terra-sigillata-2135c766-2b39-4c80-92e2-3189a1a7a949)),
  the top half, or the top two thirds for ball clays
  ([How to Siphon Terra Sigillata](https://ceramicartsnetwork.org/daily/article/How-to-Siphon-Terra-Sigillata)).
- Specific gravity about 1.1–1.2, often 1.15 for ball clays. Evaporate it down if thinner.
- It must shrink with the body, like an engobe.

## 5. Particle size and plasticity

### What the measurements tell you

- **% finer than 1 µm** is the best single predictor of plasticity, drying shrinkage and dry
  strength within one kind of clay. It is not a fair comparison across kinds: milling a kaolin
  to bentonite size does not make it as plastic as bentonite
  ([plasticity](https://digitalfire.com/glossary/plasticity)).
  - OM-4 ball clay: 57% finer than 1 µm ([OM-4](https://digitalfire.com/material/om+%234+ball+clay)).
  - Other Tennessee and Kentucky ball clays: 46–60% finer than 1 µm
    ([KTS-2](https://digitalfire.com/material/kts-2+ball+clay),
    [TB-1](https://digitalfire.com/material/tb-1+ball+clay),
    [S-3](https://digitalfire.com/material/s-3+ball+clay)).
  - Grolleg kaolin: 58% finer than **2** µm
    ([Grolleg data sheet](https://valentineclays.co.uk/cdn/shop/files/Grolleg_China_Clay_Powdered_Technical_Data_Sheet.pdf)).
    Data sheets choose different cut points, so check which one before comparing.
- **Water of plasticity** is the water needed to make a clay workable
  ([WOPL](https://digitalfire.com/test/wopl)).
  - It correlates poorly with plasticity felt by hand.
  - **The two common bases differ.** Hansen gives throwing bodies about 20–22% water, as a
    share of the wet clay. Anderson gives 26–30 g per 100 g dry for low-plasticity bodies, 31–35
    for medium and 35–38 for high, as a share of the dry
    ([Clay Body Shopping](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Clay-Body-Shopping)).
    21% of wet weight is 26.6 g per 100 g dry, so they roughly agree once converted.
- **Mesh analysis** is the coarse end: % retained on sieves.
  - 60 mesh is about 250 µm, 100 mesh 149 µm, 200 mesh 74 µm, 325 mesh 44 µm.
  - "200 mesh" materials still leave oversize. 100 g of a commercial ball clay left 1.5 g on
    79–200 mesh screens, within spec, and still specked
    ([particle size distribution](https://digitalfire.com/glossary/particle+size+distribution)).
  - Residue on 100 and 200 mesh predicts specks, pinholes and bloating. Terra cotta ground to
    42 mesh bubbled much more than at 200 mesh.
- **Dry strength (dry MOR)** says how well greenware survives handling and trimming.
  - OM-4: 610 psi (4.2 MPa), tested as 50:50 with silica.
  - Grolleg: 25.7 kgf/cm² (about 365 psi) dried at 110 °C, and 10 kgf/cm² at 80% humidity
    ([Grolleg](https://valentineclays.co.uk/cdn/shop/files/Grolleg_China_Clay_Powdered_Technical_Data_Sheet.pdf)).
  - Numbers only compare when the mix, conditioning and bar shape match. Record those with the
    number.
- **Specific surface area** combines size and platelet thickness. Anderson argues it beats mesh
  for packing and uses a relative index of about 17–28
  ([SSA Clay Formulation](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-SSA-Clay-Formulation)).
  His index is not the m²/g on data sheets; treat it as one author's method.

### Packing

- A wide range of sizes packs densest, dries fastest and cracks least, but is less plastic
  ([particle size distribution](https://digitalfire.com/glossary/particle+size+distribution)).
- A narrow range is more plastic and stronger dry, but packs loosely and shrinks more.
- Fine fractions fill the gaps between coarse ones. The more 20–80 mesh material a body has, the
  finer its clays need to be (Anderson).

### Drying physics

- Early drying removes the water between particles. The particles move together and the body
  shrinks. Later drying empties pores without more shrinkage.
- The point where shrinkage stops is near leather-hard. **Sources disagree on where**: about
  12–14% moisture ([Valentine Clays](https://valentineclays.co.uk/pages/shrinkage-rates)) or about
  20% (Norton, cited in [a Missouri S&T thesis](https://scholarsmine.mst.edu/masters_theses/5523)).
  It depends on the clay.
- Cracks come from uneven water content once the piece is rigid: a thin rim drying ahead of a
  thick base. That is why the DFAC disk test covers its centre
  ([DFAC](https://digitalfire.com/test/dfac)).
- Total shrinkage is not drying plus firing. 6.25% drying and 6.66% firing give 12.5% total,
  not 12.9% ([drying shrinkage](https://digitalfire.com/glossary/drying+shrinkage)).

## 6. Firing chemistry and physics

### The sequence

Temperatures are approximate and shift with heating rate and impurities.

| °C | What happens | Why a formulator cares |
|---|---|---|
| to about 200 | pore water leaves ("water smoking") | steam cracks thick or bentonite-rich ware |
| about 450–650 | kaolinite loses its OH water (dehydroxylation) | kaolin LOI 13–14%; ware is fragile, no shrinkage yet |
| 300–900 | organic carbon burns, most critically 700–900 | black coring and bloating if not finished |
| 573 | quartz inversion, both ways | dunting on cooling; sharp on refire |
| 700–1000 | carbonates release CO₂; sulfates later | pinholes, blisters, bloating |
| 950–1050 | metakaolin becomes a spinel phase | the start of mullite |
| from about 1000 | primary mullite from the clay | strength, stability |
| from about 1150 | feldspar melts; glass dissolves clay and quartz | shrinkage and vitrification take off |
| 1200 and up | secondary mullite needles grow in the glass | strength, warping resistance |
| above 1100, slow cooling | quartz and silica can become cristobalite | dunting near 200–270 °C later |

Sources: [what happens in a firing](https://digitalfire.com/article/firing:+what+happens+to+ceramic+ware+in+a+firing+kiln),
[mullite](https://digitalfire.com/material/mullite),
[calcium carbonate decomposition](https://digitalfire.com/temperature/18),
[carbon burnout](https://digitalfire.com/glossary/carbon+burnout),
[cristobalite](https://digitalfire.com/glossary/cristobalite).

### Dehydroxylation

- Kaolinite, Al₂O₃·2SiO₂·2H₂O, gives up its chemical water and becomes amorphous metakaolin.
- This water is most of a clay's LOI. It leaves well after the ware looks dry.
- The body does not shrink here. It is weakest here.

### Quartz inversion and cristobalite

- **Quartz** flips between alpha and beta near 573 °C, most sharply in a 50 °C band. Digitalfire
  puts the particle's expansion at about 1%
  ([what happens in a firing](https://digitalfire.com/article/firing:+what+happens+to+ceramic+ware+in+a+firing+kiln)).
  - Large free quartz particles and uneven heat crack ware here.
  - Risk rises on refires, because the denser body grips the quartz harder
    ([quartz inversion](https://digitalfire.com/glossary/quartz+inversion)).
- **Cristobalite** grows from quartz, and from the silica freed as mullite forms, above about
  1100 °C ([cristobalite](https://digitalfire.com/glossary/cristobalite)):
  - Most in high-quartz, low-feldspar bodies cooled slowly through 1500–800 °C.
  - Fine quartz converts more readily. Long soaks and refires grow more.
  - It inverts at about 200–270 °C (Digitalfire also gives 226 °C) with a volume change of about
    2.5%.
  - Vitrified or low-silica bodies fired fast grow least.
- **It cuts both ways.** In earthenware, a little cristobalite squeezes the glaze and stops
  crazing. In stoneware ovenware heated past about 200 °C, its jump cracks pots
  ([Glaze Fit and Fault](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-glaze-fit-and-fault),
  [Techno File: Cristobalite](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Cristobalite)).
  **Sources disagree here:** Ron Roy, quoted by Digitalfire, says cristobalite does not form at
  cone 04 or below, and Digitalfire says terra cotta should not be affected
  ([talc](https://digitalfire.com/material/talc), [cristobalite](https://digitalfire.com/glossary/cristobalite)).
  The squeeze may belong to earthenware fired higher, or to bodies with talc; test with a
  dilatometer rather than assume it.
- **The quartz grain size trade-off:**
  - Coarse quartz survives firing, raises expansion and fits glazes, but can dunt.
  - Fine quartz dissolves into the glass, lowering expansion, or turns to cristobalite.
  - Refiring dissolves more, so a glaze that fit after one firing can craze after decals
    ([residual quartz](https://digitalfire.com/glossary/residual+quartz)).

### Mullite

- Mullite is 3Al₂O₃·2SiO₂. It forms as kaolinite breaks down and is never pure: forming it frees
  silica ([mullite](https://digitalfire.com/material/mullite)).
- Materials-science papers name two kinds: primary mullite in the old clay grains, and secondary
  mullite as needles growing into the feldspar glass at higher temperature. Carty and Senapati's
  review is the standard account
  ([Porcelain: raw materials, processing, phase evolution, and mechanical behavior, 1998](https://doi.org/10.1111/j.1151-2916.1998.tb02290.x)).
- The needles reinforce the glass, much like fibres. They give porcelain and stoneware much of
  their strength, and help high-kaolin bodies resist warping
  ([warping](https://digitalfire.com/trouble/warping)).

### The glassy phase

- Feldspar melts and starts dissolving metakaolin and fine quartz. This is liquid-phase
  sintering: the melt pulls particles together and fills pores.
- As it dissolves alumina and silica, the melt gets stiffer, and needs more heat to go on.
  That is why a body has a range rather than a melting point.
- More glass means lower absorption, more shrinkage, more translucency, and more slumping.
- Iron in reduction (FeO) joins the glass. That is why reduction bodies mature lower and black
  core when sealed too soon.

### The vitrification range

- Plot absorption and fired shrinkage against cone. Absorption falls and shrinkage rises.
- Maturity is where absorption bottoms out and shrinkage peaks. Past it, gas bloats the body:
  absorption may rise again and shrinkage falls as the bar swells
  ([maturity](https://digitalfire.com/glossary/maturity), [bloating](https://digitalfire.com/trouble/bloating)).
- **The range** is the span of cones where absorption is low enough and the body has not
  yet warped or bloated. A wide, flat bottom is forgiving. A steep one means kiln variation
  shows.
- Flux moves the curves left; refractory material moves them right. Talc makes them steeper.
- The firing schedule moves them too: a slow firing or a soak counts as more heat-work.
- Glaze Vault already draws this chart from the firing log
  ([firing log](../user/firing-log.md#vitrification)).

### Why a body's chemistry predicts less than a glaze's

1. **Not all of it melts.** Quartz, mullite and grog stay as crystals. Expansion depends on how
   much quartz is left, which depends on grain size, time and flux
   ([residual quartz](https://digitalfire.com/glossary/residual+quartz)).
2. **Minerals matter, not just oxides.** Kaolinite, illite, smectite and mica give the same
   oxides in different amounts of plasticity, drying and melting.
3. **Particle size controls reaction rate.** The same feldspar at 200 and 400 mesh can mature a
   body differently; the same quartz dissolves or survives depending on size.
4. **The body is never at equilibrium.** Time and schedule matter: a soak, a refire, a slow cool.
5. **Gas and carbon are not in the analysis.** LOI tells you how much leaves, not when. Carbon,
   sulfates and carbonates cause bloating and black coring that oxides cannot predict.
6. **Atmosphere changes the flux.** Iron is a weak flux in oxidation and a strong one in
   reduction.
7. **Forming changes the result.** Particle orientation from throwing, pressing or casting
   changes shrinkage and warping ([warping](https://digitalfire.com/trouble/warping)).

What chemistry is still good for: comparing two bodies of the same kind; spotting a high Fe₂O₃
or TiO₂ before you fire; checking total flux and KNaO; tracking SiO₂ : Al₂O₃ for soda and wood;
and checking a substitute's analysis is in the same family. See
[clay bodies](clay-bodies.md#chemistry) for the numbers.

## 7. How formulators actually work

### Start from a known recipe

- Almost nobody starts from a blank page. Start from a published body of the right class and
  cone, or a supplier's body you like.
- Then change one thing at a time toward your goal: absorption, shrinkage, colour, plasticity,
  glaze fit.
- Digitalfire's porcelain method ([formulating a porcelain](https://digitalfire.com/article/formulating+a+porcelain)):
  1. Set the goal: translucent, casting or plastic, and the cone.
  2. Start from a base recipe.
  3. Mix well: blender, or slurry and dry on plaster.
  4. Make bars and drying disks.
  5. Fire across several cones. Measure absorption, shrinkage and strength.
  6. Adjust maturity with feldspar, against clay.
  7. Adjust plasticity with 1–3% bentonite. Check drying.
  8. Check glaze fit; adjust silica.
  9. Check warping.
  10. Repeat.
- Kaplan's version: dry-mix 10 lb of each test body, slake, pass through 60 mesh and note the
  residue, dry on plaster, wedge, make bars, and throw rings, bowls and plates for glaze tests.
  Then freeze-thaw, lemon and dishwasher tests
  ([Clay Body Building](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Technofile-Clay-Body-Building)).

### Substituting a discontinued clay

This is where most studio formulation starts. A clay changes seam or closes.

- Match the physical properties, not the chemistry: maturity, drying, plasticity, texture,
  fired colour, expansion
  ([AP Green Fireclay](https://digitalfire.com/article/duplicating+ap+green+fireclay)).
- The method Digitalfire used for AP Green Fireclay and Newman Red
  ([Newman Red](https://digitalfire.com/material/newman+red+clay)):
  1. Characterize the old clay alone: SHAB bars over a range of cones, drying disks, sieve
     residue, colour.
  2. Blend candidates (often a fire clay or ball clay with a kaolin and a flux) to match.
  3. Put the candidate into a real body at 50%, in place of the old clay, and the old clay into
     the same body. Fire side by side.
  4. Compare absorption and fired shrinkage across cones, drying shrinkage and performance,
     particle size, colour.
  5. Expect a series of tests to re-balance the recipe.
- A quick throwing check: roll cigar shapes of each and time how long until a bend splits.
- A change of seam counts too. Cedar Heights warned the new Redart is denser, less plastic,
  more refractory and lighter firing
  ([Redart](https://www.theceramicshop.com/product/299/red-art-clay-cedar-heights/)).
- Test each new load of a critical clay the same way
  ([testing a new load of EPK](https://digitalfire.com/project/testing+a+new+load+of+ep+kaolin)).

### Adjusting to a target absorption or shrinkage

- **Too porous:** add feldspar 5% at a time and take the same from the clay
  ([stoneware casting bodies](https://digitalfire.com/article/stoneware+casting+body+recipes)).
  Or add 1–2% talc. Or swap feldspar for nepheline. At low fire, a few % frit.
- **Too dense, warping or bloating:** the reverse: less feldspar, more kaolin, or fire lower.
  Stop at 1.5–3% for coarse or iron-rich stoneware.
- **Shrinks too much:** less ball clay and bentonite, more kaolin or a coarser clay, or add
  grog or silica. Expect less plasticity.
- **Crazes glazes:** more silica (200 mesh) in place of some kaolin, then more flux to keep it
  mature. Or fire the body more mature.
- Worked example from a native terra cotta: cone 04 was 11% porous; cone 02 was 6% with few
  glaze bubbles; cone 2 was under 4% but darker; cone 5 was zero but warped. Cone 02 was the
  choice ([native clays](https://digitalfire.com/article/formulating+a+body+using+clays+native+to+your+area)).
- Another: a stoneware at 10%+ porosity at cone 6. 5% Gerstley Borate took it to 6.5%; 15% of a
  low-fire clay took it to 2.7%, too dense and dark. About 10% was the call
  ([vitrification](https://digitalfire.com/glossary/vitrification)).

### Line blends for bodies

- Blend in 5% or 10% steps between two bodies, or swap one clay or feldspar for another, or
  pyrophyllite for silica
  ([Clay Bodies for Soda](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-clay-bodies-for-soda)).
- Fire every step at three to five cones around the target. The cone axis matters as much as
  the blend axis.
- Make the dry batch big enough for bars, a disk and one or two pieces: 1–5 kg.
- Two clays line-blended can land somewhere neither reaches alone, such as a low-plasticity and
  a hyper-plastic clay mixed to reach stoneware density at cone 02
  ([native clays](https://digitalfire.com/article/formulating+a+body+using+clays+native+to+your+area)).

### Tests for bodies

| Test | What it shows | Source |
|---|---|---|
| Shrinkage and absorption bars (SHAB) | maturity curves | [SHAB](https://digitalfire.com/test/shab); formulas in [clay bodies](clay-bodies.md#tests-and-their-numbers) |
| Drying disk (DFAC) | drying cracks, soluble salts | [DFAC](https://digitalfire.com/test/dfac) |
| Sieve residue | specks, bloating risk, grit | [particle size distribution](https://digitalfire.com/glossary/particle+size+distribution) |
| Pyroplastic bar (warp, slump) | softening at peak | [warping](https://digitalfire.com/trouble/warping) |
| Flame or quench test | thermal shock | [flameware](https://digitalfire.com/glossary/flameware) |
| 300 °F to ice water (IWCT) | glaze fit, crazing | [IWCT](https://digitalfire.com/test/iwct) |
| Boiling to ice water (BWIW) | glaze fit, both ways | [BWIW](https://digitalfire.com/test/bwiw) |
| Glaze inside only, break with hammer | too much glaze compression | [glaze fit and strength](https://digitalfire.com/article/the+effect+of+glaze+fit+on+fired+ware+strength) |
| Glaze-body bond (GBBT) | bond at the interface | [GBBT](https://digitalfire.com/test/gbbt) |
| Pressure cooker or autoclave | moisture expansion, delayed crazing | [glaze crazing](https://digitalfire.com/trouble/glaze+crazing) |
| Freeze-thaw, lemon, dishwasher | outdoor and kitchen use | [Clay Body Building](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Technofile-Clay-Body-Building) |
| Fired strength (MOR) | strength | [MOR](https://digitalfire.com/test/mor) |
| Dilatometer or DTA | expansion curve, inversions | lab service |

Notes:

- **Pyroplastic bar:** measure how far the dry bar is from straight. Fire it spanned, hump up.
  Add the fired sag to the dry bow; the sum is the deformation. Compare bodies fired side by
  side. Digitalfire does not give a standard span, so record yours.
- **IWCT:** tiles 3/8 in thick, 2 × 3 in, held at 300 °F for 30 minutes, plunged in stirred ice
  water for 5 minutes, checked with marker, and again the next day. One cycle per tile. 325 or
  350 °F for more stress.
- **Flame test:** a torch on one spot, in seconds to failure. Pier heats to red, then drops it in
  water ([Pier](https://ceramicartsnetwork.org/ceramic-recipes/recipe/Flameware-Clay-Body-143686)).

### How many tests, and what to record

- One Digitalfire series: 9 mixes, 5 temperatures, 45 bars, 180 measurements
  ([vitrification](https://digitalfire.com/glossary/vitrification)).
- A realistic first pass at a new body: 3–5 variants × 3–5 cones, with two bars each, plus a
  drying disk per variant and glaze tests on the best two. That is 20–50 bars.
- A substitution: the old and new clay alone and in the body, at 3–5 cones.
- Expect two or three rounds.

Record with every test:

- The recipe revision and the **lot or bag** of each clay.
- How it was mixed: dry-blended, slurried, pugged; sieve used and residue; water content.
- Bar mark length, dry and fired lengths, weights; disk crack code.
- The cone that actually bent, the kiln and position, the schedule, the atmosphere.
- Colour, warping (mm), bloating, blistering, specks.
- The glaze used and the fit test result.
- Photos with a scale.

## 8. Casting slips

### Recipe structure

- 50:50 plastic to non-plastic, within five parts
  ([Casting-Slip Design](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-casting-slip-design)).
- Mostly kaolin; ball clay gives green strength and mold release but slows casting. Kaplan adds
  about 5% of a ball clay for green strength.
- Bentonite at most about 1%. It helps release (it raises drying shrinkage) but slows casting a
  lot ([casting slip](https://digitalfire.com/glossary/casting+slip)).
- Plastic throwing bodies make poor slips: they are not permeable enough for the mold to draw
  water through them ([deflocculation](https://digitalfire.com/glossary/deflocculation)).

### Deflocculation

- Clay platelets carry charges that make them stick edge to face. Deflocculants put sodium or
  polymer on the surfaces so the particles repel each other. The slip flows with much less water.
- Less water means less shrinkage in the mold, faster drying and less warping.
- **Sodium silicate with soda ash**: the old system
  ([sodium silicate](https://digitalfire.com/material/sodium+silicate)):
  - Silicate alone makes a stringy, thixotropic slip. Soda ash is almost always used with it;
    more soda ash gives a softer cast.
  - Easy to over-deflocculate, and it attacks plaster molds.
  - Always dilute it, and add it in steps
    ([Casting-Slip Design](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-casting-slip-design)).
  - **Amounts disagree widely.** Digitalfire's benchmark for a talc and ball clay body is about
    0.55% silicate and 0.18% soda ash ([sodium carbonate](https://digitalfire.com/material/sodium+carbonate)).
    A Bath Potters terra cotta recipe works out to about 0.16% and 0.06%
    ([Bath Potters](https://www.bathpotters.co.uk/userfiles/file/castingsliprecipessept25.pdf)).
    Hot-Clay suggests 0.05–0.3% with a similar amount of ash
    ([Hot-Clay](https://www.hot-clay.com/products/sodium-silicate)). Some figures are for liquid
    silicate and some may be for its solids; few say which.
- **Darvan** (sodium polyacrylate):
  - Darvan 7: about 0.2–1% of dry weight for most whiteware bodies. A wider working range and
    easier on molds.
  - Darvan 811: for vitreous and high-iron bodies; about 1 g per 100 g for a high-iron terra cotta.
  - Digitalfire's example: 5 kg dry porcelain, 2.1 kg water, 38 g Darvan 7 (0.75%), about 1.75
    SG ([deflocculation](https://digitalfire.com/glossary/deflocculation)).
- Larger-particle kaolins need less deflocculant. One switch needed about half the Darvan
  ([casting slip problems](https://digitalfire.com/trouble/casting+slip+problems)).
- Soluble salts in a native clay can turn a slip to jelly with no practical fix.

### Specific gravity, viscosity and thixotropy

- **Specific gravity** is set by water. 1.70–1.80 for potters, up to about 1.9 in factories.
  Start at 1.7 if new to it. Water is 28–40% of dry weight
  ([deflocculation](https://digitalfire.com/glossary/deflocculation),
  [Casting-Slip Design](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-casting-slip-design)).
  Weigh a known volume; hydrometers do not work in thick slip.
- **Viscosity** is set by deflocculant. Ford cup #4 at about 40 seconds after hard mixing is one
  target. Factories use Brookfield or torsion viscometers.
- **Thixotropy** is how much the slip thickens standing. A good slip is under-deflocculated a
  little on purpose ("controlled flocculation"), so it gels slightly and does not settle. One
  description: a casting slip left standing gels in about half an hour
  ([thixotropy](https://digitalfire.com/glossary/thixotropy)).
- Industry adds deflocculant to bring thixotropy a little past target, then water to hit the
  fluidity ([deflocculation](https://digitalfire.com/glossary/deflocculation)).
- Age the slip 1–5 days. Re-measure each day; readings drift with weather and water.

### Tuning loop

1. Start with about 95% of the recipe's water and 75% of its deflocculant.
2. Add plastics first, then non-plastics, mixing as you go.
3. Mix long, ideally overnight.
4. Measure SG. Too high: add water. Too low: the batch is off; note it.
5. Measure viscosity. Too thick: try a little deflocculant. If it thins fast, the slip needed
   it. If not, it needs water.
6. Cast a test piece. Time the wall build, drain, and release.
7. Write it all down for each batch.

### Symptoms

| Symptom | Likely cause |
|---|---|
| Skin forms minutes after mixing stops; casts thin, sticky; sandy or powdery inside; hard settled layer; poor release | over-deflocculated |
| Gels, drains badly, casts thick, hard to pour | under-deflocculated |
| Behaves over-deflocculated but has less deflocculant | too much water (SG 1.6) |
| Gels very fast, drains poorly | too heavy (SG 1.9), too much clay |
| Tears when pulled from the mold | too little plastic strength; add a little Veegum or ball clay |
| Slow casting | very plastic ball clay, bentonite, or Veegum |

Sources: [deflocculation](https://digitalfire.com/glossary/deflocculation),
[casting slip problems](https://digitalfire.com/trouble/casting+slip+problems).

## 9. Common failures, from the body side

### Dunting

- **What you see:** cracks from cooling, often hairline, sometimes the pot in pieces
  ([dunting](https://digitalfire.com/glossary/dunting)).
- **Body causes:** high silica with low feldspar (not enough glass or mullite to bind it);
  coarse quartz; cristobalite; a glaze in too much compression.
- **Other causes:** uneven walls, a thick base on a heavy shelf, a rim near the elements, fast
  cooling through 573 °C or 200–270 °C.
- **A clue:** a crack days after firing points to glaze-fit stress. A crack from the rim in a
  bisque points to uneven heat.
- **Fixes:** enough feldspar to vitrify; finer silica; even walls; slow cooling through the
  inversions; fix the glaze fit. For low-fire, slow the cool through about 510–620 °C
  ([quartz inversion](https://digitalfire.com/glossary/quartz+inversion)).

### Drying cracks and S-cracks

- **Body causes:** too much drying shrinkage (over about 7.5%); too narrow a particle range;
  bentonite-heavy; laminations from pugging
  ([drying shrinkage](https://digitalfire.com/glossary/drying+shrinkage)).
- **Process causes:** uneven drying; rims ahead of bases; not compressing a thrown base;
  slip left at joins.
- **Fixes:** less ball clay or bentonite; a coarser fire clay or some fine grog; stiffer clay;
  even drying. Check with the DFAC disk.

### Bloating and blistering

- **What you see:** bubbles in the body (bloats) or small surface blisters.
- **Body causes:** gas from carbon, sulfates, carbonates or manganese granules, sealed in as the
  body vitrifies. Coarse impurities make it worse. Iron-rich bodies bloat early
  ([bloating](https://digitalfire.com/trouble/bloating)).
- **Process cause:** overfiring, very common with kiln controllers that overshoot. A cone 6
  program reached 2236 °F, about cone 7.
- **Fixes:** fire well short of the bloating cone; grind to 200 mesh; low-carbon materials; less
  flux. Bodies from air-floated industrial minerals may never bloat even at zero porosity.

### Black coring

- **What you see:** a black or grey middle in a broken section.
- **Two schools** ([black coring](https://digitalfire.com/trouble/black+coring)):
  - Carbon that did not burn out takes oxygen from Fe₂O₃, making FeO, which seals the body and
    traps the rest.
  - Reduced iron alone, since bodies with no carbon, already bisqued, still core in reduction.
- Iron content and iron particle size matter most. Pyrite at 20–40 mesh cored heavily.
- **Fixes:** a slower bisque through 700–900 °C with air; a hold near 870–920 °C for thick ware
  ([black core, Ceramic Ninja](https://ceramicninja.com/defects/black-core)); start reduction later;
  finer iron sources; about 10% feldspar to vitrify an iron-rich body.
- Digitalfire treats it as mostly cosmetic, but a cored body is also more likely to bloat and
  crack glazed ware.

### Warping and slumping

- **Body causes:** too much feldspar; a kaolin with built-in flux; overfiring; translucent
  bodies by design ([warping](https://digitalfire.com/trouble/warping)).
- Higher-kaolin bodies resist it. Ball clay and plastic bodies have more "memory" and distort
  more ([Clay Body Shopping](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Clay-Body-Shopping)).
- **Fixes:** the least feldspar that gives the absorption you need; flared shapes and thicker
  walls; machine forming; even kilns; setters for translucent ware. Test with pyroplastic bars.

### Crazing, from the body side

- **Body causes** ([glaze crazing](https://digitalfire.com/trouble/glaze+crazing)):
  - Body expansion too low: too little silica, or silica replaced with alumina.
  - Body underfired: porcelain that is not fully vitrified crazes glazes.
  - Moisture expansion: porous bodies take up water through bare feet and expand, so glazes craze
    weeks or years later.
  - Refires dissolving quartz.
- **Fixes:** more silica, with more flux; fire the body to maturity; in low fire, talc or more
  calcium carbonate; glaze the foot or keep bare clay to a minimum.
- Test with IWCT, and the pressure cooker for delayed crazing.

### Shivering, from the body side

- The mirror of crazing: the glaze is in too much compression and flakes off edges
  ([glaze shivering](https://digitalfire.com/trouble/glaze+shivering)).
- **Body causes:** body expansion too high: lots of free quartz, cristobalite, high talc. An
  engobe that is too refractory to bond.
- **Fixes:** usually raise glaze expansion. From the body: less silica, or a more mature body for
  a better bond.
- Shivered flakes are sharp and can get into food. Test transparent glazes on functional ware.

### Efflorescence and scumming

- **What you see:** a white or brown film, usually where the ware dried last: rims, edges,
  handles ([efflorescence](https://digitalfire.com/glossary/efflorescence)).
- **Cause:** soluble sulfates carried to the surface by drying water. Common in red clays, raw
  stonewares and fire clays, and in porcelain with bentonite or plastic kaolin.
- It can fire into a thin glassy skin, glue feet to shelves, and stop glazes bonding
  ([crawling](https://digitalfire.com/trouble/crawling)).
- **Fixes:** 0.2–0.5% barium carbonate (0.35% is Digitalfire's example)
  ([barium carbonate](https://digitalfire.com/material/barium+carbonate)); slurry and decant
  heavy-salt clays; handle leather-hard ware less.
- Fired ware outdoors can scum again through wet-dry cycles, as brick does.

### Lamination

- **What you see:** layers in the clay that open as cracks in drying or firing, often
  S-shaped or along a pugged log ([laminations](https://digitalfire.com/glossary/laminations)).
- **Causes:** a pugmill that does not knit the clay: worn blades, low pressure after the auger,
  weak vacuum, too fast. Too much sand or silt, or too little water.
- **Fix:** wedge it out ([wedging](https://digitalfire.com/glossary/wedging)). All pugged clay
  laminates a little.

## 10. Safety: silica

- **Why bodies matter more than glazes:**
  - You mix bodies by the kilogram or the tonne, and glazes by the gram.
  - A porcelain is often about 25% added quartz. A whiteware can be 50%+ ball clay plus 25%+
    quartz. Ball clays and bentonites carry quartz of their own; kaolins carry little
    ([dealing with dust](https://digitalfire.com/hazard/dealing+with+dust+in+ceramics)).
  - Body work makes dust again and again after mixing: dried trimmings, sanding greenware, slop
    on floors and clothes, fettling casts.
- **The hazard:** respirable crystalline silica causes silicosis and is a known human carcinogen.
  Respirable means under about 5–10 µm. Most ceramic powder is ground to about 75 µm, but every
  bag has a fine fraction.
- **The limit:** OSHA's permissible exposure limit is 50 µg/m³ as an 8-hour average, with an
  action level of 25 µg/m³ ([OSHA silica](https://www.osha.gov/silica-crystalline),
  [Congressional Research Service](https://www.everycrsreport.com/files/20180116_R44476_a0394a8898cbd756d12cc355c3b4dea64195381f.html)).
- **Sources disagree on studio risk.** Digitalfire argues typical studio dust is far below what
  causes silicosis. Ceramics Monthly's measurements found big fine-dust peaks from sanding,
  sculpting leather-hard clay, mopping and sponging
  ([Studio Dust](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Studio-Dust)).
  Both say the same thing about practice.
- **Practice:**
  - Mix dry body powders wet as soon as you can, under extraction, at the end of the day.
  - A fitted N95 at least; Ceramics Monthly names P100. Surgical masks do nothing.
  - Never sweep. Wet-mop often, not weekly. HEPA vacuums only.
  - Sponge greenware wet instead of sanding it.
  - Keep clay clothes at the studio.
- **Other body hazards:** barium carbonate is toxic; some talc has been linked with asbestos
  ([talc](https://digitalfire.com/material/talc)).

## 11. Going further, ranked

1. **Digitalfire reference library** (Tony Hansen). The deepest free source, and the one this
   file leans on. Start with:
   - Glossary: [clay body](https://digitalfire.com/glossary/clay+body),
     [plasticity](https://digitalfire.com/glossary/plasticity),
     [vitrification](https://digitalfire.com/glossary/vitrification),
     [residual quartz](https://digitalfire.com/glossary/residual+quartz),
     [deflocculation](https://digitalfire.com/glossary/deflocculation).
   - Articles: [formulating a porcelain](https://digitalfire.com/article/formulating+a+porcelain),
     [formulating a body from native clays](https://digitalfire.com/article/formulating+a+body+using+clays+native+to+your+area),
     [duplicating AP Green Fireclay](https://digitalfire.com/article/duplicating+ap+green+fireclay),
     [what happens in a firing](https://digitalfire.com/article/firing:+what+happens+to+ceramic+ware+in+a+firing+kiln).
   - [Troubles](https://digitalfire.com/trouble/list) and [tests](https://digitalfire.com/project/tests).
   - Material pages, which carry data-sheet numbers and Hansen's tests of each clay.
   - Caveats: it is Plainsman Clays' and Hansen's own practice, with Canadian materials; some
     pages are notes rather than finished articles; a few URLs move.
2. **Frank and Janet Hamer, *The Potter's Dictionary of Materials and Techniques*,** 6th edition,
   2015 ([Penn Press](https://www.pennpress.org/9780812247923/the-potters-dictionary-of-materials-and-techniques)).
   The best one-volume reference: clay minerals, firing, faults, materials, by entry. Frank
   Hamer wrote the early editions alone; any edition is useful, the later ones more so.
3. **Ceramics Monthly's Techno File columns** (Ceramic Arts Network), short and practical, some
   paywalled:
   - [Clay Body Building](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Technofile-Clay-Body-Building)
     and [Casting-Slip Design](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-casting-slip-design) (Kaplan);
   - [Deconstruct a Clay Body](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file--deconstruct-a-clay-body) (Zamek);
   - [Clay Body Shopping](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Clay-Body-Shopping),
     [SSA Clay Formulation](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-SSA-Clay-Formulation) and
     Porcelain Bodies 201 (Anderson);
   - [Clay Bodies for Soda](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-clay-bodies-for-soda) (Beck);
   - [Glaze Fit and Fault](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/techno-file-glaze-fit-and-fault)
     and [Cristobalite](https://ceramicartsnetwork.org/ceramics-monthly/ceramics-monthly-article/Techno-File-Cristobalite).
   Some figures in the free previews are in images or have slips; check the full article.
4. **Daniel Rhodes, *Clay and Glazes for the Potter*,** 3rd edition, revised by Robin Hopper,
   2000 ([Hopper's notes](https://chosinpottery.ca/pages/booksvideos.html)). Clear chapters on
   clay geology, bodies and firing. Out of print, and many named materials are gone; read it for
   principles.
5. **Harry Fraser, *Ceramic Faults and Their Remedies*** (A&C Black, 1986, later editions in the
   1990s; [Fraser](https://encyclopedia.com/arts/culture-magazines/fraser-harry)). Organized by
   fault, body and glaze; the best book for section 9.
6. **Tony Hansen's longer articles,** on Digitalfire and earlier in Ceramics Monthly, such as
   [crazing in stoneware glazes](https://digitalfire.com/article/crazing+in+stoneware+glazes:+treating+the+causes,+not+the+symptoms)
   and [glaze fit and fired strength](https://digitalfire.com/article/the+effect+of+glaze+fit+on+fired+ware+strength).
   Ranked below the library only because the library links them.
7. **Carty and Senapati, "Porcelain" (J. Am. Ceram. Soc., 1998)**
   ([DOI](https://doi.org/10.1111/j.1151-2916.1998.tb02290.x)). The science of triaxial
   porcelain: phases, mullite, quartz and strength. Dense, but the source behind much of the
   rest.
8. **Ceramic Materials Workshop** (Matt Katz and others): courses on clay body chemistry,
   rheology and casting ([Katz](https://www.andersonranch.org/people/matthew-katz)).
9. **Ian Currie, *Stoneware Glazes: A Systematic Approach* (1984) and *Revealing Glazes* (2000)**
   ([Revealing Glazes](https://leanpub.com/Revealing-Glazes-by-Ian-Currie)). Glaze books, with
   almost nothing on bodies. Ranked last for this topic. His systematic grid habit carries over
   to body blends (variant × cone), and that is the lesson to take.

Reading Glazy pages is fine for seeing what bodies people post. Its data downloads are CC BY-NC-SA
and were not used.

## 12. What this means for Glaze Vault

Ranked by how much each would help someone formulate a body. "Planned" means listed in
[clay bodies](clay-bodies.md); several planned items are now built, which is noted.

**Since built (2026-10-18):** 1 to 7, 10, the silica hint in 11, and 12. A firing's lots are
kept by the order of the fired revision's materials, not by name, so a role that reads firings
without chemistry learns no material names from them. **Built 2026-10-20:** 8; the bar
labels in 4, which name each recipe by a letter and no materials; and 9, as the mix log
([ADR 16](../adr/0016-mix-log.md)), which also keeps the lots of a batch as it is mixed, under
the batch key so a batch operator logs them. The whole list is built.

1. **Body class and forming method on a recipe.** Planned (recipe field 3), not built. It
   decides which targets and tests apply: a casting slip, a throwing porcelain and a raku body
   are judged differently.
2. **Targets for a body: absorption and shrinkage at a cone, shown as a band on the
   vitrification chart.** New. The chart is built; a target turns it from a picture into a
   pass or fail, and shows the firing range as the cones inside the band.
3. **The lot of each clay on a firing or a mix.** New. Clays change by bag and seam
   (section 7). Without the lot, a changed result cannot be traced to a new load of Redart.
4. **Body-aware blends.** New, on top of the built line and triaxial blends (ADR 15). For a body,
   show oxide % and the formula with Al₂O₃ = 1 at each step instead of the unity formula, the
   plastic to non-plastic ratio, and print bar labels for each step at each cone.
5. **Plastic to non-plastic ratio and added silica, shown for a body.** New. Both come from the
   material classes already kept. They are the first two numbers a body formulator reads.
6. **Warp and drying measurements on the test bar.** Partly planned: warped is a flaw checkbox,
   and drying disks are in the tests table. New: pyroplastic deformation in mm (dry bow plus
   fired sag, with the span), and a drying-disk crack code.
7. **Glaze fit tests that link a glaze to a body.** New beyond the planned crazing notes. A
   firing would name both recipes and record IWCT or BWIW pass or fail, so fit can be searched
   from either side.
8. **Comparing materials by data sheet, side by side.** New. The data sheet fields are built.
   Substitution is matched on shrinkage, absorption, plasticity and particle size, not oxides,
   so the comparison should put those first.
9. **A casting-slip batch record.** Partly planned: gravity, Ford cup and gel per firing are
   built. New: deflocculant added in steps, and gravity and viscosity re-read over days of
   ageing.
10. **Water on a stated basis.** New, small. Say whether a water figure is per 100 g dry or a
    share of wet weight, and convert. Section 5 shows how much confusion this causes.
11. **Expansion with a quartz caveat.** Planned and built. Could add a hint when a body's added
    silica is under about 20%, where porcelains start to craze glazes.
12. **A dust note on body batch sheets.** New, low. Printing the batch's added silica and a
    one-line reminder to mix wet costs little.
