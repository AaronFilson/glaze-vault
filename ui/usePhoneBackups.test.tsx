// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePhoneBackups } from './usePhoneBackups';

const made = { at: Date.UTC(2026, 9, 30), fileName: 'backup-1.gvbackup', photos: true, size: 1000 };

function fakeCore() {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === 'phone_back_up') return made;
    if (cmd === 'phone_backup_status') return { on: true, last: made, budget: null };
    return null;
  });
  return calls;
}

it('asks for a backup on opening and on going into the background', async () => {
  const calls = fakeCore();
  const onMade = vi.fn();
  const { result } = renderHook(() => usePhoneBackups(true, onMade));
  await waitFor(() => expect(result.current.status?.last).toEqual(made));
  expect(onMade).toHaveBeenCalledWith(made);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() => expect(calls.filter((c) => c === 'phone_back_up')).toHaveLength(2));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

it('does nothing on a desktop', async () => {
  const calls = fakeCore();
  renderHook(() => usePhoneBackups(false, () => {}));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toEqual([]);
});
