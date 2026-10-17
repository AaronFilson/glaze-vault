// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Access, Revision } from '../api';
import { materialLibrary } from '../chemistry';
import type { PricesContent } from '../prices';
import { PriceLists } from './Prices';

afterEach(() => {
  cleanup();
  clearMocks();
});

const TEAM: Access = {
  team: true,
  me: { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false },
  collections: [
    { id: 'shared', name: 'Shared', owner: null, role: 'formulator', changes: ['recipe', 'material', 'batch', 'firing', 'limits', 'prices'] },
    { id: 'glazes', name: 'Production', owner: null, role: 'chemist', changes: [] },
    { id: 'weighing', name: 'Weighing', owner: null, role: 'operator', changes: [] }
  ]
};

const production: Revision<PricesContent> = {
  recordId: 'p-1',
  revisionId: 'pv-1',
  number: 1,
  savedAt: 1,
  collectionId: 'glazes',
  content: { currency: '€', unit: 'kg', prices: [{ material: 'Silica', price: '0.5' }] }
};

describe('price lists in a team', () => {
  it('shows a collection’s own list, and makes one in a collection that has none', async () => {
    const saved: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'save_record') {
        saved.push(args as Record<string, unknown>);
        return { ...production, recordId: 'p-2', collectionId: 'shared', content: (args as { content: unknown }).content };
      }
      return null;
    });
    let lists = [production];
    render(<PriceLists lists={lists} access={TEAM} names={{}} library={materialLibrary([])} onSaved={(s) => (lists = [s, ...lists])} />);
    const picker = screen.getByLabelText('Prices for') as HTMLSelectElement;
    expect(picker.value).toBe('glazes');
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Shared (no prices yet)', 'Production']);
    // Ben may read Production's prices, not change them.
    expect((screen.getByLabelText('Price 1') as HTMLInputElement).value).toBe('0.5');
    expect(screen.queryByRole('button', { name: 'Save prices' })).toBeNull();

    fireEvent.change(picker, { target: { value: 'shared' } });
    fireEvent.change(screen.getByLabelText('Priced material 1'), { target: { value: 'Whiting' } });
    fireEvent.change(screen.getByLabelText('Price 1'), { target: { value: '0.3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ kind: 'prices', parent: null, collection: 'shared' });
    expect(lists[0].collectionId).toBe('shared');
  });
});
