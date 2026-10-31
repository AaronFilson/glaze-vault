import { useEffect, useState } from 'react';
import {
  api,
  errorText,
  type Access,
  type LastBackup,
  type PhoneBackups,
  type MaterialHead,
  type Preferences,
  type RecipeHead,
  type SetAside,
  type Settings as VaultSettings,
  type UpdateInfo,
  type VaultStatus
} from '../api';
import { exportCsv, exportFileName, exportFiringsCsv, exportInsightXml, exportJson, exportMaterialsCsv, exportMixesCsv } from '../export';
import type { Mix } from '../mix';
import type { Firing } from '../firing';
import { ImportError, readImport, type ImportPlan } from '../importFormats';
import { editableCollections, may } from '../team';
import { AuditLog } from './AuditLog';
import { Network } from './Network';
import { NewPassword } from './NewPassword';
import { ManagedPeople, People, ShareVault } from './Team';

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
  phoneBackups = null,
  phoneBackupError = '',
  backUp,
  recipes,
  materials,
  firings,
  mixes = [],
  status,
  update,
  onUpdate,
  onInstall,
  onNewRecoveryKey,
  onSwitchVault,
  switchError,
  onImport,
  onClose,
  access,
  onShared,
  onTeamChanged,
  onLeft,
  limitFormulas,
  prices
}: {
  settings: VaultSettings;
  onSettings: (settings: VaultSettings) => Promise<void>;
  lastBackup: LastBackup | null;
  /** A phone's own vault's backups; null on a desktop and on a computer that syncs. */
  phoneBackups?: PhoneBackups | null;
  phoneBackupError?: string;
  backUp: () => Promise<void>;
  recipes: RecipeHead[];
  materials: MaterialHead[];
  firings: Firing[];
  /** The mix log, for its export. */
  mixes?: Mix[];
  status: VaultStatus;
  update: UpdateInfo | null;
  onUpdate: (update: UpdateInfo | null) => void;
  onInstall: () => void;
  onNewRecoveryKey: (words: string[]) => void;
  /** Swaps this vault with one a restore set aside, and locks. */
  onSwitchVault: (name: string) => void;
  switchError: string;
  /** Shows what a file holds, to choose what to import. */
  onImport: (fileName: string, plan: ImportPlan) => void;
  onClose: () => void;
  /** Who is signed in, and whether the vault is a team's (ADR 12). */
  access: Access | null;
  /** The vault was shared: shows the organization's recovery key. */
  onShared: (organizationWords: string[]) => void;
  /** People or collections changed: reads this person's access again. */
  onTeamChanged: () => void;
  /** This computer left the vault it synced. */
  onLeft: () => void;
  /** The person's own limit formulas (Limits.tsx). */
  limitFormulas?: React.ReactNode;
  /** The price list (Prices.tsx). */
  prices?: React.ReactNode;
}) {
  const [shrunkTo, setShrunkTo] = useState<string | null>(null);
  // In a team's vault, backups and switching vaults change everyone's, so they are for admins.
  const team = !!access?.team;
  const admin = !team || !!access?.me.admin;
  /** What this person may export: the records in collections whose role lets them. */
  const exportable = <Item extends { collectionId?: string }>(list: Item[]) =>
    list.filter((item) => may(access, item.collectionId, 'export'));
  return (
    <main className="settings">
      <div className="settings-head">
        <h1>Settings</h1>
        <button type="button" onClick={onClose}>
          Back to recipes
        </button>
      </div>
      {access && (
        <Section title={team ? 'People' : 'Sharing'}>
          {shrunkTo && !team && (
            <p className="hint" role="status">
              This vault is yours alone again. The backup made first is {shrunkTo}.
            </p>
          )}
          {!team ? (
            <ShareVault onShared={onShared} />
          ) : access.me.admin ? (
            <People
              access={access}
              onOrganizationKey={onShared}
              onChanged={onTeamChanged}
              onShrunk={(backup) => {
                setShrunkTo(backup);
                onTeamChanged();
              }}
            />
          ) : access.collections.some((c) => c.manage) ? (
            <ManagedPeople access={access} onChanged={onTeamChanged} />
          ) : (
            <p>
              You are signed in as <strong>{access.me.name}</strong>. An admin decides what you can see and change, and
              backs up the vault.
            </p>
          )}
        </Section>
      )}
      {limitFormulas && <Section title="Limit formulas">{limitFormulas}</Section>}
      {prices && <Section title="Prices">{prices}</Section>}
      <AutoLock settings={settings} onSettings={onSettings} />
      {admin && (
        <Backups
          settings={settings}
          onSettings={onSettings}
          lastBackup={lastBackup}
          phoneBackups={phoneBackups}
          phoneBackupError={phoneBackupError}
          backUp={backUp}
        />
      )}
      {admin && <SetAsideVaults onSwitch={onSwitchVault} error={switchError} />}
      {(!team || editableCollections(access, 'recipe').length > 0 || editableCollections(access, 'material').length > 0) && (
        <Import onImport={onImport} />
      )}
      {(!team || access?.collections.some((c) => c.export)) && (
        <Export
          recipes={exportable(recipes)}
          materials={exportable(materials)}
          firings={exportable(firings)}
          mixes={exportable(mixes)}
          version={status.version}
          partly={[recipes, materials, firings, mixes].some((list) => exportable<{ collectionId?: string }>(list).length < list.length)}
        />
      )}
      {team && (
        <Section title="Network">
          <Network
            people={status.people}
            admin={admin}
            phone={status.platform !== 'desktop'}
            onChanged={onTeamChanged}
            onLeft={onLeft}
          />
        </Section>
      )}
      {admin && access && (
        <Section title="Audit log">
          <AuditLog access={access} people={status.people} records={recordNames(recipes, materials, firings)} />
        </Section>
      )}
      <ChangePassword />
      <RecoveryKey onNewRecoveryKey={onNewRecoveryKey} />
      <Updates status={status} update={update} onUpdate={onUpdate} onInstall={onInstall} />
    </main>
  );
}

