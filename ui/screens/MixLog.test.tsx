// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Access, RecipeHead } from '../api';
import type { BatchSheet } from '../batch';
import { newMix, type Mix, type MixContent } from '../mix';
import { MixLog, type MixEditing } from './MixLog';

vi.setConfig({ testTimeout: 30_000 });

const slip: RecipeHead = {
  recordId: 'r',
  revisionId: 'r-3',
  number: 3,
  savedAt: 1,
  collectionId: 'shared',
  content: {
    name: 'Casting porcelain',
    type: 'casting slip',
    gravity: '1.78',
    notes: '',
    lines: [
      { material: 'Grolleg', amount: '50' },
      { material: 'Custer Feldspar', amount: '25' },
      { material: 'Silica', amount: '25' }
    ]
  }
};

const sheet: BatchSheet = {
  recordId: 's',
  revisionId: 's-2',
  number: 2,
  savedAt: 1,
  collectionId: 'shared',
  content: {
    name: 'CP-1',
    notes: '',
    recipe: 'r',
    recipeNumber: 3,
    lines: [
      { material: 'M-1', amount: '50' },
      { material: 'M-2', amount: '25' },
      { material: 'M-3', amount: '25' }
    ]
  }
};

const OPERATOR: Access = {
  team: true,
  me: { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false },
  collections: [
    { id: 'shared', name: 'Shared', owner: null, role: 'operator', changes: ['mix'], export: true, print: true, chemistry: false, manage: false }
  ]
};

/** Pretends to be the core: saving a mix hands it back as saved. */
function fakeCore() {
  const saved: { content: MixContent; collection: unknown }[] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === 'save_record') {
      saved.push({ content: a.content as MixContent, collection: a.collection });
      return { recordId: 'new', revisionId: `new-${saved.length}`, number: saved.length, savedAt: 1, collectionId: 'shared', content: a.content };
    }
    if (cmd === 'record_history') return [];
    return null;
  });
  return saved;
}

function Log({
  mixes = [],
  recipes = [],
  sheets = [],
  access = null,
  start = null
}: {
  mixes?: Mix[];
  recipes?: RecipeHead[];
  sheets?: BatchSheet[];
  access?: Access | null;
  start?: MixEditing | null;
}) {
  const [editing, setEditing] = useState<MixEditing | null>(start);
  return (
    <MixLog
      mixes={mixes}
      recipes={recipes}
      sheets={sheets}
      access={access}
      editing={editing}
      onEdit={setEditing}
      forRecipe={null}
      onForRecipe={() => {}}
      onSaved={() => {}}
      onErased={() => {}}
    />
  );
}

