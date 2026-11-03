// The phone suite (`npm run e2e -- --suite android` or `--suite ios`, ADR 11): a development build
// of the app on an Android emulator or the iOS simulator, joining a hostd run on this computer and
// syncing with it both ways. The admin's side is crates/hostd/examples/dev-client.rs, not a second
// app. A phone's app gets no environment from here, so its screen and driver files are in `dev/`
// beside its vault (dev_file in crates/app/src/lib.rs), read and written through `adb` or `simctl`.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { App } from './app.ts';
import { newRecoveryKey, quote } from './scenarios.ts';

const ROOT = join(import.meta.dirname, '..');
const ID = 'com.glazecalcapp.vault';
const PASSWORD = 'pass this on';
const BENS_PASSWORD = 'bens own password';
/** As long as a sync can take to bring a change: the host's news comes at once, and the half
 * minute's sync is the fallback. */
const SYNCED = 45_000;

export type PhoneKind = 'android' | 'ios';

const exe = (name: string) => join(ROOT, 'target', 'debug', name + (process.platform === 'win32' ? '.exe' : ''));

function must(command: string, args: string[], input?: string): string {
  const done = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 16 << 20 });
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${done.stdout}${done.stderr}`);
  return done.stdout;
}

/** The app on a phone: installed, opened and driven by the files in its `dev/` folder. */
export class Phone extends App {
  readonly kind: PhoneKind;
  /** The `dev/` folder: inside the app's data for `run-as` on Android, a path here on iOS. */
  private devDir = '';

  constructor(kind: PhoneKind, dir: string) {
    super(dir);
    this.kind = kind;
  }

  /** The host's address as the phone reaches this computer: the emulator's alias for it. */
  get hostAddress() {
    return this.kind === 'android' ? '10.0.2.2:47917' : '127.0.0.1:47917';
  }

  /** Installs the app at `build` (an .apk or .app) and opens it. */
  override async start(timeoutMs: number, build?: string) {
    if (!build) throw new Error('The phone suite needs the app built: E2E_PHONE_APP names it.');
    if (this.kind === 'android') {
      must('adb', ['install', '-r', build]);
      must('adb', ['shell', 'monkey', '-p', ID, '-c', 'android.intent.category.LAUNCHER', '1']);
    } else {
      must('xcrun', ['simctl', 'install', 'booted', build]);
      must('xcrun', ['simctl', 'launch', 'booted', ID]);
    }
    await this.until(() => this.findDevDir(), timeoutMs, 'The app did not start on the phone');
  }

  private findDevDir(): boolean {
    const found =
      this.kind === 'android'
        ? spawnSync('adb', ['shell', 'run-as', ID, 'find', '.', '-path', '*/dev/screen.txt'], { encoding: 'utf8' })
        : (() => {
            const data = spawnSync('xcrun', ['simctl', 'get_app_container', 'booted', ID, 'data'], { encoding: 'utf8' });
            if (data.status !== 0) return data;
            return spawnSync('find', [data.stdout.trim(), '-path', '*/dev/screen.txt'], { encoding: 'utf8' });
          })();
    const path = found.stdout?.split('\n').find((line) => line.trim())?.trim();
    if (!path) return false;
    this.devDir = path.slice(0, -'/screen.txt'.length);
    return true;
  }

  override screen(): string {
    if (!this.devDir) return '';
    const file = `${this.devDir}/screen.txt`;
    const read =
      this.kind === 'android'
        ? spawnSync('adb', ['exec-out', 'run-as', ID, 'cat', file], { encoding: 'utf8', maxBuffer: 16 << 20 })
        : spawnSync('cat', [file], { encoding: 'utf8', maxBuffer: 16 << 20 });
    return read.status === 0 ? read.stdout : '';
  }

  protected override send(script: string) {
    const tmp = `${this.devDir}/drive.txt.tmp`;
    const file = `${this.devDir}/drive.txt`;
    if (this.kind === 'android') {
      // adb runs its arguments as one line of the phone's shell, so the redirect is quoted for
      // that shell to hand to run-as's. The move is a call of its own: after `exec-in` ends with
      // the script's end, the rest of its line is not run.
      must('adb', ['exec-in', `run-as ${ID} sh -c 'cat > ${tmp}'`], script);
      must('adb', ['shell', `run-as ${ID} mv ${tmp} ${file}`]);
    } else {
      must('sh', ['-c', 'cat > "$0" && mv "$0" "$1"', tmp, file], script);
    }
  }

  override logTail(): string {
    if (this.kind === 'android') {
      // The app's own lines only (the page's console, Tauri and Rust), and what is in dev/.
      const pid = spawnSync('adb', ['shell', 'pidof', ID], { encoding: 'utf8' }).stdout.trim();
      const lines = pid
        ? spawnSync('adb', ['logcat', '-d', '--pid', pid], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout
        : `${ID} is not running`;
      const dev = this.devDir
        ? spawnSync('adb', ['shell', `run-as ${ID} ls -la ${this.devDir}`], { encoding: 'utf8' }).stdout
        : '(no dev folder found)';
      return `dev/:\n${dev}\n${lines.split('\n').slice(-60).join('\n')}`;
    }
    const predicate = `subsystem == "${ID}" OR process CONTAINS "glaze"`;
    const log = spawnSync('xcrun', ['simctl', 'spawn', 'booted', 'log', 'show', '--last', '2m', '--style', 'compact', '--predicate', predicate], {
      encoding: 'utf8',
      maxBuffer: 16 << 20
    });
    return (log.stdout ?? '').split('\n').slice(-40).join('\n') || '(no log)';
  }

  override async stop() {
    if (this.kind === 'android') spawnSync('adb', ['shell', 'am', 'force-stop', ID]);
    else spawnSync('xcrun', ['simctl', 'terminate', 'booted', ID]);
  }
}

/** The host on this computer, and Ana, its admin, through the dev client. */
export class Host {
  readonly dir: string;
  private hostd: ChildProcess | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  client(...args: string[]): string {
    return must(exe('examples/dev-client'), [...args, '--as', 'Ana']);
  }

  /** A team vault with Ana and Ben, and a recipe; its host's store, served by hostd; and Ana's
   * replica of it, through which she syncs. */
  async start() {
    process.env.GLAZE_PASSWORD = PASSWORD;
    const at = (name: string) => join(this.dir, name);
    must(exe('examples/dev-client'), ['make-team', at('team'), '--as', 'Ana', '--add', 'Ben']);
    must(exe('examples/dev-client'), ['prepare', at('team'), at('host'), '--as', 'Ana']);
    must(exe('examples/dev-client'), ['join-local', at('team'), at('host'), at('ana'), '--as', 'Ana', '--add', 'Ben']);
    this.hostd = spawn(exe('hostd'), ['run', at('host')], { stdio: 'inherit' });
    for (let i = 0; i < 60; i++) {
      if (spawnSync(exe('examples/dev-client'), ['sync', at('ana'), '127.0.0.1:47917', '--as', 'Ana']).status === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('hostd did not answer');
  }

  /** Ana's replica syncs, then lists the newest records of a kind. */
  listed(kind: 'recipe' | 'mix'): string[] {
    this.client('sync', join(this.dir, 'ana'), '127.0.0.1:47917');
    return this.client('list', join(this.dir, 'ana'), kind).split('\n').filter(Boolean);
  }

  /** Ana pairs a computer for Ben: says the code, and approves whatever uses it. */
  pair(): { code: Promise<string>; approved: Promise<void> } {
    const child = spawn(exe('examples/dev-client'), ['pair-start', join(this.dir, 'ana'), '127.0.0.1:47917', '--as', 'Ana', '--for', 'Ben'], {
      env: process.env
    });
    let out = '';
    const code = new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (data) => {
        out += data;
        const found = /\b\d{4}-\d{4}\b/.exec(out);
        if (found) resolve(found[0]);
      });
      child.on('exit', () => reject(new Error(`No pairing code:\n${out}`)));
    });
    child.stderr.on('data', (data) => (out += data));
    const approved = new Promise<void>((resolve, reject) =>
      child.on('exit', (status) => (status === 0 ? resolve() : reject(new Error(`Pairing failed:\n${out}`))))
    );
    // Awaited only after the phone has joined; a failure before then shows there, not as a crash.
    approved.catch(() => {});
    return { code, approved };
  }

  stop() {
    this.hostd?.kill();
  }
}

/** Waits until Ana's replica lists something, syncing again each few seconds. */
async function reaches(host: Host, kind: 'recipe' | 'mix', found: (names: string[]) => boolean) {
  const deadline = Date.now() + SYNCED;
  let names: string[] = [];
  while (Date.now() < deadline) {
    names = host.listed(kind);
    if (found(names)) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`The host's ${kind}s did not change: ${names.join(', ')}`);
}

