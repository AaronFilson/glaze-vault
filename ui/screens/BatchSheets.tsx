// Batch sheets (docs/adr/0012-teams-on-one-computer.md): a recipe's lines with its materials named
// by in-house codes, for a batch operator to weigh out without seeing the recipe or its chemistry.
// The core encrypts them with a key a batch operator can hold without holding the recipes'.
import { useEffect, useState } from 'react';
import { api, errorText, type Access, type RecipeHead } from '../api';
import {
  BATCH_UNITS,
  codeProblem,
  knownCodes,
  sheetFrom,
  usableLines,
  type BatchSheet,
  type BatchUnit,
  type CodePair
} from '../batch';
import { amountOf, sameName } from '../chemistry';
import { byCollection, canEdit, may } from '../team';
import { ConfirmNotice } from './Deleted';
import { BatchTable } from './PrintView';

/** The batch sheets this person can open, one at a time, at the size they weigh. */
export function BatchSheets({
  sheets,
  access,
  names,
  current,
  onOpen,
  mixCount,
  onMixes,
  onPrint,
  onDeleted
}: {
  sheets: BatchSheet[];
  access: Access;
  names: Record<string, string>;
  current: BatchSheet | null;
  onOpen: (sheet: BatchSheet) => void;
  /** How many mixes the open sheet has. */
  mixCount: number;
  /** Shows the open sheet's mixes, and starts logging another when `logging`. */
  onMixes: (sheet: BatchSheet, logging: boolean) => void;
  onPrint: (size: number, unit: BatchUnit) => void;
  onDeleted: (sheet: BatchSheet) => void;
}) {
  const [size, setSize] = useState('1000');
  const [unit, setUnit] = useState<BatchUnit>('g');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const amount = amountOf(size);
  const ready = Number.isFinite(amount) && amount > 0;

  const remove = async () => {
    setConfirming(false);
    try {
      await api.deleteRecord('batch', current!.revisionId);
      onDeleted(current!);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <>
      <nav className="sidebar no-print" aria-label="Batch sheets">
        {sheets.length === 0 ? (
          <p className="hint">No batch sheets yet.</p>
        ) : (
          byCollection(sheets, access, names).map((group) => (
            <section key={group.label}>
              <h2 className="list-heading">{group.label}</h2>
              <ul className="list">
                {group.items.map((sheet) => (
                  <li key={sheet.recordId}>
                    <button
                      type="button"
                      aria-current={sheet.recordId === current?.recordId}
                      onClick={() => {
                        setError('');
                        setConfirming(false);
                        onOpen(sheet);
                      }}
                    >
                      {sheet.content.name || 'Untitled'}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>

      <main className="editor no-print">
        {!current ? (
          <p className="hint">
            {sheets.length
              ? 'Choose a batch sheet to weigh out.'
              : 'A batch sheet is made from a recipe, by someone who may change it: Batch sheet…, below the recipe.'}
          </p>
        ) : (
          <>
            <h1>{current.content.name || 'Untitled'}</h1>
            <p className="hint">Saved {new Date(current.savedAt).toLocaleString()}</p>
            <div className="row batch-size">
              <label htmlFor="sheet-size">Batch size</label>
              <input
                id="sheet-size"
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
            {ready && <BatchTable content={current.content} size={amount} unit={unit} heading="Code" />}
            {current.content.notes.trim() && <p className="notes">{current.content.notes}</p>}
            {confirming && (
              <ConfirmNotice confirm="Delete" onConfirm={() => void remove()} onCancel={() => setConfirming(false)}>
                <p>
                  <strong>Delete the batch sheet {current.content.name || 'Untitled'}?</strong> Nobody can weigh from
                  it any more. Its recipe stays as it is.
                </p>
              </ConfirmNotice>
            )}
            <div className="row">
              {may(access, current.collectionId, 'print') && (
                <button type="button" className="primary" disabled={!ready} onClick={() => onPrint(amount, unit)}>
                  Print
                </button>
              )}
              {canEdit(access, current.collectionId, 'mix') && (
                <button type="button" onClick={() => onMixes(current, true)}>
                  Log a mix…
                </button>
              )}
              {mixCount > 0 && (
                <button type="button" onClick={() => onMixes(current, false)}>
                  Mixes ({mixCount})
                </button>
              )}
              {canEdit(access, current.collectionId, 'batch') && (
                <button type="button" className="link danger end" onClick={() => setConfirming(true)}>
                  Delete…
                </button>
              )}
            </div>
            {error && <p role="alert" className="error">{error}</p>}
          </>
        )}
      </main>
    </>
  );
}

/** Makes or updates a recipe's batch sheet: a code for each material, a name and notes. */
export function BatchSheetForm({
  recipe,
  sheet,
  sheets,
  recipes,
  onSaved,
  onCancel
}: {
  recipe: RecipeHead;
  /** The recipe's sheet, if it has one. */
  sheet: BatchSheet | null;
  sheets: BatchSheet[];
  recipes: RecipeHead[];
  onSaved: (sheet: BatchSheet) => void;
  onCancel: () => void;
}) {
  const materials = usableLines(recipe.content.lines).map((line) => line.material);
  const [known, setKnown] = useState<CodePair[] | null>(null);
  const [codes, setCodes] = useState<string[]>(() => materials.map(() => ''));
  const [name, setName] = useState(sheet?.content.name ?? recipe.content.name);
  const [notes, setNotes] = useState(sheet?.content.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // The codes already on sheets, matched to the materials of the recipe revisions they were made
  // from, to fill in the ones this recipe uses.
  useEffect(() => {
    let stale = false;
    (async () => {
      const pairs = await Promise.all(
        sheets.map(async (s) => {
          const head = recipes.find((r) => r.recordId === s.content.recipe);
          if (!head || s.content.recipeNumber === null) return null;
          if (head.number === s.content.recipeNumber) return { recipe: head.content, sheet: s.content };
          const history = await api.history<RecipeHead['content']>('recipe', head.recordId).catch(() => []);
          const made = history.find((r) => r.number === s.content.recipeNumber);
          return made ? { recipe: made.content, sheet: s.content } : null;
        })
      );
      if (stale) return;
      const found = knownCodes(pairs.filter((p) => p !== null));
      setKnown(found);
      setCodes((typed) =>
        materials.map((material, i) => typed[i] || found.find((k) => sameName(k.material, material))?.code || '')
      );
    })().catch((e) => setError(errorText(e)));
    return () => {
      stale = true;
    };
    // Once, when the form opens.
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = codeProblem(materials, codes, known ?? []);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const content = sheetFrom(recipe, codes, name.trim() || recipe.content.name, notes);
      const saved = sheet
        ? await api.saveRecord('batch', sheet.revisionId, content)
        : await api.saveRecord('batch', null, content, recipe.collectionId ?? null);
      onSaved(saved);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <form className="notice" onSubmit={save}>
      <fieldset>
        <legend>Batch sheet</legend>
        <p className="hint">
          A batch operator sees the sheet with these codes instead of the materials, and none of the chemistry. They
          still see the amounts.
        </p>
        <label htmlFor="sheet-name">Name on the sheet</label>
        <input id="sheet-name" value={name} onChange={(e) => setName(e.target.value)} />
        <table className="lines">
          <thead>
            <tr>
              <th scope="col">Material</th>
              <th scope="col">Code</th>
            </tr>
          </thead>
          <tbody>
            {materials.map((material, i) => (
              <tr key={i}>
                <td>{material}</td>
                <td>
                  <input
                    aria-label={`Code for ${material}`}
                    value={codes[i]}
                    onChange={(e) => setCodes(codes.map((c, j) => (j === i ? e.target.value : c)))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <label htmlFor="sheet-notes">Notes for weighing</label>
        <textarea id="sheet-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </fieldset>
      <div className="row">
        <button type="submit" className="primary" disabled={saving || known === null}>
          {saving ? 'Saving…' : 'Save batch sheet'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}
