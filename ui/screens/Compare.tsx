import { useEffect, useMemo, useState } from 'react';
import { api, errorText, type RecipeHead } from '../api';
import { analyse, oxideLabel, type MaterialLibrary, type RecipeContent } from '../chemistry';
import { change, compareLines, compareUmf } from '../compare';
import { describeDetails } from '../recipeFields';

/** One side of a comparison: a recipe's newest revision, an earlier one by number, or the unsaved
 * changes in the editor. */
export type Side = { recordId: string; number: number | null } | { draft: true };

/** The editor's unsaved changes, to compare with what is saved. */
export interface Unsaved {
  recordId: string | null;
  content: RecipeContent;
}

const DRAFT = 'draft';

/** Two recipes, or two revisions of one, side by side: their batches and unity formulas. */
export function Compare({
  recipes,
  unsaved,
  library,
  initial,
  onClose
}: {
  recipes: RecipeHead[];
  unsaved: Unsaved | null;
  library: MaterialLibrary;
  initial: [Side, Side];
  onClose: () => void;
}) {
  const [sides, setSides] = useState<[Side, Side]>(initial);
  // Each record's revisions, loaded when a side needs them.
  const [histories, setHistories] = useState<Record<string, RecipeHead[]>>({});
  const [error, setError] = useState('');

  const needed = sides.flatMap((side) => ('recordId' in side ? [side.recordId] : []));
  useEffect(() => {
    for (const recordId of needed) {
      if (histories[recordId]) continue;
      api
        .history<RecipeContent>('recipe', recordId)
        .then((all) => setHistories((loaded) => ({ ...loaded, [recordId]: all })))
        .catch((e) => setError(errorText(e)));
    }
  }, [needed.join(), histories]);

  const contentOf = (side: Side): RecipeContent | null => {
    if (!('recordId' in side)) return unsaved?.content ?? null;
    const head = recipes.find((r) => r.recordId === side.recordId);
    if (side.number === null || side.number === head?.number) return head?.content ?? null;
    return histories[side.recordId]?.find((r) => r.number === side.number)?.content ?? null;
  };
  const titleOf = (side: Side): string => {
    if (!('recordId' in side)) return 'Unsaved changes';
    const name = recipes.find((r) => r.recordId === side.recordId)?.content.name || 'Untitled';
    return side.number === null ? name : `${name}, revision ${side.number}`;
  };

  const [a, b] = sides.map(contentOf);
  const lines = a && b ? compareLines(a.lines, b.lines) : [];
  const analysisA = useMemo(() => a && analyse(a.lines, library), [a, library]);
  const analysisB = useMemo(() => b && analyse(b.lines, library), [b, library]);
  const resultA = analysisA?.result;
  const resultB = analysisB?.result;
  const oxides = compareUmf(resultA, resultB);

  const setSide = (index: 0 | 1, side: Side) =>
    setSides((now) => (index === 0 ? [side, now[1]] : [now[0], side]));

  return (
    <main className="settings compare">
      <div className="settings-head">
        <h1>Compare</h1>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="compare-sides">
        {([0, 1] as const).map((index) => (
          <SidePicker
            key={index}
            label={index === 0 ? 'First' : 'Second'}
            side={sides[index]}
            recipes={recipes}
            unsaved={unsaved}
            history={'recordId' in sides[index] ? histories[sides[index].recordId] : undefined}
            onChange={(side) => setSide(index, side)}
          />
        ))}
      </div>
      {error && <p className="error">{error}</p>}

      {a && b && (
        <>
          <table className="compare-table">
            <caption>Batch, percent of each</caption>
            <thead>
              <tr>
                <th scope="col">Material</th>
                <th scope="col" className="num">
                  {titleOf(sides[0])}
                </th>
                <th scope="col" className="num">
                  {titleOf(sides[1])}
                </th>
                <th scope="col" className="num">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.material}>
                  <th scope="row">{line.addition ? `+ ${line.material} (addition)` : line.material}</th>
                  <td className="num">{line.a === null ? '—' : line.a.toFixed(1)}</td>
                  <td className="num">{line.b === null ? '—' : line.b.toFixed(1)}</td>
                  <td className="num change">{change(line.a, line.b, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="compare-table">
            <caption>Unity formula</caption>
            <thead>
              <tr>
                <th scope="col">Oxide</th>
                <th scope="col" className="num">
                  {titleOf(sides[0])}
                </th>
                <th scope="col" className="num">
                  {titleOf(sides[1])}
                </th>
                <th scope="col" className="num">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {oxides.map(({ oxide, a: x, b: y }) => (
                <tr key={oxide}>
                  <th scope="row">{oxideLabel(oxide)}</th>
                  <td className="num">{resultA ? x.toFixed(3) : '—'}</td>
                  <td className="num">{resultB ? y.toFixed(3) : '—'}</td>
                  <td className="num change">{resultA && resultB ? change(x, y, 3) : ''}</td>
                </tr>
              ))}
              <Fact label="SiO₂ : Al₂O₃" a={resultA?.siAlRatio} b={resultB?.siAlRatio} places={2} />
              <Fact label="Expansion, × 10⁻⁶/°C" a={resultA?.expansion} b={resultB?.expansion} places={2} />
              <Fact label="Loss on ignition, %" a={resultA?.loi} b={resultB?.loi} places={1} />
            </tbody>
          </table>
          {[analysisA, analysisB].map(
            (analysis, i) =>
              analysis?.problem && (
                <p key={i} className="error">
                  {titleOf(sides[i])}: {analysis.problem}
                </p>
              )
          )}

          {detailsText(a) !== detailsText(b) && (
            <div className="compare-notes">
              <h2>Details</h2>
              {[a, b].map((content, i) => (
                <div key={i}>
                  <h3>{titleOf(sides[i])}</h3>
                  <p className="pre">{detailsText(content) || '—'}</p>
                </div>
              ))}
            </div>
          )}

          {a.notes.trim() !== b.notes.trim() && (
            <div className="compare-notes">
              <h2>Notes</h2>
              {[a, b].map((content, i) => (
                <div key={i}>
                  <h3>{titleOf(sides[i])}</h3>
                  <p className="pre">{content.notes.trim() || '—'}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

/** A recipe's details and tags, as Compare shows them. */
function detailsText(content: RecipeContent): string {
  return [describeDetails(content), content.tags?.length ? `Tags: ${content.tags.join(', ')}` : '']
    .filter(Boolean)
    .join('\n');
}

function Fact({ label, a, b, places }: { label: string; a?: number | null; b?: number | null; places: number }) {
  if (a == null && b == null) return null;
  return (
    <tr className="fact">
      <th scope="row">{label}</th>
      <td className="num">{a == null ? '—' : a.toFixed(places)}</td>
      <td className="num">{b == null ? '—' : b.toFixed(places)}</td>
      <td className="num change">{a == null || b == null ? '' : change(a, b, places)}</td>
    </tr>
  );
}

/** Chooses a recipe and one of its revisions, or the unsaved changes. */
function SidePicker({
  label,
  side,
  recipes,
  unsaved,
  history,
  onChange
}: {
  label: string;
  side: Side;
  recipes: RecipeHead[];
  unsaved: Unsaved | null;
  history: RecipeHead[] | undefined;
  onChange: (side: Side) => void;
}) {
  const id = label.toLowerCase();
  const head = 'recordId' in side ? recipes.find((r) => r.recordId === side.recordId) : undefined;
  return (
    <fieldset className="compare-side">
      <legend>{label}</legend>
      <label htmlFor={`${id}-recipe`}>Recipe</label>
      <select
        id={`${id}-recipe`}
        value={'recordId' in side ? side.recordId : DRAFT}
        onChange={(e) =>
          onChange(e.target.value === DRAFT ? { draft: true } : { recordId: e.target.value, number: null })
        }
      >
        {unsaved && (
          <option value={DRAFT}>Unsaved changes to {unsaved.content.name.trim() || 'Untitled'}</option>
        )}
        {recipes.map((recipe) => (
          <option key={recipe.recordId} value={recipe.recordId}>
            {recipe.content.name || 'Untitled'}
          </option>
        ))}
      </select>
      {'recordId' in side && head && head.number > 1 && (
        <>
          <label htmlFor={`${id}-revision`}>Revision</label>
          <select
            id={`${id}-revision`}
            value={side.number ?? ''}
            onChange={(e) =>
              onChange({ recordId: side.recordId, number: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">Newest (revision {head.number})</option>
            {(history ?? [])
              .filter((r) => r.number !== head.number)
              .map((r) => (
                <option key={r.revisionId} value={r.number}>
                  Revision {r.number} · {new Date(r.savedAt).toLocaleDateString()}
                </option>
              ))}
          </select>
        </>
      )}
    </fieldset>
  );
}
