// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft } from '../api';
import { DRAFT_DELAY_MS } from './Recipes';
import { shino, spar, fakeCore, show } from './recipesTestKit';

// The whole screen renders in jsdom, with the materials list, so give it time on slow machines.
vi.setConfig({ testTimeout: 30_000 });

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
    const core = fakeCore({ settings: { autoLock: true, autoLockMinutes: 5, backupReminderDays: 0, phoneBackups: true } });
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
      recipe: { recordId: 'record-1', revisionId: 'revision-1', content: { ...shino.content, name: 'Shino, more iron' } }
    });
  });

  it('keeps unsaved changes to a material too', async () => {
    const core = fakeCore({ materials: [spar], settings: { autoLock: true, autoLockMinutes: 5, backupReminderDays: 0, phoneBackups: true } });
    const onLocked = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Lot 7, March' } });

    vi.setSystemTime(Date.UTC(2026, 9, 14, 9, 10));
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(onLocked).toHaveBeenCalledWith('idle-with-draft'));
    expect(core.called('lock_with_draft')[0].args.draft).toEqual({
      material: {
        recordId: 'material-1',
        revisionId: 'material-revision-1',
        content: { ...spar.content, notes: 'Lot 7, March' }
      }
    });
  });

  it('just locks when nothing is unsaved', async () => {
    const core = fakeCore({ settings: { autoLock: true, autoLockMinutes: 5, backupReminderDays: 0, phoneBackups: true } });
    const onLocked = show();
    await screen.findByRole('button', { name: 'Shino' });
    // Lets the idle lock start listening before the key goes down.
    await act(async () => {});
    vi.setSystemTime(Date.UTC(2026, 9, 14, 10));
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(onLocked).toHaveBeenCalledWith('idle'));
    expect(core.called('lock')).toHaveLength(1);
  });

  it('stays open when switched off', async () => {
    const core = fakeCore({ settings: { autoLock: false, autoLockMinutes: 5, backupReminderDays: 0, phoneBackups: true } });
    const onLocked = show();
    await screen.findByRole('button', { name: 'Shino' });
    vi.setSystemTime(Date.UTC(2026, 9, 15));
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(onLocked).not.toHaveBeenCalled();
    expect(core.called('lock')).toHaveLength(0);
  });
});

describe('drafts', () => {
  it('brings kept changes back after unlocking', async () => {
    const core = fakeCore({
      draft: { recipe: { recordId: 'record-1', revisionId: 'revision-1', content: { ...shino.content, name: 'Shino, kept' } } }
    });
    show();
    expect(await screen.findByDisplayValue('Shino, kept')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('unsaved changes to Shino, kept from last time');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByDisplayValue('Shino')).toBeTruthy();
    await waitFor(() => expect(core.called('clear_draft')).toHaveLength(1));
  });

  it('says kept changes to a material are there, from the recipes', async () => {
    fakeCore({
      materials: [spar],
      draft: {
        recipe: { recordId: 'record-1', revisionId: 'revision-1', content: { ...shino.content, name: 'Shino, kept' } },
        material: { recordId: 'material-1', revisionId: 'material-revision-1', content: { ...spar.content, loi: '1' } }
      }
    });
    show();
    expect(await screen.findByDisplayValue('Shino, kept')).toBeTruthy();
    const notice = screen.getByText('Spar, lot 7').closest('.notice') as HTMLElement;
    expect(notice.textContent).toContain('unsaved changes to Spar, lot 7 from last time');
    fireEvent.click(within(notice).getByRole('button', { name: 'Show them' }));
    expect((screen.getByLabelText('Loss on ignition') as HTMLInputElement).value).toBe('1');
  });

  it('leaves out changes that were saved after they were kept', async () => {
    const core = fakeCore({
      draft: { recipe: { recordId: 'record-1', revisionId: 'revision-0', content: shino.content } }
    });
    show();
    await screen.findByRole('button', { name: 'Shino' });
    expect(screen.queryByText(/from last time/)).toBeNull();
    expect((screen.getByLabelText('Recipe name') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(core.called('clear_draft')).toHaveLength(1));
  });

  it('brings back a firing that was being logged', async () => {
    const content = {
      recipe: 'record-1',
      recipeNumber: 1,
      recipeName: 'Shino',
      firedOn: '2026-10-15',
      cone: '10',
      notes: 'Ran at the foot',
      photos: []
    };
    const core = fakeCore({ draft: { firing: { recordId: null, revisionId: null, content } } });
    show();
    expect(await screen.findByDisplayValue('Ran at the foot')).toBeTruthy();
    const notice = screen.getByText(/the firing of Shino from last time/).closest('.notice') as HTMLElement;
    fireEvent.click(within(notice).getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByDisplayValue('Ran at the foot')).toBeNull();
    await waitFor(() => expect(core.called('clear_draft')).toHaveLength(1));
  });

  it('keeps a firing being logged when locking, without asking', async () => {
    const core = fakeCore();
    const onLocked = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log a firing…' }));
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Crawled by the handle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await waitFor(() => expect(onLocked).toHaveBeenCalledWith('manual'));
    expect(core.called('lock')).toHaveLength(0);
    const kept = core.called('lock_with_draft')[0].args.draft as Draft;
    expect(kept.firing).toMatchObject({ recordId: null, content: { recipe: 'record-1', notes: 'Crawled by the handle' } });
  });

  it('keeps unsaved changes a moment after typing, and forgets them once saved', async () => {
    const core = fakeCore({ recipes: [] });
    show();
    await screen.findByText('No recipes yet.');
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Tenmoku' } });
    fireEvent.change(screen.getByLabelText('Material 1'), { target: { value: 'Silica' } });
    expect(core.called('save_draft')).toHaveLength(0);
    await waitFor(() => expect(core.called('save_draft')).toHaveLength(1), { timeout: DRAFT_DELAY_MS * 3 });
    expect(core.called('save_draft')[0].args.draft).toEqual({
      recipe: {
        recordId: null,
        revisionId: null,
        content: { name: 'Tenmoku', lines: [{ material: 'Silica', amount: '' }], notes: '' }
      }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('clear_draft')).toHaveLength(1));
    expect(core.called('save_record')[0].args.kind).toBe('recipe');
  });
});
