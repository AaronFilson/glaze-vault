import { ADMIN_PASSWORD, BENS_PASSWORD, isoDate, newRecoveryKey, ONE_TIME, quote, recipeLines, unlock, type Scenario } from './helpers.ts';

export const teamAndBatchesScenarios: Scenario[] = [
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
      await app
        .run(
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
        )
        .then((sheet) => newRecoveryKey(app, sheet));
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
        'expect "[button \\"Batch sheets\\" (pressed)]" 30000',
        'click "Leach 4321" in "Batch sheets"',
        'expect "| M-104 | 38.10 | 381.0 |"',
        'expect "Sieve through 80 mesh"',
        'expect not "Custer"',
        'expect not "Delete…"',
        'click "Log a mix…"',
        'expect "# Mix of Leach 4321"',
        'type "Dry batch size" "1000"',
        'type "Lot of M-104, line 1" "L-7"',
        'click "Save"',
        'expect "revision 1" 10000',
        'expect not "Custer"',
        'click "Mix log"',
        'expect "Ben\'s test"',
        'expect not "Leach 4321"',
        'click "Lock"',
        'select "Your name" "Ana"',
        ...unlock(vault.password).slice(1),
        'click "Leach 4321"',
        'click "Mixes (1)"',
        `click ${quote(`Leach 4321 ${isoDate(new Date())} · 1000 g`)} in "Mixes"`,
        'expect "[textbox \\"Lot of Custer, line 1\\" = \\"L-7\\"]"',
        'click "Mix log"'
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
  }
];
