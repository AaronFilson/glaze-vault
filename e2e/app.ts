// The real app in development (`tauri dev`), with a throwaway vault, followed and driven through
// the screen and driver files of ui/devTools.ts.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A script the app could not finish, with the screen as it was. */
export class ScriptFailed extends Error {}

/** The "Last script:" lines: a heading, then what each command did. */
function lastScript(screen: string): string[] {
  const at = screen.indexOf('\nLast script:\n');
  if (at < 0) return [];
  return screen
    .slice(at + '\nLast script:\n'.length)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim());
}

/** The page's errors and React's warnings, which the screen file lists under "Problems:". */
function problems(screen: string): string[] {
  const match = /\nProblems:\n((?: {2}.*\n)+)/.exec(screen);
  return match ? match[1].trimEnd().split('\n') : [];
}

export class App {
  readonly dir: string;
  readonly vault: string;
  readonly files: string;
  readonly log: string;
  private readonly screenFile: string;
  private readonly driveFile: string;
  private child: ChildProcess | null = null;
  private exited = false;

  constructor(dir: string) {
    this.dir = dir;
    this.vault = join(dir, 'vault');
    this.files = join(dir, 'files');
    this.log = join(dir, 'dev.log');
    this.screenFile = join(dir, 'screen.txt');
    this.driveFile = join(dir, 'drive.txt');
    mkdirSync(this.files, { recursive: true });
  }

  /** Builds and opens the app, and waits for its first screen. */
  async start(timeoutMs: number) {
    const log = openSync(this.log, 'a');
    const env = {
      ...process.env,
      GLAZE_VAULT_DIR: this.vault,
      GLAZE_VAULT_SCREEN: this.screenFile,
      GLAZE_VAULT_DRIVE: this.driveFile,
      GLAZE_VAULT_SHOW_SECRETS: '1'
    };
    const windows = process.platform === 'win32';
    // Its own process group, so stopping it stops Vite and the app too.
    this.child = spawn(windows ? 'npx.cmd' : 'npx', ['tauri', 'dev', '--no-watch'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', log, log],
      detached: !windows,
      shell: windows
    });
    this.child.on('exit', () => (this.exited = true));
    await this.until(() => existsSync(this.screenFile), timeoutMs, 'The app did not start');
  }

  screen(): string {
    try {
      return readFileSync(this.screenFile, 'utf8');
    } catch {
      return '';
    }
  }

  /** Runs a script in the app (commands in ui/devDriver.ts) and returns the screen after it. */
  async run(...lines: string[]): Promise<string> {
    const before = lastScript(this.screen())[0];
    const problemsBefore = problems(this.screen()).length;
    writeFileSync(this.driveFile + '.tmp', lines.join('\n') + '\n');
    renameSync(this.driveFile + '.tmp', this.driveFile);
    let screen = '';
    await this.until(
      () => {
        screen = this.screen();
        const heading = lastScript(screen)[0];
        return heading !== before && / done /.test(heading ?? '');
      },
      120_000,
      'The script did not finish'
    );
    if (lastScript(screen).some((line) => line.startsWith('FAIL'))) throw new ScriptFailed(screen);
    const found = problems(screen);
    if (found.length > problemsBefore) throw new ScriptFailed(`The page reported a problem.\n\n${screen}`);
    return screen;
  }

  /** Waits for something, or fails saying what the app logged. */
  async until(done: () => boolean, timeoutMs: number, what: string) {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (this.exited) throw new Error(`${what}: it stopped.\n\n${this.logTail()}`);
      if (Date.now() > deadline) throw new Error(`${what} in ${timeoutMs / 1000} seconds.\n\n${this.logTail()}`);
      await pause(100);
    }
  }

  logTail(): string {
    try {
      // Without colours, and only the end of the build's progress lines.
      const text = readFileSync(this.log, 'utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      return text.split(/\r?\n/).slice(-30).join('\n');
    } catch {
      return '(no log)';
    }
  }

  async stop() {
    const child = this.child;
    if (!child?.pid || this.exited) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await this.until(() => this.exited, 10_000, 'The app did not stop').catch(() => {
      if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL');
    });
  }
}
