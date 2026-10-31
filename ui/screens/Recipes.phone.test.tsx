// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { fakeCore, show } from './recipesTestKit';

// The whole screen renders in jsdom, with the materials list, so give it time on slow machines.
vi.setConfig({ testTimeout: 30_000 });

it('has no bottom bar on a computer', async () => {
  fakeCore();
  show();
  await screen.findByRole('button', { name: 'Shino' });
  expect(screen.queryByRole('navigation', { name: 'Views' })).toBeNull();
});

it('leads a phone to recipes, the mix log and the firing log, and the rest under More', async () => {
  fakeCore();
  show('ios');
  const nav = await screen.findByRole('navigation', { name: 'Views' });
  const tabs = within(nav).getAllByRole('button').map((b) => b.textContent);
  expect(tabs).toEqual(['Recipes', 'Mix log', 'Firing log', 'More']);
  expect(within(nav).getByRole('button', { name: 'Recipes' }).getAttribute('aria-current')).toBe('page');

  await userEvent.click(within(nav).getByRole('button', { name: 'Mix log' }));
  expect(within(nav).getByRole('button', { name: 'Mix log' }).getAttribute('aria-current')).toBe('page');

  await userEvent.click(within(nav).getByRole('button', { name: 'More' }));
  const menu = within(nav).getByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Materials', 'Settings', 'Lock']);
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  expect(within(nav).queryByRole('menu')).toBeNull();
});

it("gives a phone's own vault import and backups", async () => {
  fakeCore();
  show('android');
  const nav = await screen.findByRole('navigation', { name: 'Views' });
  await userEvent.click(within(nav).getByRole('button', { name: 'More' }));
  await userEvent.click(within(nav).getByRole('menuitem', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { name: 'Import' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Backups' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Sharing' })).toBeTruthy();
});

it('leaves running a vault a phone joined to a computer', async () => {
  const core = fakeCore({ replica: true });
  show('ios');
  await waitFor(() => expect(core.called('network_status').length).toBeGreaterThan(0));
  const nav = await screen.findByRole('navigation', { name: 'Views' });
  await userEvent.click(within(nav).getByRole('button', { name: 'More' }));
  await userEvent.click(within(nav).getByRole('menuitem', { name: 'Settings' }));
  await screen.findByRole('heading', { name: 'Settings' });
  expect(await screen.findByText(/looked after on a computer/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Import' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Backups' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Audit log' })).toBeNull();
});
