// The fake Rust commands and recipes the Recipes screen's tests share. The tests are split into
// files by what they cover, so they run side by side.
import { mockIPC } from '@tauri-apps/api/mocks';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { Access, Draft, LastBackup, MaterialHead, RecipeHead, Settings } from '../api';
import { Recipes } from './Recipes';

export const STATUS = { exists: true, unlocked: true, version: '0.2.0', updatesConfigured: false, people: [] };

export const shino: RecipeHead = {
  recordId: 'record-1',
  revisionId: 'revision-1',
  number: 1,
  savedAt: Date.UTC(2026, 9, 1),
  content: { name: 'Shino', lines: [{ material: 'Nepheline Syenite', amount: '50' }], notes: '' }
};

export const spar: MaterialHead = {
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
export const ONE_PERSON: Access = {
  team: false,
  me: { id: 'me', name: '', admin: false, mustSetPassword: false },
  collections: [{ id: 'collection-1', name: '', owner: null, role: 'admin', changes: ['recipe', 'material', 'batch', 'firing', 'limits', 'prices'] , export: true, print: true, chemistry: true, manage: true }]
};

/** A record the fake core refuses to save. */
export const TOO_LARGE = 'Too large';
const TOO_LARGE_ERROR = { code: 'too-large', message: 'That is too large to save.' };

/** Pretends to be the Rust commands, and records what was called. */
export function fakeCore({
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

export function show() {
  const onLocked = vi.fn();
  render(<Recipes status={STATUS} update={null} onUpdate={() => {}} onLocked={onLocked} />);
  return onLocked;
}
