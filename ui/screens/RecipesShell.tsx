import { useState } from 'react';
import { BATCH_UNITS, type BatchUnit } from '../batch';
import { amountOf, sameName, standardNamed, type RecipeContent } from '../chemistry';
import type { PHONE_TABS } from '../phone';
import type { Editor } from '../useEditor';
import type { PrintJob } from './PrintView';
import { SyncIndicator } from './SyncIndicator';

export type ShellView =
  | 'recipes'
  | 'materials'
  | 'settings'
  | 'compare'
  | 'import'
  | 'batches'
  | 'firings'
  | 'mixes'
  | 'blend'
  | 'fit';

export function RecipesHeader({
  view,
  onView,
  canPrint,
  printing,
  onTogglePrint,
  team,
  signedInName,
  onLock
}: {
  view: ShellView;
  onView: (view: ShellView) => void;
  canPrint: boolean;
  printing: boolean;
  onTogglePrint: () => void;
  team: boolean;
  signedInName: string | null;
  onLock: () => void;
}) {
  const viewButton = (name: 'materials' | 'settings' | 'batches' | 'firings' | 'mixes', label: string) => (
    <button type="button" aria-pressed={view === name} onClick={() => onView(view === name ? 'recipes' : name)}>
      {label}
    </button>
  );
  return (
    <header className="bar no-print">
      <span className="brand">Glaze Vault</span>
      <div className="bar-actions">
        {/* A phone saves what it would print as a PDF (ADR 33). */}
        {view === 'recipes' && canPrint && (
          <button type="button" aria-expanded={printing} onClick={onTogglePrint}>
            Print…
          </button>
        )}
        <span className="views">
          {viewButton('mixes', 'Mix log')}
          {viewButton('firings', 'Firing log')}
          {team && viewButton('batches', 'Batch sheets')}
          {viewButton('materials', 'Materials')}
          {viewButton('settings', 'Settings')}
        </span>
        <SyncIndicator />
        {signedInName !== null && <span className="hint signed-in">{signedInName}</span>}
        <button type="button" className="views" onClick={onLock}>
          Lock
        </button>
      </div>
    </header>
  );
}

export function PhoneNav({
  view,
  onView,
  team,
  onLock
}: {
  view: ShellView;
  onView: (view: ShellView) => void;
  team: boolean;
  onLock: () => void;
}) {
  const [more, setMore] = useState(false);
  const tab = (name: (typeof PHONE_TABS)[number], label: string) => (
    <button
      type="button"
      aria-current={view === name && !more ? 'page' : undefined}
      onClick={() => {
        setMore(false);
        onView(name);
      }}
    >
      {label}
    </button>
  );
  return (
    <nav className="phone-nav no-print" aria-label="Views">
      {tab('recipes', 'Recipes')}
      {tab('mixes', 'Mix log')}
      {tab('firings', 'Firing log')}
      <button type="button" aria-expanded={more} onClick={() => setMore(!more)}>
        More
      </button>
      {more && (
        <div className="phone-more" role="menu">
          {(
            [
              ['materials', 'Materials'],
              ...(team ? [['batches', 'Batch sheets']] : []),
              ['settings', 'Settings']
            ] as ['materials' | 'batches' | 'settings', string][]
          ).map(([name, label]) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              aria-current={view === name ? 'page' : undefined}
              onClick={() => {
                setMore(false);
                onView(name);
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMore(false);
              onLock();
            }}
          >
            Lock
          </button>
        </div>
      )}
    </nav>
  );
}

export function UnsavedDialog({
  names,
  onResolve
}: {
  names: string[];
  onResolve: (choice: 'save' | 'discard' | 'stay') => void;
}) {
  return (
    <div className="notice warning" role="alertdialog" aria-labelledby="unsaved-title">
      <p id="unsaved-title">
        {names.map((name, i) => (
          <span key={name}>
            {i > 0 && ' and '}
            <strong>{name}</strong>
          </span>
        ))}{' '}
        {names.length > 1 ? 'have' : 'has'} changes that are not saved.
      </p>
      <div className="row">
        <button type="button" className="primary" autoFocus onClick={() => onResolve('save')}>
          Save
        </button>
        <button type="button" onClick={() => onResolve('discard')}>
          Discard changes
        </button>
        <button type="button" onClick={() => onResolve('stay')}>
          Keep editing
        </button>
      </div>
    </div>
  );
}

export function KeptNotice({
  name,
  plain = false,
  onShow,
  onDiscard
}: {
  name: string;
  /** The name is a phrase, not a record's name to show in bold. */
  plain?: boolean;
  onShow?: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="notice" role="status">
      <p>
        These are your unsaved changes to {plain ? name : <strong>{name || 'Untitled'}</strong>} from last time. Save
        them, or discard them.
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

export function PrintOptions({
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
  const amount = amountOf(size);
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

export function deleteOrEraseText<Content extends { name: string }>(
  action: 'delete' | 'erase',
  kind: string,
  editor: Editor<Content>,
  recipes: { content: RecipeContent }[]
) {
  const name = (editor.current ?? editor.viewing)?.content.name || 'Untitled';
  if (action === 'erase') {
    return (
      <p>
        <strong>Erase {name} permanently?</strong> All its revisions are removed from this vault and cannot be brought
        back. Backups made before now still have it.
      </p>
    );
  }
  const users =
    kind === 'material' ? recipes.filter((r) => r.content.lines.some((line) => sameName(line.material, name))).length : 0;
  const standard = kind === 'material' && standardNamed(name);
  return (
    <p>
      <strong>Delete {name}?</strong> It moves to Deleted, below the list, where you can restore it or erase it for
      good.
      {editor.changed && ' Your unsaved changes to it are lost.'}
      {users > 0 &&
        ` ${users === 1 ? '1 recipe uses' : `${users} recipes use`} it, and will ${
          standard ? `use the standard ${standard} instead` : 'not find it'
        } until it is restored.`}
    </p>
  );
}
