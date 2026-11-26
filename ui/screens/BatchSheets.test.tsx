// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Access, RecipeHead } from '../api';
import type { BatchSheet } from '../batch';
import { BatchSheetForm, BatchSheets } from './BatchSheets';

const ALL = ['recipe', 'material', 'batch', 'firing', 'mix', 'limits', 'prices'] as const;

const FORMULATOR: Access = {
  team: true,
  me: { id: 'ana', name: 'Ana', admin: false, mustSetPassword: false },
  collections: [
    { id: 'shared', name: 'Shared', owner: null, role: 'formulator', changes: [...ALL], export: true, print: true, chemistry: true, manage: false }
  ]
};

const NO_PRINT_OPERATOR: Access = {
  team: true,
  me: { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false },
  collections: [
    { id: 'shared', name: 'Shared', owner: null, role: 'operator', changes: [], export: false, print: false, chemistry: false, manage: false }
  ]
};

const sheet: BatchSheet = {
  recordId: 's1',
  revisionId: 's1-v1',
  number: 1,
  savedAt: Date.UTC(2026, 9, 12),
  collectionId: 'shared',
  content: {
    name: 'Celadon 10',
    notes: 'Sieve 80 mesh twice',
    recipe: 'r1',
    recipeNumber: 1,
    lines: [
      { material: 'C-101', amount: '60' },
      { material: 'C-202', amount: '40' }
    ]
  }
};

describe('BatchSheets viewer decision trees', () => {
  it('shows empty hints, scales weights, validates batch size, prints, opens mixes, and deletes after asking', async () => {
    let failDelete = true;
    mockIPC((cmd) => {
      if (cmd === 'delete_record') {
        if (failDelete) throw { code: 'io', message: 'Cannot write' };
        return { ...sheet, deleted: true };
      }
      return null;
    });

    const { rerender } = render(
      <BatchSheets
        sheets={[]}
        access={FORMULATOR}
        names={{}}
        current={null}
        onOpen={() => {}}
        mixCount={0}
        onMixes={() => {}}
        onPrint={() => {}}
        onDeleted={() => {}}
        onSaved={() => {}}
      />
    );
    expect(screen.getByText('No batch sheets yet.')).toBeTruthy();
    expect(screen.getByText(/Batch sheet…, below the recipe\./)).toBeTruthy();

    const onOpen = vi.fn();
    const onPrint = vi.fn();
    const onMixes = vi.fn();
    const onDeleted = vi.fn();

    rerender(
      <BatchSheets
        sheets={[sheet]}
        access={FORMULATOR}
        names={{}}
        current={null}
        onOpen={onOpen}
        mixCount={0}
        onMixes={onMixes}
        onPrint={onPrint}
        onDeleted={onDeleted}
        onSaved={() => {}}
      />
    );
    expect(screen.getByText('Choose a batch sheet to weigh out.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Celadon 10' }));
    expect(onOpen).toHaveBeenCalledWith(sheet);

    rerender(
      <BatchSheets
        sheets={[sheet]}
        access={FORMULATOR}
        names={{}}
        current={sheet}
        onOpen={onOpen}
        mixCount={2}
        onMixes={onMixes}
        onPrint={onPrint}
        onDeleted={onDeleted}
        onSaved={() => {}}
      />
    );
    expect(screen.getByText('Sieve 80 mesh twice')).toBeTruthy();

    // Invalid size disables Print and hides BatchTable.
    const sizeInput = screen.getByLabelText('Batch size');
    fireEvent.change(sizeInput, { target: { value: '0' } });
    expect(sizeInput.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: 'Print' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.change(sizeInput, { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(onPrint).toHaveBeenCalledWith(5, 'kg');

    fireEvent.click(screen.getByRole('button', { name: 'Log a mix…' }));
    expect(onMixes).toHaveBeenCalledWith(sheet, true);
    fireEvent.click(screen.getByRole('button', { name: 'Mixes (2)' }));
    expect(onMixes).toHaveBeenCalledWith(sheet, false);

    // Delete cancel, failure, and success.
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot write');
    expect(onDeleted).not.toHaveBeenCalled();

    failDelete = false;
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(sheet));
  });

  it('hides Print, Log a mix, and Delete when the person lacks those capabilities', () => {
    render(
      <BatchSheets
        sheets={[sheet]}
        access={NO_PRINT_OPERATOR}
        names={{}}
        current={sheet}
        onOpen={() => {}}
        mixCount={0}
        onMixes={() => {}}
        onPrint={() => {}}
        onDeleted={() => {}}
        onSaved={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: 'Print' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log a mix…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete…' })).toBeNull();
  });
});

describe('BatchSheetForm decision trees', () => {
  const r1Old: RecipeHead = {
    recordId: 'r1',
    revisionId: 'r1-v1',
    number: 1,
    savedAt: 1,
    collectionId: 'shared',
    content: {
      name: 'Celadon',
      notes: '',
      lines: [
        { material: 'Custer Spar', amount: '60' },
        { material: 'Silica', amount: '40' }
      ]
    }
  };
  const r1Current: RecipeHead = {
    ...r1Old,
    revisionId: 'r1-v2',
    number: 2,
    content: { ...r1Old.content, lines: [...r1Old.content.lines, { material: 'Whiting', amount: '10' }] }
  };

  it('prefills known codes from recipe history, validates missing or clashing codes, and saves or cancels', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'record_history') return [r1Current, r1Old];
      if (cmd === 'save_record') return { ...sheet, revisionId: 's1-v2', number: 2, content: (args as { content: unknown }).content };
      return null;
    });
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    render(
      <BatchSheetForm
        recipe={r1Current}
        sheet={sheet}
        sheets={[sheet]}
        recipes={[r1Current]}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    );

    // Wait for knownCodes to prefill Custer Spar -> C-101 and Silica -> C-202 from revision 1!
    await waitFor(() => expect((screen.getByLabelText('Code for Custer Spar') as HTMLInputElement).value).toBe('C-101'));
    expect((screen.getByLabelText('Code for Silica') as HTMLInputElement).value).toBe('C-202');

    // Submitting with Whiting blank reports codeProblem.
    fireEvent.click(screen.getByRole('button', { name: 'Save batch sheet' }));
    expect(screen.getByRole('alert').textContent).toBe('Give each material a code.');

    // Giving Whiting the same code as Silica reports code clash.
    fireEvent.change(screen.getByLabelText('Code for Whiting'), { target: { value: 'C-202' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save batch sheet' }));
    expect(screen.getByRole('alert').textContent).toContain('C-202 is already the code for Silica');

    // Valid code saves new revision of the sheet.
    fireEvent.change(screen.getByLabelText('Code for Whiting'), { target: { value: 'C-303' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save batch sheet' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls.find(([c]) => c === 'save_record')?.[1]).toMatchObject({
      kind: 'batch',
      parent: 's1-v1'
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
