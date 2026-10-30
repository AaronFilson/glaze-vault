// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Join } from './Join';

describe('joining a vault on this network', () => {
  it('finds the host, shows this computer’s key, and joins with the code', async () => {
    const calls: [string, unknown][] = [];
    let joined = false;
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === 'prepare_join') return { fingerprint: '428b-ec49-9b19-3bd5', suggestedName: 'Studio laptop' };
      if (command === 'discover_hosts') return [{ name: 'Studio', address: '192.168.1.20:47917' }];
    });
    render(<Join onJoined={() => (joined = true)} onBack={() => {}} />);
    expect(await screen.findByText('428b-ec49-9b19-3bd5')).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("The vault's host") as HTMLInputElement).value).toBe('192.168.1.20:47917'));
    expect((screen.getByLabelText(/This computer's name/) as HTMLInputElement).value).toBe('Studio laptop');
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: '4821-0937' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(joined).toBe(true));
    expect(calls).toContainEqual([
      'join_vault',
      { address: '192.168.1.20:47917', code: '4821-0937', name: 'Studio laptop' }
    ]);
  });

  it('says how to go on when no host answers, and shows why joining failed', async () => {
    mockIPC((command) => {
      if (command === 'prepare_join') return { fingerprint: 'aaaa-bbbb-cccc-dddd', suggestedName: '' };
      if (command === 'discover_hosts') return [];
      if (command === 'join_vault') throw { code: 'network', message: 'Pairing failed: the code was wrong' };
    });
    render(<Join onJoined={() => {}} onBack={() => {}} />);
    expect(await screen.findByText(/No host answered/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("The vault's host"), { target: { value: '10.0.0.5' } });
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: '1111-2222' } });
    fireEvent.change(screen.getByLabelText(/This computer's name/), { target: { value: 'Shed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByText(/the code was wrong/)).toBeTruthy();
  });
});
