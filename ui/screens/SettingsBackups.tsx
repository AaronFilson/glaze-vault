import { useEffect, useState } from 'react';
import { api, errorText, type LastBackup, type PhoneBackups, type SetAside, type Settings as VaultSettings } from '../api';

const LOCK_MINUTES = [1, 5, 10, 15, 30, 60, 120];
const REMINDER_DAYS: [number, string][] = [
  [0, 'Never'],
  [7, 'After a week'],
  [14, 'After two weeks'],
  [30, 'After a month'],
  [90, 'After three months']
];

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
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

export function AutoLock({
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
      <p className="hint">Changes you have not saved are kept, encrypted, and come back when you unlock.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}

/** A phone's own vault: backups kept where the phone's own backup takes them
 * (docs/adr/0028-a-phones-own-vault.md). */
function PhoneBackupChoice({
  on,
  phoneBackups,
  error,
  onChange
}: {
  on: boolean;
  phoneBackups: PhoneBackups;
  error: string;
  onChange: (on: boolean) => void;
}) {
  const { last, budget } = phoneBackups;
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        Back up with this phone's backup
      </label>
      <p className="hint">
        Each day you change the vault, Glaze Vault keeps a backup on this phone where its own backup (iCloud or
        Google) takes it, and keeps the newest three. If you lose the phone, restore it from its backup,
        then open Glaze Vault and choose Restore from a backup on this phone. The file is encrypted under your
        password, so in the cloud it is as safe as your password is strong. Your recovery key still opens it.
      </p>
      {on && last && (
        <p className="hint">
          Last backup on this phone{' '}
          {new Date(last.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          {last.photos ? '.' : ', without photos.'}
        </p>
      )}
      {on && last && !last.photos && (
        <p className="warn">
          With your photos the vault is more than the {Math.round((budget ?? 0) / (1024 * 1024))} MB this phone's
          backup takes, so the backups kept here leave the photos out. Save a whole backup somewhere else, such as
          Google Drive, with Back up now.
        </p>
      )}
      {!on && <p className="hint">This phone's own backup takes nothing of the vault.</p>}
      {error && <p role="alert" className="error">The last backup on this phone failed: {error}</p>}
    </>
  );
}

export function Backups({
  settings,
  onSettings,
  lastBackup,
  phoneBackups,
  phoneBackupError,
  backUp
}: {
  settings: VaultSettings;
  onSettings: (settings: VaultSettings) => Promise<void>;
  lastBackup: LastBackup | null;
  phoneBackups: PhoneBackups | null;
  phoneBackupError: string;
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
      {phoneBackups && (
        <PhoneBackupChoice
          on={settings.phoneBackups}
          phoneBackups={phoneBackups}
          error={phoneBackupError}
          onChange={(on) => save({ ...settings, phoneBackups: on })}
        />
      )}
      <p className="hint">To restore a backup, lock the vault and choose Restore from a backup.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}

/** Vaults a restore set aside, to switch back to. Shown only when there are some. */
export function SetAsideVaults({ onSwitch, error }: { onSwitch: (name: string) => void; error: string }) {
  const [vaults, setVaults] = useState<SetAside[] | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    api
      .setAside()
      .then(setVaults)
      .catch((e) => setLoadError(errorText(e)));
  }, []);
  if (!vaults?.length && !loadError) return null;
  const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <Section title="Vaults set aside">
      <p>
        Restoring a backup set the vault that was here aside, not deleted. Switch to one to use it again: the vault
        open now is set aside in its place, so you can switch back the same way.
      </p>
      <ul className="plain-list">
        {(vaults ?? []).map((vault) => (
          <li key={vault.name}>
            Set aside {when(vault.setAsideAt)}{' '}
            <button type="button" className="link" onClick={() => setAsking(vault.name)}>
              Switch to it…
            </button>
            {asking === vault.name && (
              <div className="notice warning" role="alertdialog" aria-label="Switch vaults">
                <p>
                  Switch to the vault set aside {when(vault.setAsideAt)}? This vault locks and is set aside. You then
                  unlock the other with its own password.
                </p>
                <div className="row">
                  <button type="button" className="primary" onClick={() => onSwitch(vault.name)}>
                    Switch vaults
                  </button>
                  <button type="button" onClick={() => setAsking(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {(error || loadError) && (
        <p role="alert" className="error">
          {error || loadError}
        </p>
      )}
      <p className="hint">The folders are in the vault folder; delete one there once you are sure you do not need it.</p>
    </Section>
  );
}
