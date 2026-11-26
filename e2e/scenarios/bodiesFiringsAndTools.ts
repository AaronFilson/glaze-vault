import { writeFileSync } from 'node:fs';
import { fileIn, quote, readable, recipeLines, type Scenario } from './helpers.ts';

export const bodiesFiringsAndToolsScenarios: Scenario[] = [
  {
    name: 'Guard unsaved changes when switching recipes',
    async run(app) {
      await app.run(
        'click "Leach 4321"',
        'type "Notes" "Testing unsaved guard"',
        'click "Tenmoku"',
        'expect "Leach 4321 has changes that are not saved."',
        'click "Keep editing"',
        'expect "[textbox \\"Notes\\" = \\"Testing unsaved guard\\"]"',
        'click "Tenmoku"',
        'click "Discard changes"',
        'expect "[button \\"Tenmoku\\" (current)]"'
      );
    }
  },
  {
    name: 'Give recipes details and additions, then find them',
    async run(app) {
      await app.run(
        'click "Leach 4321"',
        'select "Type" "Glaze"',
        'type "Cone" "10"',
        'select "Atmosphere" "Reduction"',
        'select "Surface" "Satin"',
        'type "Tags" "base, production"',
        'click "Save"',
        'expect "[button \\"Save\\" (disabled)]" 10000',
        'click "New recipe"',
        'type "Recipe name" "Iron slip"',
        'select "Type" "Slip"',
        'type "Cone" "04-1"',
        ...recipeLines([
          ['EPK', '60'],
          ['Silica', '40'],
          ['Red Iron Oxide', '5']
        ]),
        'check "Material 3 is an addition"',
        'click "Save"',
        'expect "revision 1"',
        'type "Search recipes" "production"',
        'expect "[button \\"Leach 4321\\""',
        'expect not "[button \\"Iron slip\\""',
        'type "Search recipes" "^04"',
        'expect "[button \\"Iron slip\\""',
        'expect not "[button \\"Leach 4321\\""',
        'type "Search recipes" "nothing like this"',
        'expect "No recipe has nothing like this."',
        'type "Search recipes" ""',
        'select "Sort by" "Cone"',
        'expect "[button \\"Leach 4321\\""',
        'click "Iron slip"',
        'expect "[x] \\"Material 3 is an addition\\""'
      );
    }
  },
  {
    name: 'Log a firing with a test bar and a photo',
    async run(app) {
      const photo = fileIn(app, 'tile.png');
      writeFileSync(
        photo,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64'
        )
      );
      await app.run(
        'click "Iron slip"',
        'click "Log a firing…"',
        'expect "# Iron slip"',
        'type "Cone" "04"',
        'select "Atmosphere" "Oxidation"',
        'check "Crazed"',
        'type "Dry length, mm" "95"',
        'type "Fired length, mm" "90"',
        'expect "| Total shrinkage | 10.0% |"',
        'click "Save"',
        'expect "revision 1" 10000',
        `pick ${quote(photo)}`,
        'click "Add photo…"',
        'expect "[image \\"Photo 1\\"]" 20000',
        'type "Caption for photo 1" "Front of the tile"',
        'click "Save"',
        'expect "revision 3" 10000',
        'expect "[image \\"Front of the tile\\"]"',
        'click "Firing log"',
        'expect "Firings (1)"'
      );
    }
  },
  {
    name: 'Copy clay data sheets, compare clays, formulate a clay body and zero-flux slip, and plot vitrification',
    async run(app) {
      await app.run(
        'click "Materials"',
        'click "New material"',
        'type "Material name" "Grolleg, lot 4"',
        'type "Start from a standard material" "Grolleg China Clay"',
        'click "Copy its analysis"',
        'expect "[select \\"Class\\" = \\"Kaolin\\"]"',
        'click "Save"',
        'expect "[button \\"Grolleg, lot 4\\" (current)]"',
        'click "New material"',
        'type "Material name" "OM-4, lot 2"',
        'type "Start from a standard material" "OM-4 Ball Clay"',
        'click "Copy its analysis"',
        'expect "[select \\"Class\\" = \\"Ball clay\\"]"',
        'click "Save"',
        'expect "[button \\"OM-4, lot 2\\" (current)]"',
        'click "Compare…"',
        'expect "# Compare materials"',
        'check "Grolleg, lot 4"',
        'expect "Data sheets"',
        'expect "Analysis, weight % of the raw material"',
        'click "Done"',
        'click "Materials"',
        // Clay body with targets, water conversion, low-silica porcelain caution, and multi-cone vitrification curve.
        'click "New recipe"',
        'type "Recipe name" "Studio Porcelain"',
        'select "Type" "Clay body"',
        'select "Body" "Porcelain"',
        'select "Forming" "Throwing"',
        'type "Absorption aimed for, %, to" "1"',
        'type "Water to make it workable" "21"',
        'select "What the water is a share of" "% of the wet clay"',
        'expect "That is 26.6 g per 100 g dry"',
        ...recipeLines([
          ['EPK Kaolin', '50'],
          ['Custer Spar', '35'],
          ['Silica', '15']
        ]),
        'expect "Oxides, fired weight %"',
        'expect "Formula with Al₂O₃ = 1"',
        'expect "Plastic : non-plastic\\n  50 : 50"',
        'expect "tend to craze glazes"',
        'click "Save"',
        'expect "revision 1"',
        'click "Log a firing…"',
        'type "Cone" "5"',
        'type "Length between marks, mm" "100"',
        'type "Dry length, mm" "94"',
        'type "Fired length, mm" "89"',
        'type "Fired weight, g" "50"',
        'type "Weight after soaking, g" "51"',
        'click "Save"',
        'expect "revision 1" 10000',
        'click "Log a firing"',
        'type "Cone" "6"',
        'type "Length between marks, mm" "100"',
        'type "Dry length, mm" "94"',
        'type "Fired length, mm" "88"',
        'type "Fired weight, g" "50"',
        'type "Weight after soaking, g" "50.25"',
        'click "Save"',
        'expect "revision 1" 10000',
        'click "Firing log"',
        'click "Studio Porcelain"',
        'click "Firings (2)"',
        'expect "Inside the targets at cone 6."',
        'click "Firing log"',
        // Zero-flux slip with specific gravity water calculation and slip mix ageing steps.
        'click "New recipe"',
        'type "Recipe name" "Kiln Wash"',
        'select "Type" "Slip"',
        'type "Specific gravity" "1.45"',
        ...recipeLines([
          ['Kaolin (theoretical)', '50'],
          ['Silica', '50']
        ]),
        'expect "g water per 100 g dry"',
        'expect "Formula with Al₂O₃ = 1"',
        'expect "All fluxes\\n  0.0 mol%"',
        'expect not "Unknown material"',
        'click "Save"',
        'expect "revision 1"',
        'click "Log a mix…"',
        'expect "# Mix of Kiln Wash"',
        'type "Dry batch size" "2000"',
        'type "Water at the start (g)" "900"',
        'click "Add a step"',
        'type "Deflocculant added, step 1" "10"',
        'type "Specific gravity, step 1" "1.45"',
        'expect "Deflocculant in all"',
        'expect "Water in all"',
        'click "Save"',
        'expect "revision 1" 10000',
        'click "Mix log"'
      );
    }
  },
  {
    name: 'Cost a recipe, make a custom limit formula, fit a glaze to it, export logs, and run line and triaxial blends',
    async run(app) {
      const firingsCsv = fileIn(app, 'firings.csv');
      const mixesCsv = fileIn(app, 'mixes.csv');
      await app.run(
        'click "Settings"',
        'click "Copy Cone 6 (Digitalfire)"',
        'type "Name" "Cone 6, studio"',
        'click "Save limit formula"',
        'expect "[button \\"Cone 6, studio\\"" 10000',
        'type "Priced material 1" "EPK"',
        'type "Price 1" "0.5"',
        'type "Priced material 2" "Silica"',
        'type "Price 2" "0.3"',
        'click "Save prices"',
        'expect "Prices saved." 10000',
        `pick ${quote(firingsCsv)}`,
        'click "Export firing log as CSV…"',
        'wait 500',
        `pick ${quote(mixesCsv)}`,
        'click "Export mix log as CSV…"',
        'wait 500'
      );
      await app.until(
        () => readable(firingsCsv) && readable(mixesCsv),
        10_000,
        'The firing and mix log CSV exports were not written'
      );
      await app.run(
        'click "Back to recipes"',
        'click "Iron slip"',
        'expect "Costs $0.400 per kg dry"',
        'expect "without Red Iron Oxide"',
        'select "Compare with" "Cone 6, studio"',
        'expect "outside Cone 6, studio"',
        'select "Compare with" "No limit formula"',
        'click "Blend…"',
        'select "Second recipe" "Leach 4321"',
        'select "Steps" "3"',
        'expect "| Silica |"',
        'click "Save Iron slip 50 · Leach 4321 50 as a recipe"',
        'expect "Saved as recipes: Iron slip 50 · Leach 4321 50." 10000',
        'click "Triaxial of three"',
        'expect "# Triaxial blend"',
        'select "Steps along a side" "2 (6 tests)"',
        'click "Done"',
        'expect "[button \\"Iron slip 50 · Leach 4321 50\\""',
        // Fit a glaze to our custom limit formula and save as a new recipe.
        'click "Tenmoku"',
        'select "Compare with" "Cone 6, studio"',
        'click "Fit to a formula…"',
        'expect "# Fit Tenmoku to a formula"',
        'type "Also try" "Talc"',
        'click "Add"',
        'click "Fit"',
        'click "Save as a new recipe"',
        'expect "[button \\"Saved\\" (disabled)]" 10000',
        'click "Done"',
        'expect "[button \\"Tenmoku, fitted\\""'
      );
    }
  }
];
