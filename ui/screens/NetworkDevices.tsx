import { useEffect, useRef, useState } from 'react';
import {
  api,
  errorText,
  type Device,
  type OfflinePolicy,
  type PairingCode,
  type PairingComputer,
  type Person,
  type Revoked,
  type Role
} from '../api';
import { when } from './NetworkHost';
import { roleChoices } from './Team';

export function SyncNow({ onPulled }: { onPulled: () => void }) {
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

/** Photos all, or only when opened, on a computer short of room (the plan's question 9). */
export function PhotosOnDemand() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.photosOnDemand().then(setOn, () => {});
  }, []);
  if (on === null) return null;
  const change = async (value: boolean) => {
    setError('');
    try {
      await api.setPhotosOnDemand(value);
      setOn(value);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => void change(e.target.checked)} />
        Bring photos only when someone opens them
      </label>
      <p className="hint">For a computer short of room. Otherwise every photo comes as the computer syncs.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Pairing: a code to read out, then the computer that used it, to check and approve. */
export function Pairing({ people }: { people: Person[] }) {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [computer, setComputer] = useState<PairingComputer | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [team, setTeam] = useState<Person[]>(people);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // Which pairing is current: what a cancelled or replaced one brings later is ignored.
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
      void api.cancelPairing().catch(() => {});
    },
    []
  );
  const start = async () => {
    const mine = ++attempt.current;
    setError('');
    setMessage('');
    setComputer(null);
    setChosen([]);
    try {
      const code = await api.startPairing();
      if (mine !== attempt.current) return;
      setCode(code);
      const computer = await api.waitForPairing();
      // The team as it is now: someone may have been added since this sign-in began.
      const now = await api.team().then((team) => team?.people ?? people, () => people);
      if (mine !== attempt.current) return;
      setTeam(now);
      setComputer(computer);
    } catch (e) {
      if (mine !== attempt.current) return;
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
    attempt.current++;
    void api.cancelPairing();
    setCode(null);
    setComputer(null);
  };

  return (
    <section aria-label="Pair a computer">
      <h3>Pair a computer</h3>
      {!code && (
        <>
          <p>
            On the other computer, phone or tablet, choose to join a vault on this network, and type the code shown here, or
            scan it.
          </p>
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
          {code.qrSvg && (
            <>
              <p>A phone or tablet can scan this instead, which also checks that it reaches this vault's host.</p>
              <img
                className="pairing-qr"
                alt="QR code for pairing a phone"
                src={`data:image/svg+xml;utf8,${encodeURIComponent(code.qrSvg)}`}
              />
            </>
          )}
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
export function Devices({ people, own }: { people: Person[]; own: string | null }) {
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
              {/* Again, if securing its people did not finish, or it was retired and then lost. */}
              {d.revoked && d.id !== own && (
                <button type="button" className="link danger" onClick={() => start(d, 'lost')}>
                  Lost or stolen…
                </button>
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
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </details>
  );
}

/** The rule for computers away from the host, for an admin. */
type RoleRow = { role: Role; nag: string; limit: string };
const days = (text: string) => (text.trim() ? Number(text) : null);

export function OfflineRule() {
  const [policy, setPolicy] = useState<OfflinePolicy | null>(null);
  const [nag, setNag] = useState('');
  const [limit, setLimit] = useState('');
  const [byRole, setByRole] = useState<RoleRow[]>([]);
  const [choices, setChoices] = useState<{ role: Role; label: string }[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.offlinePolicy().then((p) => {
      if (!p) return;
      setPolicy(p);
      setNag(String(p.nagDays));
      setLimit(p.limitDays === null ? '' : String(p.limitDays));
      setByRole(p.byRole.map((r) => ({ role: r.role, nag: String(r.nagDays), limit: r.limitDays === null ? '' : String(r.limitDays) })));
    }, () => {});
    api.customRoles().then((custom) => setChoices(roleChoices(custom ?? [])), () => setChoices(roleChoices([])));
  }, []);
  if (!policy) return null;
  const labelOf = (role: Role) => choices.find((c) => c.role === role)?.label ?? role;
  const unused = choices.filter((c) => !byRole.some((r) => r.role === c.role));
  const change = (at: number, row: Partial<RoleRow>) => setByRole(byRole.map((r, i) => (i === at ? { ...r, ...row } : r)));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await api.setOfflinePolicy({
        nagDays: Number(nag),
        limitDays: days(limit),
        byRole: byRole.map((r) => ({ role: r.role, nagDays: Number(r.nag), limitDays: days(r.limit) }))
      });
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
        {byRole.length > 0 && (
          <table className="lines">
            <caption>Stricter rules for some roles</caption>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Remind after</th>
                <th scope="col">Stop after</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {byRole.map((row, at) => (
                <tr key={row.role}>
                  <td>{labelOf(row.role)}</td>
                  <td>
                    <input
                      aria-label={`Remind ${labelOf(row.role)} after`}
                      className="short"
                      inputMode="numeric"
                      value={row.nag}
                      onChange={(e) => change(at, { nag: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Stop ${labelOf(row.role)} after`}
                      className="short"
                      inputMode="numeric"
                      placeholder="never"
                      value={row.limit}
                      onChange={(e) => change(at, { limit: e.target.value })}
                    />
                  </td>
                  <td>
                    <button type="button" onClick={() => setByRole(byRole.filter((_, i) => i !== at))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {unused.length > 0 && (
          <div className="row">
            <select
              aria-label="A stricter rule for a role"
              value=""
              onChange={(e) =>
                e.target.value && setByRole([...byRole, { role: e.target.value as Role, nag, limit }])
              }
            >
              <option value="">A stricter rule for a role…</option>
              {unused.map((c) => (
                <option key={c.role} value={c.role}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <p className="hint">
          Someone with more than one role has the strictest of their rules. It is a rule in the app, not a lock:
          someone with the computer and their password could get round it. An extension code lets a computer that is
          away take changes for a while.
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
