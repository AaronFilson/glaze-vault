# The firing log

The firing log keeps each firing of a recipe: how it was fired, what came out, a test bar's
measurements and photos of the tiles. It is encrypted like your recipes, photos too.

## Logging a firing

Open a recipe and choose **Log a firing…** below it, or open **Firing log** at the top and choose
**Log a firing**, then the recipe. A firing belongs to the revision of the recipe that was fired;
if you change the recipe later, the firing says so.

Fill in what you know; only the recipe and the day are needed:

- **Firing:** the day, the cone, the atmosphere, the kiln, the peak temperature in °C or °F, and the
  schedule, such as `100/hr to 600, 300/hr to cone 6, 10 min hold`.
- **Result:** the surface, how transparent it is, the colour in your words, and any flaws:
  crazed, shivered, crawled, pinholed, blistered, ran, bloated, warped.
- **Slip or glaze as applied:** its specific gravity, its seconds through a Ford cup #4, and how it
  gels standing. It opens by itself for a slip, or for a recipe that has targets for these (see
  [Recipes](recipes.md)), and shows the targets beside what you measured.
- **Notes,** then **Save**.

What you type is kept, encrypted, if the vault locks before you save, as for recipes: unlocking
brings it back. **Lock** keeps it too, without asking.

**Firings (3)** below a recipe shows its firings. In the firing log, **Search** finds firings by
recipe, cone, atmosphere, kiln, colour, flaws, notes and captions.

## A test bar

For a clay body or a slip, **Test bar and drying disk** works out shrinkage and absorption from a
bar's measurements. It opens by itself for a recipe whose type is a clay body or slip.

1. Make a plastic bar and mark two lines on it, usually 100 mm apart.
2. Measure between the marks when it is dry, and again when it is fired.
3. Weigh the fired bar, boil or soak it in water, wipe it, and weigh it again.
4. For porosity and density, also weigh it hanging in water.

| Result | Worked out as |
|---|---|
| Drying shrinkage | marks to dry, as a percentage of the marks |
| Firing shrinkage | dry to fired, as a percentage of dry |
| Total shrinkage | marks to fired, as a percentage of the marks |
| Absorption | water taken up, as a percentage of the fired weight |
| Porosity | water taken up, as a percentage of the bar's volume |
| Bulk density | fired weight over volume, in g/cm³ |

**Warping:** measure how far the dry bar is from straight, then fire it across two supports,
hump up, and measure how far it sagged. **Deformation** is the bow and the sag together, in mm.
Give the span between the supports too: there is no standard one, so compare bars fired side by
side over the same span.

**Drying disk cracks:** a drying disk's crack code, or its cracks in words.

## Material lots

**Material lots** has a field for each material of the recipe revision fired: write the lot or
bag of each, clays most of all. A new bag of a clay can change a result, and this is how you
trace it. The lots are kept by the order of the materials, without their names, so someone who
[reads firings without chemistry](sharing.md) sees the lots but not the materials.

## Glaze fit

For a glaze, **Glaze fit** keeps the body it was fired on and how a fit test went:

- **Body:** one of your clay bodies, chosen from the list, or the name of a bought clay.
- **Fit test:** 300 °F to ice water (IWCT), boiling to ice water (BWIW), the pressure cooker or
  autoclave, or another test; its **Result**, passed, crazed or shivered; and **How**, such as
  `at 325 °F` or `3 cycles`.

A glaze fired on one of your bodies is listed with the body's firings too, so its fit can be
found from either recipe.

## Vitrification

With a recipe's firings shown, and test bars measured at two cones or more, a chart above them
shows absorption and total shrinkage against cone, averaged at each cone. A body's
[targets](recipes.md#details) are shaded bands, and the chart says at which cones the body is
inside all of them: its firing range. **As a table** says so for each cone. As a body nears
maturity its absorption falls toward zero and its shrinkage levels off; past it, the bar may
bloat and shrink less. Point at a cone, or tab to it, for its numbers; **As a table** has them
all.

## Photos

Choose **Add photo…** and pick a photo: JPEG, PNG or WebP, and HEIC (iPhone photos) on a Mac. A new
firing is saved first. Photos are made smaller to at most 2,400 pixels across before they are kept,
which is plenty to see crazing and keeps the vault small. Give each a caption, and **Save**.

**Remove** takes a photo off the firing; earlier revisions still have it until the firing is
deleted.

## Exporting the log

**Settings → Export → Export firing log as CSV…** saves every firing you can open as a
spreadsheet, a row each, oldest first: how it was fired, what came out, the bar's readings and
results, warping and the drying disk, the slip as applied, the lots by the number of their
material, and the body and fit test. Photos are listed by caption. The file is not encrypted.

## Deleting a firing

**Delete…** removes the firing and its photos for good. Backups made before then still have them.

## Who sees it

In a [shared vault](sharing.md), a firing is in its recipe's collection: whoever may change the
recipe logs its firings, and whoever may read it reads them. Batch operators do not see them.
