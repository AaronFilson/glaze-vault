// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Revision } from '../api';
import type { LimitsContent } from '../limits';
import { LimitSets } from './Limits';

const mine: Revision<LimitsContent> = {
  recordId: 'l-1',
  revisionId: 'lv-1',
  number: 1,
  savedAt: 1,
  content: { name: 'Hesselberth cone 6', source: 'a book', ranges: [] }
};

describe('limit sets', () => {
  it('notes in the audit log that one was opened, and nothing for a new one', async () => {
    const notes: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'note') notes.push((args as { note: unknown }).note);
      return null;
    });
    render(<LimitSets own={[mine]} canCreate collection={null} onSaved={() => {}} onDeleted={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'New limit formula' }));
    expect(notes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Hesselberth cone 6' }));
    await waitFor(() => expect(notes).toEqual([{ action: 'opened', kind: 'limits', record: 'l-1' }]));
  });
});
