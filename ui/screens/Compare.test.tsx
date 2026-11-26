// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RecipeHead } from '../api';
import { analyse, STANDARD_LIBRARY, type RecipeContent } from '../chemistry';
import { Compare } from './Compare';
import { PrintView } from './PrintView';

const makeRecipe = (id: string, number: number, content: RecipeContent): RecipeHead => ({
  recordId: id,
  revisionId: `${id}-v${number}`,
  number,
  savedAt: Date.UTC(2026, 9, number),
  content
});

describe('Compare screen decision trees', () => {
  it('compares glazes, details, tags, notes, additions, unknown-material errors, and switches pickers', async () => {
    const rev1 = makeRecipe('r1', 1, {
      name: 'Shino',
      cone: '9',
      atmosphere: 'reduction',
      tags: ['highfire'],
      lines: [{ material: 'Nepheline Syenite (typical)', amount: '100' }],
      notes: 'Thick on rims'
    });
    const rev2 = makeRecipe('r1', 2, {
      name: 'Shino',
      cone: '10',
      atmosphere: 'reduction',
      tags: ['highfire', 'production'],
      lines: [
        { material: 'Nepheline Syenite (typical)', amount: '90' },
        { material: 'Silica', amount: '10' },
        { material: 'Red Iron Oxide', amount: '2', addition: true }
      ],
      notes: ''
    });
    const broken = makeRecipe('r2', 1, {
      name: 'Mystery Glaze',
      lines: [{ material: 'Moon Dust', amount: '100' }],
      notes: ''
    });

    mockIPC((cmd, args) => {
      if (cmd === 'record_history' && (args as { recordId: string }).recordId === 'r1') return [rev2, rev1];
      if (cmd === 'record_history') return [broken];
      return null;
    });

    const onClose = vi.fn();
    render(
      <Compare
        recipes={[rev2, broken]}
        unsaved={{ recordId: 'r1', content: { ...rev2.content, name: 'Shino draft' } }}
        library={STANDARD_LIBRARY}
        initial={[
          { recordId: 'r1', number: 1 },
          { recordId: 'r1', number: null }
        ]}
        onClose={onClose}
      />
    );

    expect(await screen.findByText('+ Red Iron Oxide (addition)')).toBeTruthy();
    // Details and Notes sections appear when they differ.
    expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy();
    expect(screen.getByText(/Tags: highfire, production/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeTruthy();
    expect(screen.getByText('Thick on rims')).toBeTruthy();

    // Switch Second recipe to Mystery Glaze -> shows problem banner!
    fireEvent.change(screen.getByLabelText('Recipe', { selector: '#second-recipe' }), { target: { value: 'r2' } });
    expect(await screen.findByText(/Mystery Glaze: Unknown material Moon Dust/)).toBeTruthy();

    // Switch First revision back to Newest (revision 2), then First recipe to draft!
    fireEvent.change(screen.getByLabelText('Revision', { selector: '#first-revision' }), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Recipe', { selector: '#first-recipe' }), { target: { value: 'draft' } });
    expect(within(screen.getByRole('table', { name: 'Batch, percent of each' })).getByText('Unsaved changes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('compares two zero-flux clay bodies without crashing on missing unity formulas', async () => {
    const b1 = makeRecipe('b1', 1, {
      name: 'Kaolin slip',
      type: 'slip',
      lines: [
        { material: 'Kaolin (theoretical)', amount: '60' },
        { material: 'Silica', amount: '40' }
      ],
      notes: ''
    });
    const b2 = makeRecipe('b2', 1, {
      name: 'Refractory wash',
      type: 'slip',
      lines: [
        { material: 'Kaolin (theoretical)', amount: '40' },
        { material: 'Silica', amount: '60' }
      ],
      notes: ''
    });
    mockIPC(() => []);
    render(
      <Compare
        recipes={[b1, b2]}
        unsaved={null}
        library={STANDARD_LIBRARY}
        initial={[
          { recordId: 'b1', number: null },
          { recordId: 'b2', number: null }
        ]}
        onClose={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByRole('table', { name: 'Unity formula' })).toBeTruthy());
    const table = screen.getByRole('table', { name: 'Unity formula' });
    expect(table.textContent).toContain('SiO₂ : Al₂O₃');
    expect(table.textContent).toContain('Loss on ignition, %');
  });
});

describe('PrintView decision trees', () => {
  it('renders unsaved banner, empty batch message, costs with missing-price note, and clay-body dust warnings', () => {
    const emptyContent: RecipeContent = { name: 'Empty', lines: [], notes: 'Try later' };
    const { container, rerender } = render(
      <PrintView
        job={{ kind: 'batch', size: 1000, unit: 'g' }}
        content={emptyContent}
        saved={null}
        changed
        analysis={analyse([])}
      />
    );
    expect(container.textContent).toContain('Not saved: printed with unsaved changes');
    expect(container.textContent).toContain('This recipe has no amounts to scale.');
    expect(container.textContent).toContain('Try later');

    // Clay body with no added silica (pure kaolin) still warns that clay bodies carry silica, and shows batch costs!
    const clayOnly: RecipeContent = {
      name: 'Pure Clay Slip',
      type: 'slip',
      cone: '6',
      tags: ['white'],
      lines: [
        { material: 'EPK Kaolin', amount: '80' },
        { material: 'Bentonite', amount: '2', addition: true }
      ],
      notes: ''
    };
    const savedHead = makeRecipe('c1', 3, clayOnly);
    rerender(
      <PrintView
        job={{ kind: 'batch', size: 1, unit: 'kg' }}
        content={clayOnly}
        saved={savedHead}
        changed={false}
        analysis={analyse(clayOnly.lines, STANDARD_LIBRARY, { body: true })}
        prices={{ currency: '$', unit: 'kg', prices: [{ material: 'EPK Kaolin', price: '1.20' }] }}
      />
    );
    expect(container.textContent).toContain('Revision 3');
    expect(container.textContent).toContain('Tags: white');
    expect(container.textContent).toContain('clay bodies carry silica.');
    expect(container.textContent).toContain('$1.20');
    expect(container.textContent).toContain('The cost leaves out Bentonite, which have no price.');
    expect(container.textContent).toContain('Weighed by');

    // Recipe print of a clay body embeds the body Chemistry panel.
    rerender(
      <PrintView
        job={{ kind: 'recipe' }}
        content={clayOnly}
        saved={savedHead}
        changed={false}
        analysis={analyse(clayOnly.lines, STANDARD_LIBRARY, { body: true })}
      />
    );
    expect(container.textContent).toContain('Oxides, fired weight %');
    expect(container.textContent).toContain('+ Bentonite (addition)');
  });
});
