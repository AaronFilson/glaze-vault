// The Rust core's commands (crates/app/src/lib.rs). The UI makes no access decisions: it shows
// what these return.
import { invoke } from '@tauri-apps/api/core';
import type { RecipeContent } from './chemistry';

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

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** Unsaved edits kept when the vault locks by itself. */
export interface Draft {
  revisionId: string | null;
  content: RecipeContent;
}

export type RestoreWith = { password: string } | { words: string; newPassword: string };

export interface RecipeHead {
  recordId: string;
  revisionId: string;
  number: number;
  savedAt: number;
  content: RecipeContent;
}

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
  recipes: () => invoke<RecipeHead[]>('list_recipes'),
  saveRecipe: (parent: string | null, content: RecipeContent) => invoke<RecipeHead>('save_recipe', { parent, content }),
  newRecoveryKey: (password: string) => invoke<string[]>('new_recovery_key', { password }),
  settings: () => invoke<Settings>('get_settings'),
  setSettings: (settings: Settings) => invoke<void>('set_settings', { settings }),
  /** Keeps the draft, encrypted, and locks. */
  lockWithDraft: (draft: Draft) => invoke<void>('lock_with_draft', { draft }),
  takeDraft: () => invoke<Draft | null>('take_draft'),
  lastBackup: () => invoke<LastBackup | null>('last_backup'),
  /** Asks where to save, then backs up. Null if cancelled. */
  backUp: (suggestedName: string) => invoke<LastBackup | null>('back_up', { suggestedName }),
  chooseBackup: () => invoke<ChosenBackup | null>('choose_backup'),
  restoreBackup: (path: string, using: RestoreWith) =>
    invoke<{ setAside: string | null }>('restore_backup', { path, ...using }),
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
