// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Access, AuditEntry, AuditLog as Log, Revision } from '../api';
import { AuditLog } from './AuditLog';
import { savedBy } from './RevisionHistory';

const ALL = ['recipe', 'material', 'batch', 'firing', 'mix', 'limits', 'prices'] as const;

const ACCESS: Access = {
  team: true,
  me: { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
  collections: [
    {
      id: 'shared',
      name: 'Shared',
      owner: null,
      role: 'admin',
      changes: [...ALL],
      export: true,
      print: true,
      chemistry: true,
      manage: true
    }
  ]
};

const entry = (seq: number, fields: Partial<AuditEntry>): AuditEntry => ({
  seq,
  at: Date.UTC(2026, 9, 21, 12, seq),
  person: 'ben',
  action: 'saved',
  kind: null,
  record: null,
  collection: null,
  detail: null,
  check: 'good',
  ...fields
});

describe('the audit log', () => {
  it('shows who did what with names put back, warns of a broken chain, and exports all of it', async () => {
    const log: Log = {
      intact: false,
      entries: [
        entry(3, {
          action: 'printed',
          kind: 'recipe',
          record: 'r1',
          collection: 'shared',
          detail: 'revision 2'
        }),
        entry(2, {
          action: 'opened',
          kind: 'recipe',
          record: 'r1',
          collection: 'shared',
          check: 'bad'
        }),
        entry(1, { action: 'signed-in' })
      ]
    };
    const exported: { suggestedName: string; contents: string }[] = [];
    const limits: unknown[] = [];
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === 'audit_log') {
        limits.push(a.limit);
        return log;
      }
      if (cmd === 'save_export') {
        exported.push(a as { suggestedName: string; contents: string });
        return 'audit.csv';
      }
      return null;
    });
    render(
      <AuditLog
        access={ACCESS}
        people={[{ id: 'ben', name: 'Ben', admin: false, mustSetPassword: false }]}
        records={{ r1: 'Shino' }}
      />
    );
    fireEvent.click(screen.getByText('Show the audit log'));
    expect(await screen.findByText('Printed recipe "Shino" (revision 2)')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('changed or taken out outside the app');
    expect(screen.getByText(/it was changed outside the app/)).toBeTruthy();
    expect(screen.getAllByText('Ben')).toHaveLength(3);

    fireEvent.click(screen.getByText('Export the whole log (CSV)'));
    await waitFor(() => expect(exported).toHaveLength(1));
    expect(limits).toEqual([200, null]);
    expect(exported[0].suggestedName).toMatch(/^Glaze Vault audit log \d{4}-\d\d-\d\d\.csv$/);
    expect(exported[0].contents).toContain('Ben,"Printed recipe ""Shino"" (revision 2)"');
    expect(await screen.findByText('Saved audit.csv.')).toBeTruthy();
  });
});

describe('who saved a revision', () => {
  const revision = (fields: Partial<Revision<unknown>>): Revision<unknown> => ({
    recordId: 'r1',
    revisionId: 'v1',
    number: 1,
    savedAt: 0,
    content: {},
    author: 'ben',
    ...fields
  });

  it('names the author and says when a signature does not check', () => {
    const names = { ben: 'Ben', ana: 'Ana' };
    expect(savedBy(revision({ signed: { by: 'ben', as: 'author', check: 'good' } }), names, true)).toBe('by Ben');
    expect(savedBy(revision({ signed: { by: 'ana', as: 'mover', check: 'good' } }), names, true)).toBe(
      'by Ben · moved by Ana'
    );
    expect(savedBy(revision({ signed: { by: 'ana', as: 'attester', check: 'good' } }), names, true)).toBe(
      'by Ben · vouched for by Ana'
    );
    expect(
      savedBy(
        revision({
          author: 'gone',
          signed: { by: 'gone', as: 'author', check: 'unconfirmed' }
        }),
        names,
        true
      )
    ).toBe('by someone no longer in the vault · signed with a key no admin has certified yet');
    // Alone, there is nobody to name; only a signature that does not match is said.
    expect(savedBy(revision({ signed: { by: 'ben', as: 'author', check: 'good' } }), {}, false)).toBe('');
    expect(savedBy(revision({ signed: { by: 'ben', as: 'author', check: 'bad' } }), {}, false)).toBe(
      '⚠ changed outside the app: its signature does not match'
    );
  });
});
