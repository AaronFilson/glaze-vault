// Development builds only (main.tsx loads it when import.meta.env.DEV): the screen as text, so
// work on the app can be followed without screenshots. The core's dev_screen command writes it to
// the file GLAZE_VAULT_SCREEN names, and does nothing when the variable is not set:
//
//     GLAZE_VAULT_DIR=/tmp/test-vault GLAZE_VAULT_SCREEN=/tmp/screen.txt npm run dev
//     cat /tmp/screen.txt
//
// The file is plain text with the recipes on screen in it, so point it at a throwaway vault.
// Passwords and recovery words (marked data-secret) are left out.
import { invoke } from '@tauri-apps/api/core';

const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DIV', 'DL', 'DT', 'FIGURE', 'FOOTER', 'H1', 'H2',
  'H3', 'H4', 'H5', 'H6', 'HR', 'LEGEND', 'LI', 'OL', 'P', 'PRE', 'SUMMARY', 'TBODY', 'TFOOT', 'THEAD', 'UL'
]);
const SKIPPED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'DATALIST', 'NOSCRIPT']);
/** Parts of the page shown as a titled group, by tag or role. */
const GROUPS: Record<string, string> = {
  HEADER: 'header',
  NAV: 'nav',
  MAIN: 'main',
  ASIDE: 'aside',
  FORM: 'form',
  FIELDSET: 'fieldset',
  TABLE: 'table',
  SECTION: 'section',
  DETAILS: 'details',
  DIALOG: 'dialog'
};
const ROLES = new Set(['alert', 'alertdialog', 'dialog', 'status']);

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const quote = (text: string) => JSON.stringify(squash(text));

function hidden(element: Element): boolean {
  if ((element as HTMLElement).hidden || element.classList.contains('visually-hidden')) return true;
  const style = getComputedStyle(element);
  return style.display === 'none' || style.visibility === 'hidden';
}

