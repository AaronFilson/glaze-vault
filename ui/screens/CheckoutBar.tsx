import { useEffect, useState } from 'react';
import { api, errorText, onEvent, type Checkout, type Kind, type SyncStatus } from '../api';

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' });

/** Checking a record out (plan section 3.5), on a computer that syncs: others see that someone is
 * changing it, and cannot save it while they do unless they take it over. It is advisory: work
 * saved away from the host is never refused, and becomes a fork instead. */
export function CheckoutBar({ kind, record, readOnly }: { kind: Kind; record: string; readOnly: boolean }) {
  const [replica, setReplica] = useState(false);
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = (status: SyncStatus | null) => {
      setReplica(!!status?.replica);
      if (status?.replica) api.checkouts().then(setCheckouts, () => {});
    };
    api.syncStatus().then(load, () => {});
    // Each sync asks the host again.
    return onEvent<SyncStatus>('sync-status', load);
  }, []);
  if (!replica || readOnly) return null;

  const held = checkouts.find((c) => c.record === record);
  const ask = async (change: () => Promise<Checkout[]>) => {
    setBusy(true);
    setError('');
    try {
      setCheckouts(await change());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={held && !held.mine ? 'notice warning' : 'row'} role="status">
      {!held && (
        <>
          <button type="button" disabled={busy} onClick={() => void ask(() => api.checkOut(kind, record, false))}>
            Check out
          </button>
          <span className="hint">So others see you are changing it.</span>
        </>
      )}
      {held?.mine && (
        <>
          <span className="hint">You have this checked out since {time(held.since)}.</span>
          <button type="button" disabled={busy} onClick={() => void ask(() => api.releaseCheckout(record))}>
            Done changing it
          </button>
        </>
      )}
      {held && !held.mine && (
        <>
          <p>
            <strong>{held.name}</strong> is changing this on another computer, since {time(held.since)}. You cannot save
            it until they are done, or you take it over.
          </p>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void ask(() => api.checkOut(kind, record, true))}>
              Take it over
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
