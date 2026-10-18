// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Restore } from './Restore';

const chosen = { path: '/media/usb/b.gvbackup', fileName: 'b.gvbackup', createdAt: Date.UTC(2026, 9, 1), appVersion: '0.2.0', admins: [] };

function fakeCore(restore: (args: Record<string, unknown>) => unknown) {
  mockIPC((cmd, args) => {
    if (cmd === 'choose_backup') return chosen;
    if (cmd === 'restore_backup') return restore(args as Record<string, unknown>);
    return null;
  });
}

it('restores with the password, warning first when a vault is here', async () => {
  const restore = vi.fn(() => ({ setAside: '/vault/replaced-1', recoveryWords: null }));
  fakeCore(restore);
  const onRestored = vi.fn();
  render(<Restore vaultExists onRestored={onRestored} onBack={() => {}} />);
  expect(screen.getByText(/moved into a folder beside it/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Choose backup file…' }));
  fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'cone six oxidation' } });
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(onRestored).toHaveBeenCalledWith({ backup: chosen, setAside: '/vault/replaced-1', recoveryWords: null }));
  expect(restore).toHaveBeenCalledWith(expect.objectContaining({ path: chosen.path, password: 'cone six oxidation' }));
});

it('can use the recovery key and a new password instead', async () => {
  const restore = vi.fn(() => ({ setAside: null, recoveryWords: null }));
  fakeCore(restore);
  render(<Restore vaultExists={false} onRestored={() => {}} onBack={() => {}} />);
  expect(screen.queryByText(/moved into a folder/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Choose backup file…' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use the recovery key instead' }));

  const words = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');
  fireEvent.change(screen.getByLabelText('Recovery words'), { target: { value: words } });
  const restoreButton = screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement;
  expect(restoreButton.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a new password' } });
  fireEvent.change(screen.getByLabelText('Type it again'), { target: { value: 'a new password' } });
  fireEvent.click(restoreButton);
  await waitFor(() =>
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ words, newPassword: 'a new password' }))
  );
});
