// The Rust core's commands (crates/app/src/lib.rs). The UI makes no access decisions: it shows
// what these return.
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import type { BatchSheet } from './batch';
import type { Firing, FiringContent } from './firing';
import type { LimitsContent } from './limits';
import type { Mix, MixContent } from './mix';
import type { PricesContent } from './prices';
import type { MaterialContent, RecipeContent } from './chemistry';

/** Calls to the core not answered yet, by when they were made; the development tools show any
 * that take long. */
export const pendingCalls = new Map<number, { command: string; at: number }>();
let nextCall = 0;

function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const id = ++nextCall;
  pendingCalls.set(id, { command, at: Date.now() });
  return tauriInvoke<T>(command, args, options).finally(() => pendingCalls.delete(id));
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  version: string;
  updatesConfigured: boolean;
  /** A team's people, to choose from on the lock screen; empty for a one-person vault. */
  people: Person[];
}

/** What a person may do in a collection (docs/adr/0012-teams-on-one-computer.md, 0004): a built-in
 * role, or "role:" and the id of one an admin made. */
export type Role = 'operator' | 'chemist' | 'tester' | 'formulator' | 'admin' | `role:${string}`;

/** What a role admins make may do besides changing records. Without chemistry it reads recipes'
 * names and details and firings, and may change only firings; managing needs chemistry. */
export interface Capabilities {
  export: boolean;
  print: boolean;
  chemistry: boolean;
  manage: boolean;
}

/** A role an admin made: it changes these kinds, and may do what its capabilities say. */
export interface CustomRole extends Capabilities {
  id: string;
  name: string;
  changes: Kind[];
}

export interface Person {
  id: string;
  name: string;
  admin: boolean;
  /** Added by an admin and not signed in since. */
  mustSetPassword: boolean;
}

export interface Collection {
  id: string;
  name: string;
  /** The person whose private collection it is. */
  owner: string | null;
  role: Role;
  /** The kinds of record this person may make and change here, as the core decides. */
  changes: Kind[];
  /** What else they may do here. Without chemistry, recipes come with no lines or notes. */
  export: boolean;
  print: boolean;
  chemistry: boolean;
  /** Gives and takes away roles here; an admin manages every collection. */
  manage: boolean;
}

/** Who unlocked the vault, whether it is a team's, and what they can open. */
export interface Access {
  team: boolean;
  me: Person;
  collections: Collection[];
}

export interface Grant {
  person: string;
  collection: string;
  role: Role;
}

/** Everyone in a team's vault and their roles, for an admin. */
export interface Team {
  people: Person[];
  grants: Grant[];
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
  /** For a team's backup, the admins who can restore it. */
  admins: Person[];
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
  firing?: DraftPart<FiringContent>;
  mix?: DraftPart<MixContent>;
}

export type RestoreWith =
  | { password: string }
  | { words: string; newPassword: string }
  /** The organization's recovery key, which gives the admin chosen a new password. */
  | { words: string; newPassword: string; organization: true };

export interface RestoreResult {
  setAside: string | null;
  /** After restoring with the organization's recovery key, the admin's new recovery key. */
  recoveryWords: string[] | null;
}

export type Kind = 'recipe' | 'material' | 'batch' | 'firing' | 'mix' | 'limits' | 'prices';

/** A file kept with a record, such as a firing's photo. */
export interface Attachment {
  id: string;
  recordId: string;
  mediaType: string;
  size: number;
  createdAt: number;
}

/** One saved revision of a record. A list holds each record's newest. */
export interface Revision<Content> {
  recordId: string;
  revisionId: string;
  number: number;
  savedAt: number;
  content: Content;
  /** The revision that deleted its record, with the content it had, to restore (ADR 9). */
  deleted?: boolean;
  collectionId?: string;
}

export type RecipeHead = Revision<RecipeContent>;
export type MaterialHead = Revision<MaterialContent>;

/** What a failed command rejects with: a stable code and a sentence for the person. */
export interface CommandError {
  code: string;
  message: string;
}

/**
 * A recipe as the screens expect it. Someone who reads a collection without its chemistry gets
 * its recipes with no lines or notes (docs/adr/0004-roles-and-collections.md); they are shown as
 * empty, and the screens say why.
 */
function filled<Content>(revision: Revision<Content>): Revision<Content> {
  const content = revision.content as Partial<RecipeContent>;
  if (Array.isArray(content.lines) && typeof content.notes === 'string') return revision;
  return { ...revision, content: { ...content, lines: content.lines ?? [], notes: content.notes ?? '' } as Content };
}