describe('a mix of a batch sheet, by a batch operator', () => {
  it('shows the codes and weights, and keeps a lot for each', async () => {
    const saved = fakeCore();
    render(<Log sheets={[sheet]} access={OPERATOR} start={{ current: null, draft: newMix({ sheet }, new Date(2026, 9, 19)) }} />);
    expect(screen.getByRole('heading', { name: 'Mix of CP-1' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Dry batch size'), { target: { value: '5000' } });
    const table = screen.getByRole('table');
    expect(within(table).getByText('Code')).toBeTruthy();
    expect(within(table).getByText(/^2,?500\.0$/)).toBeTruthy();
    expect(within(table).queryByText('Grolleg')).toBeNull();
    fireEvent.change(screen.getByLabelText('Lot of M-1, line 1'), { target: { value: 'G-12' } });
    fireEvent.change(screen.getByLabelText('Lot of M-3, line 3'), { target: { value: 'S-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].collection).toBe('shared');
    expect(saved[0].content).toMatchObject({
      sheet: 's',
      sheetNumber: 2,
      recipe: 'r',
      recipeNumber: 3,
      name: 'CP-1',
      size: '5000',
      lots: ['G-12', '', 'S-3']
    });
  });
});

describe('a casting slip as it is mixed and aged', () => {
  it('keeps deflocculant and water added in steps, with readings, and adds them up', async () => {
    const saved = fakeCore();
    const draft = { ...newMix({ recipe: slip }, new Date(2026, 9, 19)), size: '5000' };
    render(<Log recipes={[slip]} start={{ current: null, draft }} />);
    // The recipe's own materials, since this person reads them, and its target.
    expect(screen.getByText('Grolleg')).toBeTruthy();
    expect(screen.getByText(/aims for a specific gravity of 1.78/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Water at the start (g)'), { target: { value: '1900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(screen.getByLabelText('Day of step 1'), { target: { value: '2026-10-19' } });
    fireEvent.change(screen.getByLabelText('Deflocculant added, step 1'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Specific gravity, step 1'), { target: { value: '1.80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(screen.getByLabelText('Day of step 2'), { target: { value: '2026-10-21' } });
    fireEvent.change(screen.getByLabelText('Deflocculant added, step 2'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('Water added, step 2'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Ford cup #4, s, step 2'), { target: { value: '41' } });
    expect(screen.getByText('day 2')).toBeTruthy();
    const totals = screen.getByRole('table', { name: 'Put in all told' });
    expect(within(totals).getByText('37.5 g (0.75% of the dry batch)')).toBeTruthy();
    expect(within(totals).getByText(/^2,?000\.0 g \(40.00% of the dry batch\)$/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].content).toMatchObject({ sheet: null, recipe: 'r', recipeNumber: 3, name: '', water: '1900' });
    expect(saved[0].content.steps).toEqual([
      { on: '2026-10-19', deflocculant: '25', water: '', gravity: '1.80', viscosity: '', gel: '' },
      { on: '2026-10-21', deflocculant: '12.5', water: '100', gravity: '', viscosity: '41', gel: '' }
    ]);
  });

  it('asks what was mixed before saving a new one', async () => {
    const saved = fakeCore();
    render(<Log recipes={[slip]} sheets={[sheet]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log a mix' }));
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Overnight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Choose the batch sheet or recipe that was mixed.');
    fireEvent.change(screen.getByLabelText('Mixed from'), { target: { value: 'sheet:s' } });
    expect(screen.getByRole('heading', { name: 'Mix of CP-1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].content).toMatchObject({ sheet: 's', notes: 'Overnight' });
  });
});

describe('a printed mix record', () => {
  it('has the weights, a lot for each line, the steps so far and blank rows for the rest', () => {
    fakeCore();
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const draft = {
      ...newMix({ sheet }, new Date(2026, 9, 19)),
      size: '5000',
      lots: ['G-12'],
      steps: [{ on: '2026-10-19', deflocculant: '25', water: '', gravity: '1.80', viscosity: '', gel: '' }]
    };
    const { container } = render(<Log sheets={[sheet]} access={OPERATOR} start={{ current: null, draft }} />);
    expect(container.querySelector('.print-only')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Print mix record' }));
    expect(print).toHaveBeenCalledTimes(1);
    const paper = container.querySelector('.print-only') as HTMLElement;
    expect(within(paper).getByText('Mix record: CP-1')).toBeTruthy();
    expect(within(paper).getByText('G-12')).toBeTruthy();
    expect(within(paper).getByText(/^2,?500\.0$/)).toBeTruthy();
    expect(within(paper).getByText('1.80')).toBeTruthy();
    // One step typed, and eight blank for the rest.
    expect(paper.querySelectorAll('table.steps tbody tr')).toHaveLength(9);
    print.mockRestore();
  });

  it('is not offered to someone who may not print', () => {
    fakeCore();
    const noPrint: Access = { ...OPERATOR, collections: OPERATOR.collections.map((c) => ({ ...c, print: false })) };
    render(<Log sheets={[sheet]} access={noPrint} start={{ current: null, draft: newMix({ sheet }, new Date(2026, 9, 19)) }} />);
    expect(screen.queryByRole('button', { name: 'Print mix record' })).toBeNull();
  });
});
