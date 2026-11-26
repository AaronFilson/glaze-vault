import { readFileSync, writeFileSync } from 'node:fs';
import { CHANGED_PASSWORD, fileIn, NEW_PASSWORD, newRecoveryKey, quote, readable, recipeLines, unlock, type Scenario } from './helpers.ts';

export const importExportAndSecurityScenarios: Scenario[] = [
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
    name: 'The audit log lists what was done, signed',
    async run(app) {
      await app.run(
        'click "Settings"',
        'click "Show the audit log"',
        'expect "| You | Changed their password |" 30000',
        'expect "| You | Exported ("',
        'expect "| You | Made the vault |"',
        'expect not "outside the app"',
        'click "Back to recipes"'
      );
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
