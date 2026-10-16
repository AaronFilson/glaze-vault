import { useState } from 'react';
import { api, errorText, type Person } from '../api';
import { PersonPicker, rememberPerson } from './PersonPicker';

export function Unlock({
  people,
  notice,
  onUnlocked,
  onForgot,
  onRestore
}: {
  /** A team's people to choose from; empty for a one-person vault. */
  people: Person[];
  notice?: string;
  onUnlocked: () => void;
  onForgot: () => void;
  onRestore: () => void;
}) {
  const [person, setPerson] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.unlock(password, people.length ? person : null);
      if (person) rememberPerson(person);
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
        {people.length > 0 && <PersonPicker people={people} value={person} onChange={setPerson} />}
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
