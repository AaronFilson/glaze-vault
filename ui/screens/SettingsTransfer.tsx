import { useEffect, useState } from 'react';
import {
  api,
  errorText,
  type MaterialHead,
  type Preferences,
  type RecipeHead,
  type UpdateInfo,
  type VaultStatus
} from '../api';
import {
  exportCsv,
  exportFileName,
  exportFiringsCsv,
  exportInsightXml,
  exportJson,
  exportMaterialsCsv,
  exportMixesCsv
} from '../export';
import type { Firing } from '../firing';
import { ImportError, readImport, type ImportPlan } from '../importFormats';
import type { Mix } from '../mix';
import { NewPassword } from './NewPassword';
import { Section } from './SettingsBackups';

export function ImportSection({ onImport }: { onImport: (fileName: string, plan: ImportPlan) => void }) {
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

export function ExportSection({
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

export function ChangePassword() {
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

export function RecoveryKey({ onNewRecoveryKey }: { onNewRecoveryKey: (words: string[]) => void }) {
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

export function Updates({
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
