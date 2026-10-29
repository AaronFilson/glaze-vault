// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Checkout, SyncStatus } from '../api';
import { CheckoutBar } from './CheckoutBar';
import { SyncIndicator } from './SyncIndicator';

const sync = (fields: Partial<SyncStatus>): SyncStatus => ({
  replica: true,
  syncing: false,
  lastSynced: Date.UTC(2026, 9, 29, 10, 30),
  error: null,
  watching: true,
  waiting: 0,
  refused: 0,
  photosWaiting: 0,
  ...fields
});

const ana: Checkout = { record: 'r1', person: 'ana', name: 'Ana', mine: false, since: 0, expires: 1 };

describe('checking a record out', () => {
  it('shows who has it elsewhere, and takes it over', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'sync_status') return sync({});
      if (command === 'checkouts') return [ana];
      if (command === 'check_out') return [{ ...ana, person: 'ben', name: 'Ben', mine: true }];
    });
    render(<CheckoutBar kind="recipe" record="r1" readOnly={false} />);
    expect(await screen.findByText('Ana')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take it over' }));
    expect(await screen.findByText(/You have this checked out/)).toBeTruthy();
    expect(calls).toContainEqual(['check_out', { kind: 'recipe', record: 'r1', takeOver: true }]);
  });

  it('is not shown on a vault on one computer', async () => {
    let asked = false;
    mockIPC((command) => {
      if (command === 'sync_status') {
        asked = true;
        return sync({ replica: false });
      }
    });
    render(<CheckoutBar kind="recipe" record="r1" readOnly={false} />);
    await waitFor(() => expect(asked).toBe(true));
    expect(screen.queryByRole('button', { name: 'Check out' })).toBeNull();
  });
});

describe('the sync indicator', () => {
  it('says when the host is out of reach, and what waits', async () => {
    mockIPC((command) =>
      command === 'sync_status' ? sync({ error: 'The connection failed: refused', waiting: 3, refused: 1 }) : undefined
    );
    render(<SyncIndicator />);
    fireEvent.click(await screen.findByRole('button', { name: /Not synced/ }));
    expect(screen.getByText(/host is out of reach: The connection failed/)).toBeTruthy();
    expect(screen.getByText(/3 changes wait to reach the host/)).toBeTruthy();
    expect(screen.getByText(/would not take one change/)).toBeTruthy();
  });
});
