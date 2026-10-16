// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { runScript, words } from './devDriver';

afterEach(cleanup);

function Form() {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('material');
  const [shown, setShown] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  return (
    <main>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(`${name} (${kind}) submitted`);
        }}
      >
        <label htmlFor="name">Recipe name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="material">Raw material</option>
          <option value="frit">Frit</option>
        </select>
        <label>
          <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} /> Show password
        </label>
        <button type="button" onClick={() => setAsking(true)}>
          Save
        </button>
        <button type="button" disabled>
          Print
        </button>
      </form>
      {asking && (
        <div role="alertdialog">
          <button type="button" onClick={() => setSaved(`${name} (${kind})${shown ? ' shown' : ''}`)}>
            Save
          </button>
        </div>
      )}
      {saved && <p>{saved}</p>}
    </main>
  );
}

it('splits a line into words, keeping quoted text and patterns whole', () => {
  expect(words('type "Recipe name" "Shino \\"2\\"" in nav')).toEqual(['type', '"Recipe name"', '"Shino \\"2\\""', 'in', 'nav']);
  expect(words('click /^Revision 1/i #2')).toEqual(['click', '/^Revision 1/i', '#2']);
});

it('types, chooses, checks and clicks, waiting for what a click shows', async () => {
  render(<Form />);
  const report = await runScript(
    [
      '# a recipe',
      'type "Recipe name" "Shino"',
      'select "Kind" "Frit"',
      'check "Show password"',
      'click "Save"',
      'click "Save" in "alertdialog"'
    ].join('\n')
  );
  expect(report.every((line) => line.startsWith('ok'))).toBe(true);
  expect(document.body.textContent).toContain('Shino (frit) shown');
});

it('says which names are ambiguous, missing or disabled, and stops there', async () => {
  render(<Form />);
  await runScript('click "Save"');
  expect(await runScript('click "Save"\nclick "Print"')).toEqual([
    'FAIL click "Save": 2 elements are called "Save": add "in" a group, or #1 to #2.',
    '     1 more not run.'
  ]);
  expect(await runScript('click "Print"')).toEqual(['FAIL click "Print": Print is disabled.']);
  expect(await runScript('click /^Nope/')).toEqual(['FAIL click /^Nope/: Nothing on screen is called /^Nope/.']);
});

it('submits a form with Enter', async () => {
  render(<Form />);
  const report = await runScript('type "Recipe name" "Tenmoku"\npress "Enter"');
  expect(report).toEqual(['ok   type "Recipe name" "Tenmoku"', 'ok   press "Enter"']);
  expect(document.body.textContent).toContain('Tenmoku (material) submitted');
});

it('waits for text to show or to go', async () => {
  render(<Form />);
  expect(await runScript('type "Recipe name" "Shino"\nclick "Save"\nclick "Save" in "alertdialog"\nexpect "Shino (material)"')).toEqual([
    'ok   type "Recipe name" "Shino"',
    'ok   click "Save"',
    'ok   click "Save" in "alertdialog"',
    'ok   expect "Shino (material)"'
  ]);
  expect(await runScript('expect /shino \\(MATERIAL\\)/i\nexpect not "Celadon"')).toEqual([
    'ok   expect /shino \\(MATERIAL\\)/i',
    'ok   expect not "Celadon"'
  ]);
  expect(await runScript('expect not "Shino" 200')).toEqual(['FAIL expect not "Shino" 200: "Shino" is still on screen.']);
  expect(await runScript('expect "Celadon" 200')).toEqual(['FAIL expect "Celadon" 200: "Celadon" is not on screen.']);
  const started = Date.now();
  expect(await runScript('timeout 300\nexpect "Celadon"')).toEqual([
    'ok   timeout 300',
    'FAIL expect "Celadon": "Celadon" is not on screen.'
  ]);
  expect(Date.now() - started).toBeLessThan(1500);
});

it('finds a control inside a fieldset by its legend', async () => {
  render(
    <form>
      {['First', 'Second'].map((side) => (
        <fieldset key={side}>
          <legend>{side}</legend>
          <label htmlFor={side}>Recipe</label>
          <select id={side} defaultValue="a">
            <option value="a">Shino</option>
            <option value="b">Celadon</option>
          </select>
        </fieldset>
      ))}
    </form>
  );
  expect(await runScript('select "Recipe" "Celadon" in "Second"')).toEqual(['ok   select "Recipe" "Celadon" in "Second"']);
  const [first, second] = [...document.querySelectorAll('select')];
  expect([first.value, second.value]).toEqual(['a', 'b']);
});
