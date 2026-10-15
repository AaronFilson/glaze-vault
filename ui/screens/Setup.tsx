import { useState } from 'react';
import { api, errorText } from '../api';
import { NewPassword } from './NewPassword';

export function Setup({ onCreated }: { onCreated: (words: string[]) => void }) {
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
      </form>
    </main>
  );
}
