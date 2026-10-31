import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, type OwnBackup, type PhoneBackups } from './api';

const HOUR = 60 * 60 * 1000;

/** A phone's own vault backs itself up where the phone's backup takes it
 * (docs/adr/0028-a-phones-own-vault.md). The page asks when the vault opens, when the app goes into
 * the background and every hour; the core decides whether one is due. `onMade` hears each one
 * made. Off on a desktop. */
export function usePhoneBackups(on: boolean, onMade: (made: OwnBackup) => void) {
  const [status, setStatus] = useState<PhoneBackups | null>(null);
  const [error, setError] = useState('');
  const callback = useRef(onMade);
  callback.current = onMade;

  const refresh = useCallback(async () => {
    if (!on) return;
    try {
      setStatus(await api.phoneBackupStatus());
    } catch {
      // The vault locked meanwhile; the next unlock reads it again.
    }
  }, [on]);

  useEffect(() => {
    if (!on) return;
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const made = await api.phoneBackUp();
        setError('');
        if (made) callback.current(made);
      } catch (e) {
        setError(errorText(e));
      } finally {
        running = false;
      }
      await refresh();
    };
    void run();
    const timer = window.setInterval(() => void run(), HOUR);
    const hidden = () => {
      if (document.visibilityState === 'hidden') void run();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [on, refresh]);

  return { status, error, refresh };
}
