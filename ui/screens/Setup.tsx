import { useState } from 'react';
import { api, errorText } from '../api';
import { NewPassword } from './NewPassword';

export function Setup({
  notice,
  onCreated,
  onRestore,
  onJoin
}: {
  notice?: string;
  onCreated: (words: string[]) => void;
  onRestore: () => void;
  onJoin: () => void;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      onCreated(await api.create(password));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <form className="card" onSubmit={create}>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <h1>Set up your vault</h1>
        <p>
          Glaze Vault keeps your recipes encrypted on this computer. Choose a password: you will type it each time
          you open the vault.
        </p>
        <NewPassword label="Password" onChange={setPassword} />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="primary" disabled={!password || busy}>
          {busy ? 'Creating your vault…' : 'Create vault'}
        </button>
        <button type="button" className="link" onClick={onRestore}>
          Restore from a backup
        </button>
        <button type="button" className="link" onClick={onJoin}>
          Join a vault on this network
        </button>
      </form>
    </main>
  );
}
