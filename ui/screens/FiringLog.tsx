// The firing log (docs/adr/0014-firing-log-and-photos.md): every firing of the recipes this person
// can open, newest first, and one at a time to fill in, with a test bar's readings and photos.
import { useRef, useState } from 'react';
import type { Access, RecipeHead } from '../api';
import {
  firingMatches,
  firingOf,
  firingSummary,
  fitSummary,
  newFiring,
  sameFiring,
  targetsOf,
  vitrification,
  type Firing,
  type FiringContent
} from '../firing';
import type { Mix } from '../mix';
import { isFormed } from '../recipeFields';
import { canEdit, editableCollections } from '../team';
import { FiringEditor } from './FiringEditor';
import { Fold, PendingNotice } from './Fold';
import { VitrificationChart } from './VitrificationChart';

export { Fold, PendingNotice };

/** The firing open in the editor: the newest revision, if saved, and the edits to it. */
export interface FiringEditing {
  current: Firing | null;
  draft: FiringContent;
}

export function FiringLog({
  firings,
  mixes,
  recipes,
  access,
  editing,
  onEdit,
  forRecipe,
  onForRecipe,
  onSaved,
  onErased,
  phone = false
}: {
  firings: Firing[];
  /** For a firing's lots: the mixes of the revision fired. */
  mixes: Mix[];
  recipes: RecipeHead[];
  access: Access | null;
  editing: FiringEditing | null;
  onEdit: (editing: FiringEditing | null) => void;
  /** Only this recipe's firings, when one is chosen. */
  forRecipe: string | null;
  onForRecipe: (recordId: string | null) => void;
  onSaved: (saved: Firing) => void;
  onErased: (recordId: string) => void;
  /** A phone takes photos with its camera, and chooses them in the page (ADR 32). */
  phone?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<(() => void) | null>(null);
  // The open editor's save, for the notice that asks before leaving unsaved changes.
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  const changed = !!editing && (!editing.current || !sameFiring(editing.current.content, editing.draft));
  const filtered = forRecipe ? (recipes.find((r) => r.recordId === forRecipe) ?? null) : null;
  const filterName = forRecipe && (filtered?.content.name || 'Untitled');
  const shown = firings
    .filter((f) => !forRecipe || firingOf(f.content, forRecipe))
    .filter((f) => firingMatches(f.content, search))
    .sort((a, b) => b.content.firedOn.localeCompare(a.content.firedOn) || b.savedAt - a.savedAt);
  const team = !!access?.team;
  const mayLog = !team || editableCollections(access, 'firing').length > 0;
  // A recipe's firings at two cones or more make a curve.
  const curve = forRecipe ? vitrification(firings.filter((f) => f.content.recipe === forRecipe)) : [];

  /** Runs `action` now, or once unsaved changes are saved or discarded. */
  const leave = (action: () => void) => (changed ? setPending(() => action) : action());
  const startNew = () =>
    leave(() => {
      const recipe = recipes.find((r) => r.recordId === forRecipe && canEdit(access, r.collectionId, 'firing'));
      onEdit({
        current: null,
        draft: newFiring(recipe ? { recordId: recipe.recordId, number: recipe.number, name: recipe.content.name } : null, new Date())
      });
    });

  return (
    <>
      <nav className="sidebar no-print" aria-label="Firings">
        {mayLog && (
          <button type="button" className="primary" onClick={startNew}>
            Log a firing
          </button>
        )}
        {filterName && (
          <p className="hint">
            Firings of {filterName}
            {isFormed(filtered?.content.type) ? ', and of glazes fired on it' : ''}.{' '}
            <button type="button" className="link" onClick={() => onForRecipe(null)}>
              Show all
            </button>
          </p>
        )}
        {firings.length > 1 && (
          <div className="find">
            <input
              type="search"
              aria-label="Search firings"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
        {shown.length === 0 ? (
          <p className="hint">{firings.length ? 'No firings here.' : 'No firings logged yet.'}</p>
        ) : (
          <ul className="list">
            {shown.map((firing) => (
              <li key={firing.recordId}>
                <button
                  type="button"
                  aria-current={firing.recordId === editing?.current?.recordId}
                  onClick={() => leave(() => onEdit({ current: firing, draft: firing.content }))}
                >
                  {firing.content.recipeName || 'Untitled'}
                  <span className="hint list-note">
                    {' '}
                    {[
                      firingSummary(firing.content),
                      firing.content.body && `on ${firing.content.body.name}`,
                      fitSummary(firing.content.fit)
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <main className="editor no-print">
        {pending && (
          <PendingNotice
            name={editing?.draft.recipeName || 'This firing'}
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
          <FiringEditor
            key={editing.current?.recordId ?? 'new'}
            editing={editing}
            changed={changed}
            mixes={mixes}
            recipes={recipes}
            access={access}
            onEdit={onEdit}
            onSaved={onSaved}
            onErased={onErased}
            phone={phone}
            registerSave={(save) => (saveRef.current = save)}
          />
        ) : (
          <>
            {curve.length >= 2 && (
              <VitrificationChart points={curve} targets={filtered ? targetsOf(filtered.content) : null} />
            )}
            <p className="hint">
              {mayLog
                ? 'Log a firing to keep how a recipe was fired, what came out, a test bar’s measurements and photos.'
                : 'Choose a firing to read.'}
            </p>
          </>
        )}
      </main>
    </>
  );
}
