// The mix log (docs/adr/0016-mix-log.md): every batch mixed from the batch sheets and recipes this
// person can open, newest first, and one at a time to fill in: the lot of each material weighed
// and, for a slip, deflocculant and water added in steps, with readings as it ages.
import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Access, type RecipeHead } from '../api';
import { BATCH_UNITS, formatWeight, scaleBatch, usableLines, type BatchSheet, type BatchUnit } from '../batch';
import { amountOf } from '../chemistry';
import {
  daysAged,
  emptyStep,
  mixMatches,
  mixName,
  mixOf,
  mixSummary,
  mixTotals,
  newMix,
  sameMix,
  tidyMix,
  type Mix,
  type MixContent,
  type MixStep
} from '../mix';
import { isSlip } from '../slip';
import { canEdit, editableCollections, may } from '../team';
import { useRevisionLines } from '../useRevisionLines';
import { ConfirmNotice } from './Deleted';
import { Fold, PendingNotice } from './FiringLog';
import { ForkChoice } from './ForkChoice';
import { CheckoutBar } from './CheckoutBar';

/** The mix open in the editor: the newest revision, if saved, and the edits to it. */
export interface MixEditing {
  current: Mix | null;
  draft: MixContent;
}

const STEP_FIELDS: { key: keyof MixStep; label: string; decimal?: boolean }[] = [
  { key: 'deflocculant', label: 'Deflocculant added', decimal: true },
  { key: 'water', label: 'Water added', decimal: true },
  { key: 'gravity', label: 'Specific gravity', decimal: true },
  { key: 'viscosity', label: 'Ford cup #4, s', decimal: true },
  { key: 'gel', label: 'Gel' }
];

