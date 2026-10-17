// End-to-end tests: `npm run e2e` builds and opens the app in development with a throwaway vault,
// works through the scenarios in order as a person would, and stops at the first that fails,
// showing the screen as it was. `npm run e2e -- --keep` keeps the folder with the vault, the files
// the scenarios made and the app's log.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from './app.ts';
import { scenarios, type Vault } from './scenarios.ts';

const keep = process.argv.includes('--keep');
// The first build compiles SQLCipher and OpenSSL, which takes a while on a cold CI cache.
const startMinutes = Number(process.env.E2E_START_MINUTES) || 30;

// A locked Mac hides every window, and WebKit stops answering a hidden page after a while, so
// the tests would stop part way (ADR 11).
if (process.platform === 'darwin' && /"CGSSessionScreenIsLocked"=Yes/.test(spawnSync('ioreg', ['-n', 'Root', '-d1']).stdout?.toString() ?? '')) {
  console.log('The screen is locked. Unlock this Mac, then run the tests again: a locked screen hides the app.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'glaze-vault-e2e-'));
const app = new App(dir);
const vault: Vault = { password: '', recoveryWords: [], organizationWords: [] };
const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;

let failed = false;
try {
  const started = Date.now();
  console.log(`Starting the app, with its files in ${dir}`);
  await app.start(startMinutes * 60_000);
  console.log(`Started in ${seconds(started)}\n`);

  for (const [index, scenario] of scenarios.entries()) {
    const at = Date.now();
    try {
      await scenario.run(app, vault);
      console.log(`  ok    ${scenario.name} (${seconds(at)})`);
    } catch (e) {
      failed = true;
      console.log(`  FAIL  ${scenario.name} (${seconds(at)})\n`);
      console.log((e as Error).message);
      const rest = scenarios.length - index - 1;
      if (rest) console.log(`\n${rest} more not run: each starts where the one before left off.`);
      break;
    }
  }
} catch (e) {
  failed = true;
  console.log((e as Error).message);
} finally {
  await app.stop();
}

if (failed || keep) console.log(`\nThe vault, files and log (dev.log) are in ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
