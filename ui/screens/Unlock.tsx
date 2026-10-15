import { useState } from 'react';
import { api, errorText } from '../api';

export function Unlock({
  notice,
  onUnlocked,
  onForgot,
  onRestore
}: {
  notice?: string;
  onUnlocked: () => void;
  onForgot: () => void;
  onRestore: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.unlock(password);
      onUnlocked();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <form className="card" onSubmit={unlock}>
        <h1>Unlock your vault</h1>
        {notice && <p role="status">{notice}</p>}
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="primary" disabled={!password || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <button type="button" className="link" onClick={onForgot}>
          Forgot your password?
        </button>
        <button type="button" className="link" onClick={onRestore}>
          Restore from a backup
        </button>
      </form>
    </main>
  );
}
