// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft, LastBackup, RecipeHead, Settings } from '../api';
import { Recipes } from './Recipes';

// The whole screen renders in jsdom, with the materials list, so give it time on slow machines.
vi.setConfig({ testTimeout: 30_000 });

const STATUS = { exists: true, unlocked: true, version: '0.2.0', updatesConfigured: false };

const shino: RecipeHead = {
  recordId: 'record-1',
  revisionId: 'revision-1',
  number: 1,
  savedAt: Date.UTC(2026, 9, 1),
  content: { name: 'Shino', lines: [{ material: 'Nepheline Syenite', amount: '50' }], notes: '' }
};

/** Pretends to be the Rust commands, and records what was called. */
function fakeCore({
  settings = { autoLock: true, autoLockMinutes: 15, backupReminderDays: 30 },
  lastBackup = { at: Date.now(), fileName: 'b.gvbackup' },
  draft = null
}: { settings?: Settings; lastBackup?: LastBackup | null; draft?: Draft | null } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    switch (cmd) {
      case 'list_recipes':
        return [shino];
      case 'get_settings':
        return settings;
      case 'last_backup':
        return lastBackup;
      case 'take_draft':
        return draft;
      default:
        return null;
    }
  });
  return { called: (cmd: string) => calls.filter((c) => c.cmd === cmd) };
}

function show() {
  const onLocked = vi.fn();
  render(<Recipes status={STATUS} update={null} onUpdate={() => {}} onLocked={onLocked} />);
  return onLocked;
}

afterEach(() => {
  cleanup();
  clearMocks();
  vi.useRealTimers();
});

describe('unsaved changes', () => {
  it('asks before locking, and can keep editing or discard', async () => {
    const core = fakeCore();
    const onLocked = show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Shino 2' } });

    await user.click(screen.getByRole('button', { name: 'Lock' }));
    expect(screen.getByRole('alertdialog')).toHaveProperty('textContent', expect.stringContaining('not saved'));
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(core.called('lock')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Lock' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(onLocked).toHaveBeenCalledWith('manual'));
    expect(core.called('lock')).toHaveLength(1);
  });
});

describe('locking by itself', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 9));
  });

  it('keeps unsaved changes as a draft', async () => {
    const core = fakeCore({ settings: { autoLock: true, autoLockMinutes: 5, backupReminderDays: 0 } });
    const onLocked = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Shino, more iron' } });

    vi.setSystemTime(Date.UTC(2026, 9, 14, 9, 4));
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(core.called('lock_with_draft')).toHaveLength(0);

    vi.setSystemTime(Date.UTC(2026, 9, 14, 9, 10));
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(onLocked).toHaveBeenCalledWith('idle-with-draft'));
    expect(core.called('lock_with_draft')[0].args.draft).toEqual({
      revisionId: 'revision-1',
      content: { ...shino.content, name: 'Shino, more iron' }
    });
  });

  it('just locks when nothing is unsaved', async () => {
    const core = fakeCore({ settings: { autoLock: true, autoLockMinutes: 5, backupReminderDays: 0 } });
    const onLocked = show();
    await screen.findByRole('button', { name: 'Shino' });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 10));
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(onLocked).toHaveBeenCalledWith('idle'));
    expect(core.called('lock')).toHaveLength(1);
  });

  it('stays open when switched off', async () => {
    const core = fakeCore({ settings: { autoLock: false, autoLockMinutes: 5, backupReminderDays: 0 } });
    const onLocked = show();
    await screen.findByRole('button', { name: 'Shino' });
    vi.setSystemTime(Date.UTC(2026, 9, 15));
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(onLocked).not.toHaveBeenCalled();
    expect(core.called('lock')).toHaveLength(0);
  });
});

it('brings a kept draft back after unlocking', async () => {
  fakeCore({ draft: { revisionId: 'revision-1', content: { ...shino.content, name: 'Shino, kept' } } });
  show();
  expect(await screen.findByDisplayValue('Shino, kept')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('were not saved when the vault locked');
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(screen.getByDisplayValue('Shino')).toBeTruthy();
});

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
  const print = vi.fn();
  window.print = print;
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
