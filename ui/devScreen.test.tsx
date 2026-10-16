// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { describeScreen } from './devScreen';

afterEach(cleanup);

it('describes the screen as text, with controls and their values', () => {
  render(
    <div className="shell">
      <header>
        <span>Glaze Vault</span>
        <button type="button" aria-pressed="true">
          Materials
        </button>
      </header>
      <div role="alertdialog">
        <p>
          <strong>Shino</strong> has changes that are not saved.
        </p>
        <button type="button">Save</button>
      </div>
      <main>
        <label htmlFor="name">Recipe name</label>
        <input id="name" value="Shino" readOnly />
        <table>
          <tbody>
            <tr>
              <td>
                <input aria-label="Material 1" value="Silica" readOnly />
              </td>
              <td>30</td>
            </tr>
          </tbody>
        </table>
        <label>
          <input type="checkbox" checked readOnly /> Lock by itself
        </label>
        <details>
          <summary>Earlier revisions (2)</summary>
          <p>Revision 1</p>
        </details>
        <button type="button" disabled>
          Save
        </button>
        <span className="visually-hidden">Remove</span>
      </main>
    </div>
  );
  expect(describeScreen()).toBe(
    [
      '[header]',
      '  Glaze Vault',
      '  [button "Materials" (pressed)]',
      '[alertdialog]',
      '  Shino has changes that are not saved.',
      '  [button "Save"]',
      '[main]',
      '  [textbox "Recipe name" = "Shino"]',
      '  [table]',
      '    | [textbox "Material 1" = "Silica"] | 30 |',
      '  [x] Lock by itself',
      '  [details closed]',
      '    Earlier revisions (2)',
      '  [button "Save" (disabled)]'
    ].join('\n')
  );
});

it('leaves out passwords and recovery words', () => {
  render(
    <main>
      <label htmlFor="password">Password</label>
      <input id="password" type="password" value="correct horse" readOnly />
      <label htmlFor="shown">New password</label>
      <input id="shown" type="text" data-secret value="battery staple" readOnly />
      <ol className="words" data-secret>
        <li>abandon</li>
        <li>ability</li>
      </ol>
    </main>
  );
  const text = describeScreen();
  expect(text).toContain('[password "Password" = (hidden)]');
  expect(text).toContain('[textbox "New password" = (hidden)]');
  expect(text).not.toMatch(/correct horse|battery staple|abandon|ability/);
});
