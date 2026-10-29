import { useEffect, useState } from 'react';
import { api, errorText, onEvent, type OfflineStatus } from '../api';

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** The vault's rule for computers away from the host (docs/adr/0024-offline-limits-and-revocation.md):
 * a reminder after a while without a sync, firmer each day, and, where an admin set a limit,
 * that changes wait until a sync or an extension code. The core enforces it; this says so. */
export function OfflineNotice() {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => api.offlineStatus().then(setStatus, () => {});
    void load();
    return onEvent('sync-status', () => void load());
  }, []);
  if (!status?.applies || !(status.nag || status.readOnly)) return null;

  const extend = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      setStatus(await api.extendOffline(code));
      setCode('');
    } catch (e) {
      setError(errorText(e));
    }
  };
  const since = status.lastSynced ? `since ${day(status.lastSynced)}` : 'yet';
  const left = status.limitDays !== null ? status.limitDays - status.days : null;
  return (
    <div className={`notice${status.readOnly || (left !== null && left <= 2) ? ' warning' : ''}`} role="status">
      {status.readOnly ? (
        <>
          <p>
            {status.clockBack
              ? "This computer's clock is behind what it showed before, so it takes no changes until it syncs."
              : `This computer has not synced with the vault's host ${since}, so it takes no changes until it does.`}{' '}
            You can still read and print, and what you type is kept as a draft.
          </p>
          <p>Connect to the vault's network, or ask an admin for an extension code and type it here.</p>
          <form className="row" onSubmit={extend}>
            <input
              aria-label="Extension code"
              autoComplete="off"
              placeholder="14-K7Q-F9M2D-XW3PA"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="submit" disabled={!code.trim()}>
              Use the code
            </button>
          </form>
        </>
      ) : (
        <p>
          This computer has not synced with the vault's host {since}: {status.days} days.{' '}
          {left !== null
            ? left > 0
              ? `In ${left} ${left === 1 ? 'day' : 'days'} it takes no more changes until it does.`
              : ''
            : 'Connect it to the vault’s network soon, so the team’s copies stay together.'}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
