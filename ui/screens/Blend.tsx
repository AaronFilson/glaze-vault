// A line blend between two recipes, step by step, with each step's chemistry, to save a step as a
// recipe of its own or print the weights for test batches.
import { useMemo, useState } from 'react';
import type { RecipeHead } from '../api';
import { usableLines } from '../batch';
import { blendName, blendSteps } from '../blend';
import { analyse, oxideLabel, OXIDES, type MaterialLibrary, type RecipeContent } from '../chemistry';

export function Blend({
  recipes,
  library,
  initial,
  canSave,
  onSave,
  onClose
}: {
  recipes: RecipeHead[];
  library: MaterialLibrary;
  /** The recipe the blend starts from. */
  initial: string | null;
  canSave: boolean;
  /** Saves a step as a new recipe; resolves once saved. */
  onSave: (content: RecipeContent) => Promise<void>;
  onClose: () => void;
}) {
  const [first, setFirst] = useState(initial ?? recipes[0]?.recordId ?? '');
  const [second, setSecond] = useState(() => recipes.find((r) => r.recordId !== (initial ?? recipes[0]?.recordId))?.recordId ?? '');
  const [steps, setSteps] = useState('5');
  const [testSize, setTestSize] = useState('100');
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState('');
  const a = recipes.find((r) => r.recordId === first);
  const b = recipes.find((r) => r.recordId === second);
  const count = Number(steps);
  const blend = useMemo(
    () => (a && b && count >= 2 ? blendSteps(a.content.lines, b.content.lines, count) : []),
    [a, b, count]
  );
  const analyses = useMemo(() => blend.map((step) => analyse(step.lines, library)), [blend, library]);
  const materials = blend[0]?.lines.map((line) => line.material) ?? [];
  const oxides = OXIDES.filter((oxide) => analyses.some((x) => (x?.result?.umf[oxide] ?? 0) > 0));
  const size = Number(testSize.replace(',', '.'));
  const names = blend.map((step) => blendName(a?.content.name ?? '', b?.content.name ?? '', step.first));

  const save = async (index: number) => {
    setError('');
    try {
      const lines = blend[index].lines.filter((line) => Number(line.amount) > 0);
      await onSave({ name: names[index], lines, notes: `A line blend of ${a?.content.name} and ${b?.content.name}.` });
      setSaved((list) => [...list, names[index]]);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const recipePicker = (id: string, label: string, value: string, set: (value: string) => void) => (
    <div className="detail">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => set(e.target.value)}>
        {recipes.map((r) => (
          <option key={r.recordId} value={r.recordId}>
            {r.content.name || 'Untitled'}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <main className="settings compare no-print">
        <div className="row">
          <h1>Line blend</h1>
          <button type="button" className="end" onClick={onClose}>
            Done
          </button>
        </div>
        <p className="hint">
          Two recipes mixed in steps, each counted as 100 parts, from all of the first to all of the second.
        </p>
        <div className="details">
          {recipePicker('blend-first', 'First recipe', first, setFirst)}
          {recipePicker('blend-second', 'Second recipe', second, setSecond)}
          <div className="detail narrow">
            <label htmlFor="blend-steps">Steps</label>
            <select id="blend-steps" value={steps} onChange={(e) => setSteps(e.target.value)}>
              {[3, 4, 5, 6, 7, 9, 11].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="detail narrow">
            <label htmlFor="blend-size">Each test, g</label>
            <input id="blend-size" inputMode="decimal" value={testSize} onChange={(e) => setTestSize(e.target.value)} />
          </div>
        </div>
        {!blend.length ? (
          <p className="hint">Choose two recipes.</p>
        ) : (
          <>
            <table className="compare-table blend">
              <caption>Parts of each material</caption>
              <thead>
                <tr>
                  <th scope="col">Material</th>
                  {blend.map((step, i) => (
                    <th key={i} scope="col" className="num">
                      {Math.round(step.first)} : {Math.round(100 - step.first)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {materials.map((material, row) => (
                  <tr key={material}>
                    <th scope="row">{material}</th>
                    {blend.map((step, i) => (
                      <td key={i} className="num">
                        {Number(step.lines[row].amount) ? step.lines[row].amount : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="compare-table blend">
              <caption>Unity formula</caption>
              <tbody>
                {oxides.map((oxide) => (
                  <tr key={oxide}>
                    <th scope="row">{oxideLabel(oxide)}</th>
                    {analyses.map((x, i) => (
                      <td key={i} className="num">
                        {x?.result ? x.result.umf[oxide].toFixed(3) : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="fact">
                  <th scope="row">SiO₂ : Al₂O₃</th>
                  {analyses.map((x, i) => (
                    <td key={i} className="num">
                      {x?.result?.siAlRatio?.toFixed(2) ?? '—'}
                    </td>
                  ))}
                </tr>
                <tr className="fact">
                  <th scope="row">Expansion</th>
                  {analyses.map((x, i) => (
                    <td key={i} className="num">
                      {x?.result?.expansion?.toFixed(2) ?? '—'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            {canSave && (
              <div className="row">
                {blend.map((step, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Save ${names[i]} as a recipe`}
                    disabled={saved.includes(names[i])}
                    onClick={() => void save(i)}
                  >
                    {saved.includes(names[i]) ? 'Saved' : `Save ${Math.round(step.first)} : ${Math.round(100 - step.first)}`}
                  </button>
                ))}
              </div>
            )}
            {saved.length > 0 && (
              <p className="hint" role="status">
                Saved as recipes: {saved.join(', ')}.
              </p>
            )}
            <div className="row">
              <button type="button" disabled={!(size > 0)} onClick={() => window.print()}>
                Print the weights…
              </button>
            </div>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </>
        )}
      </main>

      {blend.length > 0 && size > 0 && (
        <section className="print-only paper" aria-hidden="true">
          <p className="confidential">Confidential · Printed {new Date().toLocaleString()} from Glaze Vault</p>
          <h1>
            Line blend: {a?.content.name} and {b?.content.name}
          </h1>
          <p className="meta">Each test {size} g, weights in grams</p>
          <table className="paper-table">
            <thead>
              <tr>
                <th scope="col">Material</th>
                {blend.map((step, i) => (
                  <th key={i} scope="col" className="num">
                    {i + 1}: {Math.round(step.first)} : {Math.round(100 - step.first)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {materials.map((material, row) => (
                <tr key={material}>
                  <td>{material}</td>
                  {blend.map((step, i) => {
                    const total = usableLines(step.lines).reduce((sum, line) => sum + line.amount, 0);
                    const parts = Number(step.lines[row].amount);
                    return (
                      <td key={i} className="num">
                        {parts && total ? ((parts / total) * size).toFixed(1) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
