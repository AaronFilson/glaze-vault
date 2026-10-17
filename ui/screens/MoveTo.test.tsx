// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Access } from '../api';
import { MoveTo } from './Team';

afterEach(cleanup);

const ACCESS: Access = {
  team: true,
  me: { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false },
  collections: [
    { id: 'shared', name: 'Shared', owner: null, role: 'formulator', changes: ['recipe', 'material', 'batch', 'firing', 'limits', 'prices'] },
    { id: 'production', name: 'Production', owner: null, role: 'formulator', changes: ['recipe', 'material', 'batch', 'firing', 'limits', 'prices'] },
    { id: 'archive', name: 'Archive', owner: null, role: 'chemist', changes: [] },
    { id: 'mine', name: '', owner: 'ben', role: 'admin', changes: ['recipe', 'material', 'batch', 'firing', 'limits', 'prices'] }
  ]
};

describe('moving a recipe to another collection', () => {
  it('offers only collections this person may change, and asks first', async () => {
    const onMove = vi.fn(async () => {});
    render(<MoveTo access={ACCESS} names={{}} from="shared" kinds={['recipe']} name="Shino" along={['its 2 firings', 'its batch sheet']} onMove={onMove} />);
    const to = screen.getByLabelText('Move to') as HTMLSelectElement;
    expect([...to.options].map((o) => o.textContent)).toEqual(['Production', 'Private']);
    fireEvent.click(screen.getByRole('button', { name: 'Move…' }));
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'Move Shino to Production? It goes with every revision, its 2 firings and its batch sheet. People who can open Shared but not Production will no longer see it.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('production'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('shows nothing with nowhere else to move it', () => {
    const one: Access = { ...ACCESS, collections: ACCESS.collections.slice(0, 1) };
    const { container } = render(<MoveTo access={one} names={{}} from="shared" kinds={['recipe']} name="Shino" along={[]} onMove={async () => {}} />);
    expect(container.textContent).toBe('');
  });

  it('says what else a move changes, for the collection chosen', () => {
    render(
      <MoveTo
        access={ACCESS}
        names={{}}
        from="shared"
        kinds={['material']}
        name="Grolleg"
        along={[]}
        note={(to, there) => (to === 'production' ? `2 recipes outside ${there} use it.` : '')}
        onMove={async () => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move…' }));
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'It goes with every revision. People who can open Shared but not Production will no longer see it. 2 recipes outside Production use it.'
    );
  });
});
