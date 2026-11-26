// The mix log (docs/adr/0016-mix-log.md): every batch mixed from the batch sheets and recipes this
// person can open, newest first, and one at a time to fill in: the lot of each material weighed
// and, for a slip, deflocculant and water added in steps, with readings as it ages.
import { useRef, useState } from 'react';
import type { Access, RecipeHead } from '../api';
import type { BatchSheet } from '../batch';
import { mixMatches, mixName, mixOf, mixSummary, newMix, sameMix, type Mix, type MixContent } from '../mix';
import { canEdit, editableCollections } from '../team';
import { PendingNotice } from './Fold';
import { MixEditor } from './MixEditor';

/** The mix open in the editor: the newest revision, if saved, and the edits to it. */
export interface MixEditing {
  current: Mix | null;
  draft: MixContent;
}

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
