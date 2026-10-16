// Development builds only (main.tsx loads this when import.meta.env.DEV): lets work on the app be
// followed and driven without looking at it, from a script or a coding agent.
//
//     GLAZE_VAULT_DIR=/tmp/test-vault \
//     GLAZE_VAULT_SCREEN=/tmp/screen.txt GLAZE_VAULT_DRIVE=/tmp/drive.txt npm run dev
//
// The core writes the screen as text (devScreen.ts) to GLAZE_VAULT_SCREEN whenever it changes,
// with the page's errors and the last script's results at the end. A script written to
// GLAZE_VAULT_DRIVE is taken once and run (devDriver.ts lists its commands). Without the
// variables, the core's commands say so and the page stops asking.
//
// The screen file has the recipes on screen in plain text, so use a throwaway vault. Passwords
// and recovery words are left out, unless GLAZE_VAULT_SHOW_SECRETS=1 asks for them too, to get a
// script past the recovery key's check.
import { invoke } from '@tauri-apps/api/core';
import { runScript } from './devDriver';
import { describeScreen, squash } from './devScreen';

const problems: string[] = [];
let driven: string[] = [];
/** Whether the core says to show passwords and recovery words too: GLAZE_VAULT_SHOW_SECRETS. */
let secrets = false;

/** Keeps the page's errors and React's warnings, the newest last, to show with the screen. */
function collectProblems() {
  const keep = (text: string) => {
    problems.push(`${new Date().toLocaleTimeString()} ${squash(text).slice(0, 500)}`);
    if (problems.length > 20) problems.shift();
  };
  window.addEventListener('error', (event) => keep(`error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    keep(`unhandled rejection: ${reason instanceof Error ? reason.message : JSON.stringify(reason)}`);
  });
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    keep(`console.error: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`);
    consoleError(...args);
  };
}

function snapshot(): string {
  const parts = [`Glaze Vault screen, ${new Date().toLocaleString()}`, '', describeScreen(document.body, { secrets })];
  if (problems.length) parts.push('', 'Problems:', ...problems.map((p) => '  ' + p));
  if (driven.length) parts.push('', 'Last script:', ...driven.map((line) => '  ' + line));
  return parts.join('\n') + '\n';
}

/** Sends the screen to the core whenever it changes, until the core says nobody asked for it. */
function sendScreen(): () => void {
  let last = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const send = async () => {
    timer = undefined;
    if (stopped) return;
    const text = snapshot();
    // The heading line carries the time, so compare what is below it.
    const body = text.slice(text.indexOf('\n'));
    if (body === last) return;
    last = body;
    try {
      const file = await invoke<{ written: boolean; showSecrets: boolean }>('dev_screen', { text });
      if (!file.written) stop();
      if (file.showSecrets !== secrets) {
        secrets = file.showSecrets;
        soon();
      }
    } catch {
      // Not in Tauri (npm run dev:ui), or a release core without the command.
      stop();
    }
  };
  const soon = () => {
    if (!timer && !stopped) timer = setTimeout(send, 200);
  };

  const observer = new MutationObserver(soon);
  const events = ['input', 'change', 'focusin', 'toggle'];
  // Values typed into inputs and the clock in "Saved …" change without a mutation, so look again
  // now and then too.
  const interval = setInterval(soon, 2000);
  function stop() {
    stopped = true;
    observer.disconnect();
    events.forEach((type) => document.removeEventListener(type, soon, true));
    clearInterval(interval);
  }

  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  events.forEach((type) => document.addEventListener(type, soon, true));
  soon();
  return soon;
}

/** Asks the core for a script now and then, and runs it. */
function takeScripts(onDone: () => void) {
  const poll = async () => {
    let script: string | null;
    try {
      script = await invoke<string | null>('dev_drive');
    } catch {
      return; // No GLAZE_VAULT_DRIVE, or not in Tauri: stop asking.
    }
    if (script !== null) {
      const started = new Date().toLocaleTimeString();
      driven = [`started ${started}, running…`];
      onDone();
      driven = [`started ${started}, done ${new Date().toLocaleTimeString()}`, ...(await runScript(script))];
      onDone();
    }
    setTimeout(poll, 300);
  };
  void poll();
}

export function startDevTools() {
  collectProblems();
  const screenChanged = sendScreen();
  takeScripts(screenChanged);
}
