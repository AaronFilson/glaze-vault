import { newRecoveryKey, PASSWORD, quote, recipeLines, type Scenario } from './helpers.ts';

export const vaultAndRecipesScenarios: Scenario[] = [
  {
    name: 'Set up a vault and check the recovery key',
    async run(app, vault) {
      const screen = await app.run(
        'expect "Set up your vault" 30000',
        `type "Password" ${quote(PASSWORD)}`,
        `type "Type it again" ${quote(PASSWORD)}`,
        'click "Create vault"',
        'expect "Your recovery key" 30000'
      );
      vault.password = PASSWORD;
      vault.recoveryWords = await newRecoveryKey(app, screen);
      await app.run('expect "No recipes yet." 10000');
    }
  },
  {
    name: 'Write a recipe and see its unity formula',
    async run(app) {
      await app.run(
        'type "Recipe name" "Leach 4321"',
        ...recipeLines([
          ['Custer', '40'],
          ['Silica', '30'],
          ['Whiting', '20'],
          ['EPK', '10']
        ]),
        'click "Save"',
        'expect "revision 1"',
        'expect "[button \\"Leach 4321\\" (current)]"',
        'expect "| CaO | 0.764 |"',
        'expect "| SiO₂ | 3.895 |"',
        'expect "SiO₂ : Al₂O₃"'
      );
    }
  },
  {
    name: 'Save a second revision and compare it with the first',
    async run(app) {
      await app.run(
        'type "Amount 3" "25"',
        'type "Notes" "Cone 10 reduction"',
        'click "Save"',
        'expect "revision 2"',
        'click "Compare…"',
        'expect "# Compare"',
        'expect "Leach 4321, revision 1"',
        'expect "| Whiting | 20.0 | 23.8 | +3.8 |"',
        'expect "| Silica | 30.0 | 28.6 | −1.4 |"',
        'expect "Cone 10 reduction"',
        'click "Done"',
        'expect "Earlier revisions (1)"'
      );
    }
  },
  {
    name: 'Add a material of your own, use it, and rename it in its recipes',
    async run(app) {
      await app.run(
        'click "Materials"',
        'click "New material"',
        'type "Material name" "My Spar"',
        'type "Start from a standard material" "Custer"',
        'click "Copy its analysis"',
        'expect "| Total | 100.00 |"',
        'click "Save"',
        'expect "[button \\"My Spar\\" (current)]"',
        'click "Materials"',
        'expect "New recipe"',
        'click "New recipe"',
        'type "Recipe name" "Spar test"',
        ...recipeLines([
          ['My Spar', '80'],
          ['Silica', '20']
        ]),
        'click "Save"',
        'expect "revision 1"',
        'expect not "Unknown material"',
        'click "Materials"',
        'click "My Spar"',
        'type "Material name" "My Feldspar"',
        'check /^Also rename it in this recipe/',
        'click "Save"',
        'expect "[button \\"My Feldspar\\" (current)]"',
        'click "Materials"',
        'click "Spar test"',
        'expect "[textbox \\"Material 1\\" = \\"My Feldspar\\"]"',
        'expect not "Unknown material"'
      );
    }
  },
  {
    name: 'Delete a recipe, restore it, then delete it again and erase it',
    async run(app) {
      await app.run(
        'click "Spar test"',
        'click "Delete…"',
        'click "Delete" in "alertdialog"',
        'expect not "[button \\"Spar test\\"" 5000',
        'expect "Deleted (1)"',
        'click "Deleted (1)"',
        'click "Spar test"',
        'expect "was deleted"',
        'click "Restore"',
        'expect not "Deleted (1)"',
        'expect "[button \\"Spar test\\" (current)]"',
        'click "Delete…"',
        'click "Delete" in "alertdialog"',
        'click "Deleted (1)"',
        'click "Spar test"',
        'click "Erase permanently…"',
        'click "Erase permanently" in "alertdialog"',
        'expect not "Deleted (1)"',
        'expect not "Spar test"'
      );
    }
  }
];
