// The Rust core's commands (crates/app/src/lib.rs). The UI makes no access decisions: it shows
// what these return.
import { invoke } from '@tauri-apps/api/core';
import type { RecipeContent } from './chemistry';

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

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
  saveRecipe: (parent: string | null, content: RecipeContent) => invoke<RecipeHead>('save_recipe', { parent, content })
};

export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as CommandError).message);
  return String(error);
}

export const MIN_PASSWORD_CHARS = 8;
