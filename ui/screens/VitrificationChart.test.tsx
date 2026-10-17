// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VitrificationChart } from './VitrificationChart';

afterEach(cleanup);

describe('the vitrification chart', () => {
  const points = [
    { cone: '04', firings: 1, absorption: 12, shrinkage: 4 },
    { cone: '6', firings: 2, absorption: 1.5, shrinkage: 12 },
    { cone: '10', firings: 1, shrinkage: 13 }
  ];

  it('has every value in its table', () => {
    render(<VitrificationChart points={points} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'ConeFiringsAbsorptionTotal shrinkage',
      '04112.0%4.0%',
      '621.5%12.0%',
      '101—13.0%'
    ]);
  });

  it('reads out a cone on focus, for the keyboard as for the pointer', () => {
    render(<VitrificationChart points={points} />);
    fireEvent.focus(screen.getByLabelText(/^Cone 6:/));
    const tip = screen.getByRole('status');
    expect(tip.textContent).toContain('Cone 6 · 2 firings');
    expect(tip.textContent).toContain('1.5% Absorption');
  });
});
