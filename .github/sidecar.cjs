// Builds hostd for the installers, as Tauri's sidecar (crates/app/tauri.sidecar.conf.json): a
// release build, at crates/app/binaries/hostd-<target triple>, which Tauri puts beside the app.
// `node .github/sidecar.cjs [--target <triple>]`; universal-apple-darwin is both Macs, joined.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const at = args.indexOf('--target');
const host = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1];
const target = at >= 0 ? args[at + 1] : host;
const exe = target.includes('windows') ? '.exe' : '';
const out = path.join('crates', 'app', 'binaries');
fs.mkdirSync(out, { recursive: true });

const build = (triple) => {
  execFileSync('cargo', ['build', '--release', '--locked', '-p', 'glaze-vault-hostd', '--bin', 'hostd', '--target', triple], {
    stdio: 'inherit'
  });
  return path.join('target', triple, 'release', `hostd${exe}`);
};

const dest = path.join(out, `hostd-${target}${exe}`);
if (target === 'universal-apple-darwin') {
  const parts = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(build);
  execFileSync('lipo', ['-create', '-output', dest, ...parts], { stdio: 'inherit' });
} else {
  fs.copyFileSync(build(target), dest);
}
console.log(`hostd for ${target}: ${dest}`);
