// The installers' self-test (docs/adr/0035-installer-smoke-test.md), run by ci.yml after the
// installers are built: installs each one as a person would, starts the installed app with
// GLAZE_VAULT_SMOKE, and fails unless it reports "ok" (crates/app/src/smoke.rs).
//
//   node .github/smoke-installer.cjs
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'smoke-'));
let failed = false;

function sh(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const done = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (done.status !== 0) throw new Error(`${command} failed (${done.status ?? done.signal ?? done.error})`);
}

/** Every file under `dir` whose name matches. */
function find(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

const bundles = find('target', /\.(dmg|msi|exe|deb|AppImage)$/).filter((f) => f.includes(`${path.sep}bundle${path.sep}`));

/** Starts an installed app's binary for the self-test, and checks what it reports. */
function check(name, binary, wrap = []) {
  const dir = fs.mkdtempSync(path.join(work, 'run-'));
  const result = path.join(dir, 'result.txt');
  const [command, ...args] = [...wrap, binary];
  console.log(`\n${name}: ${binary}`);
  const done = spawnSync(command, args, {
    env: { ...process.env, GLAZE_VAULT_DIR: path.join(dir, 'vault'), GLAZE_VAULT_SMOKE: result },
    stdio: 'inherit',
    timeout: 180_000
  });
  const text = fs.existsSync(result) ? fs.readFileSync(result, 'utf8').trim() : '(no result written)';
  if (text === 'ok' && done.status === 0) {
    console.log(`  ok    ${name}`);
  } else {
    failed = true;
    console.log(`  FAIL  ${name}: ${text}; exit ${done.status ?? done.signal ?? done.error}`);
    console.log(`::error title=Installer self-test::${name}: ${text}`);
  }
}

function attempt(name, steps) {
  try {
    steps();
  } catch (e) {
    failed = true;
    console.log(`  FAIL  ${name}: ${e.message}`);
    console.log(`::error title=Installer self-test::${name}: ${e.message}`);
  }
}

const one = (pattern) => {
  const found = bundles.find((f) => pattern.test(f));
  if (!found) throw new Error(`no installer matching ${pattern}`);
  return found;
};

if (process.platform === 'darwin') {
  attempt('macOS disk image', () => {
    const mount = path.join(work, 'mount');
    sh('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, one(/\.dmg$/)]);
    sh('cp', ['-R', path.join(mount, 'Glaze Vault.app'), work]);
    sh('hdiutil', ['detach', mount]);
    check('macOS disk image', path.join(work, 'Glaze Vault.app', 'Contents', 'MacOS', 'glaze-vault'));
  });
} else if (process.platform === 'win32') {
  attempt('Windows setup (NSIS)', () => {
    sh(one(/-setup\.exe$/), ['/S']);
    const [binary] = find(path.join(process.env.LOCALAPPDATA, 'Glaze Vault'), /^glaze-vault\.exe$/);
    if (!binary) throw new Error('glaze-vault.exe is not where the setup puts it');
    check('Windows setup (NSIS)', binary);
  });
  attempt('Windows installer (MSI)', () => {
    sh('msiexec', ['/i', one(/\.msi$/), '/qn', '/l*v', path.join(work, 'msi.log')]);
    const [binary] = find(path.join(process.env.ProgramFiles, 'Glaze Vault'), /^glaze-vault\.exe$/);
    if (!binary) throw new Error('glaze-vault.exe is not where the MSI puts it');
    check('Windows installer (MSI)', binary);
  });
} else {
  // Under a virtual display, as the runner has none.
  const display = ['xvfb-run', '-a'];
  attempt('Linux package (deb)', () => {
    sh('sudo', ['apt-get', 'install', '-y', path.resolve(one(/\.deb$/))]);
    check('Linux package (deb)', '/usr/bin/glaze-vault', display);
  });
  attempt('Linux AppImage', () => {
    const image = path.join(work, 'Glaze Vault.AppImage');
    fs.copyFileSync(one(/\.AppImage$/), image);
    fs.chmodSync(image, 0o755);
    check('Linux AppImage', image, display);
  });
}

process.exit(failed ? 1 : 0);
