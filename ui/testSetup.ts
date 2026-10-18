// Runs after every test in every file, so no test starts with what an earlier one left behind:
// a rendered screen, the fake Rust commands, fake clocks, stubs or what the screens remember.
import { afterEach, vi } from 'vitest';

afterEach(async () => {
  if (typeof window !== 'undefined') {
    const [{ cleanup }, { clearMocks }] = await Promise.all([
      import('@testing-library/react'),
      import('@tauri-apps/api/mocks')
    ]);
    cleanup();
    clearMocks();
    localStorage.clear();
    sessionStorage.clear();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
