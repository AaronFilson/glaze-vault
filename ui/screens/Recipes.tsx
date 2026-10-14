import { useEffect, useMemo, useState } from 'react';
import { api, errorText, type RecipeHead } from '../api';
import {
  analyse,
  GROUP_TITLES,
  MATERIAL_NAMES,
  oxideLabel,
  oxidesByGroup,
  type Analysis,
  type RecipeContent,
  type RecipeLine
} from '../chemistry';

const EMPTY: RecipeContent = { name: '', lines: [{ material: '', amount: '' }], notes: '' };

export function Recipes({ onLocked }: { onLocked: () => void }) {
  const [recipes, setRecipes] = useState<RecipeHead[]>([]);
  const [current, setCurrent] = useState<RecipeHead | null>(null);
  const [draft, setDraft] = useState<RecipeContent>(EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // What to do once unsaved changes are saved or discarded. The system webview on macOS has no
  // window.confirm(), so the question is asked in the page.
  const [pending, setPending] = useState<(() => void) | null>(null);

  useEffect(() => {
    api.recipes().then(setRecipes, (e) => setError(errorText(e)));
  }, []);

  const changed = !sameContent(draft, current?.content ?? EMPTY);
  const analysis = useMemo(() => analyse(draft.lines), [draft.lines]);

  /** Runs `action` now, or once the person has saved or discarded their changes. */
  const leave = (action: () => void) => (changed ? setPending(() => action) : action());

  const open = (recipe: RecipeHead | null) =>
    leave(() => {
      setCurrent(recipe);
      setDraft(recipe ? recipe.content : EMPTY);
      setError('');
    });

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveRecipe(current?.revisionId ?? null, draft);
      setCurrent(saved);
      setDraft(saved.content);
      setRecipes([saved, ...recipes.filter((r) => r.recordId !== saved.recordId)]);
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
      onLocked();
    });

  const resolvePending = async (choice: 'save' | 'discard' | 'stay') => {
    const action = pending;
    setPending(null);
    if (!action || choice === 'stay') return;
    if (choice === 'save' && !(await save())) return;
    action();
  };

  const setLine = (index: number, line: RecipeLine) =>
    setDraft({ ...draft, lines: draft.lines.map((l, i) => (i === index ? line : l)) });

  return (
    <div className="shell">
      <header className="bar">
        <span className="brand">Glaze Vault</span>
        <button type="button" onClick={lock}>
          Lock
        </button>
      </header>

      {pending && (
        <div className="unsaved" role="alertdialog" aria-labelledby="unsaved-title">
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

      <nav className="sidebar" aria-label="Recipes">
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

      <main className="editor">
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

      <aside className="analysis" aria-label="Unity formula">
        <AnalysisPanel analysis={analysis} />
      </aside>
    </div>
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

function AnalysisPanel({ analysis }: { analysis: Analysis }) {
  if (!analysis) return <p className="hint">Add materials and amounts to see the unity formula.</p>;
  if (!analysis.result) return <p className="error">{analysis.problem}</p>;
  const { result } = analysis;
  const groups = oxidesByGroup(result);
  return (
    <>
      <h2>Unity formula</h2>
      {(Object.keys(groups) as (keyof typeof groups)[])
        .filter((group) => groups[group].length)
        .map((group) => (
          <table key={group} className="umf">
            <caption>{GROUP_TITLES[group]}</caption>
            <tbody>
              {groups[group].map(([oxide, moles]) => (
                <tr key={oxide}>
                  <th scope="row">{oxideLabel(oxide)}</th>
                  <td className="num">{moles.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      <dl className="facts">
        {result.siAlRatio !== null && (
          <>
            <dt>SiO₂ : Al₂O₃</dt>
            <dd>{result.siAlRatio.toFixed(2)}</dd>
          </>
        )}
        {result.expansion !== null && (
          <>
            <dt>Expansion</dt>
            <dd>{result.expansion.toFixed(2)} × 10⁻⁶/°C</dd>
          </>
        )}
        <dt>Loss on ignition</dt>
        <dd>{result.loi.toFixed(1)}%</dd>
      </dl>
      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </>
  );
}
