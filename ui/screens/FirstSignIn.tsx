import { useState } from 'react';
import { api, errorText } from '../api';
import { NewPassword } from './NewPassword';

/** Someone an admin added chooses their own password, then gets their recovery key (ADR 12). */
export function FirstSignIn({ name, onDone }: { name: string; onDone: (words: string[]) => void }) {
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      onDone(await api.setOwnPassword(password));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <form className="card" onSubmit={save}>
        <h1>Welcome, {name}</h1>
        <p>
          An admin added you with a one-time password. Choose your own now: only you will know it. Then you get your
          own recovery key, in case you forget it.
        </p>
        <NewPassword label="Your password" onChange={setPassword} />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="primary" disabled={!password || busy}>
          {busy ? 'Saving…' : 'Set my password'}
        </button>
      </form>
    </main>
  );
}
