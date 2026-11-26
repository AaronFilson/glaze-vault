import { useEffect, useState } from 'react';
import { api, errorCode, errorText, type HostBackup, type NetworkStatus, type SyncStatus } from '../api';

export const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const megabytes = (bytes: number) => `${Math.max(0.1, bytes / 1024 / 1024).toFixed(1)} MB`;
const today = () => new Date().toISOString().slice(0, 10);

/** The name and port a host serves with, for starting to serve and for moving the host here. */
function useHostFields(status: NetworkStatus, id: string) {
  const [port, setPort] = useState(String(status.defaultPort));
  const [name, setName] = useState('');
  const fields = (
    <>
      <label htmlFor={`${id}-name`}>Name other computers see</label>
      <input id={`${id}-name`} value={name} placeholder="Glaze Vault host" onChange={(e) => setName(e.target.value)} />
      <label htmlFor={`${id}-port`}>Port</label>
      <input id={`${id}-port`} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
    </>
  );
  return { port: Number(port) || null, name, fields };
}

export function StartHosting({ status, onStarted }: { status: NetworkStatus; onStarted: () => void }) {
  const { port, name, fields } = useHostFields(status, 'host');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!status.canHost)
    return <p>This copy of Glaze Vault cannot serve the vault on the network: the part that does, hostd, is missing.</p>;
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await api.startHosting(port, name);
      onStarted();
    } catch (e) {
      setError(errorText(e));
      // It may have started serving and only its first sync failed: show how it stands now.
      onStarted();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>
        Serve this vault to the team's other computers on this network. This computer runs a small service from when it
        starts, even with nobody signed in, and keeps working on the vault as before. The service holds no key to the
        recipes: it cannot read them.
      </p>
      <ul>
        <li>Everyone in the vault can still sign in here. Other computers are paired one at a time, with a code.</li>
        <li>Your computer asks for an administrator's password to install the service.</li>
        <li>
          The service's files are protected by this computer's own account settings. Turn on disk encryption (FileVault,
          BitLocker or LUKS) so a stolen disk gives nothing away.
        </li>
      </ul>
      {fields}
      <div className="row">
        <button type="button" disabled={busy} onClick={start}>
          {busy ? 'Starting…' : 'Serve on this network'}
        </button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

/** The host's backups, for an admin (docs/adr/0025-host-backups-from-the-app.md): those hostd
 * makes each day on the host computer, one to keep elsewhere, and putting one back. */
export function HostBackups() {
  const [backups, setBackups] = useState<HostBackup[] | null>(null);
  const [asking, setAsking] = useState<HostBackup | 'file' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = () => api.hostBackups().then(setBackups, (e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const done = await work();
      if (done) setMessage(done);
      setAsking(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const restored =
    'The host is putting the backup back, and starts again in a few seconds. Each computer then sends again what it saved since.';
  return (
    <section aria-label="The host's backups">
      <h3>The host&rsquo;s backups</h3>
      <p className="hint">
        The host computer backs the vault up each day, and keeps the last 14. Keep one elsewhere too, in case the host
        computer is lost: it opens only with the host computer or the organization&rsquo;s key.
      </p>
      {backups && backups.length > 0 && (
        <ul className="plain">
          {backups.map((b) => (
            <li key={b.name} className="row">
              <span>
                {when(b.madeAt)}, {megabytes(b.bytes)}
              </span>
              <button type="button" disabled={busy} onClick={() => setAsking(b)}>
                Put this one back…
              </button>
            </li>
          ))}
        </ul>
      )}
      {backups && backups.length === 0 && <p className="hint">The host has made no backups yet.</p>}
      <div className="row">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const made = await api.saveHostBackup(`Glaze Vault host ${today()}.gvhost`);
              return made === null ? null : `Saved a backup of the host made ${when(made)}.`;
            })
          }
        >
          Save a backup of the host…
        </button>
        <button type="button" disabled={busy} onClick={() => setAsking('file')}>
          Put back a backup saved elsewhere…
        </button>
      </div>
      {asking && (
        <div className="notice warning" role="alertdialog" aria-label="Put a backup back">
          <p>
            The host goes back to how it was
            {asking === 'file' ? ' when that backup was made' : ` on ${when(asking.madeAt)}`}. Each computer then sends
            again what it saved since, so little is lost; but something erased since may come back, and computers paired
            since must pair again.
          </p>
          <div className="row">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (asking === 'file') return (await api.restoreHostFromFile()) === null ? null : restored;
                  await api.restoreHostBackup(asking.name);
                  return restored;
                })
              }
            >
              {asking === 'file' ? 'Choose the backup and put it back' : 'Put it back'}
            </button>
            <button type="button" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Stops serving. Usually the vault goes back to this computer alone, and the host's store goes.
 * When the host moves to another computer, or on a computer the host moved to (whose own copy has
 * only its people's keys), the store is kept for `hostd export`, and this computer leaves and joins
 * the host where it goes (docs/adr/0037-moving-the-host.md). */
export function StopHosting({ movedHere, onStopped }: { movedHere: boolean; onStopped: () => void }) {
  const [asking, setAsking] = useState(false);
  const [anyway, setAnyway] = useState(false);
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keep = moving || movedHere;
  const stop = async () => {
    setBusy(true);
    setError('');
    try {
      await api.stopHosting(anyway, keep);
      onStopped();
    } catch (e) {
      setError(errorText(e));
      setAnyway(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Stop serving">
      <h3>Stop serving</h3>
      {!asking ? (
        <div className="row">
          <button type="button" onClick={() => setAsking(true)}>
            Stop serving on this network…
          </button>
        </div>
      ) : (
        <>
          {movedHere ? (
            <p>
              The host moved to this computer from its file, so its store here is the only whole copy of the vault: it
              is kept. To serve from another computer, write it as a file here with <code>hostd export</code> (as an
              administrator) and use Move the host here on that one.
            </p>
          ) : (
            <label>
              <input type="checkbox" checked={moving} onChange={(e) => setMoving(e.target.checked)} /> The host is
              moving to another computer
            </label>
          )}
          {keep ? (
            <p>
              The service stops and its store is kept on this computer. This computer then leaves the vault and joins
              the new host with a code, like any other.
            </p>
          ) : (
            <p>
              The vault goes back to being on this computer alone. Other computers keep what they have but can no
              longer sync, and anything saved on them that has not synced is not brought here.
            </p>
          )}
          {anyway && <p className="hint">The last sync did not work. Stopping anyway loses what this computer has not sent.</p>}
          <div className="row">
            <button type="button" disabled={busy} onClick={stop}>
              {anyway ? 'Stop anyway' : 'Stop serving'}
            </button>
            <button type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}

/** Serves the vault from this computer instead of the old host, from the file the old host or an
 * admin saved (docs/adr/0037-moving-the-host.md). The old host must have stopped. If it fails, this
 * computer is as it was, and says why. */
export function MoveHostHere({ status, onMoved }: { status: NetworkStatus; onMoved: () => void }) {
  const [asking, setAsking] = useState(false);
  const { port, name, fields } = useHostFields(status, 'move-host');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const move = async (anyway: boolean) => {
    setBusy(true);
    setError('');
    try {
      if ((await api.moveHostHere(port, name, anyway)) !== null) onMoved();
    } catch (e) {
      setStale(errorCode(e) === 'host-backup-stale');
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Move the host here">
      <h3>Move the host here</h3>
      {!asking ? (
        <div className="row">
          <button type="button" onClick={() => setAsking(true)}>
            Move the host here…
          </button>
        </div>
      ) : (
        <>
          <p>
            Serve the vault from this computer instead, from the host's file: one saved under Backups of the host, or
            written on the old host computer with <code>hostd export</code>. It opens only with the organization's key.
            Stop the old host first; other computers then find this one and sync as before.
          </p>
          {fields}
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void move(false)}>
              {busy ? 'Moving…' : 'Choose the file and serve here'}
            </button>
            {stale && (
              <button type="button" className="danger" disabled={busy} onClick={() => void move(true)}>
                Choose it again and use it anyway
              </button>
            )}
            <button type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}

/** Takes this computer out of the vault: its copy goes. Others keep theirs, and the host keeps
 * everything that reached it. */
export function LeaveVault({ onLeft, servedHere = false }: { onLeft: () => void; servedHere?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ask = () => {
    setAsking(true);
    api.syncStatus().then(setSync, () => {});
  };
  const leave = async () => {
    setBusy(true);
    setError('');
    try {
      await api.leaveVault();
      onLeft();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const unsent = (sync?.waiting ?? 0) + (sync?.refused ?? 0);
  return (
    <section aria-label="Leave this vault">
      <h3>Leave this vault</h3>
      {!asking ? (
        <div className="row">
          <button type="button" onClick={ask}>
            Leave this vault…
          </button>
        </div>
      ) : (
        <>
          <p>
            This computer's copy of the vault is removed. Everyone keeps what reached the host, and can join this
            computer again with a new code from an admin.
          </p>
          {servedHere && (
            <p className="hint">
              This computer served the vault. It can leave only once it no longer does: stopped to move the host, or its
              service removed with <code>hostd uninstall</code>.
            </p>
          )}
          {unsent > 0 && (
            <p className="error">
              {unsent === 1 ? 'One change' : `${unsent} changes`} saved here never reached the host, and would be lost.
              Sync first, if you can.
            </p>
          )}
          <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={() => void leave()}>
              {busy ? 'Leaving…' : 'Leave and remove it'}
            </button>
            <button type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
