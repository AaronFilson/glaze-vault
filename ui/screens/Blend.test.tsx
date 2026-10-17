// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecipeHead } from '../api';
import { STANDARD_LIBRARY, type RecipeContent } from '../chemistry';
import { Blend } from './Blend';

afterEach(cleanup);

const head = (id: string, name: string, lines: [string, string][]): RecipeHead => ({
  recordId: id,
  revisionId: `${id}-1`,
  number: 1,
  savedAt: 1,
  content: { name, notes: '', lines: lines.map(([material, amount]) => ({ material, amount })) }
});

const recipes = [
  head('a', 'Clear', [['Custer Feldspar', '40'], ['Silica', '30'], ['Whiting', '30']]),
  head('b', 'Matte', [['Custer Feldspar', '30'], ['Dolomite', '30'], ['EPK', '40']]),
  head('c', 'Rutile', [['Rutile', '100']])
];

describe('a triaxial blend', () => {
  it('numbers its points on a triangle, and saves one as a recipe', async () => {
    const onSave = vi.fn<(content: RecipeContent) => Promise<void>>(async () => {});
    render(<Blend recipes={recipes} library={STANDARD_LIBRARY} initial="a" canSave onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Triaxial of three'));
    expect(screen.getByRole('heading', { name: 'Triaxial blend' })).toBeTruthy();
    expect((screen.getByLabelText('Third recipe') as HTMLSelectElement).value).toBe('c');
    // Four steps along a side: 15 tests.
    expect(screen.getAllByRole('button', { name: /^Save .* as a recipe$/ })).toHaveLength(15);
    fireEvent.change(screen.getByLabelText('Steps along a side'), { target: { value: '2' } });
    expect(screen.getAllByRole('button', { name: /^Save .* as a recipe$/ })).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: 'Save Matte 50 · Rutile 50 as a recipe' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved.notes).toBe('A triaxial blend of Clear, Matte and Rutile.');
    // Clear has no share in it, so its materials are left out.
    expect(saved.lines.map((l) => l.material)).toEqual(['Custer Feldspar', 'Dolomite', 'EPK', 'Rutile']);
  });
});
