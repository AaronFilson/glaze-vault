import { useEffect, useState } from 'react';
import { Format, scan } from '@tauri-apps/plugin-barcode-scanner';
import { api, errorText, type FoundHost, type Joining, type Platform } from '../api';

/** Joining a vault another computer serves on this network (docs/adr/0023-client-mode.md): find
 * the host or type its address, type the code an admin reads out, and wait for them to approve
 * this computer. Then its people sign in with the passwords they have. A phone or tablet can scan
 * the QR code the admin's screen shows instead, which also pins the host's key
 * (docs/adr/0029-phones-as-replicas.md). */
export function Join({
  onJoined,
  onBack,
  platform = 'desktop'
}: {
  onJoined: () => void;
  onBack: () => void;
  platform?: Platform;
}) {
  const [joining, setJoining] = useState<Joining | null>(null);
  const [hosts, setHosts] = useState<FoundHost[] | null>(null);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');

  const look = () => {
    setHosts(null);
    api.discoverHosts().then(
      (found) => {
        setHosts(found);
        if (found.length === 1) setAddress((typed) => typed || found[0].address);
      },
      () => setHosts([])
    );
  };
  useEffect(() => {
    api.prepareJoin().then(
      (made) => {
        setJoining(made);
        setName((typed) => typed || made.suggestedName);
      },
      (e) => setError(errorText(e))
    );
    look();
  }, []);

  const joinWith = async (invite: string | null) => {
    setWaiting(true);
    setError('');
    try {
      await api.joinVault(address, code, name, invite);
      onJoined();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWaiting(false);
    }
  };
  const join = (event: React.FormEvent) => {
    event.preventDefault();
    void joinWith(null);
  };
  const scanCode = async () => {
    setError('');
    let scanned: string;
    try {
      scanned = (await scan({ formats: [Format.QRCode] })).content;
    } catch (e) {
      setError(`The code could not be scanned (${errorText(e)}). Type the address and code instead.`);
      return;
    }
    await joinWith(scanned);
  };
  const phone = platform !== 'desktop';

  return (
    <main className="center">
      <form className="card" onSubmit={join}>
        <h1>Join a vault on this network</h1>
        <p>
          Another computer serves the team's vault. Ask an admin to choose <strong>Pair a computer</strong> in Settings,
          Network, and {phone ? 'scan the code their screen shows, or type it' : 'type the code they read out'}.
        </p>
        {platform === 'ios' && (
          <p className="hint">
            The first time, this iPhone or iPad asks whether Glaze Vault may find devices on your local network. Choose
            Allow: the vault's host is on your network, and nothing goes beyond it.
          </p>
        )}
        {phone && (
          <div className="row">
            <button type="button" className="primary" disabled={!joining || waiting} onClick={() => void scanCode()}>
              Scan the code
            </button>
          </div>
        )}
        <fieldset className="plain" disabled={waiting}>
          <label htmlFor="join-address">The vault's host</label>
          {hosts && hosts.length > 0 && (
            <ul className="list" aria-label="Hosts found on this network">
              {hosts.map((host) => (
                <li key={host.address}>
                  <button type="button" aria-current={host.address === address} onClick={() => setAddress(host.address)}>
                    {host.name} <span className="hint">{host.address}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hosts && hosts.length === 0 && (
            <p className="hint">
              No host answered. Type its address, as the admin's Settings show it, such as 192.168.1.20.
            </p>
          )}
          {!hosts && <p className="hint">Looking for hosts on this network…</p>}
          <div className="row">
            <input
              id="join-address"
              value={address}
              placeholder="192.168.1.20"
              onChange={(e) => setAddress(e.target.value)}
            />
            <button type="button" onClick={look}>
              Look again
            </button>
          </div>
          <label htmlFor="join-code">Pairing code</label>
          <input
            id="join-code"
            inputMode="numeric"
            autoComplete="off"
            value={code}
            placeholder="4821-0937"
            onChange={(e) => setCode(e.target.value)}
          />
          <label htmlFor="join-name">{phone ? "This device's name" : "This computer's name"}, for the admin to see</label>
          <input id="join-name" value={name} onChange={(e) => setName(e.target.value)} />
        </fieldset>
        {joining && (
          <p>
            The admin's screen shows this computer's key. Check that it is the same: <code>{joining.fingerprint}</code>
          </p>
        )}
        {waiting && (
          <p className="hint" role="status">
            Waiting for the admin to approve this computer…
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={!joining || !address.trim() || !code.trim() || waiting}>
          {waiting ? 'Joining…' : 'Join'}
        </button>
        {waiting ? (
          <button type="button" className="link" onClick={() => void api.cancelJoin().catch(() => {})}>
            Stop waiting
          </button>
        ) : (
          <button type="button" className="link" onClick={onBack}>
            Back
          </button>
        )}
      </form>
    </main>
  );
}
