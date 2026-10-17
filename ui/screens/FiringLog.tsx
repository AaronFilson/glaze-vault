// The firing log (docs/adr/0014-firing-log-and-photos.md): every firing of the recipes this person
// can open, newest first, and one at a time to fill in, with a test bar's readings and photos.
import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Access, type RecipeHead } from '../api';
import {
  barResults,
  EMPTY_BAR,
  firingMatches,
  firingSummary,
  FLAWS,
  hasReadings,
  newFiring,
  sameFiring,
  tidyFiring,
  vitrification,
  type BarReadings,
  type Firing,
  type FiringContent,
  type Photo
} from '../firing';
import { PhotoError, smallerPhoto } from '../photos';
import { ATMOSPHERES, SURFACES, TRANSPARENCIES } from '../recipeFields';
import { EMPTY_SLIP, hasSlipReadings, isSlip, type SlipReadings } from '../slip';
import { canEdit, editableCollections } from '../team';
import { ConfirmNotice } from './Deleted';
import { VitrificationChart } from './VitrificationChart';

/** The firing open in the editor: the newest revision, if saved, and the edits to it. */
export interface FiringEditing {
  current: Firing | null;
  draft: FiringContent;
}

const BAR_FIELDS: { key: keyof BarReadings; label: string }[] = [
  { key: 'mark', label: 'Length between marks, mm' },
  { key: 'dry', label: 'Dry length, mm' },
  { key: 'fired', label: 'Fired length, mm' },
  { key: 'firedWeight', label: 'Fired weight, g' },
  { key: 'soakedWeight', label: 'Weight after soaking, g' },
  { key: 'suspendedWeight', label: 'Weight in water, g' }
];

const BODY_TYPES = ['clay body', 'slip', 'engobe', 'casting slip', 'terra sigillata'];

const SLIP_FIELDS: { key: keyof SlipReadings; label: string; target?: 'gravity' | 'viscosity'; decimal?: boolean }[] = [
  { key: 'gravity', label: 'Specific gravity', target: 'gravity', decimal: true },
  { key: 'viscosity', label: 'Ford cup #4, s', target: 'viscosity', decimal: true },
  { key: 'gel', label: 'Gel' }
];

