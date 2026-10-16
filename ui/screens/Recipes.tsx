import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  errorText,
  type Draft,
  type LastBackup,
  type MaterialHead,
  type RecipeHead,
  type Settings as VaultSettings,
  type UpdateInfo,
  type VaultStatus
} from '../api';
import { BATCH_UNITS, type BatchUnit } from '../batch';
import { analyse, materialLibrary, sameName, type MaterialContent, type RecipeContent } from '../chemistry';
import { localDate } from '../export';
import { restorePart, useEditor, type Editor } from '../useEditor';
import { useIdleLock } from '../useIdleLock';
import { EMPTY_MATERIAL, Materials, sameMaterial } from './Materials';
import { PrintView, type PrintJob } from './PrintView';
import { EMPTY_RECIPE, RecipeEditor, sameRecipe } from './RecipeEditor';
import { RecoverySheet } from './RecoverySheet';
import { Settings } from './Settings';

const DAY = 24 * 60 * 60 * 1000;
/** How long after the last keystroke unsaved edits are kept as a draft. */
export const DRAFT_DELAY_MS = 1000;

type Scope = 'recipe' | 'material' | 'all';

export type LockReason = 'manual' | 'idle' | 'idle-with-draft';

/** The open vault: the recipe list and editor, materials, settings, printing, and the notices
 * above them. */
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
  const [materials, setMaterials] = useState<MaterialHead[]>([]);
  const recipe = useEditor<RecipeContent>(EMPTY_RECIPE, sameRecipe);
  const material = useEditor<MaterialContent>(EMPTY_MATERIAL, sameMaterial);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [materialError, setMaterialError] = useState('');
  const [backupError, setBackupError] = useState('');
  const [saving, setSaving] = useState(false);
  // What to do once unsaved changes are saved or discarded. The system webview on macOS has no
  // window.confirm(), so the question is asked in the page.
  const [pending, setPending] = useState<{ scope: Scope; action: () => void } | null>(null);
  const [view, setView] = useState<'recipes' | 'materials' | 'settings'>('recipes');
  const [settings, setSettings] = useState<VaultSettings | null>(null);
  const [lastBackup, setLastBackup] = useState<LastBackup | null>(null);
  const [kept, setKept] = useState({ recipe: false, material: false });
  const [newWords, setNewWords] = useState<string[] | null>(null);
  const [reminderHidden, setReminderHidden] = useState(false);
  const [updateHidden, setUpdateHidden] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printJob, setPrintJob] = useState<PrintJob>({ kind: 'recipe' });
  const [printRequest, setPrintRequest] = useState(0);
  // Whether the vault holds a draft, so one is only cleared when there is one.
  const draftKept = useRef(false);
  // Draft writes, one after another: the core runs commands side by side, and a draft kept after
  // it was cleared would come back.
  const draftWrites = useRef<Promise<unknown>>(Promise.resolve());
  const writeDraft = <T,>(write: () => Promise<T>): Promise<T> => {
    const done = draftWrites.current.then(write);
    draftWrites.current = done.catch(() => {});
    return done;
  };

  useEffect(() => {
    (async () => {
      const [heads, ownMaterials, settings, last, draft] = await Promise.all([
        api.recipes(),
        api.materials(),
        api.settings(),
        api.lastBackup(),
        api.draft()
      ]);
      setRecipes(heads);
      setMaterials(ownMaterials);
      setSettings(settings);
      setLastBackup(last);
      draftKept.current = !!draft;
      const keptRecipe = draft?.recipe && restorePart(draft.recipe, heads, sameRecipe);
      const keptMaterial = draft?.material && restorePart(draft.material, ownMaterials, sameMaterial);
      if (keptRecipe) recipe.show(keptRecipe.current, keptRecipe.content);
      if (keptMaterial) material.show(keptMaterial.current, keptMaterial.content);
      if (keptMaterial && !keptRecipe) setView('materials');
      setKept({ recipe: !!keptRecipe, material: !!keptMaterial });
      setLoaded(true);
    })().catch((e) => setError(errorText(e)));
    // Once, on opening.
  }, []);

  // Keeps unsaved edits as an encrypted draft a moment after the last change, and forgets the
  // draft as soon as nothing is unsaved.
  const unsaved: Draft | null =
    recipe.part || material.part ? { recipe: recipe.part, material: material.part } : null;
  const unsavedJson = JSON.stringify(unsaved);
  useEffect(() => {
    if (!loaded) return;
    if (!unsaved) {
      if (draftKept.current) {
        draftKept.current = false;
        writeDraft(api.clearDraft).catch(() => {});
      }
      return;
    }
    const timer = setTimeout(() => {
      draftKept.current = true;
      writeDraft(() => api.saveDraft(unsaved)).catch(() => {});
    }, DRAFT_DELAY_MS);
    return () => clearTimeout(timer);
    // unsavedJson stands for unsaved, which is a new object every render.
  }, [loaded, unsavedJson]);

  // Print once the page shows the chosen layout.
  useEffect(() => {
    if (printRequest) window.print();
  }, [printRequest]);

  const library = useMemo(() => materialLibrary(materials.map((m) => m.content)), [materials]);
  const shownRecipe = recipe.viewing?.content ?? recipe.draft;
  const analysis = useMemo(() => analyse(shownRecipe.lines, library), [shownRecipe.lines, library]);

  useIdleLock(settings?.autoLock && !newWords ? settings.autoLockMinutes : null, async () => {
    try {
      if (unsaved) {
        await writeDraft(() => api.lockWithDraft(unsaved));
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

  const unsavedIn = (scope: Scope) =>
    (scope !== 'material' && recipe.changed) || (scope !== 'recipe' && material.changed);

  /** Runs `action` now, or once the person has saved or discarded the changes it would lose. */
  const leave = (scope: Scope, action: () => void) =>
    unsavedIn(scope) ? setPending({ scope, action }) : action();

  const openRecipe = (head: RecipeHead | null) =>
    leave('recipe', () => {
      recipe.open(head);
      setError('');
      setKept((k) => ({ ...k, recipe: false }));
      setView('recipes');
    });

  const openMaterial = (head: MaterialHead | null) =>
    leave('material', () => {
      material.open(head);
      setMaterialError('');
      setKept((k) => ({ ...k, material: false }));
    });

  const saveRecipe = async (): Promise<boolean> => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveRecipe(recipe.current?.revisionId ?? null, recipe.draft);
      recipe.show(saved);
      setRecipes((list) => [saved, ...list.filter((r) => r.recordId !== saved.recordId)]);
      setKept((k) => ({ ...k, recipe: false }));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveMaterial = async (): Promise<boolean> => {
    const name = material.draft.name.trim();
    const clash = materials.find(
      (m) => m.recordId !== material.current?.recordId && sameName(m.content.name, name)
    );
    if (!name || clash) {
      setMaterialError(
        name ? `You already have a material called ${clash!.content.name}.` : 'Give the material a name.'
      );
      return false;
    }
    setSaving(true);
    setMaterialError('');
    try {
      const saved = await api.saveMaterial(material.current?.revisionId ?? null, { ...material.draft, name });
      material.show(saved);
      setMaterials((list) => [saved, ...list.filter((m) => m.recordId !== saved.recordId)]);
      setKept((k) => ({ ...k, material: false }));
      return true;
    } catch (e) {
      setMaterialError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const lock = () =>
    leave('all', async () => {
      await api.lock();
      onLocked('manual');
    });

  const resolvePending = async (choice: 'save' | 'discard' | 'stay') => {
    if (!pending) return;
    const { scope, action } = pending;
    setPending(null);
    if (choice === 'stay') return;
    const doRecipe = scope !== 'material' && recipe.changed;
    const doMaterial = scope !== 'recipe' && material.changed;
    if (choice === 'save') {
      if (doRecipe && !(await saveRecipe())) return;
      if (doMaterial && !(await saveMaterial())) return;
    } else {
      if (doRecipe) recipe.discard();
      if (doMaterial) material.discard();
    }
    action();
  };

  /** Puts an earlier revision in the editor, once the edits it would replace are saved or discarded. */
  const takeRevision = <Content,>(scope: 'recipe' | 'material', editor: Editor<Content>) => {
    const content = editor.viewing!.content;
    leave(scope, () => editor.edit(content));
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
    leave('all', async () => {
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

  if (newWords) {
    return <RecoverySheet words={newWords} doneLabel="Done" onDone={() => setNewWords(null)} />;
  }

  const reminderDays = settings?.backupReminderDays ?? 0;
  const backupDue =
    !reminderHidden &&
    reminderDays > 0 &&
    recipes.length > 0 &&
    (!lastBackup || Date.now() - lastBackup.at > reminderDays * DAY);
  const pendingNames = pending
    ? [
        pending.scope !== 'material' && recipe.changed && (recipe.draft.name || 'This recipe'),
        pending.scope !== 'recipe' && material.changed && (material.draft.name || 'This material')
      ].filter((name): name is string => !!name)
    : [];
  const viewButton = (name: 'materials' | 'settings', label: string) => (
    <button type="button" aria-pressed={view === name} onClick={() => setView(view === name ? 'recipes' : name)}>
      {label}
    </button>
  );

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
          {viewButton('materials', 'Materials')}
          {viewButton('settings', 'Settings')}
          <button type="button" onClick={lock}>
            Lock
          </button>
        </div>
      </header>

      <div className="notices no-print">
        {pending && (
          <div className="notice warning" role="alertdialog" aria-labelledby="unsaved-title">
            <p id="unsaved-title">
              {pendingNames.map((name, i) => (
                <span key={name}>
                  {i > 0 && ' and '}
                  <strong>{name}</strong>
                </span>
              ))}{' '}
              {pendingNames.length > 1 ? 'have' : 'has'} changes that are not saved.
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
        {kept.recipe && recipe.changed && (
          <KeptNotice
            name={recipe.draft.name}
            onShow={view === 'recipes' ? undefined : () => setView('recipes')}
            onDiscard={() => {
              recipe.discard();
              setKept((k) => ({ ...k, recipe: false }));
            }}
          />
        )}
        {kept.material && material.changed && (
          <KeptNotice
            name={material.draft.name}
            onShow={view === 'materials' ? undefined : () => setView('materials')}
            onDiscard={() => {
              material.discard();
              setKept((k) => ({ ...k, material: false }));
            }}
          />
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
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setBackupError('');
                  backUp().catch((e) => setBackupError(errorText(e)));
                }}
              >
                Back up now…
              </button>
              <button type="button" onClick={() => setReminderHidden(true)}>
                Not now
              </button>
            </div>
            {backupError && <p role="alert" className="error">{backupError}</p>}
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
          materials={materials}
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
      ) : view === 'materials' ? (
        <Materials
          materials={materials}
          recipes={recipes}
          editor={material}
          saving={saving}
          error={materialError}
          onOpen={openMaterial}
          onSave={() => saveMaterial()}
          onUseRevision={() => takeRevision('material', material)}
        />
      ) : (
        <RecipeEditor
          recipes={recipes}
          editor={recipe}
          library={library}
          analysis={analysis}
          saving={saving}
          error={error}
          onOpen={openRecipe}
          onSave={() => saveRecipe()}
          onUseRevision={() => takeRevision('recipe', recipe)}
        />
      )}

      <PrintView
        job={printJob}
        content={shownRecipe}
        saved={recipe.viewing ?? recipe.current}
        changed={!recipe.viewing && recipe.changed}
        analysis={analysis}
      />
    </div>
  );
}

function KeptNotice({ name, onShow, onDiscard }: { name: string; onShow?: () => void; onDiscard: () => void }) {
  return (
    <div className="notice" role="status">
      <p>
        These are your unsaved changes to <strong>{name || 'Untitled'}</strong> from last time. Save them, or discard
        them.
      </p>
      <div className="row">
        {onShow && (
          <button type="button" className="primary" onClick={onShow}>
            Show them
          </button>
        )}
        <button type="button" onClick={onDiscard}>
          Discard changes
        </button>
      </div>
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
