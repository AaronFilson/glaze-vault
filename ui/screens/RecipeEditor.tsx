import type { RecipeHead } from '../api';
import type { Analysis, MaterialLibrary, RecipeContent, RecipeLine } from '../chemistry';
import type { Editor } from '../useEditor';
import { AnalysisPanel } from './AnalysisPanel';
import { DeletedList, DeletedNotice } from './Deleted';
import { RevisionHistory, ViewingNotice } from './RevisionHistory';

export const EMPTY_RECIPE: RecipeContent = { name: '', lines: [{ material: '', amount: '' }], notes: '' };

/** Compares by value: the core hands content back with its keys in another order. */
export function sameRecipe(a: RecipeContent, b: RecipeContent): boolean {
  return (
    a.name === b.name &&
    a.notes === b.notes &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line.material === b.lines[i].material && line.amount === b.lines[i].amount)
  );
}

/** The recipe list, an editor for one, and its unity formula. */
export function RecipeEditor({
  recipes,
  deleted,
  editor,
  library,
  analysis,
  saving,
  error,
  onOpen,
  onSave,
  onUseRevision,
  onOpenDeleted,
  onDelete,
  onRestore,
  onErase,
  onCompare,
  readOnly = false,
  canCreate = true,
  groups,
  newIn
}: {
  recipes: RecipeHead[];
  deleted: RecipeHead[];
  editor: Editor<RecipeContent>;
  library: MaterialLibrary;
  analysis: Analysis;
  saving: boolean;
  error: string;
  onOpen: (recipe: RecipeHead | null) => void;
  onSave: () => void;
  onUseRevision: () => void;
  onOpenDeleted: (recipe: RecipeHead) => void;
  onDelete: () => void;
  onRestore: () => void;
  onErase: () => void;
  /** Opens Compare: from here when nothing is said, or with an earlier revision. Missing when
   * there is nothing to compare with. */
  onCompare?: (revisionNumber?: number) => void;
  /** The person may read this recipe but not change it (a team's vault, ADR 12). */
  readOnly?: boolean;
  /** Whether the person may make recipes in any collection. */
  canCreate?: boolean;
  /** In a team's vault, the list in groups by collection. */
  groups?: { label: string; items: RecipeHead[] }[];
  /** For a new recipe in a team's vault, where it will be saved. */
  newIn?: React.ReactNode;
}) {
  const { current, draft, setDraft, changed, viewing } = editor;
  const shown = viewing?.content ?? draft;

  const setLine = (index: number, line: RecipeLine) =>
    setDraft({ ...draft, lines: draft.lines.map((l, i) => (i === index ? line : l)) });

  return (
    <>
      <nav className="sidebar no-print" aria-label="Recipes">
        {canCreate && (
          <button type="button" className="primary" onClick={() => onOpen(null)}>
            New recipe
          </button>
        )}
        {recipes.length === 0 ? (
          <p className="hint">No recipes yet.</p>
        ) : groups ? (
          groups.map((group) => (
            <section key={group.label}>
              <h2 className="list-heading">{group.label}</h2>
              <RecipeList recipes={group.items} current={current} onOpen={onOpen} />
            </section>
          ))
        ) : (
          <RecipeList recipes={recipes} current={current} onOpen={onOpen} />
        )}
        <DeletedList deleted={deleted} nameOf={(c) => c.name} viewing={viewing} onOpen={onOpenDeleted} />
      </nav>

      <main className="editor no-print">
        {viewing?.deleted && (
          <DeletedNotice deleted={viewing} name={viewing.content.name} onRestore={onRestore} onErase={onErase} />
        )}
        {viewing && !viewing.deleted && current && (
          <ViewingNotice
            viewing={viewing}
            newest={current}
            onUse={onUseRevision}
            onBack={() => editor.setViewing(null)}
            onCompare={onCompare && (() => onCompare(viewing.number))}
          />
        )}
        {readOnly && current && !viewing && (
          <p className="hint" role="status">
            You can read this recipe, but not change it. An admin can change what you may do.
          </p>
        )}
        {!current && !viewing && newIn}
        <fieldset className="plain" disabled={!!viewing || readOnly}>
          <label htmlFor="name">Recipe name</label>
          <input
            id="name"
            className="title"
            value={shown.name}
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
              {shown.lines.map((line, index) => (
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
            {library.names.map(({ name, yours }) => (
              <option key={name} value={name} label={yours ? 'Your material' : undefined} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={() => setDraft({ ...draft, lines: [...draft.lines, { material: '', amount: '' }] })}
          >
            Add material
          </button>

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            rows={4}
            value={shown.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </fieldset>

        <div className="row">
          {!readOnly && (
            <button type="button" className="primary" disabled={!changed || saving || !!viewing} onClick={onSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {current && !changed && !viewing && (
            <span className="hint">
              Saved {new Date(current.savedAt).toLocaleString()} · revision {current.number}
            </span>
          )}
          {onCompare && !viewing && (
            <button type="button" className="end" onClick={() => onCompare()}>
              Compare…
            </button>
          )}
          {current && !viewing && !readOnly && (
            <button type="button" className={`link danger${onCompare ? '' : ' end'}`} onClick={onDelete}>
              Delete…
            </button>
          )}
        </div>
        {error && <p role="alert" className="error">{error}</p>}
        {current && <RevisionHistory kind="recipe" current={current} viewing={viewing} onView={editor.setViewing} />}
      </main>

      <aside className="analysis no-print" aria-label="Unity formula">
        <AnalysisPanel analysis={analysis} />
      </aside>
    </>
  );
}

function RecipeList({
  recipes,
  current,
  onOpen
}: {
  recipes: RecipeHead[];
  current: RecipeHead | null;
  onOpen: (recipe: RecipeHead) => void;
}) {
  return (
    <ul className="list">
      {recipes.map((head) => (
        <li key={head.recordId}>
          <button type="button" aria-current={head.recordId === current?.recordId} onClick={() => onOpen(head)}>
            {head.content.name || 'Untitled'}
          </button>
        </li>
      ))}
    </ul>
  );
}
