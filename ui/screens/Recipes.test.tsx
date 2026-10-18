// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Access, RecipeHead } from '../api';
import { shino, spar, fakeCore, show } from './recipesTestKit';

// The whole screen renders in jsdom, with the materials list, so give it time on slow machines.
vi.setConfig({ testTimeout: 30_000 });

describe('backup reminder', () => {
  it('shows when there has been no backup', async () => {
    fakeCore({ lastBackup: null });
    show();
    expect(await screen.findByText(/have not been backed up yet/)).toBeTruthy();
  });

  it('shows after the chosen number of days, and not before', async () => {
    const day = 24 * 60 * 60 * 1000;
    fakeCore({ lastBackup: { at: Date.now() - 31 * day, fileName: 'old.gvbackup' } });
    show();
    expect(await screen.findByText(/last backup was 31 days ago/)).toBeTruthy();
    cleanup();
    fakeCore({ lastBackup: { at: Date.now() - 29 * day, fileName: 'recent.gvbackup' } });
    show();
    await screen.findByRole('button', { name: 'Shino' });
    expect(screen.queryByText(/last backup was/)).toBeNull();
  });

  it('says why a backup failed, in the reminder', async () => {
    fakeCore({ lastBackup: null });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Back up now…' }));
    const notice = screen.getByText(/have not been backed up yet/).closest('.notice') as HTMLElement;
    expect((await within(notice).findByRole('alert')).textContent).toContain('the disk is full');
  });

  it('stays quiet when switched off', async () => {
    fakeCore({ lastBackup: null, settings: { autoLock: true, autoLockMinutes: 15, backupReminderDays: 0 } });
    show();
    await screen.findByRole('button', { name: 'Shino' });
    expect(screen.queryByText(/backed up/)).toBeNull();
  });
});

it('switches auto-lock off from Settings', async () => {
  const core = fakeCore();
  show();
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'Shino' });
  await user.click(screen.getByRole('button', { name: 'Settings' }));
  await user.click(screen.getByLabelText(/Lock the vault when Glaze Vault has not been used/));
  await waitFor(() => expect(core.called('set_settings')).toHaveLength(1));
  expect(core.called('set_settings')[0].args.settings).toEqual({
    autoLock: false,
    autoLockMinutes: 15,
    backupReminderDays: 30
  });
  expect((screen.getByLabelText('Lock after') as HTMLSelectElement).disabled).toBe(true);
});

it('prints a batch sheet scaled to the batch size', async () => {
  fakeCore();
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Shino' }));
  await user.click(screen.getByRole('button', { name: 'Print…' }));
  await user.click(screen.getByLabelText('A batch sheet for weighing out'));
  await user.clear(screen.getByLabelText('Batch size'));
  await user.type(screen.getByLabelText('Batch size'), '2.5');
  await user.selectOptions(screen.getByLabelText('Unit'), 'kg');
  await user.click(screen.getByRole('button', { name: 'Print' }));
  expect(print).toHaveBeenCalledTimes(1);
  const paper = document.querySelector('.paper')!;
  expect(paper.textContent).toContain('Batch sheet: Shino');
  expect(paper.querySelector('.weight')!.textContent).toBe((2.5).toLocaleString(undefined, { minimumFractionDigits: 3 }));
});

