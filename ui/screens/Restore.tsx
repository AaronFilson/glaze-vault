import { useState } from 'react';
import { api, errorText, type ChosenBackup } from '../api';
import { NewPassword } from './NewPassword';

export interface RestoreResult {
  backup: ChosenBackup;
  setAside: string | null;
}

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
  const [useRecovery, setUseRecovery] = useState(false);
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
      const { setAside } = await api.restoreBackup(
        backup.path,
        useRecovery ? { words, newPassword: newPassword ?? '' } : { password }
      );
      onRestored({ backup, setAside });
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
            {useRecovery ? (
              <>
                <label htmlFor="restore-words">Recovery words</label>
                <textarea
                  id="restore-words"
                  rows={4}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                  aria-describedby="restore-count"
                />
                <p id="restore-count" className="hint">
                  {count} of 24 words, from the recovery sheet you had when the backup was made
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
            <button type="button" className="link left" onClick={() => setUseRecovery(!useRecovery)}>
              {useRecovery ? 'Use the password instead' : 'Use the recovery key instead'}
            </button>
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
            The user guide says how to bring it back. Delete that folder once you are sure you do not need it.
          </p>
        )}
        <button type="button" className="primary" autoFocus onClick={onDone}>
          Open my vault
        </button>
      </section>
    </main>
  );
}
