// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { STANDARD_LIBRARY, type RecipeContent, type RecipeLine } from '../chemistry';
import { BUILT_IN_LIMITS } from '../limits';
import { Fit } from './Fit';

const lime: RecipeContent = {
  name: 'Lime matte',
  notes: '',
  lines: [
    { material: 'Custer Spar', amount: '25' },
    { material: 'Silica', amount: '20' },
    { material: 'Whiting', amount: '35' },
    { material: 'EPK', amount: '20' },
    { material: 'Red Iron Oxide', amount: '2', addition: true }
  ]
};

describe('fitting on screen', () => {
  it('moves a recipe into a limit formula with a material brought in, and hands the amounts back', () => {
    const onUse = vi.fn<(lines: RecipeLine[]) => void>();
    render(
      <Fit recipe={lime} library={STANDARD_LIBRARY} sets={BUILT_IN_LIMITS} initialSet="" onUse={onUse} onClose={() => {}} />
    );
    // The colorant is kept as it is unless asked.
    expect((screen.getByLabelText('Red Iron Oxide may change') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Also try'), { target: { value: 'Talc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByRole('status').textContent).toBe('Within Cone 6 (Digitalfire).');
    fireEvent.click(screen.getByRole('button', { name: 'Use these amounts' }));
    const lines = onUse.mock.calls[0][0];
    // Another target, and what was fitted to the last one goes.
    fireEvent.click(screen.getByLabelText('A unity formula I give'));
    expect(screen.queryByRole('button', { name: 'Use these amounts' })).toBeNull();
    expect(lines.find((l) => l.material === 'Red Iron Oxide')).toEqual({ material: 'Red Iron Oxide', amount: '2', addition: true });
    expect(Number(lines.find((l) => l.material === 'Talc')?.amount)).toBeGreaterThan(0);
    expect(Number(lines.find((l) => l.material === 'Whiting')!.amount)).toBeLessThan(35);
  });

  it('fits to a formula typed in', () => {
    render(<Fit recipe={lime} library={STANDARD_LIBRARY} sets={[]} initialSet="" onClose={() => {}} />);
    expect((screen.getByLabelText('A unity formula I give') as HTMLInputElement).checked).toBe(true);
    const silica = screen.getAllByLabelText(/^Target oxide/).findIndex((c) => (c as HTMLSelectElement).value === 'SiO2');
    const moles = screen.getAllByLabelText(/^Target moles/)[silica] as HTMLInputElement;
    fireEvent.change(moles, { target: { value: String(Number(moles.value) + 0.5) } });
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByRole('status').textContent).toBe('As near the target as these materials come.');
    // Without permission to change the recipe or make one, the amounts are only shown.
    expect(screen.queryByRole('button', { name: 'Use these amounts' })).toBeNull();
  });

  it('chooses other materials from the library, says what each is for, and leaves one out when asked', async () => {
    render(<Fit recipe={lime} library={STANDARD_LIBRARY} sets={[]} initialSet="" onClose={() => {}} />);
    // Boron, which nothing in the recipe has.
    const empty = screen.getAllByLabelText(/^Target oxide/).length - 1;
    fireEvent.change(screen.getAllByLabelText(/^Target oxide/)[empty], { target: { value: 'B2O3' } });
    fireEvent.change(screen.getAllByLabelText(/^Target moles/)[empty], { target: { value: '0.3' } });
    fireEvent.click(screen.getByLabelText(/Let it choose other materials too/));
    fireEvent.change(screen.getByLabelText('New materials, at most'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByRole('button', { name: 'Choosing…' })).toBeTruthy();
    const leaveOut = await screen.findAllByRole('button', { name: /^Leave .* out$/ }, { timeout: 15000 });
    expect(leaveOut).toHaveLength(1);
    const brought = leaveOut[0].getAttribute('aria-label')!.replace(/^Leave (.*) out$/, '$1');
    expect(leaveOut[0].closest('tr')!.textContent).toContain('B₂O₃');
    fireEvent.click(leaveOut[0]);
    expect(screen.getByText(/Not to use:/).textContent).toContain(brought);
  }, 20000);

  it('drops a choice whose inputs changed while it was choosing', async () => {
    render(<Fit recipe={lime} library={STANDARD_LIBRARY} sets={[]} initialSet="" onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/Let it choose other materials too/));
    fireEvent.change(screen.getByLabelText('New materials, at most'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    // Before the choice comes back, the target changes.
    const moles = screen.getAllByLabelText(/^Target moles/)[0] as HTMLInputElement;
    fireEvent.change(moles, { target: { value: String(Number(moles.value) + 0.1) } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeTruthy();
  }, 20000);
});
