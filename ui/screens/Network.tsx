import { useEffect, useState } from 'react';
import {
  api,
  errorText,
  type Device,
  type NetworkStatus,
  type PairingCode,
  type PairingComputer,
  type Person
} from '../api';

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Serving the vault to other computers on this network, for an admin
 * (docs/adr/0022-host-mode.md): starting, pairing computers, the computers paired, and stopping. */
export function Network({ people, onChanged }: { people: Person[]; onChanged: () => void }) {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    api
      .networkStatus()
      .then(setStatus)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  if (!status) return error ? <p className="error">{error}</p> : <p className="hint">Loading…</p>;
  if (!status.replica)
    return (
      <StartHosting
        status={status}
        onStarted={() => {
          void load();
          onChanged();
        }}
      />
    );
  return (
    <>
      <p>
        {status.hostHere
          ? `This computer serves the vault on this network, on port ${status.hostAddress?.split(':')[1]}. It needs to stay on for other computers to sync.`
          : `This vault syncs with the host at ${status.hostAddress}.`}
      </p>
      <SyncNow onPulled={onChanged} />
      <Pairing people={people} />
      <Devices people={people} />
      {status.hostHere && (
        <StopHosting
          onStopped={() => {
            void load();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function StartHosting({ status, onStarted }: { status: NetworkStatus; onStarted: () => void }) {
  const [port, setPort] = useState(String(status.defaultPort));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!status.canHost)
    return <p>This copy of Glaze Vault cannot serve the vault on the network: the part that does, hostd, is missing.</p>;
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await api.startHosting(Number(port) || null, name);
      onStarted();
    } catch (e) {
      setError(errorText(e));
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
      <label htmlFor="host-name">Name other computers see</label>
      <input id="host-name" value={name} placeholder="Glaze Vault host" onChange={(e) => setName(e.target.value)} />
      <label htmlFor="host-port">Port</label>
      <input id="host-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
      <div className="row">
        <button type="button" disabled={busy} onClick={start}>
          {busy ? 'Starting…' : 'Serve on this network'}
        </button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

function SyncNow({ onPulled }: { onPulled: () => void }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const sync = async () => {
    setError('');
    setMessage('');
    try {
      const report = await api.syncNow();
      setMessage(
        `Synced: ${report.pulled} received, ${report.accepted} sent` +
          (report.refused ? `, ${report.refused} the host would not take` : '') +
          '.'
      );
      if (report.pulled) onPulled();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="row">
      <button type="button" onClick={sync}>
        Sync now
      </button>
      {message && <span role="status">{message}</span>}
      {error && <span role="alert" className="error">{error}</span>}
    </div>
  );
}

/** Pairing: a code to read out, then the computer that used it, to check and approve. */
function Pairing({ people }: { people: Person[] }) {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [computer, setComputer] = useState<PairingComputer | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const start = async () => {
    setError('');
    setMessage('');
    setComputer(null);
    setChosen([]);
    try {
      const code = await api.startPairing();
      setCode(code);
      const computer = await api.waitForPairing();
      setComputer(computer);
    } catch (e) {
      setCode(null);
      setError(errorText(e));
    }
  };
  const approve = async () => {
    setError('');
    try {
      await api.approvePairing(chosen);
      setMessage(`${computer?.name} is paired. Its people sign in there with their own passwords.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCode(null);
      setComputer(null);
    }
  };
  const cancel = () => {
    void api.cancelPairing();
    setCode(null);
    setComputer(null);
  };

  return (
    <section aria-label="Pair a computer">
      <h3>Pair a computer</h3>
      {!code && (
        <>
          <p>On the other computer, choose to join a vault on this network, and type the code shown here.</p>
          <div className="row">
            <button type="button" onClick={start}>
              Pair a computer…
            </button>
          </div>
        </>
      )}
      {code && !computer && (
        <>
          <p>
            Type this code on the other computer. It works once, until{' '}
            {new Date(code.expiresAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}.
          </p>
          <p className="pairing-code" aria-label="Pairing code">
            {code.code}
          </p>
          <p className="hint">Waiting for the other computer…</p>
          <div className="row">
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      )}
      {computer && (
        <>
          <p>
            <strong>{computer.name}</strong> used the code. Check that it shows the same key: <code>{computer.fingerprint}</code>
          </p>
          <p>Who will use this computer? Only they can sign in at it, and it holds only what they can see.</p>
          {people.map((person) => (
            <label key={person.id} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(person.id)}
                onChange={(e) =>
                  setChosen(e.target.checked ? [...chosen, person.id] : chosen.filter((id) => id !== person.id))
                }
              />
              {person.name}
            </label>
          ))}
          <div className="row">
            <button type="button" disabled={!chosen.length} onClick={approve}>
              Approve
            </button>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}

function Devices({ people }: { people: Person[] }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api
      .devices()
      .then(setDevices)
      .catch((e) => setError(errorText(e)));
  };
  const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
  return (
    <details className="history" onToggle={(e) => (e.target as HTMLDetailsElement).open && load()}>
      <summary>Show the computers paired</summary>
      {error && <p className="error">{error}</p>}
      {devices && (
        <ul>
          {devices.map((d) => (
            <li key={d.id}>
              <strong>{d.name}</strong>, paired {when(d.issuedAt)}, for{' '}
              {d.people.map((id) => names[id] ?? 'someone removed').join(', ') || 'no one'}
              {d.revoked && ' (revoked)'}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function StopHosting({ onStopped }: { onStopped: () => void }) {
  const [asking, setAsking] = useState(false);
  const [anyway, setAnyway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stop = async () => {
    setBusy(true);
    setError('');
    try {
      await api.stopHosting(anyway);
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
          <p>
            The vault goes back to being on this computer alone. Other computers keep what they have but can no longer
            sync, and anything saved on them that has not synced is not brought here.
          </p>
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
