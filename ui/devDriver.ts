// Development builds only: works the page from a script, the other half of devScreen.ts. The core's
// dev_drive command hands over the file GLAZE_VAULT_DRIVE names, once, and the page runs it:
//
//     GLAZE_VAULT_SCREEN=/tmp/screen.txt GLAZE_VAULT_DRIVE=/tmp/drive.txt npm run dev
//     printf '%s\n' 'type "Recipe name" "Shino"' 'click "Save"' > /tmp/drive.txt
//     cat /tmp/screen.txt          # the screen, then what each command did
//
// One command a line; names are as the screen file shows them, in quotes:
//
//     click "Save"                       a button, link, checkbox, summary or list entry
//     click "Save" in "alertdialog"      only inside a group: its kind or label in the screen file
//     click "Save" #2                    the second of several with that name
//     type "Recipe name" "Shino"         replaces a field's text
//     select "Kind" "Frit"               chooses an option by its text
//     check "Show password" / uncheck "Show password"
//     press "Enter"                      a key, to the focused element; Enter submits its form
//     pick "/tmp/recipes.glz"            the file the next open or save dialog chooses, unasked
//     expect "Saved"                     waits for text anywhere in the screen file, or fails
//     expect not "Unsaved" 5000          waits for it to go; a number of milliseconds waits longer
//     wait 500                           milliseconds
//     # a comment
//
// A name in slashes, such as /^Revision 1/, is a regular expression. Each command waits up to
// two seconds for its element, so one can follow a click that changes the screen. Expect matches
// part of the screen file's text (devScreen.ts), passwords and recovery words left out.
import { invoke } from '@tauri-apps/api/core';
import { describeScreen, hidden, nameOf, squash } from './devScreen';

const CONTROLS = 'button, a[href], input, select, textarea, summary';
const FIND_FOR_MS = 2000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Splits a line into words, keeping "quoted text" (JSON string rules) and /regex/ whole. */
export function words(line: string): string[] {
  const found: string[] = [];
  const pattern = /\s*("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)+\/[a-z]*|\S+)/gy;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) && match[1]) found.push(match[1]);
  return found;
}

const unquote = (word: string) => (word.startsWith('"') ? (JSON.parse(word) as string) : word);

function matcher(word: string): (text: string) => boolean {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(word);
  if (regex) {
    const pattern = new RegExp(regex[1], regex[2]);
    return (text) => pattern.test(text);
  }
  const wanted = unquote(word);
  return (text) => text === wanted;
}

function visible(element: Element): boolean {
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (hidden(at)) return false;
    // A closed <details> shows only its summary.
    const details = at.parentElement;
    if (details?.tagName === 'DETAILS' && !(details as HTMLDetailsElement).open && at.tagName !== 'SUMMARY') return false;
  }
  return true;
}

/** Groups as the screen file titles them: [alertdialog], [nav "Recipes"]. */
function groupMatches(element: Element, test: (text: string) => boolean): boolean {
  const label = element.getAttribute('aria-label');
  const role = element.getAttribute('role');
  const kind = role ?? element.tagName.toLowerCase();
  return test(kind) || (!!label && test(label));
}

function candidates(name: string, scope: string | undefined): HTMLElement[] {
  const test = matcher(name);
  const inScope = scope ? matcher(scope) : null;
  return [...document.querySelectorAll<HTMLElement>(CONTROLS)].filter((element) => {
    if (!visible(element)) return false;
    if (inScope) {
      let inside = false;
      for (let at = element.parentElement; at && !inside; at = at.parentElement) inside = groupMatches(at, inScope);
      if (!inside) return false;
    }
    return test(element.tagName === 'SUMMARY' ? squash(element.textContent ?? '') : nameOf(element));
  });
}

