// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBackgroundLock } from './useIdleLock';

afterEach(() => vi.useRealTimers());

function hide(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible'
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

it('locks after the grace in the background, and not when back in time', () => {
  vi.useFakeTimers();
  const onAway = vi.fn();
  const { unmount } = renderHook(() => useBackgroundLock(30, onAway));
  hide(true);
  vi.advanceTimersByTime(10_000);
  hide(false);
  vi.advanceTimersByTime(60_000);
  expect(onAway).not.toHaveBeenCalled();
  hide(true);
  vi.advanceTimersByTime(30_000);
  expect(onAway).toHaveBeenCalledTimes(1);
  hide(false);
  unmount();
});

it('locks on coming back when a suspended app ran no timers', () => {
  vi.useFakeTimers();
  const onAway = vi.fn();
  const { unmount } = renderHook(() => useBackgroundLock(30, onAway));
  hide(true);
  // Suspended: the clock moves on, but no timer runs.
  vi.setSystemTime(Date.now() + 5 * 60_000);
  hide(false);
  expect(onAway).toHaveBeenCalledTimes(1);
  unmount();
});

it('does nothing when off', () => {
  vi.useFakeTimers();
  const onAway = vi.fn();
  const { unmount } = renderHook(() => useBackgroundLock(null, onAway));
  hide(true);
  vi.advanceTimersByTime(60_000);
  hide(false);
  expect(onAway).not.toHaveBeenCalled();
  unmount();
});
