// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { RecipeHead } from '../api';
import { EMPTY_BAR, newFiring, type Firing, type FiringContent } from '../firing';
import { FiringLog, type FiringEditing } from './FiringLog';

vi.setConfig({ testTimeout: 30_000 });

const recipe = (recordId: string, name: string, number: number, more: Partial<RecipeHead['content']> = {}): RecipeHead => ({
  recordId,
  revisionId: `${recordId}-${number}`,
  number,
  savedAt: Date.UTC(2026, 9, 1),
  content: { name, lines: [], notes: '', ...more }
});

const porcelain = recipe('p', 'Cone 6 porcelain', 2, {
  type: 'clay body',
  bodyClass: 'porcelain',
  absorptionMax: '1',
  lines: [
    { material: 'Grolleg China Clay', amount: '50' },
    { material: 'Custer Spar', amount: '25' },
    { material: 'Silica', amount: '25' }
  ]
});
const clear = recipe('g', 'Clear', 3, { type: 'glaze', lines: [{ material: 'Custer Spar', amount: '100' }] });

const firing = (id: string, content: Partial<FiringContent>): Firing => ({
  recordId: id,
  revisionId: `${id}-1`,
  number: 1,
  savedAt: Date.UTC(2026, 9, 10),
  content: { ...newFiring(null, new Date(2026, 9, 10)), ...content }
});

/** Pretends to be the core: saving a firing hands it back as saved, and a recipe's history has an
 * earlier revision of the porcelain. */
function fakeCore() {
  const saved: FiringContent[] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'save_record':
        saved.push(a.content as FiringContent);
        return { recordId: 'new', revisionId: `new-${saved.length}`, number: saved.length, savedAt: 1, content: a.content };
      case 'record_history':
        return [
          porcelain,
          { ...porcelain, revisionId: 'p-1', number: 1, content: { ...porcelain.content, lines: [{ material: 'EPK Kaolin', amount: '100' }] } }
        ];
      default:
        return null;
    }
  });
  return saved;
}

function Log({ firings, forRecipe = null, start = null }: { firings: Firing[]; forRecipe?: string | null; start?: FiringEditing | null }) {
  const [editing, setEditing] = useState<FiringEditing | null>(start);
  return (
    <FiringLog
      firings={firings}
      recipes={[porcelain, clear]}
      access={null}
      editing={editing}
      onEdit={setEditing}
      forRecipe={forRecipe}
      onForRecipe={() => {}}
      onSaved={() => {}}
      onErased={() => {}}
    />
  );
}

describe('a body’s firing', () => {
  it('keeps the lot of each material by the revision fired, and how far a bar warped', async () => {
    const saved = fakeCore();
    const draft = newFiring({ recordId: 'p', number: 2, name: 'Cone 6 porcelain' }, new Date(2026, 9, 18));
    render(<Log firings={[]} start={{ current: null, draft }} />);
    fireEvent.change(screen.getByLabelText('Grolleg China Clay'), { target: { value: 'bag 3' } });
    fireEvent.change(screen.getByLabelText('Silica'), { target: { value: 'lot 7731' } });

    fireEvent.change(screen.getByLabelText('Span between supports, mm'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Bow when dry, mm'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Sag when fired, mm'), { target: { value: '3' } });
    expect(within(screen.getByRole('table', { name: 'Warping' })).getByText('3.5 mm over 100 mm')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Drying disk cracks'), { target: { value: '2' } });

    // A body is not fired on a body.
    expect(screen.queryByText('Glaze fit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].lots).toEqual(['bag 3', '', 'lot 7731']);
    expect(saved[0].bar).toEqual({ ...EMPTY_BAR, span: '100', bow: '0.5', sag: '3', disk: '2' });
  });

  it('names the lots by an earlier revision’s materials, from its history', async () => {
    fakeCore();
    const old = firing('f1', { recipe: 'p', recipeNumber: 1, recipeName: 'Cone 6 porcelain', lots: ['bag 1'] });
    render(<Log firings={[old]} start={{ current: old, draft: old.content }} />);
    expect(((await screen.findByLabelText('EPK Kaolin')) as HTMLInputElement).value).toBe('bag 1');
  });
});

describe('glaze fit', () => {
  it('names the body a glaze was fired on, and how a fit test went', async () => {
    const saved = fakeCore();
    const draft = newFiring({ recordId: 'g', number: 3, name: 'Clear' }, new Date(2026, 9, 18));
    render(<Log firings={[]} start={{ current: null, draft }} />);
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'cone 6 porcelain' } });
    fireEvent.change(screen.getByLabelText('Fit test'), { target: { value: 'iwct' } });
    fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'crazed' } });
    fireEvent.change(screen.getByLabelText('How'), { target: { value: 'at 325 °F' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].body).toEqual({ recipe: 'p', name: 'cone 6 porcelain' });
    expect(saved[0].fit).toEqual({ test: 'iwct', result: 'crazed', detail: 'at 325 °F' });
  });

  it('stays open while its field is cleared, and is cleared for another recipe', async () => {
    fakeCore();
    render(<Log firings={[]} start={{ current: null, draft: newFiring(null, new Date(2026, 9, 18)) }} />);
    fireEvent.change(screen.getByLabelText('Recipe'), { target: { value: 'g' } });
    const fold = screen.getByText('Glaze fit').closest('details')!;
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'C' } });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '' } });
    expect(fold.open).toBe(true);

    fireEvent.change(screen.getByLabelText('Custer Spar'), { target: { value: 'bag 9' } });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Cone 6 porcelain' } });
    fireEvent.change(screen.getByLabelText('Recipe'), { target: { value: 'p' } });
    // The glaze's lot is not the porcelain's first material's, and a body is not fired on a body.
    expect((screen.getByLabelText('Grolleg China Clay') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Glaze fit')).toBeNull();
  });

  it('is in the body’s firings too, beside its own, under its targets', () => {
    fakeCore();
    const bar = (fired: string, soaked: string) => ({ ...EMPTY_BAR, dry: '94', fired, firedWeight: '50', soakedWeight: soaked });
    const firings = [
      firing('b5', { recipe: 'p', recipeName: 'Cone 6 porcelain', cone: '5', bar: bar('89', '51') }),
      firing('b6', { recipe: 'p', recipeName: 'Cone 6 porcelain', cone: '6', bar: bar('88', '50.25') }),
      firing('g1', { recipe: 'g', recipeName: 'Clear', body: { recipe: 'p', name: 'Cone 6 porcelain' }, fit: { test: 'iwct', result: 'passed' } }),
      firing('other', { recipe: 'g', recipeName: 'Clear' })
    ];
    render(<Log firings={firings} forRecipe="p" />);
    expect(screen.getByText(/Firings of Cone 6 porcelain, and of glazes fired on it/)).toBeTruthy();
    const list = within(screen.getByRole('navigation', { name: 'Firings' })).getAllByRole('button', { name: /Clear|porcelain/ });
    expect(list.map((b) => b.textContent)).toContain('Clear 2026-10-10 · on Cone 6 porcelain · IWCT: passed');
    expect(list).toHaveLength(3);
    // The curve is of the body's own bars, against its target of 1% absorption at most.
    expect(screen.getByText(/Inside the targets at cone 6\./)).toBeTruthy();
  });
});
