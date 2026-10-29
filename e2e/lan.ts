// The LAN suite (`npm run e2e -- --suite lan`, docs/adr/0023-client-mode.md): two apps on one
// computer, Ana's serving the vault through a development hostd, its child, and Ben's joining it
// with a pairing code. Each scenario starts where the one before left off. The two apps may share
// the webview's stored data on macOS, so nothing here depends on what the page keeps there.
import type { App } from './app.ts';
import { newRecoveryKey, quote, recipeLines } from './scenarios.ts';

export interface Lan {
  a: App;
  b: App;
}

export interface LanScenario {
  name: string;
  run: (lan: Lan) => Promise<void>;
}

const PASSWORD = 'kiln shelf wadding';
const ONE_TIME = 'pass this on';
const BENS_PASSWORD = 'bens own password';
/** As long as a sync can take to bring a change: the host's news comes at once, and the half
 * minute's sync is the fallback. */
const SYNCED = 45_000;

export const lanScenarios: LanScenario[] = [
  {
    name: 'Ana sets up a team vault and serves it on the network',
    async run({ a }) {
      await newRecoveryKey(
        a,
        await a.run(
          'expect "Set up your vault" 60000',
          `type "Password" ${quote(PASSWORD)}`,
          `type "Type it again" ${quote(PASSWORD)}`,
          'click "Create vault"',
          'expect "Your recovery key" 30000'
        )
      );
      await a.run(
        'expect "No recipes yet." 10000',
        'type "Recipe name" "Shino"',
        ...recipeLines([['Silica', '100']]),
        'click "Save"',
        'expect "revision 1"'
      );
      await newRecoveryKey(
        a,
        await a.run(
          'click "Settings"',
          'type "Your name" "Ana"',
          'click "Share this vault…"',
          'click "Share this vault" in "alertdialog"',
          'expect "The organization\'s recovery key" 30000'
        )
      );
      await a.run(
        'type "Name" "Ben"',
        `type "One-time password" ${quote(ONE_TIME)}`,
        'click "Add"',
        'expect "Pass the one-time password on to Ben." 30000',
        'select "Ben in Shared" "Formulator: changes"',
        'expect "[select \\"Ben in Shared\\" = \\"Formulator: changes\\"]"',
        'type "Name other computers see" "Studio"',
        'click "Serve on this network"',
        'expect "This computer serves the vault on this network" 60000'
      );
    }
  },
  {
    name: "Ben's computer joins with a pairing code, and he signs in there",
    async run({ a, b }) {
      const shown = await a.run('click "Pair a computer…"', 'expect "Type this code on the other computer" 30000');
      const code = /\b\d{4}-\d{4}\b/.exec(shown)?.[0];
      if (!code) throw new Error(`No pairing code on the screen:\n\n${shown}`);
      await b.run(
        'expect "Set up your vault" 60000',
        'click "Join a vault on this network"',
        'expect "Join a vault on this network"',
        'type "The vault\'s host" "127.0.0.1:47917"',
        `type "Pairing code" ${quote(code)}`,
        'type "This computer\'s name, for the admin to see" "Ben\'s laptop"',
        'click "Join"',
        'expect "Waiting for the admin to approve this computer" 10000'
      );
      await a.run('expect "used the code" 30000', 'check "Ben"', 'click "Approve"', 'expect "is paired" 30000');
      const sheet = await b.run(
        'expect "This computer has joined the vault" 30000',
        'select "Your name" "Ben"',
        `type "Password" ${quote(ONE_TIME)}`,
        'click "Unlock"',
        'expect "Welcome, Ben" 30000',
        `type "Your password" ${quote(BENS_PASSWORD)}`,
        `type "Type it again" ${quote(BENS_PASSWORD)}`,
        'click "Set my password"',
        'expect "Your recovery key" 30000'
      );
      await newRecoveryKey(b, sheet);
      // The first sync brings what Ben may read.
      await b.run(`expect "Shino" ${SYNCED}`, 'expect "Synced"');
    }
  },
  {
    name: 'A save on one computer shows on the other',
    async run({ a, b }) {
      await a.run(
        'click "Back to recipes"',
        'click "Shino"',
        'type "Recipe name" "Shino blue"',
        'click "Save"',
        'expect "revision 2"'
      );
      await b.run(`expect "Shino blue" ${SYNCED}`);
    }
  },
  {
    name: 'A recipe checked out on one computer cannot be saved on the other until it is taken over',
    async run({ a, b }) {
      await b.run('click "Shino blue"', 'click "Check out"', 'expect "You have this checked out" 30000');
      await a.run(
        `expect "is changing this on another computer" ${SYNCED}`,
        'type "Recipe name" "Shino green"',
        'click "Save"',
        'expect "Ben is changing this on another computer. Wait until they are done" 10000',
        'click "Take it over"',
        'expect "You have this checked out" 30000',
        'click "Save"',
        'expect "revision 3" 10000'
      );
      await b.run(`expect "Shino green" ${SYNCED}`, `expect "is changing this on another computer" ${SYNCED}`);
    }
  }
];
