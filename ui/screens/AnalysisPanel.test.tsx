// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { analyse } from '../chemistry';
import { AnalysisPanel } from './AnalysisPanel';

afterEach(cleanup);

const PORCELAIN = analyse([
  { material: 'Kaolin', amount: '50' },
  { material: 'Potash Feldspar', amount: '25' },
  { material: 'Silica', amount: '25' }
]);

describe('the analysis panel', () => {
  it('shows a glaze its unity formula', () => {
    render(<AnalysisPanel analysis={PORCELAIN} />);
    expect(screen.getByRole('heading', { name: 'Unity formula' })).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Formula with Al₂O₃ = 1' })).toBeNull();
  });

  it('shows a body its oxide percentages and a formula with alumina as one', () => {
    render(<AnalysisPanel analysis={PORCELAIN} body />);
    expect(screen.getByRole('heading', { name: 'Chemistry' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Oxides, fired weight %' }).textContent).toContain('SiO₂');
    expect(screen.getByRole('table', { name: 'Formula with Al₂O₃ = 1' }).textContent).toContain('1.000');
    expect(screen.getByText('KNaO')).toBeTruthy();
    expect(screen.getByText(/keeps some of its silica as quartz/)).toBeTruthy();
    // The unity formula is still there, folded away.
    expect(screen.getByText('Unity formula', { selector: 'summary' })).toBeTruthy();
  });
});