function Import({ onImport }: { onImport: (fileName: string, plan: ImportPlan) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choose = async () => {
    setBusy(true);
    setError('');
    try {
      const file = await api.chooseImport();
      if (file) onImport(file.fileName, readImport(file.fileName, file.contents));
    } catch (e) {
      setError(e instanceof ImportError ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Import">
      <p>
        Adds recipes and materials from a file: a Glaze Vault export, Insight or Glazy XML, GlazeChem recipes (.glz) or
        materials (.mat), or a spreadsheet (CSV) of materials with a column for each oxide. You see what it holds, and
        choose, before anything is added.
      </p>
      <div className="row">
        <button type="button" disabled={busy} onClick={choose}>
          Import from a file…
        </button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}

/** Vaults a restore set aside, to switch back to. Shown only when there are some. */
function SetAsideVaults({ onSwitch, error }: { onSwitch: (name: string) => void; error: string }) {
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

/** What an export held, for the audit log: the format and how many records. */
function exported(kind: string, recipes: number, materials: number, firings: number, mixes: number): string {
  switch (kind) {
    case 'json':
      return `${recipes} recipes and ${materials} materials as JSON`;
    case 'xml':
      return `${recipes} recipes as Insight XML`;
    case 'materials-csv':
      return `${materials} materials as CSV`;
    case 'firings-csv':
      return `${firings} firings as CSV`;
    case 'mixes-csv':
      return `${mixes} mixes as CSV`;
    default:
      return `${recipes} recipes as CSV`;
  }
}

/** What the audit log calls the records this person can open. */
function recordNames(recipes: RecipeHead[], materials: MaterialHead[], firings: Firing[]): Record<string, string> {
  return Object.fromEntries([
    ...recipes.map((r) => [r.recordId, r.content.name] as const),
    ...materials.map((m) => [m.recordId, m.content.name] as const),
    ...firings.map((f) => [f.recordId, `${f.content.recipeName} fired ${f.content.firedOn}`] as const)
  ]);
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

function Backups({
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

function Export({
  recipes,
  materials,
  firings,
  mixes,
  version,
  partly
}: {
  recipes: RecipeHead[];
  materials: MaterialHead[];
  firings: Firing[];
  mixes: Mix[];
  version: string;
  /** Some records are in collections this person may not export from, and are left out. */
  partly: boolean;
}) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const run = async (kind: 'csv' | 'json' | 'xml' | 'materials-csv' | 'firings-csv' | 'mixes-csv') => {
    setMessage('');
    setError('');
    const now = new Date();
    const contents =
      kind === 'csv'
        ? exportCsv(recipes)
        : kind === 'json'
          ? exportJson(recipes, materials, now, version)
          : kind === 'xml'
            ? exportInsightXml(recipes)
            : kind === 'firings-csv'
              ? exportFiringsCsv(firings)
              : kind === 'mixes-csv'
                ? exportMixesCsv(mixes, recipes)
                : exportMaterialsCsv(materials);
    const fileName =
      kind === 'materials-csv'
        ? exportFileName('csv', now, 'materials')
        : kind === 'firings-csv'
          ? exportFileName('csv', now, 'firing log')
          : kind === 'mixes-csv'
            ? exportFileName('csv', now, 'mix log')
            : exportFileName(kind, now);
    try {
      const saved = await api.saveExport(fileName, contents);
      if (saved) {
        setMessage(`Saved ${saved}.`);
        const detail = exported(kind, recipes.length, materials.length, firings.length, mixes.length);
        api.note({ action: 'exported', detail }).catch(() => {});
      }
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Section title="Export">
      <p>
        Saves every recipe as a spreadsheet (CSV), or as Insight XML for Insight-live and Glazy, or everything as JSON
        for other programs. Your own materials, the firing log and the mix log each have a spreadsheet of their own.{' '}
        <strong>Exported files are not encrypted:</strong> anyone who gets the file can read your recipes. Use a
        backup to keep a safe copy.
      </p>
      {partly && <p className="hint">Only the collections you may export from are in it.</p>}
      <div className="row">
        <button type="button" disabled={!recipes.length} onClick={() => run('csv')}>
          Export as CSV…
        </button>
        <button type="button" disabled={!recipes.length} onClick={() => run('xml')}>
          Export as Insight XML…
        </button>
        <button type="button" disabled={!recipes.length && !materials.length} onClick={() => run('json')}>
          Export as JSON…
        </button>
        <button type="button" disabled={!materials.length} onClick={() => run('materials-csv')}>
          Export materials as CSV…
        </button>
        <button type="button" disabled={!firings.length} onClick={() => run('firings-csv')}>
          Export firing log as CSV…
        </button>
        <button type="button" disabled={!mixes.length} onClick={() => run('mixes-csv')}>
          Export mix log as CSV…
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
      ) : status.platform === 'desktop' ? (
        <p className="hint">This copy was built without updates. New versions are installed by hand.</p>
      ) : (
        <p className="hint">
          New versions come from the {status.platform === 'ios' ? 'App Store' : 'Play Store'}, like any other app.
        </p>
      )}
      {message && <p className="hint" role="status">{message}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}
