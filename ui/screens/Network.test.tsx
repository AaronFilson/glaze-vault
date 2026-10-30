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
  device: null,
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
      // Ben was added since this sign-in began, so the lock screen's list lacks him.
      if (command === 'team') return { people: PEOPLE, grants: [] };
    });
    render(<Network people={PEOPLE.slice(0, 1)} admin onChanged={() => {}} onLeft={() => {}} />);
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

  it('revokes a lost computer, and shows its people\u2019s new one-time passwords', async () => {
    const calls: [string, unknown][] = [];
    const laptop = { id: 'd2', name: "Ben's laptop", people: ['ben'], issuedAt: 1, revoked: false, lost: false };
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'network_status')
        return status({ replica: true, hostHere: true, hostAddress: '127.0.0.1:47917', device: 'd1' });
      if (command === 'devices')
        return [{ id: 'd1', name: 'The host computer', people: ['ana', 'ben'], issuedAt: 0, revoked: false, lost: false }, laptop];
      if (command === 'offline_policy') return { nagDays: 14, limitDays: null, byRole: [] };
      if (command === 'revoke_device')
        return { devices: [{ ...laptop, revoked: true, lost: true }], passwords: [['ben', 'abcd-efgh-jkmn']] };
    });
    render(<Network people={PEOPLE} admin onChanged={() => {}} onLeft={() => {}} />);
    fireEvent.click(await screen.findByText('Show the computers paired'));
    expect(await screen.findByText(/\(this computer\)/)).toBeTruthy();
    // Only the other computer can be revoked.
    expect(screen.getAllByRole('button', { name: 'Lost or stolen…' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Lost or stolen…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke it as lost' }));
    expect(await screen.findByText('abcd-efgh-jkmn')).toBeTruthy();
    expect(calls).toContainEqual(['revoke_device', { device: 'd2', lost: true }]);
    expect(await screen.findByText(/revoked as lost/)).toBeTruthy();
  });

  it('sets the rule for computers away from the host', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'network_status') return status({ replica: true, hostHere: true, hostAddress: '127.0.0.1:47917' });
      if (command === 'offline_policy') return { nagDays: 14, limitDays: null, byRole: [] };
    });
    render(<Network people={PEOPLE} admin onChanged={() => {}} onLeft={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Stop taking changes after this many days'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the rule' }));
    await waitFor(() =>
      expect(calls).toContainEqual(['set_offline_policy', { policy: { nagDays: 14, limitDays: 30, byRole: [] } }])
    );
  });

  it('sets a stricter rule for a role', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'network_status') return status({ replica: true, hostHere: true, hostAddress: '127.0.0.1:47917' });
      if (command === 'offline_policy') return { nagDays: 14, limitDays: null, byRole: [] };
      if (command === 'custom_roles') return [];
    });
    render(<Network people={PEOPLE} admin onChanged={() => {}} onLeft={() => {}} />);
    fireEvent.change(await screen.findByLabelText('A stricter rule for a role'), { target: { value: 'tester' } });
    fireEvent.change(screen.getByLabelText('Remind Tester: logs firings after'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Stop Tester: logs firings after'), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the rule' }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'set_offline_policy',
        { policy: { nagDays: 14, limitDays: null, byRole: [{ role: 'tester', nagDays: 7, limitDays: 21 }] } }
      ])
    );
  });

  it("lists the host's backups and puts one back after asking", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'network_status') return status({ replica: true, hostAddress: '192.168.1.20:47917' });
      if (command === 'host_backups') return [{ name: 'backup-1', madeAt: Date.UTC(2026, 9, 28), bytes: 5_000_000 }];
    });
    render(<Network people={PEOPLE} admin onChanged={() => {}} onLeft={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Put this one back…' }));
    expect(screen.getByText(/something erased since may come back/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Put it back' }));
    expect(await screen.findByText(/The host is putting the backup back/)).toBeTruthy();
    expect(calls).toContainEqual(['restore_host_backup', { name: 'backup-1' }]);
  });
});
