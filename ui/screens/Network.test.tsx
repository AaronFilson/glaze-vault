// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NetworkStatus, Person } from '../api';
import { Network } from './Network';

const PEOPLE: Person[] = [
  { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
  { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false }
];

const status = (fields: Partial<NetworkStatus>): NetworkStatus => ({
  replica: false,
  hostHere: false,
  hostAddress: null,
  canHost: true,
  defaultPort: 47917,
  ...fields
});

describe('the network section', () => {
  it('starts serving on the port and name given', async () => {
    const calls: [string, unknown][] = [];
    let serving = false;
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'network_status')
        return serving ? status({ replica: true, hostHere: true, hostAddress: '127.0.0.1:5000' }) : status({});
      if (command === 'start_hosting') {
        serving = true;
        return { pulled: 3, accepted: 0, refused: 0 };
      }
    });
    render(<Network people={PEOPLE} admin onChanged={() => {}} onLeft={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Port'), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText('Name other computers see'), { target: { value: 'Studio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Serve on this network' }));
    expect(await screen.findByText(/serves the vault on this network, on port 5000/)).toBeTruthy();
    expect(calls).toContainEqual(['start_hosting', { port: 5000, name: 'Studio' }]);
  });

  it('pairs a computer: shows the code, then the computer, and approves it for the people chosen', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'network_status') return status({ replica: true, hostHere: true, hostAddress: '127.0.0.1:47917' });
      if (command === 'start_pairing') return { code: '4821-0937', expiresAt: Date.now() + 600_000 };
      if (command === 'wait_for_pairing') return { device: 'd1', name: "Ben's laptop", fingerprint: '428b-ec49-9b19-3bd5' };
    });
    render(<Network people={PEOPLE} admin onChanged={() => {}} onLeft={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pair a computer…' }));
    expect(await screen.findByText(/428b-ec49-9b19-3bd5/)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Ben'));
    fireEvent.click(approve);
    await waitFor(() => expect(calls).toContainEqual(['approve_pairing', { people: ['ben'] }]));
    expect(await screen.findByText(/Ben's laptop is paired/)).toBeTruthy();
  });

  it('says so when hostd is missing', async () => {
    mockIPC((command) => (command === 'network_status' ? status({ canHost: false }) : undefined));
    render(<Network people={PEOPLE} admin onChanged={() => {}} onLeft={() => {}} />);
    expect(await screen.findByText(/hostd, is missing/)).toBeTruthy();
  });

  it('lets someone on a computer that syncs leave, warning of what has not reached the host', async () => {
    const calls: string[] = [];
    let left = false;
    mockIPC((command) => {
      calls.push(command);
      if (command === 'network_status') return status({ replica: true, hostAddress: '192.168.1.20:47917' });
      if (command === 'sync_status')
        return { replica: true, syncing: false, lastSynced: 1, error: null, watching: true, waiting: 2, refused: 0, photosWaiting: 0 };
    });
    render(<Network people={PEOPLE} admin={false} onChanged={() => {}} onLeft={() => (left = true)} />);
    expect(await screen.findByText(/syncs with the host at 192.168.1.20/)).toBeTruthy();
    // Someone who is not an admin pairs nothing.
    expect(screen.queryByRole('button', { name: 'Pair a computer…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Leave this vault…' }));
    expect(await screen.findByText(/2 changes saved here never reached the host/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave and remove it' }));
    await waitFor(() => expect(left).toBe(true));
    expect(calls).toContain('leave_vault');
  });

  it('tells someone who is not an admin that the vault is on this computer alone', async () => {
    mockIPC((command) => (command === 'network_status' ? status({}) : undefined));
    render(<Network people={PEOPLE} admin={false} onChanged={() => {}} onLeft={() => {}} />);
    expect(await screen.findByText(/on this computer alone/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Serve on this network' })).toBeNull();
  });
});
