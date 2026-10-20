// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VitrificationChart } from './VitrificationChart';

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

  it('shades a body’s targets, and says which cones are inside them', () => {
    const { container } = render(
      <VitrificationChart points={points} targets={{ absorption: { max: 2 }, shrinkage: { min: 11, max: 13 } }} />
    );
    expect(container.querySelectorAll('.target-band')).toHaveLength(2);
    expect(screen.getByText(/Inside the targets at cone 6\./).textContent).toContain(
      'Aimed for: absorption at most 2%, total shrinkage 11–13%.'
    );
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual(['Inside the targets', 'No', 'Yes', '—']);
    expect(screen.getByLabelText(/^Cone 6:/).getAttribute('aria-label')).toContain('inside the targets');
  });

  it('says when no cone is inside the targets yet', () => {
    render(<VitrificationChart points={points} targets={{ absorption: { max: 0.5 } }} />);
    expect(screen.getByText(/No cone is inside the targets yet/)).toBeTruthy();
  });
});
