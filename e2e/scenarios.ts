// What the end-to-end tests do, in order, in one vault: each scenario starts where the one before
// left off. Commands are ui/devDriver.ts's; `expect` fails a script when the text does not show.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from './app.ts';

export interface Scenario {
  name: string;
  run: (app: App, vault: Vault) => Promise<void>;
}

/** What the scenarios learn about the vault as they go. */
export interface Vault {
  password: string;
  recoveryWords: string[];
}

const PASSWORD = 'kiln shelf wadding';
const CHANGED_PASSWORD = 'glaze kiln wedge';
const NEW_PASSWORD = 'bisque cone nine';

const quote = (text: string) => JSON.stringify(text);
const fileIn = (app: App, name: string) => join(app.files, name);

/** Types a recipe's lines into the editor, adding rows as needed. */
function recipeLines(lines: [string, string][]): string[] {
  return lines.flatMap(([material, amount], i) => [
    ...(i > 0 ? ['click "Add material"'] : []),
    `type "Material ${i + 1}" ${quote(material)}`,
    `type "Amount ${i + 1}" ${quote(amount)}`
  ]);
}

/** Reads the recovery words off the sheet on screen, and types back the ones the check asks for. */
async function newRecoveryKey(app: App, sheet: string): Promise<string[]> {
  const words = [...sheet.matchAll(/^ *- (\d+) ([a-z]+)$/gm)].map((match) => match[2]);
  if (words.length !== 24) throw new Error(`Expected 24 recovery words:\n\n${sheet}`);
  const check = await app.run(
    'check /^I have printed or written down/',
    'click "Continue"',
    'expect "Check your recovery key"'
  );
  const asked = [...check.matchAll(/\[textbox "Word (\d+)"/g)].map((match) => Number(match[1]));
  if (asked.length !== 3) throw new Error(`Expected three words to check:\n\n${check}`);
  // "Open my vault" when setting up, "Done" for a new key from Settings.
  const finish = /\[button "(Open my vault|Done)"/.exec(check)?.[1] ?? 'Open my vault';
  await app.run(...asked.map((n) => `type "Word ${n}" ${quote(words[n - 1])}`), `click ${quote(finish)}`);
  return words;
}

const unlock = (password: string) => [
  'expect "Unlock your vault" 5000',
  `type "Password" ${quote(password)}`,
  'click "Unlock"',
  'expect "New recipe" 30000'
];

export const scenarios: Scenario[] = [
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
        // Materials again goes back to the recipes.
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
  },
  {
    name: 'Import recipes from GlazeChem, then the material they lack from a spreadsheet',
    async run(app) {
      const glz = fileIn(app, 'Studio.glz');
      writeFileSync(
        glz,
        [
          'filetype = GlazeChem Glazes',
          'version = 2',
          '',
          'name = Tenmoku',
          'range = 10',
          'component = Custer',
          'amount = 45',
          'component = Silica',
          'amount = 30',
          'component = Whiting',
          'amount = 15',
          'component = EPK',
          'amount = 10',
          'addition = Red Iron Oxide',
          'addamount = 10',
          '',
          'name = Mystery',
          'component = Mystery frit',
          'amount = 100',
          ''
        ].join('\r\n')
      );
      const csv = fileIn(app, 'frits.csv');
      writeFileSync(csv, ',LOI,SiO2,Al2O3,CaO,B2O3\r\nMystery frit,0,55,10,20,15\r\n');

      await app.run(
        'click "Settings"',
        `pick ${quote(glz)}`,
        'click "Import from a file…"',
        'expect "# Import from Studio.glz"',
        'expect "Read as GlazeChem"',
        'expect "not found: Mystery frit"',
        'click "Import 2 recipes and 0 materials"',
        'expect "2 recipes and 0 materials imported from Studio.glz" 10000',
        'click "Done"',
        'click "Back to recipes"',
        'click "Mystery"',
        'expect "Unknown material Mystery frit"'
      );
      await app.run(
        'click "Settings"',
        `pick ${quote(csv)}`,
        'click "Import from a file…"',
        'expect "Read as Materials (CSV)"',
        'click "Import 0 recipes and 1 material"',
        'expect "0 recipes and 1 material imported" 10000',
        'click "Done"',
        'click "Back to recipes"',
        'click "Mystery"',
        'expect not "Unknown material"',
        'expect "| B₂O₃ |"'
      );
    }
  },
  {
    name: 'Export recipes and materials',
    async run(app) {
      const csv = fileIn(app, 'recipes.csv');
      const json = fileIn(app, 'everything.json');
      const materials = fileIn(app, 'materials.csv');
      const xml = fileIn(app, 'recipes.xml');
      await app.run(
        'click "Settings"',
        `pick ${quote(csv)}`,
        'click "Export as CSV…"',
        'wait 500',
        `pick ${quote(json)}`,
        'click "Export as JSON…"',
        'wait 500',
        `pick ${quote(materials)}`,
        'click "Export materials as CSV…"',
        'wait 500',
        `pick ${quote(xml)}`,
        'click "Export as Insight XML…"',
        'wait 500'
      );
      await app.until(
        () => [csv, json, materials, xml].every((file) => readable(file)),
        10_000,
        'The exports were not written'
      );
      const exported = JSON.parse(readFileSync(json, 'utf8')) as {
        recipes: { name: string }[];
        materials: { name: string }[];
      };
      const names = exported.recipes.map((r) => r.name).sort();
      if (names.join() !== 'Leach 4321,Mystery,Tenmoku') throw new Error(`The JSON export has ${names.join(', ')}`);
      if (exported.materials.map((m) => m.name).sort().join() !== 'My Feldspar,Mystery frit')
        throw new Error('The JSON export has the wrong materials');
      if (!readFileSync(csv, 'utf8').includes('Leach 4321')) throw new Error('The CSV export lacks Leach 4321');
      if (!readFileSync(materials, 'utf8').includes('Mystery frit')) throw new Error('The materials CSV lacks Mystery frit');
      if (!readFileSync(xml, 'utf8').includes('<recipeline material="Custer" amount="40"'))
        throw new Error('The Insight XML lacks Leach 4321');
      await app.run('click "Back to recipes"');
    }
  },
  {
    name: 'Lock, refuse a wrong password, and unlock',
    async run(app, vault) {
      await app.run(
        'click "Lock"',
        'type "Password" "not the password"',
        'click "Unlock"',
        'expect "That password is not right." 30000',
        `type "Password" ${quote(vault.password)}`,
        'click "Unlock"',
        'expect "Leach 4321" 30000'
      );
    }
  },
  {
    name: 'Back up, restore the backup, and switch back to the vault it set aside',
    async run(app, vault) {
      const backup = fileIn(app, 'vault.gvbackup');
      await app.run(
        'click "Settings"',
        `pick ${quote(backup)}`,
        'click "Back up now…" in "section"',
        'expect "Last backup" 10000',
        'expect "vault.gvbackup"',
        'click "Back to recipes"',
        'click "New recipe"',
        'type "Recipe name" "After the backup"',
        ...recipeLines([['Silica', '100']]),
        'click "Save"',
        'expect "revision 1"',
        'click "Lock"',
        `pick ${quote(backup)}`,
        'click "Restore from a backup"',
        'click "Choose backup file…"',
        'expect "vault.gvbackup"',
        `type "Password" ${quote(vault.password)}`,
        'click "Restore"',
        'expect "Backup restored" 30000',
        'expect "Vaults set aside lists it"',
        'click "Open my vault"',
        'expect "Leach 4321" 10000',
        'expect not "After the backup"',
        // The backup it came from is its latest, so there is nothing to remind about.
        'expect not "have not been backed up"',
        'click "Settings"',
        'expect "Vaults set aside" 5000',
        'click "Switch to it…"',
        'click "Switch vaults" in "Switch vaults"',
        ...unlock(vault.password),
        'expect "After the backup" 5000'
      );
    }
  },
  {
    name: 'Change the password in Settings',
    async run(app, vault) {
      await app.run(
        'click "Settings"',
        'type "Current password" "not the password"',
        `type "New password" ${quote(CHANGED_PASSWORD)}`,
        `type "Type it again" ${quote(CHANGED_PASSWORD)}`,
        'click "Change password"',
        'expect "That password is not right." 30000',
        `type "Current password" ${quote(vault.password)}`,
        `type "New password" ${quote(CHANGED_PASSWORD)}`,
        `type "Type it again" ${quote(CHANGED_PASSWORD)}`,
        'click "Change password"',
        'expect "Password changed. Your recovery key has not changed." 30000',
        'click "Lock"',
        ...unlock(CHANGED_PASSWORD)
      );
      vault.password = CHANGED_PASSWORD;
    }
  },
  {
    name: 'Make a new recovery key, and the old one stops working',
    async run(app, vault) {
      const oldWords = vault.recoveryWords;
      vault.recoveryWords = await newRecoveryKey(
        app,
        await app.run(
          'click "Settings"',
          `type "Password" ${quote(vault.password)}`,
          'click "Make a new recovery key"',
          'expect "Your recovery key" 30000'
        )
      );
      if (vault.recoveryWords.join() === oldWords.join()) throw new Error('The recovery key did not change');
      await app.run(
        'click "Lock"',
        'click "Forgot your password?"',
        `type "Recovery words" ${quote(oldWords.join(' '))}`,
        `type "New password" ${quote(NEW_PASSWORD)}`,
        `type "Type it again" ${quote(NEW_PASSWORD)}`,
        'click "Set password and unlock"',
        'expect "That recovery key is not right." 30000',
        'click "Back"',
        ...unlock(vault.password)
      );
    }
  },
  {
    name: 'Recover with the recovery key, and unlock with the new password',
    async run(app, vault) {
      await app.run(
        'click "Lock"',
        'click "Forgot your password?"',
        `type "Recovery words" ${quote(vault.recoveryWords.join(' '))}`,
        'expect "24 of 24 words"',
        `type "New password" ${quote(NEW_PASSWORD)}`,
        `type "Type it again" ${quote(NEW_PASSWORD)}`,
        'click "Set password and unlock"',
        'expect "New recipe" 30000',
        'click "Lock"',
        ...unlock(NEW_PASSWORD),
        'expect "Leach 4321"'
      );
      vault.password = NEW_PASSWORD;
    }
  }
];

function readable(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').length > 0;
  } catch {
    return false;
  }
}
