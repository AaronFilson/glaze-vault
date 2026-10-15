import { expect, it } from 'vitest';
import { isIdle } from './useIdleLock';

it('is idle once the minutes have passed', () => {
  const start = Date.UTC(2026, 9, 14, 9);
  expect(isIdle(start, start + 14 * 60_000 + 59_999, 15)).toBe(false);
  expect(isIdle(start, start + 15 * 60_000, 15)).toBe(true);
  // A laptop that slept for hours locks when it wakes.
  expect(isIdle(start, start + 5 * 3_600_000, 15)).toBe(true);
});
