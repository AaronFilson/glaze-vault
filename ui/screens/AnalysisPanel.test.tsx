// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { analyse } from '../chemistry';
import { AnalysisPanel } from './AnalysisPanel';

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

  it('shows what a body is made of, and warns a porcelain short of silica', () => {
    const makeup = { plastic: 50, silica: 15, unknown: ['Local red'] };
    render(<AnalysisPanel analysis={PORCELAIN} body makeup={makeup} bodyClass="porcelain" />);
    expect(screen.getByText('Plastic : non-plastic').nextElementSibling?.textContent).toBe('50 : 50');
    expect(screen.getByText('Added silica').nextElementSibling?.textContent).toBe('15.0%');
    expect(screen.getByText(/Local red has no class, so it counts as not plastic/)).toBeTruthy();
    expect(screen.getByText(/less than about 20% added silica tend to craze glazes/)).toBeTruthy();
  });

  it('does not warn a porcelain with silica enough, or a stoneware', () => {
    const { rerender } = render(
      <AnalysisPanel analysis={PORCELAIN} body makeup={{ plastic: 50, silica: 25, unknown: [] }} bodyClass="porcelain" />
    );
    expect(screen.queryByText(/tend to craze glazes/)).toBeNull();
    rerender(<AnalysisPanel analysis={PORCELAIN} body makeup={{ plastic: 80, silica: 10, unknown: [] }} bodyClass="stoneware" />);
    expect(screen.queryByText(/tend to craze glazes/)).toBeNull();
  });
});
