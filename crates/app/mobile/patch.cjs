// What Glaze Vault changes in the mobile projects that `tauri android init` and `tauri ios init`
// make (docs/adr/0027-phones.md), which are made fresh and not checked in. Run after either:
// `node crates/app/mobile/patch.cjs android` or `… ios`. Running it again changes nothing more.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const gen = path.join(here, '..', 'gen');

function find(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = find(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return null;
}

function must(found, what) {
  if (!found) throw new Error(`${what} was not found: has \`tauri init\` run?`);
  return found;
}

/** Sets `name="value"` on the manifest's <application>, replacing any value there. */
function setAttribute(manifest, name, value) {
  const open = /<application\b[^>]*>/s.exec(manifest);
  if (!open) throw new Error('The manifest has no <application>.');
  let tag = open[0];
  const existing = new RegExp(`\\s${name}="[^"]*"`);
  tag = existing.test(tag) ? tag.replace(existing, ` ${name}="${value}"`) : tag.replace(/<application\b/, `<application ${name}="${value}"`);
  return manifest.replace(open[0], tag);
}

function android() {
  const main = path.join(gen, 'android', 'app', 'src', 'main');
  // Backups: only the finished backups folder, never the live vault.
  const xml = path.join(main, 'res', 'xml');
  fs.mkdirSync(xml, { recursive: true });
  for (const file of ['backup_rules.xml', 'data_extraction_rules.xml']) {
    fs.copyFileSync(path.join(here, 'android', file), path.join(xml, file));
  }
  const manifestPath = must(fs.existsSync(path.join(main, 'AndroidManifest.xml')) && path.join(main, 'AndroidManifest.xml'), 'AndroidManifest.xml');
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  manifest = setAttribute(manifest, 'android:allowBackup', 'true');
  manifest = setAttribute(manifest, 'android:fullBackupContent', '@xml/backup_rules');
  manifest = setAttribute(manifest, 'android:dataExtractionRules', '@xml/data_extraction_rules');
  fs.writeFileSync(manifestPath, manifest);

  // FLAG_SECURE: no recipe in the recent apps picture, and no screenshots.
  const activityPath = must(find(path.join(main, 'java'), 'MainActivity.kt'), 'MainActivity.kt');
  let activity = fs.readFileSync(activityPath, 'utf8');
  if (!activity.includes('FLAG_SECURE')) {
    const secure =
      '    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)\n';
    if (/super\.onCreate\(savedInstanceState\)\n/.test(activity)) {
      activity = activity.replace(/( *)super\.onCreate\(savedInstanceState\)\n/, (line) => line + secure);
    } else {
      activity = activity.replace(
        /class MainActivity : TauriActivity\(\)\s*(\{\s*\})?/,
        'class MainActivity : TauriActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(savedInstanceState)\n' +
          secure +
          '  }\n}'
      );
    }
    for (const name of ['android.os.Bundle', 'android.view.WindowManager']) {
      if (!activity.includes(`import ${name}\n`)) activity = activity.replace(/^(package [^\n]+\n)/, `$1\nimport ${name}\n`);
    }
    if (!activity.includes('FLAG_SECURE')) throw new Error(`MainActivity.kt is not as expected:\n${activity}`);
    fs.writeFileSync(activityPath, activity);
  }
}

function ios() {
  const apple = path.join(gen, 'apple');
  // The snapshot cover goes beside the app's main.mm, and the Xcode project is made again so it
  // is built.
  const mainMm = must(find(path.join(apple, 'Sources'), 'main.mm'), 'main.mm');
  fs.copyFileSync(path.join(here, 'ios', 'SnapshotCover.m'), path.join(path.dirname(mainMm), 'SnapshotCover.m'));
  execFileSync('xcodegen', ['generate', '--spec', 'project.yml'], { cwd: apple, stdio: 'inherit' });
}

const which = process.argv[2];
if (which === 'android') android();
else if (which === 'ios') ios();
else {
  console.error('Usage: node crates/app/mobile/patch.cjs android|ios');
  process.exit(2);
}