export function MixLog({
  mixes,
  recipes,
  sheets,
  access,
  editing,
  onEdit,
  forRecipe,
  onForRecipe,
  onSaved,
  onErased
}: {
  mixes: Mix[];
  recipes: RecipeHead[];
  sheets: BatchSheet[];
  access: Access | null;
  editing: MixEditing | null;
  onEdit: (editing: MixEditing | null) => void;
  /** Only the mixes of this recipe, from its sheets or not, when one is chosen. */
  forRecipe: string | null;
  onForRecipe: (recordId: string | null) => void;
  onSaved: (saved: Mix) => void;
  onErased: (recordId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<(() => void) | null>(null);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  const changed = !!editing && (!editing.current || !sameMix(editing.current.content, editing.draft));
  const nameOf = (content: MixContent) => mixName(content, recipes);
  const filterName =
    forRecipe &&
    (recipes.find((r) => r.recordId === forRecipe)?.content.name ||
      sheets.find((s) => s.content.recipe === forRecipe)?.content.name ||
      'Untitled');
  const shown = mixes
    .filter((m) => !forRecipe || mixOf(m.content, forRecipe))
    .filter((m) => mixMatches(m.content, nameOf(m.content), search))
    .sort((a, b) => b.content.mixedOn.localeCompare(a.content.mixedOn) || b.savedAt - a.savedAt);
  const mayLog = !access?.team || editableCollections(access, 'mix').length > 0;

  const leave = (action: () => void) => (changed ? setPending(() => action) : action());
  const startNew = () =>
    leave(() => {
      // Of the recipe shown, when there is one: from its sheet if this person weighs from sheets.
      const sheet = sheets.find((s) => s.content.recipe === forRecipe && canEdit(access, s.collectionId, 'mix'));
      const recipe = recipes.find((r) => r.recordId === forRecipe && canEdit(access, r.collectionId, 'mix'));
      onEdit({
        current: null,
        draft: newMix(sheet ? { sheet } : recipe ? { recipe } : null, new Date())
      });
    });

  return (
    <>
      <nav className="sidebar no-print" aria-label="Mixes">
        {mayLog && (
          <button type="button" className="primary" onClick={startNew}>
            Log a mix
          </button>
        )}
        {filterName && (
          <p className="hint">
            Mixes of {filterName}.{' '}
            <button type="button" className="link" onClick={() => onForRecipe(null)}>
              Show all
            </button>
          </p>
        )}
        {mixes.length > 1 && (
          <div className="find">
            <input
              type="search"
              aria-label="Search mixes"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
        {shown.length === 0 ? (
          <p className="hint">{mixes.length ? 'No mixes here.' : 'No mixes logged yet.'}</p>
        ) : (
          <ul className="list">
            {shown.map((mix) => (
              <li key={mix.recordId}>
                <button
                  type="button"
                  aria-current={mix.recordId === editing?.current?.recordId}
                  onClick={() => leave(() => onEdit({ current: mix, draft: mix.content }))}
                >
                  {nameOf(mix.content)}
                  <span className="hint list-note"> {mixSummary(mix.content)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <main className="editor no-print">
        {pending && (
          <PendingNotice
            name={editing ? `The mix of ${nameOf(editing.draft)}` : 'This mix'}
            label="Unsaved mix"
            onSave={async () => {
              const action = pending;
              setPending(null);
              if (await (saveRef.current?.() ?? Promise.resolve(false))) action();
            }}
            onDiscard={() => {
              const action = pending;
              setPending(null);
              action();
            }}
            onStay={() => setPending(null)}
          />
        )}
        {editing ? (
          <MixEditor
            key={editing.current?.recordId ?? 'new'}
            editing={editing}
            changed={changed}
            recipes={recipes}
            sheets={sheets}
            access={access}
            onEdit={onEdit}
            onSaved={onSaved}
            onErased={onErased}
            registerSave={(save) => (saveRef.current = save)}
          />
        ) : (
          <p className="hint">
            {mayLog
              ? 'Log a mix to keep when a batch was mixed, the lot of each material, and for a slip, what went in and how it read as it aged.'
              : 'Choose a mix to read.'}
          </p>
        )}
      </main>
    </>
  );
}

function MixEditor({
  editing,
  changed,
  recipes,
  sheets,
  access,
  onEdit,
  onSaved,
  onErased,
  registerSave
}: {
  editing: MixEditing;
  changed: boolean;
  recipes: RecipeHead[];
  sheets: BatchSheet[];
  access: Access | null;
  onEdit: (editing: MixEditing | null) => void;
  onSaved: (saved: Mix) => void;
  onErased: (recordId: string) => void;
  registerSave: (save: () => Promise<boolean>) => void;
}) {
  const { current, draft } = editing;
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const sheet = sheets.find((s) => s.recordId === draft.sheet) ?? null;
  const recipe = recipes.find((r) => r.recordId === draft.recipe) ?? null;
  const collection = current?.collectionId ?? sheet?.collectionId ?? recipe?.collectionId ?? null;
  const readOnly = !canEdit(access, collection, 'mix');
  const set = (change: Partial<MixContent>) => onEdit({ current, draft: { ...draft, ...change } });
  const name = mixName(draft, recipes);

  // The lines weighed: the recipe revision's, with its materials' names, when this person can read
  // them; else the batch sheet's, with its codes.
  const recipeLines = useRevisionLines('recipe', recipe, draft.recipeNumber);
  const sheetLines = useRevisionLines('batch', sheet, draft.sheetNumber);
  const lines = recipeLines?.some((l) => l.material.trim()) ? recipeLines : sheetLines;
  const size = amountOf(draft.size ?? '');
  const unit = draft.unit ?? 'g';
  const batch = lines ? scaleBatch(lines, Number.isFinite(size) ? size : 0) : null;
  const weighed = lines ? usableLines(lines) : [];
  const lots = draft.lots ?? [];
  const lotRows = Math.max(weighed.length, lots.length);
  const steps = draft.steps ?? [];
  const totals = mixTotals(draft);
  const slip = isSlip(recipe?.content.type);
  const mayPrint = (!!draft.sheet || !!draft.recipe) && may(access, collection, 'print');
  // The record goes in the page once asked for, and the print dialog takes it after it renders.
  const [printRequest, setPrintRequest] = useState(0);
  useEffect(() => {
    if (printRequest) window.print();
  }, [printRequest]);
  const print = () => {
    setPrintRequest((n) => n + 1);
    if (current) api.note({ action: 'printed', kind: 'mix', record: current.recordId, detail: 'mix record' }).catch(() => {});
  };

  const save = async (content = draft): Promise<Mix | null> => {
    if (!content.sheet && !content.recipe) {
      setError('Choose the batch sheet or recipe that was mixed.');
      return null;
    }
    setSaving(true);
    setError('');
    try {
      const tidy = tidyMix(content);
      const saved = current
        ? await api.saveRecord<MixContent>('mix', current.revisionId, tidy)
        : await api.saveRecord<MixContent>('mix', null, tidy, collection);
      onSaved(saved);
      onEdit({ current: saved, draft: saved.content });
      return saved;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setSaving(false);
    }
  };
  registerSave(async () => !!(await save()));

  const remove = async () => {
    setConfirming(false);
    try {
      const gone = await api.deleteRecord('mix', current!.revisionId);
      await api.eraseRecord('mix', gone.recordId);
      onErased(gone.recordId);
      onEdit(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const setLot = (i: number, lot: string) => {
    const next = Array.from({ length: lotRows }, (_, j) => lots[j] ?? '');
    next[i] = lot;
    set({ lots: next });
  };
  const setStep = (i: number, change: Partial<MixStep>) =>
    set({ steps: steps.map((step, j) => (j === i ? { ...step, ...change } : step)) });
  const amount = (total: { amount: number; percent: number | null } | null) =>
    total &&
    `${formatWeight(total.amount, unit)} ${unit}${total.percent === null ? '' : ` (${total.percent.toFixed(2)}% of the dry batch)`}`;

  // Sheets this person may log a mix of, and recipes that have none they can weigh from.
  const sources = [
    ...sheets.filter((s) => canEdit(access, s.collectionId, 'mix')).map((s) => ({ value: `sheet:${s.recordId}`, label: s.content.name || 'Untitled' })),
    ...recipes
      .filter((r) => canEdit(access, r.collectionId, 'mix') && r.content.lines.length > 0)
      .map((r) => ({ value: `recipe:${r.recordId}`, label: r.content.name || 'Untitled' }))
  ];

  return (
    <>
      {current && (
        <ForkChoice
          kind="mix"
          head={current}
          name={`Mix of ${name}`}
          readOnly={readOnly}
          onResolved={(saved) => {
            if (saved.deleted) {
              onErased(saved.recordId);
              onEdit(null);
            } else {
              onSaved(saved);
              onEdit({ current: saved, draft: saved.content });
            }
          }}
        />
      )}
      {current && <CheckoutBar kind="mix" record={current.recordId} readOnly={readOnly} />}
      {readOnly && current && (
        <p className="hint" role="status">
          You can read this mix, but not change it.
        </p>
      )}
      <fieldset className="plain" disabled={readOnly}>
        <h1>{draft.sheet || draft.recipe ? `Mix of ${name}` : 'New mix'}</h1>
        {current ? (
          <p className="hint">
            {draft.sheet ? `Revision ${draft.sheetNumber} of the batch sheet.` : `Revision ${draft.recipeNumber} of the recipe.`}
          </p>
        ) : (
          <div className="detail">
            <label htmlFor="mix-source">Mixed from</label>
            <select
              id="mix-source"
              value={draft.sheet ? `sheet:${draft.sheet}` : draft.recipe ? `recipe:${draft.recipe}` : ''}
              onChange={(e) => {
                const [kind, id] = e.target.value.split(':');
                const fromSheet = kind === 'sheet' ? sheets.find((s) => s.recordId === id) : undefined;
                const fromRecipe = kind === 'recipe' ? recipes.find((r) => r.recordId === id) : undefined;
                // Lots belong to the lines of what is mixed.
                const source = newMix(fromSheet ? { sheet: fromSheet } : fromRecipe ? { recipe: fromRecipe } : null, new Date());
                set({ ...source, mixedOn: draft.mixedOn, size: draft.size, unit: draft.unit, notes: draft.notes, lots: undefined });
              }}
            >
              <option value="">Choose a batch sheet or recipe</option>
              {sources.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.value.startsWith('sheet:') ? `${s.label} (batch sheet)` : s.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="details">
          <div className="detail">
            <label htmlFor="mix-date">Mixed on</label>
            <input id="mix-date" type="date" value={draft.mixedOn} onChange={(e) => set({ mixedOn: e.target.value })} />
          </div>
          <div className="detail">
            <label htmlFor="mix-size">Dry batch size</label>
            <div className="row tight">
              <input id="mix-size" inputMode="decimal" value={draft.size ?? ''} onChange={(e) => set({ size: e.target.value })} />
              <select aria-label="Unit" value={unit} onChange={(e) => set({ unit: e.target.value as BatchUnit })}>
                {BATCH_UNITS.map((u) => (
                  <option key={u.unit} value={u.unit}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {lotRows > 0 && (
          <>
            <h2 className="section-heading">What was weighed</h2>
            <p className="hint">The lot or bag of each material, clays most of all: a new bag can change a result.</p>
            <table className="lines">
              <thead>
                <tr>
                  <th scope="col">{lines === sheetLines && sheet ? 'Code' : 'Material'}</th>
                  {batch && (
                    <>
                      <th scope="col" className="num">
                        %
                      </th>
                      <th scope="col" className="num">
                        Weight ({unit})
                      </th>
                    </>
                  )}
                  <th scope="col">Lot</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: lotRows }, (_, i) => {
                  const label = weighed[i]?.material || `Material ${i + 1}`;
                  return (
                    <tr key={i}>
                      <td>{label}</td>
                      {batch && (
                        <>
                          <td className="num">{batch.lines[i] ? batch.lines[i].percent.toFixed(2) : ''}</td>
                          <td className="num">{batch.lines[i] ? formatWeight(batch.lines[i].weight, unit) : ''}</td>
                        </>
                      )}
                      <td>
                        <input aria-label={`Lot of ${label}, line ${i + 1}`} value={lots[i] ?? ''} onChange={(e) => setLot(i, e.target.value)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        <Fold open={slip || steps.length > 0 || !!draft.water?.trim()}>
          <summary>Water, deflocculant and readings</summary>
          <p className="hint">
            For a slip: the water put in at the start, then each step as it is mixed and aged, with what was added and
            how it read after. Add deflocculant a little at a time; readings drift for a few days.
            {recipe?.content.gravity || recipe?.content.viscosity
              ? ` The recipe aims for ${[
                  recipe.content.gravity && `a specific gravity of ${recipe.content.gravity}`,
                  recipe.content.viscosity && `${recipe.content.viscosity} s through a Ford cup`
                ]
                  .filter(Boolean)
                  .join(' and ')}.`
              : ''}
          </p>
          <div className="details">
            <div className="detail">
              <label htmlFor="mix-water">Water at the start ({unit})</label>
              <input id="mix-water" inputMode="decimal" value={draft.water ?? ''} onChange={(e) => set({ water: e.target.value })} />
            </div>
          </div>
          {steps.length > 0 && (
            <table className="lines steps">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  {STEP_FIELDS.map((f) => (
                    <th scope="col" key={f.key}>
                      {f.label}
                      {f.key === 'deflocculant' || f.key === 'water' ? ` (${unit})` : ''}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step, i) => {
                  const day = daysAged(draft.mixedOn, step.on);
                  return (
                    <tr key={i}>
                      <td>
                        <input
                          type="date"
                          aria-label={`Day of step ${i + 1}`}
                          value={step.on}
                          onChange={(e) => setStep(i, { on: e.target.value })}
                        />
                        {day !== null && day > 0 && <span className="hint"> day {day}</span>}
                      </td>
                      {STEP_FIELDS.map((f) => (
                        <td key={f.key}>
                          <input
                            aria-label={`${f.label}, step ${i + 1}`}
                            inputMode={f.decimal ? 'decimal' : undefined}
                            value={step[f.key]}
                            onChange={(e) => setStep(i, { [f.key]: e.target.value })}
                          />
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          className="link danger"
                          aria-label={`Remove step ${i + 1}`}
                          onClick={() => set({ steps: steps.filter((_, j) => j !== i) })}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <button
            type="button"
            onClick={() => set({ steps: [...steps, emptyStep(new Date())] })}
          >
            Add a step
          </button>
          {(totals.deflocculant || totals.water) && (
            <table className="facts" aria-label="Put in all told">
              <tbody>
                {totals.deflocculant && (
                  <tr>
                    <th scope="row">Deflocculant in all</th>
                    <td className="num">{amount(totals.deflocculant)}</td>
                  </tr>
                )}
                {totals.water && (
                  <tr>
                    <th scope="row">Water in all</th>
                    <td className="num">{amount(totals.water)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </Fold>

        <label htmlFor="mix-notes">Notes</label>
        <textarea id="mix-notes" rows={4} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
      </fieldset>

      {confirming && (
        <ConfirmNotice confirm="Delete" onConfirm={() => void remove()} onCancel={() => setConfirming(false)}>
          <p>
            <strong>Delete this mix of {name}?</strong> It is removed for good. Backups made before now still have it.
          </p>
        </ConfirmNotice>
      )}
      <div className="row">
        {!readOnly && (
          <button type="button" className="primary" disabled={!changed || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {current && !changed && (
          <span className="hint">
            Saved {new Date(current.savedAt).toLocaleString()} · revision {current.number}
          </span>
        )}
        {mayPrint && (
          <button type="button" onClick={print}>
            Print mix record
          </button>
        )}
        {current && !readOnly && (
          <button type="button" className="link danger end" onClick={() => setConfirming(true)}>
            Delete…
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {mayPrint && printRequest > 0 && (
        <PrintedMix
          draft={draft}
          name={name}
          changed={changed}
          current={current}
          heading={lines === sheetLines && sheet ? 'Code' : 'Material'}
          rows={Array.from({ length: lotRows }, (_, i) => ({
            material: weighed[i]?.material || `Material ${i + 1}`,
            percent: batch?.lines[i]?.percent ?? null,
            weight: batch?.lines[i]?.weight ?? null,
            lot: lots[i] ?? ''
          }))}
          slip={slip}
        />
      )}
    </>
  );
}

/** Blank rows a printed mix record leaves for the steps still to come. */
const BLANK_STEPS = 8;

/** A mix record for the shop floor (ui/styles.css hides it on screen, once it is asked for): the batch as weighed, with
 * a place for each lot, then the slip's steps so far and blank rows for the rest, to fill in by
 * hand and type in later. */
function PrintedMix({
  draft,
  name,
  changed,
  current,
  heading,
  rows,
  slip
}: {
  draft: MixContent;
  name: string;
  changed: boolean;
  current: Mix | null;
  heading: string;
  rows: { material: string; percent: number | null; weight: number | null; lot: string }[];
  slip: boolean;
}) {
  const unit = draft.unit ?? 'g';
  const steps = draft.steps ?? [];
  const printed = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const status = changed
    ? 'Not saved: printed with unsaved changes'
    : current
      ? `Revision ${current.number}, saved ${new Date(current.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
      : '';
  const hasWeights = rows.some((row) => row.weight !== null);
  return (
    <section className="print-only paper" aria-hidden="true">
      <p className="confidential">Confidential · Printed {printed} from Glaze Vault</p>
      <h1>Mix record: {name}</h1>
      {status && <p className="meta">{status}</p>}
      <p className="meta">
        {draft.sheet ? `Batch sheet revision ${draft.sheetNumber}` : `Recipe revision ${draft.recipeNumber}`} · Mixed on{' '}
        {draft.mixedOn}
        {draft.size?.trim() ? ` · Dry batch ${draft.size.trim()} ${unit}` : ''}
      </p>
      {rows.length > 0 && (
        <table className="paper-table">
          <thead>
            <tr>
              <th scope="col">{heading}</th>
              {hasWeights && (
                <>
                  <th scope="col" className="num">
                    %
                  </th>
                  <th scope="col" className="num">
                    Weight ({unit})
                  </th>
                </>
              )}
              <th scope="col">Lot</th>
              <th scope="col">Weighed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>{row.material}</td>
                {hasWeights && (
                  <>
                    <td className="num">{row.percent === null ? '' : row.percent.toFixed(2)}</td>
                    <td className="num">{row.weight === null ? '' : formatWeight(row.weight, unit)}</td>
                  </>
                )}
                <td className="write-in">{row.lot}</td>
                <td className="write-in" />
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(slip || steps.length > 0 || !!draft.water?.trim()) && (
        <>
          <h2>Water, deflocculant and readings</h2>
          <p className="meta">Water at the start: {draft.water?.trim() ? `${draft.water.trim()} ${unit}` : '________'}</p>
          <table className="paper-table steps">
            <thead>
              <tr>
                <th scope="col">Day</th>
                {STEP_FIELDS.map((f) => (
                  <th scope="col" key={f.key}>
                    {f.label}
                    {f.key === 'deflocculant' || f.key === 'water' ? ` (${unit})` : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {steps.map((step, i) => (
                <tr key={i}>
                  <td>{step.on}</td>
                  {STEP_FIELDS.map((f) => (
                    <td key={f.key}>{step[f.key]}</td>
                  ))}
                </tr>
              ))}
              {Array.from({ length: BLANK_STEPS }, (_, i) => (
                <tr key={`blank-${i}`}>
                  <td className="write-in" />
                  {STEP_FIELDS.map((f) => (
                    <td key={f.key} className="write-in" />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {draft.notes.trim() && (
        <>
          <h2>Notes</h2>
          <p className="notes">{draft.notes}</p>
        </>
      )}
      <dl className="signoff">
        <dt>Mixed by</dt>
        <dd />
        <dt>Date</dt>
        <dd />
        <dt>Checked by</dt>
        <dd />
      </dl>
    </section>
  );
}
