import { useState } from 'react';
import type { RecipeHead } from '../api';
import { bodyMakeup, isBody, otherBasis } from '../body';
import type { Analysis, MaterialLibrary, RecipeContent, RecipeLine } from '../chemistry';
import { recipeDensity } from '../materialData';
import {
  ATMOSPHERES,
  BODY_CLASSES,
  FORMINGS,
  isFormed,
  matchesSearch,
  parseTags,
  RECIPE_ORDERS,
  sortRecipes,
  type RecipeOrder,
  RECIPE_TYPES,
  sameDetails,
  SURFACES,
  TRANSPARENCIES,
  WATER_BASES,
  type RecipeDetails,
  type WaterBasis
} from '../recipeFields';
import { isSlip, waterPer100 } from '../slip';
import type { Editor } from '../useEditor';
import { AnalysisPanel } from './AnalysisPanel';
import { DeletedList, DeletedNotice } from './Deleted';
import { CheckoutBar } from './CheckoutBar';
import { ForkNotice } from './ForkNotice';
import { RevisionHistory, ViewingNotice } from './RevisionHistory';

export const EMPTY_RECIPE: RecipeContent = { name: '', lines: [{ material: '', amount: '' }], notes: '' };

/** Compares by value: the core hands content back with its keys in another order. */
export function sameRecipe(a: RecipeContent, b: RecipeContent): boolean {
  return (
    a.name === b.name &&
    a.notes === b.notes &&
    sameDetails(a, b) &&
    a.lines.length === b.lines.length &&
    a.lines.every(
      (line, i) =>
        line.material === b.lines[i].material &&
        line.amount === b.lines[i].amount &&
        !!line.addition === !!b.lines[i].addition
    )
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
  onKeepVersion,
  onCompare,
  onCompareFork,
  readOnly = false,
  canCreate = true,
  groups,
  newIn,
  batchSheet,
  limits,
  withoutChemistry = false
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
  /** Ends a fork of the record shown by keeping one of its newest revisions (ADR 17). */
  onKeepVersion: (revisionId: string) => void;
  /** Opens Compare: from here when nothing is said, or with an earlier revision. Missing when
   * there is nothing to compare with. */
  onCompare?: (revisionNumber?: number) => void;
  /** Opens Compare with the version shown and another newest one of a fork. */
  onCompareFork?: (revisionId: string) => void;
  /** The person may read this recipe but not change it (a team's vault, ADR 12). */
  readOnly?: boolean;
  /** Whether the person may make recipes in any collection. */
  canCreate?: boolean;
  /** In a team's vault, the list in groups by collection. */
  groups?: { label: string; items: RecipeHead[] }[];
  /** For a new recipe in a team's vault, where it will be saved. */
  newIn?: React.ReactNode;
  /** Below the recipe: its batch sheet, in a team's vault. */
  batchSheet?: React.ReactNode;
  /** Below the unity formula: comparing it with a limit formula. */
  limits?: React.ReactNode;
  /** This person reads the recipe's collection without its chemistry: no lines, notes or
   * unity formula to show. */
  withoutChemistry?: boolean;
}) {
  const { current, draft, setDraft, changed, viewing } = editor;
  const shown = viewing?.content ?? draft;
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<RecipeOrder>(savedOrder);
  const found = (list: RecipeHead[]) => sortRecipes(list.filter((r) => matchesSearch(r.content, search)), order);
  const shownGroups = groups?.map((group) => ({ ...group, items: found(group.items) })).filter((g) => g.items.length);
  const shownRecipes = found(recipes);

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
        {recipes.length > 1 && (
          <div className="find">
            <input
              type="search"
              aria-label="Search recipes"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Sort by"
              value={order}
              onChange={(e) => {
                const next = e.target.value as RecipeOrder;
                setOrder(next);
                try {
                  localStorage.setItem(ORDER_KEY, next);
                } catch {
                  // Remembering the order is a convenience.
                }
              }}
            >
              {RECIPE_ORDERS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {recipes.length === 0 ? (
          <p className="hint">No recipes yet.</p>
        ) : !shownRecipes.length ? (
          <p className="hint">No recipe has {search.trim()}.</p>
        ) : shownGroups ? (
          shownGroups.map((group) => (
            <section key={group.label}>
              <h2 className="list-heading">{group.label}</h2>
              <RecipeList recipes={group.items} current={current} onOpen={onOpen} />
            </section>
          ))
        ) : (
          <RecipeList recipes={shownRecipes} current={current} onOpen={onOpen} />
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
        {current && !viewing && (
          <ForkNotice
            head={current}
            name={current.content.name}
            readOnly={readOnly}
            onKeep={onKeepVersion}
            onCompare={onCompareFork}
          />
        )}
        {current && !viewing && <CheckoutBar kind="recipe" record={current.recordId} readOnly={readOnly} />}
        {withoutChemistry && current ? (
          <p className="hint" role="status">
            You see this recipe’s name and details, and its firings, but not its materials, amounts or notes. An admin
            can change what you may do.
          </p>
        ) : (
          readOnly &&
          current &&
          !viewing && (
            <p className="hint" role="status">
              You can read this recipe, but not change it. An admin can change what you may do.
            </p>
          )
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
          <DetailsFields shown={shown} library={library} onChange={(change) => setDraft({ ...draft, ...change })} />
        </fieldset>
        {!withoutChemistry && (
          <fieldset className="plain" disabled={!!viewing || readOnly}>
            <table className="lines">
              <thead>
                <tr>
                  <th scope="col">Material</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col" title="On top of the base, which adds up to 100">
                    Added
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
                    <td className="added">
                      <input
                        type="checkbox"
                        aria-label={`Material ${index + 1} is an addition`}
                        checked={!!line.addition}
                        onChange={(e) => {
                          const { addition: _, ...rest } = line;
                          setLine(index, e.target.checked ? { ...rest, addition: true } : rest);
                        }}
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
        )}

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
        {batchSheet}
        {current && <RevisionHistory kind="recipe" current={current} viewing={viewing} onView={editor.setViewing} />}
      </main>

      {!withoutChemistry && (
        <aside className="analysis no-print" aria-label={isBody(shown.type) ? 'Chemistry' : 'Unity formula'}>
          <AnalysisPanel
            analysis={analysis}
            body={isBody(shown.type)}
            makeup={isBody(shown.type) ? bodyMakeup(shown.lines, library.own) : null}
            bodyClass={shown.bodyClass}
          />
          {limits}
        </aside>
      )}
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

const ORDER_KEY = 'glaze-vault.recipe-order';

function savedOrder(): RecipeOrder {
  try {
    const saved = localStorage.getItem(ORDER_KEY);
    if (RECIPE_ORDERS.some((o) => o.value === saved)) return saved as RecipeOrder;
  } catch {
    // Not available: the default.
  }
  return 'changed';
}

const choices = <Value extends string>(options: { value: Value; label: string }[]) => (
  <>
    <option value="">—</option>
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </>
);

/** A recipe's optional details: what it is, how it is fired, how it looks, tags, for a slip or
 * glaze the gravity and viscosity it is mixed to, and for a body its class, forming, targets and
 * water. */
function DetailsFields({
  shown,
  library,
  onChange
}: {
  shown: RecipeContent;
  library: MaterialLibrary;
  onChange: (change: Partial<RecipeDetails>) => void;
}) {
  // Tags are typed as text, so a comma can be typed before the next tag.
  const [tagText, setTagText] = useState(() => (shown.tags ?? []).join(', '));
  const tags = shown.tags ?? [];
  const typed = parseTags(tagText);
  const tagsShown =
    typed.length === tags.length && typed.every((tag, i) => tag === tags[i]) ? tagText : tags.join(', ');
  const mixed = !!shown.gravity || !!shown.viscosity || shown.type === 'glaze' || isSlip(shown.type);
  const solids = recipeDensity(shown.lines, library.own);
  const water = waterPer100(shown.gravity ?? '', solids.density);
  const formed =
    isFormed(shown.type) ||
    !!(shown.bodyClass || shown.forming || shown.absorptionMin || shown.absorptionMax) ||
    !!(shown.shrinkageMin || shown.shrinkageMax || shown.water);
  const otherWater = otherBasis(shown);
  /** A target's two ends, each optional. */
  const range = (id: string, label: string, min: 'absorptionMin' | 'shrinkageMin', max: 'absorptionMax' | 'shrinkageMax') => (
    <div className="detail wide">
      <span className="label" id={`${id}-label`}>
        {label}
      </span>
      <div className="row tight" role="group" aria-labelledby={`${id}-label`}>
        <input
          aria-label={`${label}, from`}
          inputMode="decimal"
          value={shown[min] ?? ''}
          onChange={(e) => onChange({ [min]: e.target.value || undefined })}
        />
        <span aria-hidden="true">to</span>
        <input
          aria-label={`${label}, to`}
          inputMode="decimal"
          value={shown[max] ?? ''}
          onChange={(e) => onChange({ [max]: e.target.value || undefined })}
        />
      </div>
    </div>
  );
  const select = <Value extends string>(
    id: string,
    label: string,
    options: { value: Value; label: string }[],
    value: Value | undefined,
    set: (value: Value | undefined) => void
  ) => (
    <div className="detail">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={(e) => set((e.target.value as Value) || undefined)}>
        {choices(options)}
      </select>
    </div>
  );
  return (
    <div className="details">
      {select('recipe-type', 'Type', RECIPE_TYPES, shown.type, (type) => onChange({ type }))}
      <div className="detail narrow">
        <label htmlFor="recipe-cone">Cone</label>
        <input
          id="recipe-cone"
          value={shown.cone ?? ''}
          placeholder="6, or 9-10"
          onChange={(e) => onChange({ cone: e.target.value || undefined })}
        />
      </div>
      {select('recipe-atmosphere', 'Atmosphere', ATMOSPHERES, shown.atmosphere, (atmosphere) =>
        onChange({ atmosphere })
      )}
      {select('recipe-surface', 'Surface', SURFACES, shown.surface, (surface) => onChange({ surface }))}
      {select('recipe-transparency', 'Transparency', TRANSPARENCIES, shown.transparency, (transparency) =>
        onChange({ transparency })
      )}
      <div className="detail">
        <label htmlFor="recipe-color">Color</label>
        <input
          id="recipe-color"
          value={shown.color ?? ''}
          onChange={(e) => onChange({ color: e.target.value || undefined })}
        />
      </div>
      <div className="detail wide">
        <label htmlFor="recipe-tags">Tags</label>
        <input
          id="recipe-tags"
          value={tagsShown}
          placeholder="Separated by commas"
          onChange={(e) => {
            setTagText(e.target.value);
            const next = parseTags(e.target.value);
            onChange({ tags: next.length ? next : undefined });
          }}
        />
      </div>
      {mixed && (
        <>
          <div className="detail narrow">
            <label htmlFor="recipe-gravity">Specific gravity</label>
            <input
              id="recipe-gravity"
              inputMode="decimal"
              value={shown.gravity ?? ''}
              placeholder="1.78"
              aria-describedby={water === null ? undefined : 'recipe-water'}
              onChange={(e) => onChange({ gravity: e.target.value || undefined })}
            />
            {water !== null && (
              <span id="recipe-water" className="hint">
                About {Math.round(water)} g water per 100 g dry ({Math.round((100 * water) / (100 + water))}% of the
                wet weight), with solids of {solids.density.toFixed(2)} g/cm³
                {solids.worked ? ' from its materials' : ''}
              </span>
            )}
          </div>
          <div className="detail narrow">
            <label htmlFor="recipe-viscosity">Ford cup #4, s</label>
            <input
              id="recipe-viscosity"
              inputMode="decimal"
              value={shown.viscosity ?? ''}
              onChange={(e) => onChange({ viscosity: e.target.value || undefined })}
            />
          </div>
        </>
      )}
      {formed && (
        <>
          {select('recipe-body-class', 'Body', BODY_CLASSES, shown.bodyClass, (bodyClass) => onChange({ bodyClass }))}
          {(shown.type !== 'casting slip' || shown.forming) &&
            select('recipe-forming', 'Forming', FORMINGS, shown.forming, (forming) => onChange({ forming }))}
          {range('recipe-absorption', 'Absorption aimed for, %', 'absorptionMin', 'absorptionMax')}
          {range('recipe-shrinkage', 'Total shrinkage aimed for, %', 'shrinkageMin', 'shrinkageMax')}
          <div className="detail wide">
            <label htmlFor="recipe-body-water">Water to make it workable</label>
            <div className="row tight">
              <input
                id="recipe-body-water"
                inputMode="decimal"
                value={shown.water ?? ''}
                aria-describedby={otherWater === null ? undefined : 'recipe-body-water-other'}
                onChange={(e) => onChange({ water: e.target.value || undefined })}
              />
              <select
                aria-label="What the water is a share of"
                value={shown.waterBasis ?? 'dry'}
                onChange={(e) => onChange({ waterBasis: e.target.value === 'wet' ? ('wet' as WaterBasis) : undefined })}
              >
                {WATER_BASES.map((basis) => (
                  <option key={basis.value} value={basis.value}>
                    {basis.label}
                  </option>
                ))}
              </select>
            </div>
            {otherWater !== null && (
              <span id="recipe-body-water-other" className="hint">
                {shown.waterBasis === 'wet'
                  ? `That is ${otherWater.toFixed(1)} g per 100 g dry`
                  : `That is ${otherWater.toFixed(1)}% of the wet clay`}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