/** Finds the one element a command means, waiting a moment for it to appear. */
async function find(args: string[]): Promise<HTMLElement> {
  const name = args[0];
  if (!name) throw new Error('Say which element, in quotes.');
  const scopeAt = args.indexOf('in');
  const scope = scopeAt > 0 ? args[scopeAt + 1] : undefined;
  const nth = args.find((arg) => /^#\d+$/.test(arg));
  const deadline = Date.now() + FIND_FOR_MS;
  for (;;) {
    const found = candidates(name, scope);
    if (nth) {
      const element = found[Number(nth.slice(1)) - 1];
      if (element) return element;
    } else if (found.length === 1) {
      return found[0];
    } else if (found.length > 1) {
      throw new Error(`${found.length} elements are called ${name}: add "in" a group, or #1 to #${found.length}.`);
    }
    if (Date.now() > deadline) throw new Error(`Nothing on screen is called ${name}${scope ? ` in ${scope}` : ''}.`);
    await pause(100);
  }
}

/** Sets a field's value the way typing would, so React sees the change. */
function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

/** What Enter in a field does. Older WebKit, such as macOS 12's, has no requestSubmit. */
function submit(form: HTMLFormElement) {
  if (typeof form.requestSubmit === 'function') return form.requestSubmit();
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"], input[type="submit"]');
  if (button) button.click();
  else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function disabled(element: HTMLElement) {
  if (element.matches(':disabled')) throw new Error(`${nameOf(element)} is disabled.`);
}

/** Waits for text on screen, or for it to go. Quoted text matches any part of the screen. */
async function expectText(args: string[]) {
  const absent = args[0] === 'not';
  const [what, ms] = absent ? args.slice(1) : args;
  if (!what) throw new Error('Say what text, in quotes.');
  const regex = /^\/(.+)\/([a-z]*)$/.exec(what);
  const pattern = regex ? new RegExp(regex[1], regex[2]) : null;
  const wanted = unquote(what);
  const deadline = Date.now() + (Number(ms) || FIND_FOR_MS);
  for (;;) {
    const screen = describeScreen(document.body);
    const found = pattern ? pattern.test(screen) : screen.includes(wanted);
    if (found !== absent) return;
    if (Date.now() > deadline) throw new Error(absent ? `${what} is still on screen.` : `${what} is not on screen.`);
    await pause(100);
  }
}

async function run(line: string): Promise<void> {
  const [command, ...args] = words(line);
  switch (command) {
    case 'click': {
      const element = await find(args);
      disabled(element);
      element.click();
      return;
    }
    case 'check':
    case 'uncheck': {
      const element = (await find(args)) as HTMLInputElement;
      disabled(element);
      if (element.checked !== (command === 'check')) element.click();
      return;
    }
    case 'type': {
      const element = (await find([args[0], ...args.slice(2)])) as HTMLInputElement | HTMLTextAreaElement;
      if (!('value' in element) || element.tagName === 'BUTTON') throw new Error(`${args[0]} is not a field.`);
      disabled(element);
      element.focus();
      setValue(element, args[1] === undefined ? '' : unquote(args[1]));
      return;
    }
    case 'select': {
      const element = (await find([args[0], ...args.slice(2)])) as HTMLSelectElement;
      if (element.tagName !== 'SELECT') throw new Error(`${args[0]} is not a list to choose from.`);
      disabled(element);
      const test = matcher(args[1] ?? '""');
      const option = [...element.options].find((o) => test((o.textContent ?? '').trim()));
      if (!option) throw new Error(`${args[0]} has no option ${args[1]}.`);
      setValue(element, option.value);
      return;
    }
    case 'press': {
      const key = unquote(args[0] ?? '');
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      const init = { key, bubbles: true, cancelable: true };
      const go = target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      const form = (target as HTMLInputElement).form;
      if (go && key === 'Enter' && form && target.tagName === 'INPUT') submit(form);
      return;
    }
    case 'pick': {
      if (!args[0]) throw new Error('Say which file, in quotes.');
      await invoke('dev_pick', { path: unquote(args[0]) });
      return;
    }
    case 'expect':
      return expectText(args);
    case 'wait':
      await pause(Number(args[0]) || 0);
      return;
    default:
      throw new Error(`There is no command ${command}.`);
  }
}

/** Runs a script line by line, stopping at the first failure. Returns what each line did. */
export async function runScript(script: string): Promise<string[]> {
  const report: string[] = [];
  const lines = script.split(/\r?\n/).map((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    if (!line || line.startsWith('#')) continue;
    try {
      await run(line);
      report.push(`ok   ${line}`);
      // Lets React render before the next command looks.
      await pause(50);
    } catch (e) {
      report.push(`FAIL ${line}: ${(e as Error).message}`);
      const skipped = lines.slice(index + 1).filter((l) => l && !l.startsWith('#')).length;
      if (skipped) report.push(`     ${skipped} more not run.`);
      break;
    }
  }
  return report;
}