/** What a person would call a control: its aria-label, its label, or its placeholder. */
function nameOf(element: HTMLElement): string {
  const label = element.getAttribute('aria-label');
  if (label) return squash(label);
  const by = element.getAttribute('aria-labelledby');
  if (by) return squash(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
  const labels = (element as HTMLInputElement).labels;
  if (labels?.length) return squash(labels[0].textContent ?? '');
  return squash(element.getAttribute('placeholder') ?? element.getAttribute('title') ?? element.textContent ?? '');
}

function states(element: HTMLElement): string {
  const found: string[] = [];
  if (element.matches(':disabled')) found.push('disabled');
  if (element.getAttribute('aria-pressed') === 'true') found.push('pressed');
  const current = element.getAttribute('aria-current');
  if (current && current !== 'false') found.push('current');
  const expanded = element.getAttribute('aria-expanded');
  if (expanded) found.push(expanded === 'true' ? 'expanded' : 'collapsed');
  if (element.getAttribute('aria-invalid') === 'true') found.push('invalid');
  if (element === document.activeElement) found.push('focused');
  return found.length ? ` (${found.join(', ')})` : '';
}

/** A control as one token, such as [textbox "Recipe name" = "Shino"], or null if it is not one. */
function control(element: HTMLElement): string | null {
  const secret = element.closest('[data-secret]');
  switch (element.tagName) {
    case 'BUTTON':
      return `[button ${quote(nameOf(element))}${states(element)}]`;
    case 'A':
      return `[link ${quote(nameOf(element))}${states(element)}]`;
    case 'SELECT': {
      const select = element as HTMLSelectElement;
      const chosen = select.selectedOptions[0]?.textContent ?? '';
      return `[select ${quote(nameOf(element))} = ${quote(chosen)}${states(element)}]`;
    }
    case 'TEXTAREA':
    case 'INPUT': {
      const input = element as HTMLInputElement;
      const type = element.tagName === 'TEXTAREA' ? 'textbox' : input.type;
      // Inside its label, the label's own words follow it.
      const named = element.closest('label') ? '' : ' ' + quote(nameOf(element));
      if (type === 'checkbox') return `[${input.checked ? 'x' : ' '}]${named}${states(element)}`;
      if (type === 'radio') return `(${input.checked ? '•' : ' '})${named}${states(element)}`;
      if (type === 'hidden') return '';
      if (['button', 'submit', 'reset'].includes(type)) return `[button ${quote(input.value)}${states(element)}]`;
      const kind = type === 'text' || type === 'textbox' ? 'textbox' : type;
      const value =
        type === 'password' || secret
          ? input.value
            ? '(hidden)'
            : '""'
          : input.value
            ? JSON.stringify(input.value)
            : `""${input.placeholder ? ` placeholder ${quote(input.placeholder)}` : ''}`;
      return `[${kind} ${quote(nameOf(element))} = ${value}${states(element)}]`;
    }
    default:
      return null;
  }
}

/** The visible page as indented lines of text, with controls and their values. */
export function describeScreen(root: Element = document.body): string {
  const lines: string[] = [];
  let line = '';
  let depth = 0;
  const flush = () => {
    const text = squash(line);
    if (text) lines.push('  '.repeat(depth) + text);
    line = '';
  };

  const group = (title: string, walkInside: () => void) => {
    flush();
    lines.push('  '.repeat(depth) + title);
    depth += 1;
    walkInside();
    flush();
    depth -= 1;
  };

  const children = (element: Element) => element.childNodes.forEach(walk);

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent;
      return;
    }
    if (!(node instanceof HTMLElement) || SKIPPED.has(node.tagName) || hidden(node)) return;
    const tag = node.tagName;

    if (node.dataset.secret !== undefined && !control(node)) {
      line += ' (hidden) ';
      return;
    }
    const token = control(node);
    if (token !== null) {
      // Straight inside a form or other group, a control is a line of its own; in a row or a
      // sentence, it stays with its neighbours.
      const parent = node.parentElement;
      const alone = parent && (GROUPS[parent.tagName] || ROLES.has(parent.getAttribute('role') ?? ''));
      if (alone) flush();
      line += ` ${token} `;
      if (alone) flush();
      return;
    }
    if (tag === 'LABEL') {
      const target = (node as HTMLLabelElement).control;
      // A label for a control is said with the control.
      if (target && !node.contains(target)) return;
      // One around its checkbox is a line, like the control would be.
      flush();
      children(node);
      flush();
      return;
    }

    const role = node.getAttribute('role') ?? '';
    const kind = ROLES.has(role) ? role : GROUPS[tag];
    if (kind) {
      const label = node.getAttribute('aria-label');
      const extra =
        tag === 'DETAILS' ? ((node as HTMLDetailsElement).open ? ' open' : ' closed') : states(node).replace(/[()]/g, '');
      group(`[${kind}${label ? ' ' + quote(label) : ''}${extra}]`, () => {
        if (tag === 'DETAILS' && !(node as HTMLDetailsElement).open) {
          const summary = node.querySelector(':scope > summary');
          if (summary) walk(summary);
        } else {
          children(node);
        }
      });
      return;
    }

    if (tag === 'TR') {
      flush();
      const cells = [...node.children].filter((cell) => !hidden(cell));
      cells.forEach((cell, i) => {
        if (i > 0) line += ' | ';
        children(cell);
      });
      line = '| ' + line + ' |';
      flush();
      return;
    }
    if (tag === 'BR') {
      flush();
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      flush();
      line = '#'.repeat(Number(tag[1])) + ' ';
      children(node);
      flush();
      return;
    }
    if (BLOCKS.has(tag)) {
      flush();
      if (tag === 'LI') line = '- ';
      children(node);
      flush();
      return;
    }
    children(node);
  }

  walk(root);
  flush();
  return lines.join('\n');
}

const problems: string[] = [];

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
  const parts = [`Glaze Vault screen, ${new Date().toLocaleString()}`, '', describeScreen()];
  if (problems.length) parts.push('', 'Problems:', ...problems.map((p) => '  ' + p));
  return parts.join('\n') + '\n';
}

/** Sends the screen to the core whenever it changes, until the core says nobody asked for it. */
export function startDevScreen() {
  collectProblems();
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
      if (!(await invoke<boolean>('dev_screen', { text }))) stop();
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
}
