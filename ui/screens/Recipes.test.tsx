// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Access, Draft, LastBackup, MaterialHead, RecipeHead, Settings } from '../api';
import { DRAFT_DELAY_MS, Recipes } from './Recipes';

// The whole screen renders in jsdom, with the materials list, so give it time on slow machines.
vi.setConfig({ testTimeout: 30_000 });

const STATUS = { exists: true, unlocked: true, version: '0.2.0', updatesConfigured: false, people: [] };

const shino: RecipeHead = {
  recordId: 'record-1',
  revisionId: 'revision-1',
  number: 1,
  savedAt: Date.UTC(2026, 9, 1),
  content: { name: 'Shino', lines: [{ material: 'Nepheline Syenite', amount: '50' }], notes: '' }
};

const spar: MaterialHead = {
  recordId: 'material-1',
  revisionId: 'material-revision-1',
  number: 1,
  savedAt: Date.UTC(2026, 9, 1),
  content: {
    name: 'Spar, lot 7',
    category: 'material',
    oxides: [
      { oxide: 'K2O', percent: '12' },
      { oxide: 'Al2O3', percent: '18' },
      { oxide: 'SiO2', percent: '70' }
    ],
    loi: '0',
    notes: ''
  }
};

/** A one-person vault's access: its person can do everything in its one collection. */
const ONE_PERSON: Access = {
  team: false,
  me: { id: 'me', name: '', admin: false, mustSetPassword: false },
  collections: [{ id: 'collection-1', name: '', owner: null, role: 'admin' }]
};

/** A record the fake core refuses to save. */
const TOO_LARGE = 'Too large';
const TOO_LARGE_ERROR = { code: 'too-large', message: 'That is too large to save.' };

