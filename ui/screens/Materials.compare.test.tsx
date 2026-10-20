// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MaterialHead } from '../api';
import { fakeCore, show, spar } from './recipesTestKit';

// The whole screen renders in jsdom, with the materials list, so give it time on slow machines.
vi.setConfig({ testTimeout: 30_000 });

const clay = (id: string, name: string, cone: string, absorption: string): MaterialHead => ({
  ...spar,
  recordId: id,
  revisionId: `${id}-revision`,
  content: { ...spar.content, name, class: 'fire clay', sheet: { cone, dryingShrinkage: '6', absorption } }
});

describe('comparing materials', () => {
  it('puts the chosen ones side by side, from the one open', async () => {
    fakeCore({ materials: [clay('m1', 'Old fire clay', '10', '4.2'), clay('m2', 'Candidate', '10', '3.1'), spar] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Old fire clay' }));
    await user.click(screen.getByRole('button', { name: 'Compare…' }));
    expect(screen.getByRole('heading', { name: 'Compare materials' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Old fire clay' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Choose two or more materials.')).toBeTruthy();

    await user.click(screen.getByRole('checkbox', { name: 'Candidate' }));
    const sheets = screen.getByRole('table', { name: 'Data sheets' });
    expect(within(sheets).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Old fire clay',
      'Candidate'
    ]);
    const absorption = within(sheets).getByText('Absorption').closest('tr')!;
    expect([...absorption.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['4.2', '3.1 −1.1']);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('table', { name: 'Analysis, weight % of the raw material' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByLabelText('Material name')).toBeTruthy();
  });

  it('warns when the sheets are at different cones', async () => {
    fakeCore({ materials: [clay('m1', 'Old fire clay', '10', '4.2'), clay('m2', 'Candidate', '6', '3.1')] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Compare…' }));
    await user.click(screen.getByRole('checkbox', { name: 'Candidate' }));
    await user.click(screen.getByRole('checkbox', { name: 'Old fire clay' }));
    // Chosen in that order, the candidate is the first column.
    const headers = within(screen.getByRole('table', { name: 'Data sheets' })).getAllByRole('columnheader');
    expect(headers.map((th) => th.textContent)).toEqual(['', 'Candidate', 'Old fire clay']);
    expect(screen.getByRole('note').textContent).toContain('different cones');
  });
});
