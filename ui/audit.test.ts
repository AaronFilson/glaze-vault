import { describe as group, expect, it } from 'vitest';
import type { AuditEntry } from './api';
import { auditCsv, describe, type AuditNames } from './audit';

const names: AuditNames = {
  people: { ana: 'Ana', ben: 'Ben' },
  collections: { shared: 'Shared', prod: 'Production' },
  records: { r1: 'Shino' }
};

const entry = (fields: Partial<AuditEntry>): AuditEntry => ({
  seq: 1,
  at: Date.UTC(2026, 9, 21, 12),
  person: 'ana',
  action: 'saved',
  kind: null,
  record: null,
  collection: null,
  detail: null,
  check: 'good',
  ...fields
});

group('the audit log in words', () => {
  it('names the record, the person and the collection it can', () => {
    expect(describe(entry({ kind: 'recipe', record: 'r1', collection: 'shared' }), names)).toBe('Saved recipe "Shino"');
    expect(
      describe(
        entry({
          action: 'printed',
          kind: 'recipe',
          record: 'r1',
          detail: '5000 g'
        }),
        names
      )
    ).toBe('Printed recipe "Shino" (5000 g)');
    expect(describe(entry({ action: 'opened', kind: 'firing', record: 'f123456789' }), names)).toBe(
      'Opened a firing (f1234567)'
    );
    expect(describe(entry({ action: 'person-added', detail: 'person ben' }), names)).toBe('Added Ben');
    expect(describe(entry({ action: 'person-removed', detail: 'person gone12345' }), names)).toBe(
      'Removed someone (gone1234)'
    );
    expect(
      describe(
        entry({
          action: 'grant-set',
          detail: 'person ben',
          collection: 'prod'
        }),
        names
      )
    ).toBe('Set the role of Ben in Production');
    expect(
      describe(
        entry({
          action: 'moved',
          kind: 'recipe',
          record: 'r1',
          collection: 'prod',
          detail: 'from shared'
        }),
        names
      )
    ).toBe('Moved recipe "Shino" to Production');
  });

  it('exports every entry oldest first, with the ids', () => {
    const csv = auditCsv(
      [entry({ seq: 2, action: 'signed-in', person: 'ben' }), entry({ seq: 1, action: 'created' })],
      names
    );
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('When,Who,What,Kind,Record,Collection,Detail,Signature,Entry');
    expect(lines[1]).toBe('2026-10-21T12:00:00.000Z,Ana,Made the vault,,,,,good,1');
    expect(lines[2]).toBe('2026-10-21T12:00:00.000Z,Ben,Signed in,,,,,good,2');
  });
});