it('offers each export only when there is something to export', async () => {
  fakeCore({ recipes: [], materials: [spar] });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  const enabled = (name: string) => !(screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
  expect(enabled('Export as CSV…')).toBe(false);
  expect(enabled('Export as JSON…')).toBe(true);
  expect(enabled('Export materials as CSV…')).toBe(true);
  cleanup();
  fakeCore({ materials: [] });
  show();
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  expect(enabled('Export as CSV…')).toBe(true);
  expect(enabled('Export materials as CSV…')).toBe(false);
});

it('switches to a vault a restore set aside, after asking', async () => {
  const core = fakeCore({ setAside: [{ name: 'replaced-1', setAsideAt: Date.UTC(2026, 9, 1) }] });
  const onLocked = show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  await user.click(await screen.findByRole('button', { name: 'Switch to it…' }));
  await user.click(screen.getByRole('button', { name: 'Switch vaults' }));
  await waitFor(() => expect(onLocked).toHaveBeenCalledWith('switched'));
  expect(core.called('bring_back_vault')[0].args).toEqual({ name: 'replaced-1' });
});

it('imports what was chosen from a file, skipping names already in use unless told', async () => {
  const contents = [
    'filetype = GlazeChem Glazes',
    'name = Shino',
    'component = Nepheline Syenite',
    'amount = 60',
    'name = Tenmoku',
    'component = Custer Spar',
    'amount = 40',
    'component = Unobtainium',
    'amount = 5'
  ].join('\n');
  const core = fakeCore({ importFile: { fileName: 'Highfire.glz', contents } });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  await user.click(screen.getByRole('button', { name: 'Import from a file…' }));
  expect(await screen.findByRole('heading', { name: 'Import from Highfire.glz' })).toBeTruthy();
  expect(screen.getByText(/not found: Unobtainium/)).toBeTruthy();
  const shinoChoice = screen.getByLabelText('What to do with Shino') as HTMLSelectElement;
  expect(shinoChoice.value).toBe('skip');
  await user.click(screen.getByRole('button', { name: 'Import 1 recipe and 0 materials' }));
  await waitFor(() => expect(core.called('save_records')).toHaveLength(1));
  expect(core.called('save_records')[0].args).toMatchObject({ kind: 'recipe', revisions: [[null, { name: 'Tenmoku' }]] });
  expect(await screen.findByText(/1 recipe and 0 materials imported from Highfire.glz/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Done' }));

  await user.click(screen.getByRole('button', { name: 'Import from a file…' }));
  await user.selectOptions(await screen.findByLabelText('What to do with Shino'), 'revision');
  await user.selectOptions(screen.getByLabelText('What to do with Tenmoku'), 'copy');
  await user.click(screen.getByRole('button', { name: 'Import 2 recipes and 0 materials' }));
  await waitFor(() => expect(core.called('save_records')).toHaveLength(2));
  expect(core.called('save_records')[1].args).toMatchObject({
    revisions: [
      ['revision-1', { name: 'Shino' }],
      [null, { name: 'Tenmoku (imported)' }]
    ]
  });
});

it('saves the rest of a batch that fails, and says which could not be saved', async () => {
  const contents = ['filetype = GlazeChem Glazes', 'name = Celadon', 'name = Too large', 'name = Ash'].join('\n');
  const core = fakeCore({ recipes: [], importFile: { fileName: 'Big.glz', contents } });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  await user.click(screen.getByRole('button', { name: 'Import from a file…' }));
  await user.click(await screen.findByRole('button', { name: 'Import 3 recipes and 0 materials' }));
  expect(await screen.findByText(/2 recipes and 0 materials imported from Big.glz/)).toBeTruthy();
  expect(screen.getByText('Too large: That is too large to save.')).toBeTruthy();
  expect(core.called('save_records')).toHaveLength(1);
  expect(core.called('save_record').map((call) => (call.args.content as { name: string }).name)).toEqual([
    'Celadon',
    'Too large',
    'Ash'
  ]);
});

it('says why a file cannot be imported', async () => {
  fakeCore({ importFile: { fileName: 'prices.csv', contents: 'Name,Price\nSilica,1\n' } });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  await user.click(screen.getByRole('button', { name: 'Import from a file…' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/a column for each oxide/);
});

describe('a role without chemistry', () => {
  it('sees a recipe’s name and details, and no lines, unity formula, comparing or printing', async () => {
    const sales: Access = {
      team: true,
      me: { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false },
      collections: [
        { id: 'shared', name: 'Shared', owner: null, role: 'role:sales', changes: ['firing'], export: false, print: false, chemistry: false, manage: false }
      ]
    };
    // The core sends the summary alone.
    const summary = { ...shino, collectionId: 'shared', content: { name: 'Shino', cone: '10' } } as unknown as RecipeHead;
    fakeCore({ access: sales, recipes: [summary] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    expect(screen.getByText(/not its materials, amounts or notes/)).toBeTruthy();
    expect((screen.getByLabelText('Cone') as HTMLInputElement).value).toBe('10');
    expect(screen.queryByLabelText('Material 1')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Unity formula' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Print…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Log a firing…' })).toBeTruthy();
  });
});
