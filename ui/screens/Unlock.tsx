import { useState } from 'react';
import { api, errorText } from '../api';

export function Unlock({ onUnlocked, onForgot }: { onUnlocked: () => void; onForgot: () => void }) {
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
      </form>
    </main>
  );
}
