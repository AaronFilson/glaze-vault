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
    render(<Network people={PEOPLE} onChanged={() => {}} />);
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
    render(<Network people={PEOPLE} onChanged={() => {}} />);
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
    render(<Network people={PEOPLE} onChanged={() => {}} />);
    expect(await screen.findByText(/hostd, is missing/)).toBeTruthy();
  });
});
