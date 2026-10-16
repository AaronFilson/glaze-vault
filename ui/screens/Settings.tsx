import { useEffect, useState } from 'react';
import {
  api,
  errorText,
  type LastBackup,
  type MaterialHead,
  type Preferences,
  type RecipeHead,
  type Settings as VaultSettings,
  type UpdateInfo,
  type VaultStatus
} from '../api';
import { exportCsv, exportFileName, exportJson, exportMaterialsCsv } from '../export';
import { NewPassword } from './NewPassword';

const LOCK_MINUTES = [1, 5, 10, 15, 30, 60, 120];
const REMINDER_DAYS: [number, string][] = [
  [0, 'Never'],
  [7, 'After a week'],
  [14, 'After two weeks'],
  [30, 'After a month'],
  [90, 'After three months']
];

export function Settings({
  settings,
  onSettings,
  lastBackup,
  backUp,
  recipes,
  materials,
  status,
  update,
  onUpdate,
  onInstall,
  onNewRecoveryKey,
  onClose
}: {
  settings: VaultSettings;
  onSettings: (settings: VaultSettings) => Promise<void>;
  lastBackup: LastBackup | null;
  backUp: () => Promise<void>;
  recipes: RecipeHead[];
  materials: MaterialHead[];
  status: VaultStatus;
  update: UpdateInfo | null;
  onUpdate: (update: UpdateInfo | null) => void;
  onInstall: () => void;
  onNewRecoveryKey: (words: string[]) => void;
  onClose: () => void;
}) {
  return (
    <main className="settings">
      <div className="settings-head">
        <h1>Settings</h1>
        <button type="button" onClick={onClose}>
          Back to recipes
        </button>
      </div>
      <AutoLock settings={settings} onSettings={onSettings} />
      <Backups settings={settings} onSettings={onSettings} lastBackup={lastBackup} backUp={backUp} />
      <Export recipes={recipes} materials={materials} version={status.version} />
      <ChangePassword />
      <RecoveryKey onNewRecoveryKey={onNewRecoveryKey} />
      <Updates status={status} update={update} onUpdate={onUpdate} onInstall={onInstall} />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = 'setting-' + title.toLowerCase().replace(/\W+/g, '-');
  return (
    <section className="setting" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function useSaving(onSettings: (settings: VaultSettings) => Promise<void>) {
  const [error, setError] = useState('');
  const save = (settings: VaultSettings) => {
    setError('');
    onSettings(settings).catch((e) => setError(errorText(e)));
  };
  return { error, save };
}

function AutoLock({
  settings,
  onSettings
}: {
  settings: VaultSettings;
  onSettings: (settings: VaultSettings) => Promise<void>;
}) {
  const { error, save } = useSaving(onSettings);
  const minutes = LOCK_MINUTES.includes(settings.autoLockMinutes)
    ? LOCK_MINUTES
    : [...LOCK_MINUTES, settings.autoLockMinutes].sort((a, b) => a - b);
  return (
    <Section title="Locking">
      <label className="check">
        <input
          type="checkbox"
          checked={settings.autoLock}
          onChange={(e) => save({ ...settings, autoLock: e.target.checked })}
        />
        Lock the vault when Glaze Vault has not been used for a while
      </label>
      <label htmlFor="lock-minutes">Lock after</label>
      <select
        id="lock-minutes"
        disabled={!settings.autoLock}
        value={settings.autoLockMinutes}
        onChange={(e) => save({ ...settings, autoLockMinutes: Number(e.target.value) })}
      >
        {minutes.map((m) => (
          <option key={m} value={m}>
            {m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${m / 60} hour${m === 60 ? '' : 's'}`}
          </option>
        ))}
      </select>
      <p className="hint">
        Changes you have not saved are kept, encrypted, and come back when you unlock.
      </p>
      {error && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}

function Backups({
  settings,
  onSettings,
  lastBackup,
  backUp
}: {
  settings: VaultSettings;
  onSettings: (settings: VaultSettings) => Promise<void>;
  lastBackup: LastBackup | null;
  backUp: () => Promise<void>;
}) {
  const { error, save } = useSaving(onSettings);
  const [busy, setBusy] = useState(false);
  const [backupError, setBackupError] = useState('');
  const run = async () => {
    setBusy(true);
    setBackupError('');
    try {
      await backUp();
    } catch (e) {
      setBackupError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Backups">
      <p>
        A backup is one encrypted file with all your recipes. Keep it on a USB drive or another computer. It opens
        with the password or recovery key you have when you make it.
      </p>
      <p className="hint">
        {lastBackup
          ? `Last backup ${new Date(lastBackup.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}: ${lastBackup.fileName}`
          : 'No backup yet.'}
      </p>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={run}>
          {busy ? 'Backing up…' : 'Back up now…'}
        </button>
      </div>
      {backupError && <p role="alert" className="error">{backupError}</p>}
      <label htmlFor="reminder">Remind me to back up</label>
      <select
        id="reminder"
        value={settings.backupReminderDays}
        onChange={(e) => save({ ...settings, backupReminderDays: Number(e.target.value) })}
      >
        {REMINDER_DAYS.map(([days, label]) => (
          <option key={days} value={days}>
            {label}
          </option>
        ))}
      </select>
      <p className="hint">To restore a backup, lock the vault and choose Restore from a backup.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}

function Export({
  recipes,
  materials,
  version
}: {
  recipes: RecipeHead[];
  materials: MaterialHead[];
  version: string;
}) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const run = async (kind: 'csv' | 'json' | 'materials-csv') => {
    setMessage('');
    setError('');
    const now = new Date();
    const contents =
      kind === 'csv'
        ? exportCsv(recipes)
        : kind === 'json'
          ? exportJson(recipes, materials, now, version)
          : exportMaterialsCsv(materials);
    const fileName =
      kind === 'materials-csv' ? exportFileName('csv', now, 'materials') : exportFileName(kind, now);
    try {
      const saved = await api.saveExport(fileName, contents);
      if (saved) setMessage(`Saved ${saved}.`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Section title="Export">
      <p>
        Saves every recipe as a spreadsheet (CSV), or everything as JSON for other programs. Your own materials have
        a spreadsheet of their own.{' '}
        <strong>Exported files are not encrypted:</strong> anyone who gets the file can read your recipes. Use a
        backup to keep a safe copy.
      </p>
      <div className="row">
        <button type="button" disabled={!recipes.length} onClick={() => run('csv')}>
          Export as CSV…
        </button>
        <button type="button" disabled={!recipes.length && !materials.length} onClick={() => run('json')}>
          Export as JSON…
        </button>
        <button type="button" disabled={!materials.length} onClick={() => run('materials-csv')}>
          Export materials as CSV…
        </button>
      </div>
      {message && <p className="hint" role="status">{message}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const change = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await api.changePassword(current, password);
      setCurrent('');
      setKey(key + 1);
      setMessage('Password changed. Your recovery key has not changed.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Password">
      <form onSubmit={change}>
        <label htmlFor="current-password">Current password</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <NewPassword key={key} label="New password" onChange={setPassword} autoFocus={false} />
        <div className="row">
          <button type="submit" disabled={!current || !password || busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
        {message && <p className="hint" role="status">{message}</p>}
        {error && <p role="alert" className="error">{error}</p>}
      </form>
    </Section>
  );
}

function RecoveryKey({ onNewRecoveryKey }: { onNewRecoveryKey: (words: string[]) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const make = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onNewRecoveryKey(await api.newRecoveryKey(password));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Section title="Recovery key">
      <form onSubmit={make}>
        <p>
          Make a new recovery key if your recovery sheet is lost or someone else may have seen it. The old sheet stops
          opening this vault straight away. Backups made before still open with the old sheet.
        </p>
        <label htmlFor="recovery-password">Password</label>
        <input
          id="recovery-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="row">
          <button type="submit" disabled={!password || busy}>
            {busy ? 'Making a new key…' : 'Make a new recovery key'}
          </button>
        </div>
        {error && <p role="alert" className="error">{error}</p>}
      </form>
    </Section>
  );
}

function Updates({
  status,
  update,
  onUpdate,
  onInstall
}: {
  status: VaultStatus;
  update: UpdateInfo | null;
  onUpdate: (update: UpdateInfo | null) => void;
  onInstall: () => void;
}) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.preferences().then(setPreferences, () => setPreferences({ checkForUpdates: true }));
  }, []);

  const check = async () => {
    setChecking(true);
    setMessage('');
    setError('');
    try {
      const found = await api.checkForUpdate();
      onUpdate(found);
      if (!found) setMessage(`Glaze Vault ${status.version} is the newest version.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const setAutomatic = (checkForUpdates: boolean) => {
    const next = { checkForUpdates };
    setPreferences(next);
    api.setPreferences(next).catch((e) => setError(errorText(e)));
  };

  return (
    <Section title="Updates">
      <p>This is Glaze Vault {status.version}.</p>
      {status.updatesConfigured ? (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={preferences?.checkForUpdates ?? true}
              disabled={!preferences}
              onChange={(e) => setAutomatic(e.target.checked)}
            />
            Check for updates when Glaze Vault starts
          </label>
          <p className="hint">
            Checking asks GitHub for the newest version number. Nothing from your vault is sent. Updates are only
            installed when you choose to.
          </p>
          <div className="row">
            <button type="button" disabled={checking} onClick={check}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
            {update && (
              <button type="button" className="primary" onClick={onInstall}>
                Install {update.version} and restart
              </button>
            )}
          </div>
          {update?.notes && <p className="hint">{update.notes}</p>}
        </>
      ) : (
        <p className="hint">This copy was built without updates. New versions are installed by hand.</p>
      )}
      {message && <p className="hint" role="status">{message}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}