export interface PhoneScenario {
  name: string;
  run: (phone: Phone, host: Host) => Promise<void>;
}

export const phoneScenarios: PhoneScenario[] = [
  {
    name: 'The phone joins the host with a pairing code, and Ben signs in there',
    async run(phone, host) {
      const pairing = host.pair();
      const code = await pairing.code;
      await phone.run(
        'expect "Set up your vault" 120000',
        'click "Join a vault on this network"',
        'expect "Join a vault on this network"',
        `type "The vault's host" ${quote(phone.hostAddress)}`,
        `type "Pairing code" ${quote(code)}`,
        'type "This device\'s name, for the admin to see" "Ben\'s phone"',
        'click "Join"',
        'expect "Waiting for the admin to approve this computer" 30000'
      );
      await pairing.approved;
      const sheet = await phone.run(
        'expect "has joined the vault" 30000',
        'select "Your name" "Ben"',
        `type "Password" ${quote(PASSWORD)}`,
        'click "Unlock"',
        'expect "Welcome, Ben" 30000',
        `type "Your password" ${quote(BENS_PASSWORD)}`,
        `type "Type it again" ${quote(BENS_PASSWORD)}`,
        'click "Set my password"',
        'expect "Your recovery key" 30000'
      );
      await newRecoveryKey(phone, sheet);
      await phone.run(`expect "Shino" ${SYNCED}`);
    }
  },
  {
    name: 'A recipe saved on the phone reaches the host, and one saved there reaches the phone',
    async run(phone, host) {
      await phone.run('click "New recipe"', 'type "Recipe name" "Tenmoku"', 'click "Save"', 'expect "revision 1" 30000');
      await reaches(host, 'recipe', (names) => names.includes('Tenmoku'));
      host.client('save-recipe', join(host.dir, 'ana'), 'Celadon');
      host.listed('recipe');
      await phone.run('click "Recipes"', `expect "Celadon" ${SYNCED}`);
    }
  },
  {
    name: 'Ben logs a mix on the phone, and it reaches the host',
    async run(phone, host) {
      await phone.run(
        'click "Shino"',
        'click "Log a mix…"',
        'expect "# Mix of Shino"',
        'type "Dry batch size" "1000"',
        'click "Save"',
        'expect "revision 1" 30000'
      );
      await reaches(host, 'mix', (names) => names.length > 0);
    }
  }
];
