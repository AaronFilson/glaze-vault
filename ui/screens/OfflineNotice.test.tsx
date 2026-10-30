// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OfflineStatus } from '../api';
import { OfflineNotice } from './OfflineNotice';

const status = (fields: Partial<OfflineStatus>): OfflineStatus => ({
  applies: true,
  lastSynced: Date.UTC(2026, 9, 1),
  days: 20,
  nagDays: 14,
  limitDays: 30,
  extendedUntil: null,
  nag: true,
  readOnly: false,
  clockBack: false,
  ...fields
});

describe('the offline notice', () => {
  it('reminds, saying when changes will stop', async () => {
    mockIPC((command) => (command === 'offline_status' ? status({}) : undefined));
    render(<OfflineNotice />);
    expect(await screen.findByText(/In 10 days it takes no more changes/)).toBeTruthy();
  });

  it('takes an extension code once changes have stopped', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'offline_status') return status({ days: 31, readOnly: true });
      if (command === 'extend_offline') return status({ days: 31, nag: true, readOnly: false, limitDays: null });
    });
    render(<OfflineNotice />);
    fireEvent.change(await screen.findByLabelText('Extension code'), { target: { value: '14-K7Q-F9M2D-XW3PA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use the code' }));
    await waitFor(() => expect(screen.queryByLabelText('Extension code')).toBeNull());
    expect(calls).toContainEqual(['extend_offline', { code: '14-K7Q-F9M2D-XW3PA' }]);
  });

  it('says nothing on a computer the rule does not apply to', async () => {
    let asked = false;
    mockIPC((command) => {
      if (command === 'offline_status') {
        asked = true;
        return status({ applies: false });
      }
    });
    const { container } = render(<OfflineNotice />);
    await waitFor(() => expect(asked).toBe(true));
    expect(container.textContent).toBe('');
  });
});
