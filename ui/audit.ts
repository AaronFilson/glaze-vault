// The audit log as people read it (docs/adr/0019-signatures-and-audit-log.md): the core keeps ids,
// and the screen puts back the names this person can see.
import type { AuditEntry, Kind } from './api';
import { csvField } from './export';

/** The names to put back: people, collections and records, by id. */
export interface AuditNames {
  people: Record<string, string>;
  collections: Record<string, string>;
  records: Record<string, string>;
}

const KINDS: Record<Kind, string> = {
  recipe: 'recipe',
  material: 'material',
  batch: 'batch sheet',
  firing: 'firing',
  mix: 'mix',
  limits: 'limit set',
  prices: 'price list'
};

/** What each action says, before what it was done to. */
const ACTIONS: Record<string, string> = {
  created: 'Made the vault',
  'signed-in': 'Signed in',
  'password-changed': 'Changed their password',
  'recovery-key-changed': 'Made a new recovery key',
  'backed-up': 'Made a backup',
  restored: 'Restored a backup',
  saved: 'Saved',
  deleted: 'Deleted',
  erased: 'Erased',
  moved: 'Moved',
  attached: 'Added a file to',
  opened: 'Opened',
  printed: 'Printed',
  exported: 'Exported',
  'took-over': 'Took over',
  'person-added': 'Added',
  'person-keys-changed': 'Gave new keys to',
  'person-removed': 'Removed',
  'admin-given': 'Made an admin:',
  'admin-taken': 'Took admin away from',
  'team-formed': 'Shared the vault',
  'team-disbanded': 'Made the vault theirs alone',
  'collection-created': 'Made the collection',
  'collection-renamed': 'Renamed the collection',
  'key-epoch': 'Gave a new key to',
  'grant-set': 'Set the role of',
  'grant-removed': 'Took the role away from',
  'organization-grant-set': 'Sealed to the organization',
  'certificate-issued': 'Certified the key of',
  'organization-key-added': "Listed the organization's key",
  'role-created': 'Made a role',
  'role-changed': 'Changed a role',
  'role-deleted': 'Deleted a role'
};

const short = (id: string) => id.slice(0, 8);

/** "Ana", or the start of the id of someone no longer in the vault. */
export function personName(id: string | null, names: AuditNames): string {
  if (!id) return '';
  return names.people[id] ?? `someone (${short(id)})`;
}

/** What an entry says was done, in words. */
export function describe(entry: AuditEntry, names: AuditNames): string {
  const action = ACTIONS[entry.action] ?? entry.action;
  const parts = [action];
  if (entry.kind && entry.record) {
    const name = names.records[entry.record];
    parts.push(name ? `${KINDS[entry.kind]} "${name}"` : `a ${KINDS[entry.kind]} (${short(entry.record)})`);
  }
  // Directory changes name a person or a role in their detail.
  const subject = entry.detail?.match(/^person (.+)$/);
  if (subject) parts.push(`${entry.action === 'took-over' ? 'from ' : ''}${personName(subject[1], names)}`);
  else if (entry.detail && !entry.detail.startsWith('role ') && !entry.detail.startsWith('from ')) {
    parts.push(`(${entry.detail})`);
  }
  if (entry.collection && !(entry.kind && entry.record) && entry.action !== 'opened') {
    parts.push(`in ${names.collections[entry.collection] ?? 'a collection'}`);
  }
  if (entry.action === 'moved' && entry.collection) {
    parts.push(`to ${names.collections[entry.collection] ?? 'another collection'}`);
  }
  return parts.join(' ');
}

const COLUMNS = ['When', 'Who', 'What', 'Kind', 'Record', 'Collection', 'Detail', 'Signature', 'Entry'];

/** The whole log as a spreadsheet, oldest first: names, and the ids they came from. */
export function auditCsv(entries: AuditEntry[], names: AuditNames): string {
  const rows = [COLUMNS];
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    rows.push([
      new Date(entry.at).toISOString(),
      personName(entry.person, names),
      describe(entry, names),
      entry.kind ?? '',
      entry.record ?? '',
      entry.collection ?? '',
      entry.detail ?? '',
      entry.check,
      String(entry.seq)
    ]);
  }
  return '﻿' + rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
