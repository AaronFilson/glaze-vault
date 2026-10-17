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
  /** Once the vault is shared, the organization's recovery key. */
  organizationWords: string[];
}

const PASSWORD = 'kiln shelf wadding';
const CHANGED_PASSWORD = 'glaze kiln wedge';
const ONE_TIME = 'pass this on';
const BENS_PASSWORD = 'bens own password';
const ADMIN_PASSWORD = 'back in again';
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
  },
  {
    name: 'Share the vault, add someone, and they see only what they were given',
    async run(app, vault) {
      vault.organizationWords = await newRecoveryKey(
        app,
        await app.run(
          'click "Settings"',
          'type "Your name" "Ana"',
          'click "Share this vault…"',
          'click "Share this vault" in "alertdialog"',
          'expect "The organization\'s recovery key" 30000'
        )
      );
      await app.run(
        'expect "You are signed in as Ana, an admin."',
        'type "Name" "Ben"',
        `type "One-time password" ${quote(ONE_TIME)}`,
        'click "Add"',
        'expect "Pass the one-time password on to Ben." 30000',
        'select "Ben in Shared" "Chemist: reads"',
        'expect "[select \\"Ben in Shared\\" = \\"Chemist: reads\\"]"',
        'click "Back to recipes"',
        'click "Lock"',
        'select "Your name" "Ben"',
        `type "Password" ${quote(ONE_TIME)}`,
        'click "Unlock"',
        'expect "Welcome, Ben" 30000',
        `type "Your password" ${quote(BENS_PASSWORD)}`,
        `type "Type it again" ${quote(BENS_PASSWORD)}`,
        'click "Set my password"',
        'expect "Your recovery key" 30000'
      ).then((sheet) => newRecoveryKey(app, sheet));
      await app.run(
        'expect "Leach 4321" 10000',
        'expect "## Shared"',
        'click "Leach 4321"',
        'expect "You can read this recipe, but not change it."',
        'expect not "[button \\"Save\\""',
        'expect not "Delete…"',
        'click "New recipe"',
        'expect "[select \\"Save in\\" = \\"Private\\"]"',
        'type "Recipe name" "Ben\'s test"',
        ...recipeLines([['Silica', '100']]),
        'click "Save"',
        'expect "revision 1"',
        'expect "## Private"',
        'click "Settings"',
        'expect "You are signed in as Ben."',
        'expect not "Back up now…"',
        'click "Back to recipes"',
        'click "Lock"',
        'select "Your name" "Ana"',
        `type "Password" ${quote(vault.password)}`,
        'click "Unlock"',
        'expect "## From Ben" 30000',
        'expect "Ben\'s test"'
      );
    }
  },
  {
    name: 'A batch operator weighs from a batch sheet, without the recipe',
    async run(app, vault) {
      await app.run(
        'click "Leach 4321"',
        'click "Batch sheet…"',
        'type "Code for Custer" "M-104"',
        'type "Code for Silica" "M-200"',
        'type "Code for Whiting" "M-310"',
        'type "Code for EPK" "M-104"',
        'click "Save batch sheet"',
        'expect "M-104 is already the code for Custer."',
        'type "Code for EPK" "M-401"',
        'type "Notes for weighing" "Sieve through 80 mesh"',
        'click "Save batch sheet"',
        'expect "Its batch sheet is up to date." 10000',
        'click "Settings"',
        'select "Ben in Shared" "Batch operator: weighs"',
        'expect "[select \\"Ben in Shared\\" = \\"Batch operator: weighs\\"]" 30000',
        'click "Back to recipes"',
        'click "Lock"',
        'select "Your name" "Ben"',
        `type "Password" ${quote(BENS_PASSWORD)}`,
        'click "Unlock"',
        // Ben only weighs in Shared, so he starts on the batch sheets.
        'expect "[button \\"Batch sheets\\" (pressed)]" 30000',
        'click "Leach 4321" in "Batch sheets"',
        'expect "| M-104 | 38.10 | 381.0 |"',
        'expect "Sieve through 80 mesh"',
        'expect not "Custer"',
        'expect not "Delete…"',
        'click "Batch sheets"',
        'expect "Ben\'s test"',
        'expect not "Leach 4321"',
        'click "Lock"',
        'select "Your name" "Ana"',
        ...unlock(vault.password).slice(1)
      );
    }
  },
  {
    name: "The organization's recovery key gets an admin back in",
    async run(app, vault) {
      const screen = await app.run(
        'click "Lock"',
        'click "Forgot your password?"',
        'click "Use the organization\'s recovery key"',
        'select "Admin" "Ana"',
        `type "Recovery words" ${quote(vault.organizationWords.join(' '))}`,
        `type "New password" ${quote(ADMIN_PASSWORD)}`,
        `type "Type it again" ${quote(ADMIN_PASSWORD)}`,
        'click "Set password and unlock"',
        'expect "Your recovery key" 30000'
      );
      vault.recoveryWords = await newRecoveryKey(app, screen);
      vault.password = ADMIN_PASSWORD;
      await app.run(
        'expect "Leach 4321" 10000',
        'click "Lock"',
        'select "Your name" "Ana"',
        ...unlock(ADMIN_PASSWORD).slice(1)
      );
    }
  },
  {
    name: 'Go back to one person',
    async run(app, vault) {
      await app.run(
        'click "Settings"',
        'click "Go back to one person…"',
        'expect "Ben can no longer sign in."',
        'click "Go back to one person" in "alertdialog"',
        'expect "This vault is yours alone again." 60000',
        'expect "## Sharing"',
        'click "Back to recipes"',
        'expect not "## Shared"',
        'expect "Ben\'s test"',
        'click "Lock"',
        'expect not "Your name"',
        `type "Password" ${quote(vault.password)}`,
        'click "Unlock"',
        'expect "Leach 4321" 30000'
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
      // A photo of one red pixel: enough to be read, made smaller and shown.
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
        // A slip's firing opens with its test bar.
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
    name: 'Cost a recipe, compare it with a limit formula, and blend two recipes',
    async run(app) {
      await app.run(
        'click "Settings"',
        'type "Priced material 1" "EPK"',
        'type "Price 1" "0.5"',
        'type "Priced material 2" "Silica"',
        'type "Price 2" "0.3"',
        'click "Save prices"',
        'expect "Prices saved." 10000',
        'click "Back to recipes"',
        'click "Iron slip"',
        // 60 EPK at 0.5 and 40 silica at 0.3 in 105 parts: 0.40 a kilogram.
        'expect "Costs $0.400 per kg dry"',
        'expect "without Red Iron Oxide"',
        'select "Compare with" "Cone 6 (Digitalfire)"',
        'expect "outside Cone 6 (Digitalfire)"',
        'select "Compare with" "No limit formula"',
        'click "Blend…"',
        'select "Second recipe" "Leach 4321"',
        'select "Steps" "3"',
        'expect "| Silica |"',
        'click "Save Iron slip 50 · Leach 4321 50 as a recipe"',
        'expect "Saved as recipes: Iron slip 50 · Leach 4321 50." 10000',
        'click "Done"',
        'expect "[button \\"Iron slip 50 · Leach 4321 50\\""'
      );
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
