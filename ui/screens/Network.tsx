import { useEffect, useState } from 'react';
import {
  api,
  errorText,
  type Device,
  type NetworkStatus,
  type PairingCode,
  type PairingComputer,
  type OfflinePolicy,
  type Person,
  type Revoked,
  type SyncStatus
} from '../api';

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The vault on this network. For an admin, serving it to other computers
 * (docs/adr/0022-host-mode.md): starting, pairing computers, the computers paired, and stopping.
 * For anyone on a computer that syncs with a host (docs/adr/0023-client-mode.md): syncing, and
 * leaving the vault. */
export function Network({
  people,
  admin,
  onChanged,
  onLeft
}: {
  people: Person[];
  admin: boolean;
  onChanged: () => void;
  onLeft: () => void;
}) {
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
  if (!status.replica && !admin)
    return <p className="hint">This vault is on this computer alone. An admin can serve it to the team's other computers.</p>;
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
      {admin && <Pairing people={people} />}
      {admin && <Devices people={people} own={status.device} />}
      {admin && <OfflineRule />}
      {status.hostHere ? (
        admin && (
          <StopHosting
            onStopped={() => {
              void load();
              onChanged();
            }}
          />
        )
      ) : (
        <LeaveVault onLeft={onLeft} />
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
  const [team, setTeam] = useState<Person[]>(people);
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
      // The team as it is now: someone may have been added since this sign-in began.
      setTeam(await api.team().then((team) => team?.people ?? people, () => people));
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
          {team.map((person) => (
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

/** The computers paired, and for each an admin may give an extension code, or revoke it as
 * retired or as lost (docs/adr/0024-offline-limits-and-revocation.md). */
function Devices({ people, own }: { people: Person[]; own: string | null }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [acting, setActing] = useState<{ device: Device; action: 'code' | 'retire' | 'lost' } | null>(null);
  const [days, setDays] = useState('7');
  const [code, setCode] = useState('');
  const [revoked, setRevoked] = useState<Revoked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api
      .devices()
      .then(setDevices)
      .catch((e) => setError(errorText(e)));
  };
  const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const start = (device: Device, action: 'code' | 'retire' | 'lost') => {
    setActing({ device, action });
    setCode('');
    setRevoked(null);
    setError('');
  };
  const giveCode = async () => {
    if (!acting) return;
    setBusy(true);
    try {
      setCode(await api.extensionCode(acting.device.id, Number(days)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!acting) return;
    setBusy(true);
    try {
      const done = await api.revokeDevice(acting.device.id, acting.action === 'lost');
      setDevices(done.devices);
      setRevoked(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="history" onToggle={(e) => (e.target as HTMLDetailsElement).open && load()}>
      <summary>Show the computers paired</summary>
      {devices && (
        <ul>
          {devices.map((d) => (
            <li key={d.id}>
              <strong>{d.name}</strong>, paired {when(d.issuedAt)}, for{' '}
              {d.people.map((id) => names[id] ?? 'someone removed').join(', ') || 'no one'}
              {d.revoked && (d.lost ? ' (revoked as lost)' : ' (retired)')}
              {d.id === own && ' (this computer)'}
              {!d.revoked && d.id !== own && (
                <span className="row">
                  <button type="button" className="link" onClick={() => start(d, 'code')}>
                    Extension code…
                  </button>
                  <button type="button" className="link" onClick={() => start(d, 'retire')}>
                    Retire…
                  </button>
                  <button type="button" className="link danger" onClick={() => start(d, 'lost')}>
                    Lost or stolen…
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {acting?.action === 'code' && (
        <div className="notice" aria-label="Extension code">
          <p>
            A code lets <strong>{acting.device.name}</strong> take changes again though it has not synced, from today
            for the days you choose. Read it out to whoever is at it.
          </p>
          <div className="row">
            <label htmlFor="extension-days">Days</label>
            <input
              id="extension-days"
              className="short"
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <button type="button" disabled={busy || !(Number(days) >= 1 && Number(days) <= 99)} onClick={giveCode}>
              Make a code
            </button>
          </div>
          {code && (
            <p className="pairing-code" aria-label="The extension code">
              {code}
            </p>
          )}
        </div>
      )}
      {acting && acting.action !== 'code' && !revoked && (
        <div className="notice warning" role="alertdialog" aria-label="Revoke a computer">
          {acting.action === 'retire' ? (
            <p>
              <strong>{acting.device.name}</strong> stops syncing, and removes its copy of the vault the next time it
              reaches the host. Anything saved on it that has not synced is lost.
            </p>
          ) : (
            <p>
              <strong>{acting.device.name}</strong> stops syncing. Every collection it could read gets a new key, so
              what is saved from now on is out of its reach, and each of its people gets a new one-time password, as
              their keys are on it. Until it reaches the host it still opens with their old passwords.
            </p>
          )}
          <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={revoke}>
              {acting.action === 'retire' ? 'Retire it' : 'Revoke it as lost'}
            </button>
            <button type="button" onClick={() => setActing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {revoked && (
        <div className="notice" role="status">
          <p>{acting?.device.name} is revoked.</p>
          {revoked.passwords.length > 0 && (
            <>
              <p>Pass these one-time passwords on. Each person chooses their own at their next sign-in.</p>
              <ul>
                {revoked.passwords.map(([person, password]) => (
                  <li key={person}>
                    {names[person] ?? 'Someone'}: <code>{password}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {revoked.resetElsewhere.length > 0 && (
            <p>
              Reset {revoked.resetElsewhere.map((id) => names[id] ?? 'someone').join(', ')} from the computer that
              serves the vault, which holds their keys: People, Reset password.
            </p>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </details>
  );
}

/** The rule for computers away from the host, for an admin. */
function OfflineRule() {
  const [policy, setPolicy] = useState<OfflinePolicy | null>(null);
  const [nag, setNag] = useState('');
  const [limit, setLimit] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.offlinePolicy().then((p) => {
      if (!p) return;
      setPolicy(p);
      setNag(String(p.nagDays));
      setLimit(p.limitDays === null ? '' : String(p.limitDays));
    }, () => {});
  }, []);
  if (!policy) return null;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await api.setOfflinePolicy({ ...policy, nagDays: Number(nag), limitDays: limit.trim() ? Number(limit) : null });
      setMessage('Saved. Each computer applies it as it syncs.');
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section aria-label="Computers away from the host">
      <h3>Computers away from the host</h3>
      <form onSubmit={save}>
        <div className="row">
          <label htmlFor="offline-nag">Remind after this many days without a sync</label>
          <input id="offline-nag" className="short" inputMode="numeric" value={nag} onChange={(e) => setNag(e.target.value)} />
        </div>
        <div className="row">
          <label htmlFor="offline-limit">Stop taking changes after this many days</label>
          <input
            id="offline-limit"
            className="short"
            inputMode="numeric"
            placeholder="never"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </div>
        <p className="hint">
          It is a rule in the app, not a lock: someone with the computer and their password could get round it. An
          extension code lets a computer that is away take changes for a while.
        </p>
        <div className="row">
          <button type="submit">Save the rule</button>
          {message && <span role="status">{message}</span>}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </section>
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

/** Takes this computer out of the vault: its copy goes. Others keep theirs, and the host keeps
 * everything that reached it. */
function LeaveVault({ onLeft }: { onLeft: () => void }) {
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
