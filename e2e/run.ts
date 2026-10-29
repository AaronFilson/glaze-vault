// End-to-end tests: `npm run e2e` builds and opens the app in development with a throwaway vault,
// works through the scenarios in order as a person would, and stops at the first that fails,
// showing the screen as it was. `npm run e2e -- --keep` keeps the folder with the vault, the files
// the scenarios made and the app's log. `npm run e2e -- --suite lan` runs the LAN suite instead
// (e2e/lan.ts): two apps, one serving the vault to the other.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from './app.ts';
import { lanScenarios } from './lan.ts';
import { scenarios, type Vault } from './scenarios.ts';

const keep = process.argv.includes('--keep');
const suite = process.argv.indexOf('--suite');
const lan = suite >= 0 && process.argv[suite + 1] === 'lan';
const ROOT = join(import.meta.dirname, '..');
// The first build compiles SQLCipher and OpenSSL, which takes a while on a cold CI cache.
const startMinutes = Number(process.env.E2E_START_MINUTES) || 30;

// A locked Mac hides every window, and WebKit stops answering a hidden page after a while, so
// the tests would stop part way (ADR 11).
if (process.platform === 'darwin' && /"CGSSessionScreenIsLocked"=Yes/.test(spawnSync('ioreg', ['-n', 'Root', '-d1']).stdout?.toString() ?? '')) {
  console.log('The screen is locked. Unlock this Mac, then run the tests again: a locked screen hides the app.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'glaze-vault-e2e-'));
// The LAN suite's first app serves through hostd as its child, with no service (ADR 22), and
// its second runs the debug build the first one's `tauri dev` made.
const app = lan ? new App(join(dir, 'a'), { GLAZE_VAULT_HOST_NO_SERVICE: '1' }) : new App(dir);
const other = lan ? new App(join(dir, 'b')) : null;
const vault: Vault = { password: '', recoveryWords: [], organizationWords: [] };
const run = lan
  ? lanScenarios.map((s) => ({ name: s.name, run: () => s.run({ a: app, b: other! }) }))
  : scenarios.map((s) => ({ name: s.name, run: () => s.run(app, vault) }));
/** In GitHub Actions, the failure goes on the run as an annotation too, which can be read without
 * the job's log. */
const annotate = (text: string) => {
  if (!process.env.GITHUB_ACTIONS) return;
  const escaped = text.slice(0, 6000).replaceAll('%', '%25').replaceAll('\r', '').replaceAll('\n', '%0A');
  console.log(`::error title=End-to-end tests::${escaped}`);
};
const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;

let failed = false;
try {
  const started = Date.now();
  if (lan) {
    console.log('Building hostd');
    const built = spawnSync('cargo', ['build', '-p', 'glaze-vault-hostd'], { cwd: ROOT, stdio: 'inherit' });
    if (built.status !== 0) throw new Error('hostd did not build');
  }
  console.log(`Starting the app, with its files in ${dir}`);
  await app.start(startMinutes * 60_000);
  if (other) {
    const binary = join(ROOT, 'target', 'debug', `glaze-vault${process.platform === 'win32' ? '.exe' : ''}`);
    await other.start(120_000, binary);
  }
  console.log(`Started in ${seconds(started)}\n`);

  for (const [index, scenario] of run.entries()) {
    const at = Date.now();
    try {
      await scenario.run();
      console.log(`  ok    ${scenario.name} (${seconds(at)})`);
    } catch (e) {
      failed = true;
      console.log(`  FAIL  ${scenario.name} (${seconds(at)})\n`);
      console.log((e as Error).message);
      annotate(`${scenario.name}: ${(e as Error).message}`);
      const rest = run.length - index - 1;
      if (rest) console.log(`\n${rest} more not run: each starts where the one before left off.`);
      break;
    }
  }
} catch (e) {
  failed = true;
  console.log((e as Error).message);
  annotate((e as Error).message);
} finally {
  await other?.stop();
  await app.stop();
}

if (failed || keep) console.log(`\nThe vault, files and log (dev.log) are in ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
