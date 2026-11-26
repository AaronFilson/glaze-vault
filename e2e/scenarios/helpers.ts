import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../app.ts';

export interface Scenario {
  name: string;
  run: (app: App, vault: Vault) => Promise<void>;
}

/** What the scenarios learn about the vault as they go. */
export interface Vault {
  password: string;
  recoveryWords: string[];
  /** Once the vault is shared, the organization's recovery key. */
  organizationWords: string[];
}

export const PASSWORD = 'kiln shelf wadding';
export const CHANGED_PASSWORD = 'glaze kiln wedge';
export const ONE_TIME = 'pass this on';
export const BENS_PASSWORD = 'bens own password';
export const ADMIN_PASSWORD = 'back in again';
export const NEW_PASSWORD = 'bisque cone nine';

export const quote = (text: string) => JSON.stringify(text);
export const fileIn = (app: App, name: string) => join(app.files, name);

/** Types a recipe's lines into the editor, adding rows as needed. */
export function recipeLines(lines: [string, string][]): string[] {
  return lines.flatMap(([material, amount], i) => [
    ...(i > 0 ? ['click "Add material"'] : []),
    `type "Material ${i + 1}" ${quote(material)}`,
    `type "Amount ${i + 1}" ${quote(amount)}`
  ]);
}

/** Reads the recovery words off the sheet on screen, and types back the ones the check asks for. */
export async function newRecoveryKey(app: App, sheet: string): Promise<string[]> {
  const words = [...sheet.matchAll(/^ *- (\d+) ([a-z]+)$/gm)].map((match) => match[2]);
  if (words.length !== 24) throw new Error(`Expected 24 recovery words:\n\n${sheet}`);
  const check = await app.run(
    'check /^I have printed or written down/',
    'click "Continue"',
    'expect "Check your recovery key"'
  );
  const asked = [...check.matchAll(/\[textbox "Word (\d+)"/g)].map((match) => Number(match[1]));
  if (asked.length !== 3) throw new Error(`Expected three words to check:\n\n${check}`);
  // "Open my vault" when setting up, "Done" for a new key from Settings.
  const finish = /\[button "(Open my vault|Done)"/.exec(check)?.[1] ?? 'Open my vault';
  await app.run(...asked.map((n) => `type "Word ${n}" ${quote(words[n - 1])}`), `click ${quote(finish)}`);
  return words;
}

/** A day as the app shows it, YYYY-MM-DD. */
export const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const unlock = (password: string) => [
  'expect "Unlock your vault" 5000',
  `type "Password" ${quote(password)}`,
  'click "Unlock"',
  'expect "New recipe" 30000'
];

export function readable(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').length > 0;
  } catch {
    return false;
  }
}
