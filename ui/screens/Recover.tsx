import { useState } from 'react';
import { api, errorText, type Person } from '../api';
import { NewPassword } from './NewPassword';
import { PersonPicker } from './PersonPicker';

/** Sets a new password with a recovery key: the person's own, or in a team's vault the
 * organization's, which gives an admin a new password and a new recovery key of their own. */
export function Recover({
  people,
  onRecovered,
  onBack
}: {
  /** A team's people; empty for a one-person vault. */
  people: Person[];
  /** With the admin's new recovery words, after using the organization's key. */
  onRecovered: (newWords: string[] | null) => void;
  onBack: () => void;
}) {
  const [organization, setOrganization] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
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
      if (organization && person) {
        onRecovered(await api.recoverOrganization(person, words, password));
      } else {
        await api.recover(words, password, people.length ? person : null);
        onRecovered(null);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <form className="card" onSubmit={recover}>
        <h1>{organization ? "Use the organization's recovery key" : 'Use your recovery key'}</h1>
        {organization ? (
          <p>
            When every admin has lost their password and recovery sheet: type the 24 words from the organization's
            recovery sheet, choose the admin to get back in, and their new password. They get a new recovery sheet too.
          </p>
        ) : (
          <p>Type the 24 words from your recovery sheet, in order, then choose a new password.</p>
        )}
        {people.length > 0 && (
          <PersonPicker
            people={organization ? people.filter((p) => p.admin) : people}
            value={person}
            onChange={setPerson}
            label={organization ? 'Admin' : 'Your name'}
          />
        )}
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
        {people.some((p) => p.admin) && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setOrganization(!organization);
              setPerson(null);
            }}
          >
            {organization ? 'Use your own recovery key instead' : "Use the organization's recovery key"}
          </button>
        )}
        <button type="button" className="link" onClick={onBack}>
          Back
        </button>
      </form>
    </main>
  );
}
