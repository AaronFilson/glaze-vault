import { useState } from 'react';
import { api, errorText, type ChosenBackup } from '../api';
import { NewPassword } from './NewPassword';
import { PersonPicker } from './PersonPicker';

export interface RestoreResult {
  backup: ChosenBackup;
  setAside: string | null;
  /** After restoring with the organization's recovery key, the admin's new recovery words. */
  recoveryWords: string[] | null;
}

/** How the backup is opened: a password, the person's recovery key, or for a team's backup the
 * organization's recovery key. */
type Using = 'password' | 'recovery' | 'organization';

/** Restores a backup file: choose it, then open it with its password or recovery key. */
export function Restore({
  vaultExists,
  onRestored,
  onBack
}: {
  vaultExists: boolean;
  onRestored: (result: RestoreResult) => void;
  onBack: () => void;
}) {
  const [backup, setBackup] = useState<ChosenBackup | null>(null);
  const [using, setUsing] = useState<Using>('password');
  const [admin, setAdmin] = useState<string | null>(null);
  const useRecovery = using !== 'password';
  const [password, setPassword] = useState('');
  const [words, setWords] = useState('');
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const count = words.split(/\s+/).filter(Boolean).length;

  const choose = async () => {
    setError('');
    try {
      const chosen = await api.chooseBackup();
      if (chosen) setBackup(chosen);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const restore = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!backup) return;
    setBusy(true);
    setError('');
    try {
      const { setAside, recoveryWords } = await api.restoreBackup(
        backup.path,
        using === 'organization'
          ? { words, newPassword: newPassword ?? '', organization: true }
          : useRecovery
            ? { words, newPassword: newPassword ?? '' }
            : { password },
        backup.admins.length ? admin : null
      );
      onRestored({ backup, setAside, recoveryWords });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const ready = backup && (useRecovery ? count === 24 && newPassword : password);

  return (
    <main className="center">
      <form className="card" onSubmit={restore}>
        <h1>Restore from a backup</h1>
        {vaultExists && (
          <p className="warn">
            Restoring replaces the vault on this computer with the backup. The vault that is here now is not deleted:
            it is moved into a folder beside it, in case you need it.
          </p>
        )}
        {!backup ? (
          <>
            <p>Choose the backup file. Backup files end in .gvbackup.</p>
            <button type="button" className="primary" onClick={choose}>
              Choose backup file…
            </button>
          </>
        ) : (
          <>
            <p>
              <strong>{backup.fileName}</strong>
              <br />
              <span className="hint">
                Made {new Date(backup.createdAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}{' '}
                with Glaze Vault {backup.appVersion}
              </span>
            </p>
            <button type="button" className="link left" onClick={choose}>
              Choose another file
            </button>
            {backup.admins.length > 0 && (
              <>
                <p className="hint">This is a team's backup: an admin restores it.</p>
                <PersonPicker people={backup.admins} value={admin} onChange={setAdmin} label="Admin" />
              </>
            )}
            {useRecovery ? (
              <>
                <label htmlFor="restore-words">Recovery words</label>
                <textarea
                  id="restore-words"
                  data-secret
                  rows={4}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                  aria-describedby="restore-count"
                />
                <p id="restore-count" className="hint">
                  {count} of 24 words, from{' '}
                  {using === 'organization'
                    ? "the organization's recovery sheet"
                    : 'the recovery sheet you had when the backup was made'}
                </p>
                <NewPassword label="New password" onChange={setNewPassword} autoFocus={false} />
              </>
            ) : (
              <>
                <label htmlFor="restore-password">Password</label>
                <input
                  id="restore-password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby="restore-password-hint"
                />
                <p id="restore-password-hint" className="hint">
                  The password the vault had when this backup was made.
                </p>
              </>
            )}
            <button
              type="button"
              className="link left"
              onClick={() => setUsing(using === 'password' ? 'recovery' : 'password')}
            >
              {useRecovery ? 'Use the password instead' : 'Use the recovery key instead'}
            </button>
            {backup.admins.length > 0 && using !== 'organization' && (
              <button type="button" className="link left" onClick={() => setUsing('organization')}>
                Use the organization's recovery key
              </button>
            )}
            <button type="submit" className="primary" disabled={!ready || busy}>
              {busy ? 'Restoring…' : 'Restore'}
            </button>
          </>
        )}
        {error && <p role="alert" className="error">{error}</p>}
        <button type="button" className="link" onClick={onBack}>
          Back
        </button>
      </form>
    </main>
  );
}

/** Says what was restored, and where the replaced vault went. */
export function Restored({ result, onDone }: { result: RestoreResult; onDone: () => void }) {
  return (
    <main className="center">
      <section className="card">
        <h1>Backup restored</h1>
        <p>
          Your vault now holds the recipes from the backup made{' '}
          {new Date(result.backup.createdAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}.
        </p>
        {result.setAside && (
          <p className="hint">
            The vault that was here before was moved, not deleted, to <code className="path">{result.setAside}</code>.
            To switch back to it, open Settings: Vaults set aside lists it. Delete that folder once you are sure you do
            not need it.
          </p>
        )}
        <button type="button" className="primary" autoFocus onClick={onDone}>
          Open my vault
        </button>
      </section>
    </main>
  );
}
