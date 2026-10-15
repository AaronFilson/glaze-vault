import { useEffect, useMemo, useState } from 'react';
import {
  api,
  errorText,
  type LastBackup,
  type RecipeHead,
  type Settings as VaultSettings,
  type UpdateInfo,
  type VaultStatus
} from '../api';
import { BATCH_UNITS, type BatchUnit } from '../batch';
import { analyse, MATERIAL_NAMES, type RecipeContent, type RecipeLine } from '../chemistry';
import { localDate } from '../export';
import { useIdleLock } from '../useIdleLock';
import { AnalysisPanel } from './AnalysisPanel';
import { PrintView, type PrintJob } from './PrintView';
import { RecoverySheet } from './RecoverySheet';
import { Settings } from './Settings';

const EMPTY: RecipeContent = { name: '', lines: [{ material: '', amount: '' }], notes: '' };
const DAY = 24 * 60 * 60 * 1000;

export type LockReason = 'manual' | 'idle' | 'idle-with-draft';

/** The open vault: the recipe list and editor, settings, printing, and the notices above them. */
export function Recipes({
  status,
  update,
  onUpdate,
  onLocked
}: {
  status: VaultStatus;
  update: UpdateInfo | null;
  onUpdate: (update: UpdateInfo | null) => void;
  onLocked: (reason: LockReason) => void;
}) {
  const [recipes, setRecipes] = useState<RecipeHead[]>([]);
  const [current, setCurrent] = useState<RecipeHead | null>(null);
  const [draft, setDraft] = useState<RecipeContent>(EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // What to do once unsaved changes are saved or discarded. The system webview on macOS has no
  // window.confirm(), so the question is asked in the page.
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [view, setView] = useState<'recipes' | 'settings'>('recipes');
  const [settings, setSettings] = useState<VaultSettings | null>(null);
  const [lastBackup, setLastBackup] = useState<LastBackup | null>(null);
  const [keptDraft, setKeptDraft] = useState(false);
  const [newWords, setNewWords] = useState<string[] | null>(null);
  const [reminderHidden, setReminderHidden] = useState(false);
  const [updateHidden, setUpdateHidden] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printJob, setPrintJob] = useState<PrintJob>({ kind: 'recipe' });
  const [printRequest, setPrintRequest] = useState(0);

  useEffect(() => {
    (async () => {
      const [heads, settings, last, kept] = await Promise.all([
        api.recipes(),
        api.settings(),
        api.lastBackup(),
        api.takeDraft()
      ]);
      setRecipes(heads);
      setSettings(settings);
      setLastBackup(last);
      if (kept) {
        const head = heads.find((h) => h.revisionId === kept.revisionId) ?? null;
        setCurrent(head);
        setDraft(kept.content);
        setKeptDraft(true);
      }
    })().catch((e) => setError(errorText(e)));
  }, []);

  // Print once the page shows the chosen layout.
  useEffect(() => {
    if (printRequest) window.print();
  }, [printRequest]);

  const changed = !sameContent(draft, current?.content ?? EMPTY);
  const analysis = useMemo(() => analyse(draft.lines), [draft.lines]);

  useIdleLock(settings?.autoLock && !newWords ? settings.autoLockMinutes : null, async () => {
    try {
      if (changed) {
        await api.lockWithDraft({ revisionId: current?.revisionId ?? null, content: draft });
        onLocked('idle-with-draft');
      } else {
        await api.lock();
        onLocked('idle');
      }
    } catch {
      await api.lock().catch(() => {});
      onLocked('idle');
    }
  });

  /** Runs `action` now, or once the person has saved or discarded their changes. */
  const leave = (action: () => void) => (changed ? setPending(() => action) : action());

  const open = (recipe: RecipeHead | null) =>
    leave(() => {
      setCurrent(recipe);
      setDraft(recipe ? recipe.content : EMPTY);
      setError('');
      setKeptDraft(false);
      setView('recipes');
    });

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveRecipe(current?.revisionId ?? null, draft);
      setCurrent(saved);
      setDraft(saved.content);
      setRecipes([saved, ...recipes.filter((r) => r.recordId !== saved.recordId)]);
      setKeptDraft(false);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const lock = () =>
    leave(async () => {
      await api.lock();
      onLocked('manual');
    });

  const resolvePending = async (choice: 'save' | 'discard' | 'stay') => {
    const action = pending;
    setPending(null);
    if (!action || choice === 'stay') return;
    if (choice === 'save' && !(await save())) return;
    action();
  };

  const backUp = async () => {
    const saved = await api.backUp(`Glaze Vault backup ${localDate(new Date())}.gvbackup`);
    if (saved) setLastBackup(saved);
  };

  const saveSettings = async (next: VaultSettings) => {
    await api.setSettings(next);
    setSettings(next);
  };

  const install = () =>
    leave(async () => {
      setInstalling(true);
      try {
        await api.installUpdate();
      } catch (e) {
        setInstalling(false);
        // The vault is locked just before installing, so a failed install can leave it locked.
        const now = await api.status().catch(() => null);
        if (now && !now.unlocked) onLocked('manual');
        else setError(errorText(e));
      }
    });

  const print = (job: PrintJob) => {
    setPrintJob(job);
    setPrinting(false);
    setPrintRequest((n) => n + 1);
  };

  const setLine = (index: number, line: RecipeLine) =>
    setDraft({ ...draft, lines: draft.lines.map((l, i) => (i === index ? line : l)) });

  if (newWords) {
    return <RecoverySheet words={newWords} doneLabel="Done" onDone={() => setNewWords(null)} />;
  }

  const reminderDays = settings?.backupReminderDays ?? 0;
  const backupDue =
    !reminderHidden &&
    reminderDays > 0 &&
    recipes.length > 0 &&
    (!lastBackup || Date.now() - lastBackup.at > reminderDays * DAY);

  return (
    <div className="shell">
      <header className="bar no-print">
        <span className="brand">Glaze Vault</span>
        <div className="bar-actions">
          {view === 'recipes' && (
            <button type="button" aria-expanded={printing} onClick={() => setPrinting(!printing)}>
              Print…
            </button>
          )}
          <button
            type="button"
            aria-pressed={view === 'settings'}
            onClick={() => setView(view === 'settings' ? 'recipes' : 'settings')}
          >
            Settings
          </button>
          <button type="button" onClick={lock}>
            Lock
          </button>
        </div>
      </header>

      <div className="notices no-print">
        {pending && (
          <div className="notice warning" role="alertdialog" aria-labelledby="unsaved-title">
            <p id="unsaved-title">
              <strong>{draft.name || 'This recipe'}</strong> has changes that are not saved.
            </p>
            <div className="row">
              <button type="button" className="primary" autoFocus onClick={() => resolvePending('save')}>
                Save
              </button>
              <button type="button" onClick={() => resolvePending('discard')}>
                Discard changes
              </button>
              <button type="button" onClick={() => resolvePending('stay')}>
                Keep editing
              </button>
            </div>
          </div>
        )}
        {keptDraft && changed && (
          <div className="notice" role="status">
            <p>
              These are the changes to <strong>{draft.name || 'Untitled'}</strong> that were not saved when the vault
              locked. Save them, or discard them.
            </p>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  setDraft(current?.content ?? EMPTY);
                  setKeptDraft(false);
                }}
              >
                Discard changes
              </button>
            </div>
          </div>
        )}
        {printing && view === 'recipes' && (
          <PrintOptions job={printJob} onPrint={print} onCancel={() => setPrinting(false)} />
        )}
        {update && !updateHidden && (
          <div className="notice" role="status">
            <p>Glaze Vault {update.version} is ready to install.</p>
            <div className="row">
              <button type="button" className="primary" disabled={installing} onClick={install}>
                {installing ? 'Installing…' : 'Install and restart'}
              </button>
              <button type="button" disabled={installing} onClick={() => setUpdateHidden(true)}>
                Later
              </button>
            </div>
          </div>
        )}
        {backupDue && (
          <div className="notice" role="status">
            <p>
              {lastBackup
                ? `Your last backup was ${Math.floor((Date.now() - lastBackup.at) / DAY)} days ago.`
                : 'Your recipes have not been backed up yet.'}{' '}
              A backup is an encrypted copy to keep away from this computer.
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => backUp().catch((e) => setError(errorText(e)))}>
                Back up now…
              </button>
              <button type="button" onClick={() => setReminderHidden(true)}>
                Not now
              </button>
            </div>
          </div>
        )}
      </div>

      {view === 'settings' && settings ? (
        <Settings
          settings={settings}
          onSettings={saveSettings}
          lastBackup={lastBackup}
          backUp={backUp}
          recipes={recipes}
          status={status}
          update={update}
          onUpdate={(found) => {
            onUpdate(found);
            setUpdateHidden(false);
          }}
          onInstall={install}
          onNewRecoveryKey={setNewWords}
          onClose={() => setView('recipes')}
        />
      ) : (
        <>
          <nav className="sidebar no-print" aria-label="Recipes">
            <button type="button" className="primary" onClick={() => open(null)}>
              New recipe
            </button>
            {recipes.length === 0 ? (
              <p className="hint">No recipes yet.</p>
            ) : (
              <ul className="list">
                {recipes.map((recipe) => (
                  <li key={recipe.recordId}>
                    <button
                      type="button"
                      aria-current={recipe.recordId === current?.recordId}
                      onClick={() => open(recipe)}
                    >
                      {recipe.content.name || 'Untitled'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>

          <main className="editor no-print">
            <label htmlFor="name">Recipe name</label>
            <input
              id="name"
              className="title"
              value={draft.name}
              placeholder="Untitled"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />

            <table className="lines">
              <thead>
                <tr>
                  <th scope="col">Material</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((line, index) => (
                  <tr key={index}>
                    <td>
                      <input
                        aria-label={`Material ${index + 1}`}
                        list="materials"
                        value={line.material}
                        onChange={(e) => setLine(index, { ...line, material: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        aria-label={`Amount ${index + 1}`}
                        inputMode="decimal"
                        value={line.amount}
                        onChange={(e) => setLine(index, { ...line, amount: e.target.value })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link"
                        aria-label={`Remove material ${index + 1}`}
                        onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, i) => i !== index) })}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="materials">
              {MATERIAL_NAMES.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <button
              type="button"
              onClick={() => setDraft({ ...draft, lines: [...draft.lines, { material: '', amount: '' }] })}
            >
              Add material
            </button>

            <label htmlFor="notes">Notes</label>
            <textarea id="notes" rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />

            <div className="row">
              <button type="button" className="primary" disabled={!changed || saving} onClick={() => save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {current && !changed && (
                <span className="hint">
                  Saved {new Date(current.savedAt).toLocaleString()} · revision {current.number}
                </span>
              )}
            </div>
            {error && <p role="alert" className="error">{error}</p>}
          </main>

          <aside className="analysis no-print" aria-label="Unity formula">
            <AnalysisPanel analysis={analysis} />
          </aside>
        </>
      )}

      <PrintView job={printJob} content={draft} saved={current} changed={changed} analysis={analysis} />
    </div>
  );
}

function PrintOptions({
  job,
  onPrint,
  onCancel
}: {
  job: PrintJob;
  onPrint: (job: PrintJob) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<PrintJob['kind']>(job.kind);
  const [size, setSize] = useState(job.kind === 'batch' ? String(job.size) : '1000');
  const [unit, setUnit] = useState<BatchUnit>(job.kind === 'batch' ? job.unit : 'g');
  const amount = Number(size.trim().replace(',', '.'));
  const ready = kind === 'recipe' || (Number.isFinite(amount) && amount > 0);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (ready) onPrint(kind === 'recipe' ? { kind } : { kind, size: amount, unit });
  };

  return (
    <form className="notice" onSubmit={submit}>
      <fieldset className="print-options">
        <legend>Print</legend>
        <label className="check">
          <input type="radio" name="print-kind" checked={kind === 'recipe'} onChange={() => setKind('recipe')} />
          The recipe, with its unity formula
        </label>
        <label className="check">
          <input type="radio" name="print-kind" checked={kind === 'batch'} onChange={() => setKind('batch')} />
          A batch sheet for weighing out
        </label>
        {kind === 'batch' && (
          <div className="row batch-size">
            <label htmlFor="batch-size">Batch size</label>
            <input
              id="batch-size"
              inputMode="decimal"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              aria-invalid={!ready}
            />
            <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as BatchUnit)}>
              {BATCH_UNITS.map((u) => (
                <option key={u.unit} value={u.unit}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </fieldset>
      <div className="row">
        <button type="submit" className="primary" disabled={!ready}>
          Print
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Compares by value: the core hands content back with its keys in another order. */
function sameContent(a: RecipeContent, b: RecipeContent): boolean {
  return (
    a.name === b.name &&
    a.notes === b.notes &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line.material === b.lines[i].material && line.amount === b.lines[i].amount)
  );
}
