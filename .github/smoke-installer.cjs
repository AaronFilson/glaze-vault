// The installers' self-test (docs/adr/0035-installer-smoke-test.md), run by ci.yml after the
// installers are built: installs each one as a person would, starts the installed app with
// GLAZE_VAULT_SMOKE, and fails unless it reports "ok" (crates/app/src/smoke.rs). On Windows it
// also installs the MSI again over a copy whose hostd serves as a service, as an update would,
// and checks it needs no restart and the service serves after (docs/adr/0038-hardening-hostd.md).
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
  // The MSI first: it installs for the whole computer, the setup for this user.
  let msiBinary;
  attempt('Windows installer (MSI)', () => {
    const log = path.join(work, 'msi.log');
    sh('msiexec', ['/i', path.resolve(one(/\.msi$/)), '/qn', '/norestart', '/l*v', log]);
    const places = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const binary = places.flatMap((place) => find(path.join(place, 'Glaze Vault'), /^glaze-vault\.exe$/))[0];
    if (!binary) {
      // Where the MSI said it put files, to see why.
      const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf16le') : '';
      const lines = text.split(/\r?\n/).filter((l) => /INSTALLDIR|APPLICATIONFOLDER|Installation success|return value 3|Error \d/i.test(l));
      console.log(lines.slice(-30).join('\n') || text.slice(-3000));
      throw new Error('glaze-vault.exe is not in Program Files after the MSI');
    }
    msiBinary = binary;
    check('Windows installer (MSI)', binary);
  });
  attempt('Windows installer (MSI) again while hostd serves', () => {
    if (!msiBinary) throw new Error('the MSI did not install');
    msiUpdateWhileServing(path.resolve(one(/\.msi$/)), path.join(path.dirname(msiBinary), 'hostd.exe'));
  });
  attempt('Windows setup (NSIS)', () => {
    sh(one(/-setup\.exe$/), ['/S']);
    const [binary] = find(path.join(process.env.LOCALAPPDATA, 'Glaze Vault'), /^glaze-vault\.exe$/);
    if (!binary) throw new Error('glaze-vault.exe is not where the setup puts it');
    check('Windows setup (NSIS)', binary);
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

/** The installed hostd as a service, serving a team's store from the dev client, then the MSI
 * installed again over it with every file replaced, as an update replaces them. */
function msiUpdateWhileServing(msi, hostd) {
  const client = path.resolve('target', 'debug', 'examples', 'dev-client.exe');
  if (!fs.existsSync(client)) throw new Error(`${client} is not built`);
  const env = { ...process.env, GLAZE_PASSWORD: 'smoke test password' };
  const dir = fs.mkdtempSync(path.join(work, 'host-'));
  const [vault, staging, replica] = ['vault', 'staging', 'replica'].map((d) => path.join(dir, d));
  sh(client, ['make-team', vault, '--as', 'Ana'], { env });
  sh(client, ['prepare', vault, staging, '--as', 'Ana'], { env });
  sh(client, ['join-local', vault, staging, replica, '--as', 'Ana'], { env });
  const synced = () => {
    for (let i = 0; i < 30; i++) {
      if (spawnSync(client, ['sync', replica, '127.0.0.1:47917', '--as', 'Ana'], { env, stdio: 'inherit' }).status === 0) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
    throw new Error('the replica did not sync with the service');
  };
  sh(hostd, ['install', '--from', staging, '--name', 'Smoke test']);
  try {
    synced();
    // The key went under DPAPI as it was installed (vault/host_key.rs).
    const data = path.join(process.env.ProgramData, 'Glaze Vault', 'host');
    if (fs.existsSync(path.join(data, 'host.key')) || !fs.existsSync(path.join(data, 'host.key.dpapi'))) {
      throw new Error('host.key is not kept under DPAPI');
    }
    // Exit 0, not 3010: hostd.exe was free to replace, as the service had stopped.
    const log = path.join(work, 'msi-again.log');
    sh('msiexec', ['/i', msi, '/qn', '/norestart', 'REINSTALL=ALL', 'REINSTALLMODE=vamus', '/l*v', log]);
    synced();
  } finally {
    spawnSync(hostd, ['uninstall'], { stdio: 'inherit' });
  }
}

process.exit(failed ? 1 : 0);
