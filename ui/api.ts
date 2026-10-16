// The Rust core's commands (crates/app/src/lib.rs). The UI makes no access decisions: it shows
// what these return.
import { invoke } from '@tauri-apps/api/core';
import type { MaterialContent, RecipeContent } from './chemistry';

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  version: string;
  updatesConfigured: boolean;
}

/** Kept in the vault, per person (crates/core/src/vault.rs). */
export interface Settings {
  autoLock: boolean;
  autoLockMinutes: number;
  /** 0 means no reminder. */
  backupReminderDays: number;
}

/** Kept outside the vault, because they apply before it is unlocked. */
export interface Preferences {
  checkForUpdates: boolean;
}

export interface LastBackup {
  at: number;
  fileName: string;
}

export interface ChosenBackup {
  path: string;
  fileName: string;
  createdAt: number;
  appVersion: string;
}

/** A vault that a restore moved aside, beside the vault's files. */
export interface SetAside {
  name: string;
  setAsideAt: number;
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** Unsaved edits to one record: the revision they started from (none for a new record). */
export interface DraftPart<Content> {
  recordId: string | null;
  revisionId: string | null;
  content: Content;
}

/** Unsaved edits, kept encrypted until they are saved or discarded, so they outlast locking,
 * closing the app or a crash. */
export interface Draft {
  recipe?: DraftPart<RecipeContent>;
  material?: DraftPart<MaterialContent>;
}

export type RestoreWith = { password: string } | { words: string; newPassword: string };

export type Kind = 'recipe' | 'material';

/** One saved revision of a record. A list holds each record's newest. */
export interface Revision<Content> {
  recordId: string;
  revisionId: string;
  number: number;
  savedAt: number;
  content: Content;
  /** The revision that deleted its record, with the content it had, to restore (ADR 9). */
  deleted?: boolean;
}

export type RecipeHead = Revision<RecipeContent>;
export type MaterialHead = Revision<MaterialContent>;

/** What a failed command rejects with: a stable code and a sentence for the person. */
export interface CommandError {
  code: string;
  message: string;
}

export const api = {
  status: () => invoke<VaultStatus>('vault_status'),
  /** Makes the vault, leaves it unlocked, and returns the 24 recovery words. */
  create: (password: string) => invoke<string[]>('create_vault', { password }),
  unlock: (password: string) => invoke<void>('unlock', { password }),
  recover: (words: string, newPassword: string) => invoke<void>('recover', { words, newPassword }),
  lock: () => invoke<void>('lock'),
  changePassword: (current: string, newPassword: string) => invoke<void>('change_password', { current, newPassword }),
  recipes: () => invoke<RecipeHead[]>('list_records', { kind: 'recipe' }),
  saveRecipe: (parent: string | null, content: RecipeContent) =>
    invoke<RecipeHead>('save_record', { kind: 'recipe', parent, content }),
  materials: () => invoke<MaterialHead[]>('list_records', { kind: 'material' }),
  saveMaterial: (parent: string | null, content: MaterialContent) =>
    invoke<MaterialHead>('save_record', { kind: 'material', parent, content }),
  saveRecord: <Content>(kind: Kind, parent: string | null, content: Content) =>
    invoke<Revision<Content>>('save_record', { kind, parent, content }),
  /** Saves several revisions at once, all or none: `[parent, content]` each, as for saveRecord. */
  saveRecords: <Content>(kind: Kind, revisions: [string | null, Content][]) =>
    invoke<Revision<Content>[]>('save_records', { kind, revisions }),
  /** Every revision of a record, newest first. */
  history: <Content>(kind: Kind, recordId: string) =>
    invoke<Revision<Content>[]>('record_history', { kind, recordId }),
  /** Deletes a record by its newest revision; returns the revision that deleted it. */
  deleteRecord: <Content>(kind: Kind, newest: string) => invoke<Revision<Content>>('delete_record', { kind, newest }),
  /** The deleted records, newest first. */
  deletedRecords: <Content>(kind: Kind) => invoke<Revision<Content>[]>('deleted_records', { kind }),
  /** Removes every revision of a deleted record; returns how many there were. */
  eraseRecord: (kind: Kind, recordId: string) => invoke<number>('erase_record', { kind, recordId }),
  newRecoveryKey: (password: string) => invoke<string[]>('new_recovery_key', { password }),
  settings: () => invoke<Settings>('get_settings'),
  setSettings: (settings: Settings) => invoke<void>('set_settings', { settings }),
  /** Keeps the draft, encrypted, and locks. */
  lockWithDraft: (draft: Draft) => invoke<void>('lock_with_draft', { draft }),
  draft: () => invoke<Draft | null>('get_draft'),
  saveDraft: (draft: Draft) => invoke<void>('save_draft', { draft }),
  clearDraft: () => invoke<void>('clear_draft'),
  lastBackup: () => invoke<LastBackup | null>('last_backup'),
  /** Asks where to save, then backs up. Null if cancelled. */
  backUp: (suggestedName: string) => invoke<LastBackup | null>('back_up', { suggestedName }),
  chooseBackup: () => invoke<ChosenBackup | null>('choose_backup'),
  restoreBackup: (path: string, using: RestoreWith) =>
    invoke<{ setAside: string | null }>('restore_backup', { path, ...using }),
  /** Asks for a file to import and reads it. Null if cancelled. */
  chooseImport: () => invoke<{ fileName: string; contents: string } | null>('choose_import'),
  setAside: () => invoke<SetAside[]>('set_aside_vaults'),
  /** Locks, and swaps the vault with one set aside; returns where the open one went. */
  bringBack: (name: string) => invoke<{ setAside: string | null }>('bring_back_vault', { name }),
  /** Asks where to save, then writes. The file name, or null if cancelled. */
  saveExport: (suggestedName: string, contents: string) =>
    invoke<string | null>('save_export', { suggestedName, contents }),
  preferences: () => invoke<Preferences>('get_preferences'),
  setPreferences: (preferences: Preferences) => invoke<void>('set_preferences', { preferences }),
  checkForUpdate: () => invoke<UpdateInfo | null>('check_for_update'),
  /** Downloads, locks the vault, installs and restarts. */
  installUpdate: () => invoke<void>('install_update')
};

export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as CommandError).message);
  return String(error);
}

export const MIN_PASSWORD_CHARS = 8;
