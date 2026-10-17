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

For a clay body or a slip, **Test bar** works out shrinkage and absorption from a bar's
measurements. It opens by itself for a recipe whose type is a clay body or slip.

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

## Vitrification

With a recipe's firings shown, and test bars measured at two cones or more, a chart above them
shows absorption and total shrinkage against cone, averaged at each cone. As a body nears
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
results, and the slip as applied. Photos are listed by caption. The file is not encrypted.

## Deleting a firing

**Delete…** removes the firing and its photos for good. Backups made before then still have them.

## Who sees it

In a [shared vault](sharing.md), a firing is in its recipe's collection: whoever may change the
recipe logs its firings, and whoever may read it reads them. Batch operators do not see them.
