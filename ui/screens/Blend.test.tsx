// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RecipeHead } from '../api';
import { STANDARD_LIBRARY, type RecipeContent } from '../chemistry';
import { Blend } from './Blend';

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
  it('needs three different recipes', () => {
    render(<Blend recipes={recipes.slice(0, 2)} library={STANDARD_LIBRARY} initial="a" canSave onSave={async () => {}} onClose={() => {}} />);
    expect((screen.getByRole('radio', { name: /Triaxial of three/ }) as HTMLInputElement).disabled).toBe(true);
    cleanup();
    render(<Blend recipes={recipes} library={STANDARD_LIBRARY} initial="a" canSave onSave={async () => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Triaxial of three'));
    fireEvent.change(screen.getByLabelText('Third recipe'), { target: { value: 'b' } });
    expect(screen.getByText('Choose three different recipes.')).toBeTruthy();
  });

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

describe('a blend of bodies', () => {
  const body = (id: string, name: string, lines: [string, string][]): RecipeHead => {
    const recipe = head(id, name, lines);
    recipe.content.type = 'clay body';
    return recipe;
  };
  const bodies = [
    body('p', 'Porcelain', [['EPK Kaolin', '50'], ['Custer Spar', '25'], ['Silica', '25']]),
    body('s', 'Stoneware', [['OM-4 Ball Clay', '80'], ['Custer Spar', '10'], ['Silica', '10']])
  ];

  it('shows each step as a body, with what is plastic, and saves a step as a body', async () => {
    const onSave = vi.fn<(content: RecipeContent) => Promise<void>>(async () => {});
    render(<Blend recipes={bodies} library={STANDARD_LIBRARY} initial="p" canSave onSave={onSave} onClose={() => {}} />);
    expect(screen.queryByRole('table', { name: 'Unity formula' })).toBeNull();
    const oxides = screen.getByRole('table', { name: 'Oxides, fired weight %' });
    const plastic = within(oxides).getByText('Plastic : non-plastic').parentElement!;
    expect([...plastic.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      '50 : 50',
      '58 : 43',
      '65 : 35',
      '73 : 28',
      '80 : 20'
    ]);
    const silica = within(oxides).getByText('Added silica').parentElement!;
    expect(silica.querySelector('td')?.textContent).toBe('25.0%');
    expect(screen.getByRole('table', { name: 'Formula with Al₂O₃ = 1' }).textContent).toContain('1.000');

    fireEvent.click(screen.getAllByRole('button', { name: /^Save .* as a recipe$/ })[2]);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].type).toBe('clay body');
  });
});

describe('bar labels', () => {
  it('give each test at each cone a label, with the recipes by their letters', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<Blend recipes={recipes} library={STANDARD_LIBRARY} initial="a" canSave onSave={async () => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '3' } });
    expect(screen.getByText(/Each recipe goes by its letter: A: Clear · B: Matte\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name on the labels'), { target: { value: 'LB 12' } });
    fireEvent.change(screen.getByLabelText('Cones'), { target: { value: '5, 6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Print 6 bar labels…' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const labels = [...document.querySelectorAll('.bar-label')].map((li) =>
      [...li.children].map((part) => part.textContent)
    );
    expect(labels).toHaveLength(6);
    expect(labels[1]).toEqual(['LB 12 · 2', 'A 50 · B 50', 'Cone 5', 'Mark']);
    expect(labels[5]).toEqual(['LB 12 · 3', 'B 100', 'Cone 6', 'Mark']);
    // Labels name no materials, and the weights are not printed with them.
    expect(document.querySelector('.print-only')!.textContent).not.toContain('Custer Feldspar');
    print.mockRestore();
  });

  it('are not offered where the blend may not be printed', () => {
    render(
      <Blend
        recipes={recipes}
        library={STANDARD_LIBRARY}
        initial="a"
        canSave
        canPrint={() => false}
        onSave={async () => {}}
        onClose={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: /bar labels/ })).toBeNull();
  });
});
