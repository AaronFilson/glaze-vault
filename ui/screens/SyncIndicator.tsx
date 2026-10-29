import { useEffect, useState } from 'react';
import { api, errorText, onEvent, type SyncStatus } from '../api';

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' });

/** How syncing with the host stands, in the bar (docs/adr/0023-client-mode.md): shown only on a
 * computer that syncs. The core syncs by itself; "Sync now" asks it not to wait. */
export function SyncIndicator() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.syncStatus().then(setStatus, () => {});
    return onEvent<SyncStatus>('sync-status', setStatus);
  }, []);
  if (!status?.replica) return null;

  const offline = !!status.error && !status.syncing;
  const label = status.syncing
    ? 'Syncing…'
    : offline
      ? 'Not synced'
      : status.lastSynced
        ? `Synced ${time(status.lastSynced)}`
        : 'Not synced yet';
  const syncNow = async () => {
    setError('');
    try {
      await api.syncNow();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <span className="sync">
      <button
        type="button"
        className={`link${offline ? ' warning' : ''}`}
        aria-expanded={open}
        aria-label={`${label}. Show how syncing stands`}
        onClick={() => setOpen(!open)}
      >
        {label}
        {status.waiting > 0 && ` · ${status.waiting} to send`}
      </button>
      {open && (
        <div className="sync-detail notice" role="status">
          {offline ? (
            <p>
              The vault's host is out of reach: {status.error}{' '}
              {status.lastSynced ? `The last sync was at ${time(status.lastSynced)}.` : ''} You can go on working; what
              you save is sent when the host is back.
            </p>
          ) : (
            <p>
              {status.lastSynced ? `Synced with the host at ${time(status.lastSynced)}.` : 'Not synced yet.'}{' '}
              {status.watching ? 'Changes from other computers come as they are saved.' : ''}
            </p>
          )}
          {status.waiting > 0 && (
            <p>
              {status.waiting === 1 ? 'One change waits' : `${status.waiting} changes wait`} to reach the host.
            </p>
          )}
          {status.photosWaiting > 0 && (
            <p>
              {status.photosWaiting === 1 ? 'One photo is' : `${status.photosWaiting} photos are`} still coming from the
              host.
            </p>
          )}
          {status.refused > 0 && (
            <p className="error">
              The host would not take {status.refused === 1 ? 'one change' : `${status.refused} changes`} saved here. They
              are kept on this computer; an admin can tell why.
            </p>
          )}
          <div className="row">
            <button type="button" disabled={status.syncing} onClick={() => void syncNow()}>
              Sync now
            </button>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      )}
    </span>
  );
}
