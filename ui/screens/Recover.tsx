import { useState } from 'react';
import { api, errorText } from '../api';
import { NewPassword } from './NewPassword';

export function Recover({ onRecovered, onBack }: { onRecovered: () => void; onBack: () => void }) {
  const [words, setWords] = useState('');
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const count = words.split(/\s+/).filter(Boolean).length;

  const recover = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      await api.recover(words, password);
      onRecovered();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <form className="card" onSubmit={recover}>
        <h1>Use your recovery key</h1>
        <p>Type the 24 words from your recovery sheet, in order, then choose a new password.</p>
        <label htmlFor="words">Recovery words</label>
        <textarea
          id="words"
          data-secret
          rows={4}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={words}
          onChange={(e) => setWords(e.target.value)}
          aria-describedby="count"
        />
        <p id="count" className="hint">
          {count} of 24 words
        </p>
        <NewPassword label="New password" onChange={setPassword} autoFocus={false} />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="primary" disabled={count !== 24 || !password || busy}>
          {busy ? 'Unlocking…' : 'Set password and unlock'}
        </button>
        <button type="button" className="link" onClick={onBack}>
          Back
        </button>
      </form>
    </main>
  );
}