export function FiringLog({
  firings,
  recipes,
  access,
  editing,
  onEdit,
  forRecipe,
  onForRecipe,
  onSaved,
  onErased
}: {
  firings: Firing[];
  recipes: RecipeHead[];
  access: Access | null;
  editing: FiringEditing | null;
  onEdit: (editing: FiringEditing | null) => void;
  /** Only this recipe's firings, when one is chosen. */
  forRecipe: string | null;
  onForRecipe: (recordId: string | null) => void;
  onSaved: (saved: Firing) => void;
  onErased: (recordId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<(() => void) | null>(null);
  // The open editor's save, for the notice that asks before leaving unsaved changes.
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  const changed = !!editing && (!editing.current || !sameFiring(editing.current.content, editing.draft));
  const filterName = forRecipe && (recipes.find((r) => r.recordId === forRecipe)?.content.name || 'Untitled');
  const shown = firings
    .filter((f) => !forRecipe || f.content.recipe === forRecipe)
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
            Firings of {filterName}.{' '}
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
                  <span className="hint list-note"> {firingSummary(firing.content)}</span>
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
            recipes={recipes}
            access={access}
            onEdit={onEdit}
            onSaved={onSaved}
            onErased={onErased}
            registerSave={(save) => (saveRef.current = save)}
          />
        ) : (
          <>
            {curve.length >= 2 && <VitrificationChart points={curve} />}
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

function PendingNotice({
  name,
  onSave,
  onDiscard,
  onStay
}: {
  name: string;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  return (
    <div className="notice warning" role="alertdialog" aria-label="Unsaved firing">
      <p>
        <strong>{name}</strong> has changes that are not saved.
      </p>
      <div className="row">
        <button
          type="button"
          className="primary"
          autoFocus
          onClick={onSave}
        >
          Save
        </button>
        <button type="button" onClick={onDiscard}>
          Discard changes
        </button>
        <button type="button" onClick={onStay}>
          Keep editing
        </button>
      </div>
    </div>
  );
}

function FiringEditor({
  editing,
  changed,
  recipes,
  access,
  onEdit,
  onSaved,
  onErased,
  registerSave
}: {
  editing: FiringEditing;
  changed: boolean;
  recipes: RecipeHead[];
  access: Access | null;
  onEdit: (editing: FiringEditing | null) => void;
  onSaved: (saved: Firing) => void;
  onErased: (recordId: string) => void;
  registerSave: (save: () => Promise<boolean>) => void;
}) {
  const { current, draft } = editing;
  const [saving, setSaving] = useState(false);
  const [addingPhoto, setAddingPhoto] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const recipe = recipes.find((r) => r.recordId === draft.recipe) ?? null;
  const collection = current?.collectionId ?? recipe?.collectionId ?? null;
  const readOnly = !canEdit(access, collection, 'firing');
  const set = (change: Partial<FiringContent>) => onEdit({ current, draft: { ...draft, ...change } });
  const bar = draft.bar ?? EMPTY_BAR;
  const slip = draft.slip ?? EMPTY_SLIP;
  const results = barResults(draft.bar);
  const urls = usePhotoUrls(draft.photos);

  const save = async (content = draft): Promise<Firing | null> => {
    if (!content.recipe) {
      setError('Choose the recipe that was fired.');
      return null;
    }
    setSaving(true);
    setError('');
    try {
      const tidy = tidyFiring(content);
      const saved = current
        ? await api.saveRecord<FiringContent>('firing', current.revisionId, tidy)
        : await api.saveRecord<FiringContent>('firing', null, tidy, recipe?.collectionId ?? null);
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

  const addPhoto = async () => {
    setAddingPhoto(true);
    setError('');
    try {
      const chosen = await api.choosePhoto();
      if (!chosen.length) return;
      const photo = await smallerPhoto(chosen);
      // A photo belongs to a saved firing, so a new one, or one with changes, is saved first.
      const saved = current && !changed ? current : await save();
      if (!saved) return;
      const attachment = await api.addAttachment('firing', saved.recordId, photo.mediaType, photo.bytes);
      const photos: Photo[] = [...saved.content.photos, { id: attachment.id, mediaType: photo.mediaType, caption: '' }];
      const next = await api.saveRecord<FiringContent>('firing', saved.revisionId, tidyFiring({ ...saved.content, photos }));
      onSaved(next);
      onEdit({ current: next, draft: next.content });
    } catch (e) {
      setError(e instanceof PhotoError ? e.message : errorText(e));
    } finally {
      setAddingPhoto(false);
    }
  };

  const remove = async () => {
    setConfirming(false);
    try {
      const gone = await api.deleteRecord('firing', current!.revisionId);
      await api.eraseRecord('firing', gone.recordId);
      onErased(gone.recordId);
      onEdit(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const select = <Value extends string>(
    id: string,
    label: string,
    options: { value: Value; label: string }[],
    value: Value | undefined,
    onChange: (value: Value | undefined) => void
  ) => (
    <div className="detail">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange((e.target.value as Value) || undefined)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
  const text = (id: string, label: string, value: string | undefined, onChange: (value: string) => void, wide = false) => (
    <div className={`detail${wide ? ' wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
  const percent = (value?: number) => (value === undefined ? '—' : `${value.toFixed(1)}%`);

  return (
    <>
      {readOnly && current && (
        <p className="hint" role="status">
          You can read this firing, but not change it.
        </p>
      )}
      <fieldset className="plain" disabled={readOnly}>
        <h1>{draft.recipeName || 'New firing'}</h1>
        {current ? (
          <p className="hint">
            Revision {draft.recipeNumber} of the recipe
            {recipe && draft.recipeNumber !== null && recipe.number > draft.recipeNumber
              ? `; it is at revision ${recipe.number} now.`
              : '.'}
          </p>
        ) : (
          <div className="detail">
            <label htmlFor="firing-recipe">Recipe</label>
            <select
              id="firing-recipe"
              value={draft.recipe ?? ''}
              onChange={(e) => {
                const head = recipes.find((r) => r.recordId === e.target.value);
                set({
                  recipe: head?.recordId ?? null,
                  recipeNumber: head?.number ?? null,
                  recipeName: head?.content.name ?? ''
                });
              }}
            >
              <option value="">Choose a recipe</option>
              {recipes
                .filter((r) => canEdit(access, r.collectionId, 'firing'))
                .map((r) => (
                  <option key={r.recordId} value={r.recordId}>
                    {r.content.name || 'Untitled'}
                  </option>
                ))}
            </select>
          </div>
        )}

        <h2 className="section-heading">Firing</h2>
        <div className="details">
          <div className="detail">
            <label htmlFor="firing-date">Fired on</label>
            <input id="firing-date" type="date" value={draft.firedOn} onChange={(e) => set({ firedOn: e.target.value })} />
          </div>
          {text('firing-cone', 'Cone', draft.cone, (cone) => set({ cone }))}
          {select('firing-atmosphere', 'Atmosphere', ATMOSPHERES, draft.atmosphere, (atmosphere) => set({ atmosphere }))}
          {text('firing-kiln', 'Kiln', draft.kiln, (kiln) => set({ kiln }))}
          <div className="detail">
            <label htmlFor="firing-peak">Peak temperature</label>
            <div className="row tight">
              <input id="firing-peak" inputMode="decimal" value={draft.peak ?? ''} onChange={(e) => set({ peak: e.target.value })} />
              <select
                aria-label="Temperature unit"
                value={draft.peakUnit ?? 'C'}
                onChange={(e) => set({ peakUnit: e.target.value as 'C' | 'F' })}
              >
                <option value="C">°C</option>
                <option value="F">°F</option>
              </select>
            </div>
          </div>
          {text('firing-schedule', 'Schedule', draft.schedule, (schedule) => set({ schedule }), true)}
        </div>

        <h2 className="section-heading">Result</h2>
        <div className="details">
          {select('firing-surface', 'Surface', SURFACES, draft.surface, (surface) => set({ surface }))}
          {select('firing-transparency', 'Transparency', TRANSPARENCIES, draft.transparency, (transparency) =>
            set({ transparency })
          )}
          {text('firing-color', 'Color', draft.color, (color) => set({ color }), true)}
        </div>
        <fieldset className="flaws">
          <legend>Flaws</legend>
          {FLAWS.map((flaw) => (
            <label key={flaw.value} className="check">
              <input
                type="checkbox"
                checked={draft.flaws?.includes(flaw.value) ?? false}
                onChange={(e) =>
                  set({
                    flaws: e.target.checked
                      ? [...(draft.flaws ?? []), flaw.value]
                      : (draft.flaws ?? []).filter((f) => f !== flaw.value)
                  })
                }
              />
              {flaw.label}
            </label>
          ))}
        </fieldset>

        <details className="bar" open={hasReadings(draft.bar) || BODY_TYPES.includes(recipe?.content.type ?? '')}>
          <summary>Test bar</summary>
          <p className="hint">
            Mark a plastic bar, then measure it dry and fired. Weigh it fired, after soaking in water, and, for porosity
            and density, hanging in water.
          </p>
          <div className="details">
            {BAR_FIELDS.map(({ key, label }) => (
              <div className="detail" key={key}>
                <label htmlFor={`bar-${key}`}>{label}</label>
                <input
                  id={`bar-${key}`}
                  inputMode="decimal"
                  value={bar[key]}
                  onChange={(e) => set({ bar: { ...bar, [key]: e.target.value } })}
                />
              </div>
            ))}
          </div>
          <table className="facts" aria-label="Test bar results">
            <tbody>
              <tr>
                <th scope="row">Drying shrinkage</th>
                <td className="num">{percent(results.dryingShrinkage)}</td>
              </tr>
              <tr>
                <th scope="row">Firing shrinkage</th>
                <td className="num">{percent(results.firingShrinkage)}</td>
              </tr>
              <tr>
                <th scope="row">Total shrinkage</th>
                <td className="num">{percent(results.totalShrinkage)}</td>
              </tr>
              <tr>
                <th scope="row">Absorption</th>
                <td className="num">{percent(results.absorption)}</td>
              </tr>
              <tr>
                <th scope="row">Porosity</th>
                <td className="num">{percent(results.porosity)}</td>
              </tr>
              <tr>
                <th scope="row">Bulk density</th>
                <td className="num">{results.density === undefined ? '—' : `${results.density.toFixed(2)} g/cm³`}</td>
              </tr>
            </tbody>
          </table>
        </details>

        <details
          className="bar"
          open={
            hasSlipReadings(draft.slip) ||
            isSlip(recipe?.content.type) ||
            !!recipe?.content.gravity ||
            !!recipe?.content.viscosity
          }
        >
          <summary>Slip or glaze as applied</summary>
          <p className="hint">Its specific gravity and how long it takes through a Ford cup, measured before applying.</p>
          <div className="details">
            {SLIP_FIELDS.map(({ key, label, target, decimal }) => {
              const aim = target && recipe?.content[target];
              return (
                <div className={`detail${key === 'gel' ? ' wide' : ''}`} key={key}>
                  <label htmlFor={`slip-${key}`}>{label}</label>
                  <input
                    id={`slip-${key}`}
                    inputMode={decimal ? 'decimal' : undefined}
                    placeholder={key === 'gel' ? 'None, or slight after an hour' : undefined}
                    value={slip[key]}
                    aria-describedby={aim ? `slip-${key}-target` : undefined}
                    onChange={(e) => set({ slip: { ...slip, [key]: e.target.value } })}
                  />
                  {aim && (
                    <span id={`slip-${key}-target`} className="hint">
                      The recipe aims for {aim}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </details>

        <label htmlFor="firing-notes">Notes</label>
        <textarea id="firing-notes" rows={4} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />

        <h2 className="section-heading">Photos</h2>
        {draft.photos.length > 0 && (
          <div className="photos">
            {draft.photos.map((photo, i) => (
              <figure key={photo.id}>
                {urls[photo.id] ? (
                  <img src={urls[photo.id]} alt={photo.caption || `Photo ${i + 1}`} />
                ) : (
                  <div className="photo-loading">Opening…</div>
                )}
                <figcaption>
                  <input
                    aria-label={`Caption for photo ${i + 1}`}
                    placeholder="What it shows"
                    value={photo.caption}
                    onChange={(e) =>
                      set({ photos: draft.photos.map((p) => (p.id === photo.id ? { ...p, caption: e.target.value } : p)) })
                    }
                  />
                  <button
                    type="button"
                    className="link danger"
                    aria-label={`Remove photo ${i + 1}`}
                    onClick={() => set({ photos: draft.photos.filter((p) => p.id !== photo.id) })}
                  >
                    Remove
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        <button type="button" disabled={addingPhoto || saving} onClick={() => void addPhoto()}>
          {addingPhoto ? 'Adding the photo…' : 'Add photo…'}
        </button>
      </fieldset>

      {confirming && (
        <ConfirmNotice confirm="Delete" onConfirm={() => void remove()} onCancel={() => setConfirming(false)}>
          <p>
            <strong>Delete this firing of {draft.recipeName || 'Untitled'}?</strong> It and its photos are removed for
            good. Backups made before now still have them.
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
    </>
  );
}

/** Pictures for the photos, opened from the vault as they are needed and let go when done. */
function usePhotoUrls(photos: Photo[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  // Each photo's picture once opened; a photo being opened has none yet.
  const made = useRef<Record<string, string | null>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const url of Object.values(made.current)) if (url) URL.revokeObjectURL(url);
      made.current = {};
    };
  }, []);
  useEffect(() => {
    for (const photo of photos) {
      if (photo.id in made.current) continue;
      made.current[photo.id] = null;
      api
        .attachment(photo.id)
        .then((buffer) => {
          if (!mounted.current) return;
          const url = URL.createObjectURL(new Blob([buffer], { type: photo.mediaType }));
          made.current[photo.id] = url;
          setUrls((now) => ({ ...now, [photo.id]: url }));
        })
        .catch(() => delete made.current[photo.id]);
    }
  }, [photos.map((p) => p.id).join()]);
  return urls;
}