export const api = {
  status: () => invoke<VaultStatus>('vault_status'),
  /** Makes the vault, leaves it unlocked, and returns the 24 recovery words. */
  create: (password: string) => invoke<string[]>('create_vault', { password }),
  /** A team's vault needs the person; a one-person vault's is found without. */
  unlock: (password: string, person: string | null = null) => invoke<void>('unlock', { person, password }),
  recover: (words: string, newPassword: string, person: string | null = null) =>
    invoke<void>('recover', { person, words, newPassword }),
  /** Gives an admin a new password with the organization's recovery key; returns their new
   * recovery words. */
  recoverOrganization: (admin: string, words: string, newPassword: string) =>
    invoke<string[]>('recover_organization', { admin, words, newPassword }),
  access: () => invoke<Access>('my_access'),
  team: () => invoke<Team>('team'),
  /** Makes the vault a team's with this person as admin; returns the organization's recovery words. */
  growIntoTeam: (name: string) => invoke<string[]>('grow_into_team', { name }),
  addPerson: (name: string, oneTimePassword: string, roles: [string, Role][]) =>
    invoke<Person>('add_person', { name, oneTimePassword, roles }),
  /** At a first sign-in; returns the person's recovery words. */
  setOwnPassword: (newPassword: string) => invoke<string[]>('set_own_password', { newPassword }),
  /** Null takes the role away. */
  setRole: (person: string, collection: string, role: Role | null) =>
    invoke<void>('set_role', { person, collection, role }),
  removePerson: (person: string) => invoke<void>('remove_person', { person }),
  resetPerson: (person: string, oneTimePassword: string) =>
    invoke<void>('reset_person', { person, oneTimePassword }),
  makeAdmin: (person: string) => invoke<void>('make_admin', { person }),
  /** Returns the organization's new recovery words: the old sheet stops working. */
  takeAdminAway: (person: string) => invoke<string[]>('take_admin_away', { person }),
  newOrganizationRecoveryKey: () => invoke<string[]>('new_organization_recovery_key'),
  /** Removes everyone else and the organization key; returns where the backup made first is. */
  goBackToOnePerson: () => invoke<string>('go_back_to_one_person'),
  createCollection: (name: string) => invoke<Collection>('create_collection', { name }),
  customRoles: () => invoke<CustomRole[]>('custom_roles'),
  createRole: (name: string, changes: Kind[], may: Capabilities) =>
    invoke<CustomRole>('create_role', { name, changes, may }),
  changeRole: (id: string, name: string, changes: Kind[], may: Capabilities) =>
    invoke<void>('change_role', { id, name, changes, may }),
  /** Refused while anyone has the role. */
  deleteRole: (id: string) => invoke<void>('delete_role', { id }),
  renameCollection: (collection: string, name: string) => invoke<void>('rename_collection', { collection, name }),
  lock: () => invoke<void>('lock'),
  changePassword: (current: string, newPassword: string) => invoke<void>('change_password', { current, newPassword }),
  recipes: () => invoke<RecipeHead[]>('list_records', { kind: 'recipe' }).then((list) => list.map(filled)),
  /** A new record goes into `collection`, when one is named. */
  saveRecipe: (parent: string | null, content: RecipeContent, collection: string | null = null) =>
    invoke<RecipeHead>('save_record', { kind: 'recipe', parent, collection, content }),
  materials: () => invoke<MaterialHead[]>('list_records', { kind: 'material' }),
  batchSheets: () => invoke<BatchSheet[]>('list_records', { kind: 'batch' }),
  firings: () => invoke<Firing[]>('list_records', { kind: 'firing' }),
  mixes: () => invoke<Mix[]>('list_records', { kind: 'mix' }),
  limitSets: () => invoke<Revision<LimitsContent>[]>('list_records', { kind: 'limits' }),
  priceLists: () => invoke<Revision<PricesContent>[]>('list_records', { kind: 'prices' }),
  /** Asks for a photo and returns its bytes; empty if cancelled. */
  choosePhoto: () => invoke<ArrayBuffer>('choose_photo').then((buffer) => new Uint8Array(buffer)),
  addAttachment: (kind: Kind, recordId: string, mediaType: string, bytes: Uint8Array) =>
    invoke<Attachment>('add_attachment', bytes, {
      headers: { kind, 'record-id': recordId, 'media-type': mediaType }
    }),
  attachment: (id: string) => invoke<ArrayBuffer>('get_attachment', { id }),
  saveMaterial: (parent: string | null, content: MaterialContent, collection: string | null = null) =>
    invoke<MaterialHead>('save_record', { kind: 'material', parent, collection, content }),
  saveRecord: <Content>(kind: Kind, parent: string | null, content: Content, collection: string | null = null) =>
    invoke<Revision<Content>>('save_record', { kind, parent, collection, content }),
  /** Saves several revisions at once, all or none: `[parent, content]` each, as for saveRecord. */
  saveRecords: <Content>(kind: Kind, revisions: [string | null, Content][], collection: string | null = null) =>
    invoke<Revision<Content>[]>('save_records', { kind, collection, revisions }),
  /** Every revision of a record, newest first. */
  history: <Content>(kind: Kind, recordId: string) =>
    invoke<Revision<Content>[]>('record_history', { kind, recordId }).then((list) =>
      kind === 'recipe' ? list.map(filled) : list
    ),
  /** Deletes a record by its newest revision; returns the revision that deleted it. */
  deleteRecord: <Content>(kind: Kind, newest: string) => invoke<Revision<Content>>('delete_record', { kind, newest }),
  /** The deleted records, newest first. */
  deletedRecords: <Content>(kind: Kind) =>
    invoke<Revision<Content>[]>('deleted_records', { kind }).then((list) => (kind === 'recipe' ? list.map(filled) : list)),
  /** Moves records, with all their revisions and attachments, to another collection, all or none. */
  moveRecords: (records: [Kind, string][], to: string) => invoke<void>('move_records', { records, to }),
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
  /** `person` is the admin restoring a team's backup. */
  restoreBackup: (path: string, using: RestoreWith, person: string | null = null) =>
    invoke<RestoreResult>('restore_backup', { path, person, ...using }),
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
