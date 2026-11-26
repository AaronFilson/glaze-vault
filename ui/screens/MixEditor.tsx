import { useEffect, useState } from 'react';
import { api, errorText, type Access, type RecipeHead } from '../api';
import { BATCH_UNITS, formatWeight, scaleBatch, usableLines, type BatchSheet, type BatchUnit } from '../batch';
import { amountOf } from '../chemistry';
import { daysAged, emptyStep, mixName, mixTotals, newMix, tidyMix, type Mix, type MixContent, type MixStep } from '../mix';
import { printOut } from '../printing';
import { isSlip } from '../slip';
import { canEdit, may } from '../team';
import { useRevisionLines } from '../useRevisionLines';
import { CheckoutBar } from './CheckoutBar';
import { ConfirmNotice } from './Deleted';
import { Fold } from './Fold';
import { ForkChoice } from './ForkChoice';
import type { MixEditing } from './MixLog';
import { PrintedMix, STEP_FIELDS } from './PrintedMix';

export function MixEditor({
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
    if (printRequest) printOut().catch((e) => setError(errorText(e)));
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
          <button type="button" onClick={() => set({ steps: [...steps, emptyStep(new Date())] })}>
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
