// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MaterialHead, RecipeHead } from '../api';
import type { ImportPlan } from '../importFormats';
import { Import } from './Import';

const existingRecipe = (id: string, name: string): RecipeHead => ({
  recordId: id,
  revisionId: `${id}-rev1`,
  number: 1,
  savedAt: 1,
  content: { name, lines: [{ material: 'Silica', amount: '100' }], notes: '' }
});

const existingMaterial: MaterialHead = {
  recordId: 'mat-1',
  revisionId: 'mat-1-rev1',
  number: 1,
  savedAt: 1,
  content: {
    name: 'Local Clay',
    category: 'material',
    oxides: [{ oxide: 'SiO2', percent: '60' }],
    loi: '10',
    notes: ''
  }
};

describe('Import screen decision trees', () => {
  it('shows file warnings, skips standard and clashing names by default, toggles Import all / none, and updates missing materials dynamically', async () => {
    const plan: ImportPlan = {
      format: 'Glaze Vault JSON',
      warnings: ['Line 4 had no oxide value', 'Skipped empty row'],
      materials: [
        { name: 'Silica', category: 'material', oxides: [{ oxide: 'SiO2', percent: '100' }], loi: '0', notes: '' },
        { name: 'Local Clay', category: 'material', oxides: [{ oxide: 'SiO2', percent: '62' }], loi: '9', notes: '' },
        {
          name: 'Custom Frit',
          category: 'frit',
          basis: 'formula',
          oxides: [],
          formula: [{ oxide: 'B2O3', moles: '1' }],
          loi: '0',
          notes: ''
        }
      ],
      recipes: [
        { name: 'Shino', lines: [{ material: 'Silica', amount: '100' }], notes: '' },
        { name: 'Shino (imported)', lines: [{ material: 'Silica', amount: '100' }], notes: '' },
        { name: 'Boron Clear', lines: [{ material: 'Custom Frit', amount: '50' }], notes: '' }
      ]
    };

    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'save_records') {
        const batch = (args as { revisions: [string | null, { name: string }][] }).revisions;
        return batch.map(([parent, content], i) => ({
          recordId: parent ? `existing-${i}` : `new-${i}`,
          revisionId: `rev-${i}`,
          number: parent ? 2 : 1,
          savedAt: 2,
          content
        }));
      }
      return null;
    });

    const onImported = vi.fn();
    const onClose = vi.fn();
    render(
      <Import
        fileName="studio.json"
        plan={plan}
        recipes={[existingRecipe('r1', 'Shino'), existingRecipe('r2', 'Shino (imported)')]}
        materials={[existingMaterial]}
        collection="shared"
        into={<p>Saving into Shared</p>}
        onImported={onImported}
        onClose={onClose}
      />
    );

    expect(screen.getByText('Saving into Shared')).toBeTruthy();
    expect(screen.getByText('2 notes on reading the file')).toBeTruthy();
    expect(screen.getByText('Line 4 had no oxide value')).toBeTruthy();
    expect(screen.getByText('Frit, formula')).toBeTruthy();

    // Standard material Silica and clashing Local Clay default to skip; Custom Frit defaults to import.
    const silicaSelect = screen.getByLabelText('What to do with Silica') as HTMLSelectElement;
    expect(silicaSelect.value).toBe('skip');
    expect([...silicaSelect.options].map((o) => o.textContent)).toEqual([
      'Skip: the standard Silica is used',
      'Import, to use instead of the standard Silica'
    ]);
    expect((screen.getByLabelText('What to do with Local Clay') as HTMLSelectElement).value).toBe('skip');
    expect((screen.getByLabelText('What to do with Custom Frit') as HTMLSelectElement).value).toBe('import');

    // While Custom Frit is set to import, Boron Clear has no missing material warning.
    expect(screen.queryByText(/not found: Custom Frit/)).toBeNull();

    // Clicking "Import none" on Materials skips Custom Frit -> Boron Clear now warns "not found: Custom Frit"!
    const matSection = screen.getByRole('heading', { name: 'Materials (3)' }).closest('section')!;
    fireEvent.click(within(matSection).getByRole('button', { name: 'Import none' }));
    expect(screen.getByText(/not found: Custom Frit/)).toBeTruthy();

    // Clicking "Import none" on Recipes too disables the main Import button!
    const recSection = screen.getByRole('heading', { name: 'Recipes (3)' }).closest('section')!;
    fireEvent.click(within(recSection).getByRole('button', { name: 'Import none' }));
    const importBtn = screen.getByRole('button', { name: 'Import 0 recipes and 0 materials' }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);

    // Clicking "Import all" restores plain items without touching clashes or standard materials.
    fireEvent.click(within(matSection).getByRole('button', { name: 'Import all' }));
    fireEvent.click(within(recSection).getByRole('button', { name: 'Import all' }));
    expect(silicaSelect.value).toBe('skip');
    expect((screen.getByLabelText('What to do with Custom Frit') as HTMLSelectElement).value).toBe('import');
    expect((screen.getByLabelText('What to do with Boron Clear') as HTMLSelectElement).value).toBe('import');

    // Choose "copy" for Shino -> since "Shino (imported)" already exists in the vault, freeName picks "Shino (imported 2)"!
    fireEvent.change(screen.getByLabelText('What to do with Shino'), { target: { value: 'copy' } });
    // Choose to import Silica to replace standard, and Local Clay as a revision.
    fireEvent.change(silicaSelect, { target: { value: 'import' } });
    fireEvent.change(screen.getByLabelText('What to do with Local Clay'), { target: { value: 'revision' } });

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 recipes and 3 materials' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));

    const recipeCall = calls.find(([cmd, a]) => cmd === 'save_records' && (a as { kind: string }).kind === 'recipe')![1] as {
      collection: string;
      revisions: [string | null, { name: string }][];
    };
    expect(recipeCall.collection).toBe('shared');
    expect(recipeCall.revisions.map(([p, c]) => [p, c.name])).toEqual([
      [null, 'Shino (imported 2)'],
      [null, 'Boron Clear']
    ]);

    expect(await screen.findByText('2 recipes and 3 materials imported from studio.json.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels before importing without saving anything', () => {
    const onClose = vi.fn();
    render(
      <Import
        fileName="empty.glz"
        plan={{ format: 'GlazeChem', warnings: [], materials: [], recipes: [{ name: 'Test', lines: [], notes: '' }] }}
        recipes={[]}
        materials={[]}
        onImported={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