/** Pretends to be the Rust commands, and records what was called. */
function fakeCore({
  settings = { autoLock: true, autoLockMinutes: 15, backupReminderDays: 30 },
  lastBackup = { at: Date.now(), fileName: 'b.gvbackup' },
  draft = null,
  recipes = [shino],
  materials = [],
  deleted = [],
  history = [],
  setAside = [],
  importFile = null,
  access = ONE_PERSON
}: {
  settings?: Settings;
  lastBackup?: LastBackup | null;
  draft?: Draft | null;
  recipes?: RecipeHead[];
  materials?: MaterialHead[];
  deleted?: (RecipeHead | MaterialHead)[];
  history?: (RecipeHead | MaterialHead)[];
  setAside?: { name: string; setAsideAt: number }[];
  importFile?: { fileName: string; contents: string } | null;
  access?: Access;
} = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const revisions = new Map<string, { recordId: string; number: number }>(
    [...recipes, ...materials, ...history].map((r) => [r.revisionId, r])
  );
  let saved = 0;
  const save = (parentId: string | null, content: { name?: string }) => {
    if (content.name === TOO_LARGE) throw TOO_LARGE_ERROR;
    saved += 1;
    const parent = revisions.get(parentId as string);
    const revision = {
      recordId: parent?.recordId ?? `saved-${saved}`,
      revisionId: `saved-revision-${saved}`,
      number: (parent?.number ?? 0) + 1,
      savedAt: Date.now(),
      content
    };
    revisions.set(revision.revisionId, revision);
    return revision;
  };
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    switch (cmd) {
      case 'list_records':
        return a.kind === 'recipe' ? recipes : a.kind === 'material' ? materials : [];
      case 'save_record':
        return save(a.parent as string | null, a.content as { name?: string });
      case 'save_records': {
        const batch = a.revisions as [string | null, { name?: string }][];
        if (batch.some(([, content]) => content.name === TOO_LARGE)) throw TOO_LARGE_ERROR;
        return batch.map(([parent, content]) => save(parent, content));
      }
      case 'deleted_records':
        return deleted.filter((r) => (a.kind === 'recipe') === 'lines' in r.content);
      case 'delete_record': {
        saved += 1;
        const newest = [...recipes, ...materials].find((r) => r.revisionId === a.newest)!;
        const gone = { ...newest, revisionId: `deleted-revision-${saved}`, number: newest.number + 1, deleted: true };
        revisions.set(gone.revisionId, gone);
        return gone;
      }
      case 'erase_record':
        return 2;
      case 'choose_import':
        return importFile;
      case 'set_aside_vaults':
        return setAside;
      case 'bring_back_vault':
        return { setAside: '/vault/replaced-2' };
      case 'record_history':
        return history.filter((r) => r.recordId === a.recordId);
      case 'back_up':
        throw { code: 'io', message: 'A file could not be read or written: the disk is full' };
      case 'get_settings':
        return settings;
      case 'my_access':
        return access;
      case 'last_backup':
        return lastBackup;
      case 'get_draft':
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
      recipe: { recordId: 'record-1', revisionId: 'revision-1', content: { ...shino.content, name: 'Shino, more iron' } }
    });
  });

  it('keeps unsaved changes to a material too', async () => {
    const core = fakeCore({ materials: [spar], settings: { autoLock: true, autoLockMinutes: 5, backupReminderDays: 0 } });
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

describe('your materials', () => {
  it('are made from a standard material’s analysis and saved', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    expect(screen.getByText(/No materials of your own yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Start from a standard material'), { target: { value: 'Whiting' } });
    await user.click(screen.getByRole('button', { name: 'Copy its analysis' }));
    expect((screen.getByLabelText('Material name') as HTMLInputElement).value).toBe('Whiting');
    expect((screen.getByLabelText('Percent 1') as HTMLInputElement).value).toBe('56.03');
    expect(screen.getByTestId('material-total').textContent).toBe('100.00');
    expect(screen.getByText(/instead of the standard Whiting/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Whiting, lot 12' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args).toEqual({
      kind: 'material',
      parent: null,
      collection: null,
      content: {
        name: 'Whiting, lot 12',
        category: 'material',
        basis: 'analysis',
        oxides: [{ oxide: 'CaO', percent: '56.03' }],
        loi: '43.97',
        notes: ''
      }
    });
    expect(await screen.findByRole('button', { name: 'Whiting, lot 12' })).toBeTruthy();
  });

  it('are used by recipes', async () => {
    fakeCore({
      recipes: [{ ...shino, content: { name: 'Shino', lines: [{ material: 'spar lot 7', amount: '50' }, { material: 'Whiting', amount: '20' }], notes: '' } }],
      materials: [spar]
    });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    expect(screen.getByRole('complementary', { name: 'Unity formula' }).textContent).toContain('K₂O');
    expect(document.querySelector('#materials option[value="Spar, lot 7"]')!.getAttribute('label')).toBe('Your material');

    await user.click(screen.getByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    expect(screen.getByRole('complementary', { name: 'Material check' }).textContent).toContain('Used inShino');
  });

  it('take the kind of the standard material they start from', async () => {
    fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Start from a standard material'), { target: { value: 'Chromium Oxide' } });
    await user.click(screen.getByRole('button', { name: 'Copy its analysis' }));
    expect((screen.getByLabelText('Kind') as HTMLSelectElement).value).toBe('colorant');
  });

  it('say when they replace a standard material by another of its names', async () => {
    fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Quartz' } });
    expect(screen.getByRole('complementary', { name: 'Material check' }).textContent).toContain(
      'instead of the standard Silica, wherever they call it Quartz.'
    );
  });

  it('report a loss on ignition that is not a number', async () => {
    fakeCore({ materials: [spar] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    fireEvent.change(screen.getByLabelText('Loss on ignition'), { target: { value: '4.5%' } });
    expect(screen.getByRole('complementary', { name: 'Material check' }).textContent).toContain(
      'The loss on ignition of Spar, lot 7 is not a number.'
    );
  });

  it('show an earlier revision and make it the newest', async () => {
    const second = { ...spar, revisionId: 'material-revision-2', number: 2, content: { ...spar.content, loi: '2' } };
    const core = fakeCore({ materials: [second], history: [second, spar] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    await user.click(screen.getByText('Earlier revisions (1)'));
    await user.click(await screen.findByRole('button', { name: /^Revision 1 ·/ }));
    expect(core.called('record_history')[0].args).toEqual({ kind: 'material', recordId: 'material-1' });
    expect((screen.getByLabelText('Loss on ignition') as HTMLInputElement).value).toBe('0');

    await user.click(screen.getByRole('button', { name: 'Use this revision' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args).toMatchObject({
      kind: 'material',
      parent: 'material-revision-2',
      content: { loi: '0' }
    });
  });

  it('can be given as a formula', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Whiting, theory' } });
    await user.selectOptions(screen.getByLabelText('Given as'), 'formula');
    await user.click(screen.getByRole('button', { name: 'Add oxide' }));
    await user.click(screen.getByRole('button', { name: 'Add oxide' }));
    await user.selectOptions(screen.getByLabelText('Formula oxide 1'), 'CaO');
    await user.selectOptions(screen.getByLabelText('Formula oxide 2'), 'CO2');
    fireEvent.change(screen.getByLabelText('Moles 1'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Moles 2'), { target: { value: '1' } });
    expect(screen.getByTestId('material-total').textContent).toBe('100.09');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args.content).toMatchObject({
      basis: 'formula',
      formula: [
        { oxide: 'CaO', moles: '1' },
        { oxide: 'CO2', moles: '1' }
      ]
    });
  });

  it('take a new name into the recipes that use them', async () => {
    const usesSpar = { ...shino, content: { ...shino.content, lines: [{ material: 'spar lot 7', amount: '50' }] } };
    const core = fakeCore({ recipes: [usesSpar], materials: [spar] });
    show();
    const user = userEvent.setup();
    // Shino is open with unsaved notes while the material is renamed.
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Thicker' } });
    await user.click(screen.getByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Spar, lot 8' } });
    const check = screen.getByRole('complementary', { name: 'Material check' });
    expect(check.textContent).toContain('1 recipe uses the old name, Spar, lot 7:');
    expect((screen.getByLabelText(/Also rename it in this recipe/) as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(2));
    expect(core.called('save_record')[1].args).toMatchObject({
      kind: 'recipe',
      parent: 'revision-1',
      content: { lines: [{ material: 'Spar, lot 8', amount: '50' }], notes: '' }
    });
    await user.click(screen.getByRole('button', { name: 'Materials' }));
    expect((screen.getByLabelText('Material 1') as HTMLInputElement).value).toBe('Spar, lot 8');
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('Thicker');
    expect(screen.getByRole('button', { name: 'Save' }).matches(':disabled')).toBe(false);
  });

  it('cannot share a name with another of yours', async () => {
    const core = fakeCore({ materials: [spar] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'SPAR lot 7' } });
    fireEvent.change(screen.getByLabelText('Percent 1'), { target: { value: '100' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('You already have a material called Spar, lot 7.');
    expect(core.called('save_record')).toHaveLength(0);
  });
});

it('shows an earlier revision and makes it the newest', async () => {
  const third = { ...shino, revisionId: 'revision-3', number: 3, content: { ...shino.content, name: 'Shino 3' } };
  const first = { ...shino, revisionId: 'revision-1', number: 1, content: { ...shino.content, name: 'Shino 1' } };
  const second = { ...shino, revisionId: 'revision-2', number: 2, content: { ...shino.content, name: 'Shino 2' } };
  const core = fakeCore({ recipes: [third], history: [third, second, first] });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Shino 3' }));
  await user.click(screen.getByText('Earlier revisions (2)'));
  await user.click(await screen.findByRole('button', { name: /^Revision 1 ·/ }));
  expect(core.called('record_history')[0].args).toEqual({ kind: 'recipe', recordId: 'record-1' });
  expect(screen.queryByRole('button', { name: /^Revision 3 ·/ })).toBeNull();

  const name = screen.getByLabelText('Recipe name') as HTMLInputElement;
  expect(name.value).toBe('Shino 1');
  expect(name.matches(':disabled')).toBe(true);
  expect(screen.getByText(/This is revision 1 of 3/)).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Use this revision' }));
  expect(name.value).toBe('Shino 1');
  expect(name.matches(':disabled')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
  expect(core.called('save_record')[0].args).toMatchObject({ parent: 'revision-3', content: { name: 'Shino 1' } });
});

describe('deleting', () => {
  it('moves a recipe to Deleted, and restores it from there', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete' }).textContent).toContain('Delete Shino?');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(core.called('delete_record')).toHaveLength(1));
    expect(core.called('delete_record')[0].args).toEqual({ kind: 'recipe', newest: 'revision-1' });
    expect(await screen.findByText('No recipes yet.')).toBeTruthy();

    await user.click(screen.getByText('Deleted (1)'));
    await user.click(screen.getByRole('button', { name: 'Shino' }));
    expect(screen.getByText(/was deleted/)).toBeTruthy();
    expect((screen.getByLabelText('Recipe name') as HTMLInputElement).matches(':disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args).toMatchObject({ kind: 'recipe', parent: 'deleted-revision-1' });
    expect(screen.queryByText('Deleted (1)')).toBeNull();
    expect((screen.getByLabelText('Recipe name') as HTMLInputElement).value).toBe('Shino');
  });

  it('erases a deleted recipe after asking', async () => {
    const gone = { ...shino, revisionId: 'revision-2', number: 2, deleted: true };
    const core = fakeCore({ recipes: [], deleted: [gone] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Deleted (1)'));
    await user.click(screen.getByRole('button', { name: 'Shino' }));
    await user.click(screen.getByRole('button', { name: 'Erase permanently…' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('cannot be brought back');
    await user.click(screen.getByRole('button', { name: 'Erase permanently' }));
    await waitFor(() => expect(core.called('erase_record')).toHaveLength(1));
    expect(core.called('erase_record')[0].args).toEqual({ kind: 'recipe', recordId: 'record-1' });
    expect(screen.queryByText(/Deleted \(/)).toBeNull();
  });

  it('says what deleting a material does to the recipes that use it', async () => {
    fakeCore({
      recipes: [{ ...shino, content: { ...shino.content, lines: [{ material: 'Spar, lot 7', amount: '10' }] } }],
      materials: [spar, { ...spar, recordId: 'material-2', revisionId: 'r-silica', content: { ...spar.content, name: 'Silica' } }]
    });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('1 recipe uses it, and will not find it until it is restored.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Silica' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(screen.getByRole('alertdialog').textContent).not.toContain('recipe uses');
  });

  it('does not restore a material over another of the same name', async () => {
    const gone = { ...spar, revisionId: 'material-revision-2', number: 2, deleted: true };
    const core = fakeCore({ materials: [{ ...spar, recordId: 'material-9', revisionId: 'r-9' }], deleted: [gone] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByText('Deleted (1)'));
    await user.click(within(screen.getByText('Deleted (1)').closest('details')!).getByRole('button', { name: 'Spar, lot 7' }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(screen.getByRole('alert').textContent).toContain('You have another material called Spar, lot 7.');
    expect(core.called('save_record')).toHaveLength(0);
  });
});

describe('comparing', () => {
  it('compares unsaved changes with what they started from', async () => {
    fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Material 1'), { target: { value: 'Nepheline Syenite' } });
    await user.click(screen.getByRole('button', { name: 'Add material' }));
    fireEvent.change(screen.getByLabelText('Material 2'), { target: { value: 'Whiting' } });
    fireEvent.change(screen.getByLabelText('Amount 2'), { target: { value: '25' } });
    await user.click(screen.getByRole('button', { name: 'Compare…' }));

    const batch = screen.getByRole('table', { name: 'Batch, percent of each' });
    const rows = [...batch.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows).toEqual(['Nepheline Syenite100.050.0−50.0', 'Whiting—50.0added']);
    expect(screen.getByRole('table', { name: 'Unity formula' }).textContent).toContain('CaO');
    expect((screen.getByLabelText('Recipe', { selector: '#second-recipe' }) as HTMLSelectElement).value).toBe('draft');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect((screen.getByLabelText('Amount 2') as HTMLInputElement).value).toBe('25');
  });

  it('compares an earlier revision with the newest', async () => {
    const second = { ...shino, revisionId: 'revision-2', number: 2, content: { ...shino.content, notes: 'Thinner' } };
    fakeCore({ recipes: [second], history: [second, shino] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    await user.click(screen.getByText('Earlier revisions (1)'));
    await user.click(await screen.findByRole('button', { name: /^Revision 1 ·/ }));
    await user.click(screen.getByRole('button', { name: 'Compare with the newest' }));
    expect(await screen.findByRole('heading', { name: 'Shino, revision 1' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Shino' })).toBeTruthy();
    expect(screen.getByText('Thinner')).toBeTruthy();
  });
});

describe('saving on the way', () => {
  it('reopens the recipe being saved at the revision just saved', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Shino 2' } });
    await user.click(screen.getByRole('button', { name: 'Shino' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect((screen.getByLabelText('Recipe name') as HTMLInputElement).value).toBe('Shino 2');
    expect(screen.getByText(/revision 2$/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Shino 3' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(2));
    expect(core.called('save_record')[1].args.parent).toBe('saved-revision-1');
  });

  it('uses an earlier revision on top of the edits just saved', async () => {
    const second = { ...shino, revisionId: 'revision-2', number: 2, content: { ...shino.content, name: 'Shino 2' } };
    const core = fakeCore({ recipes: [second], history: [second, shino] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino 2' }));
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Shino, edited' } });
    await user.click(screen.getByText('Earlier revisions (1)'));
    await user.click(await screen.findByRole('button', { name: /^Revision 1 ·/ }));
    await user.click(screen.getByRole('button', { name: 'Use this revision' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args).toMatchObject({ parent: 'revision-2', content: { name: 'Shino, edited' } });

    const name = screen.getByLabelText('Recipe name') as HTMLInputElement;
    expect(name.value).toBe('Shino');
    expect(name.matches(':disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(2));
    expect(core.called('save_record')[1].args).toMatchObject({ parent: 'saved-revision-1', content: { name: 'Shino' } });
  });
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
