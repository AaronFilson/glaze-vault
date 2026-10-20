// Blends, with each step's chemistry, to save a step as a recipe of its own or print the weights
// for test batches: a line blend between two recipes, step by step, or a triaxial of three, over a
// triangle of points. A blend of bodies shows each step as a body: oxide percentages, a formula
// with alumina as one, and what is plastic. Bar labels for the tests, one at each cone, go with
// the bars to the kiln.
import { useEffect, useMemo, useState } from 'react';
import type { RecipeHead } from '../api';
import { baseOf, usableLines } from '../batch';
import { bodyChemistry, bodyMakeup, isBody } from '../body';
import {
  barLabels,
  blendName,
  blendSteps,
  parseCones,
  RECIPE_LETTERS,
  shareText,
  triaxialSteps,
  type BlendStep
} from '../blend';
import { amountOf, analyse, oxideLabel, OXIDES, type MaterialLibrary, type RecipeContent } from '../chemistry';

type Mode = 'line' | 'triaxial';
/** What goes on paper: the weights of each test, or a label for each test bar. */
type Paper = 'weights' | 'labels';

export function Blend({
  recipes,
  library,
  initial,
  canSave,
  canPrint = () => true,
  onSave,
  onClose
}: {
  recipes: RecipeHead[];
  library: MaterialLibrary;
  /** The recipe the blend starts from. */
  initial: string | null;
  canSave: boolean;
  /** Whether the weights of a blend of these recipes may be printed. */
  canPrint?: (recordIds: string[]) => boolean;
  /** Saves a step as a new recipe; resolves once saved. */
  onSave: (content: RecipeContent) => Promise<void>;
  onClose: () => void;
}) {
  const start = initial ?? recipes[0]?.recordId ?? '';
  const others = recipes.filter((r) => r.recordId !== start).map((r) => r.recordId);
  const [mode, setMode] = useState<Mode>('line');
  const [first, setFirst] = useState(start);
  const [second, setSecond] = useState(others[0] ?? '');
  const [third, setThird] = useState(others[1] ?? '');
  const [steps, setSteps] = useState('5');
  const [divisions, setDivisions] = useState('4');
  const [testSize, setTestSize] = useState('100');
  const [saved, setSaved] = useState<string[]>([]);
  const [labelName, setLabelName] = useState('');
  const [cones, setCones] = useState('');
  const [paper, setPaper] = useState<Paper>('weights');
  // Printed once the paper asked for is on the page.
  const [printRequest, setPrintRequest] = useState(0);
  useEffect(() => {
    if (printRequest) window.print();
  }, [printRequest]);
  const [error, setError] = useState('');
  const picked = (mode === 'line' ? [first, second] : [first, second, third]).map((id) =>
    recipes.find((r) => r.recordId === id)
  );
  // Each recipe once: a blend of a recipe with itself shows nothing.
  const ready = picked.every(Boolean) && new Set(picked).size === picked.length;
  const [a, b, c] = picked;
  const recipeNames = picked.map((r) => r?.content.name ?? '');
  const blend = useMemo<BlendStep[]>(() => {
    if (!a || !b) return [];
    if (mode === 'line') return blendSteps(a.content.lines, b.content.lines, Number(steps));
    return c ? triaxialSteps(a.content.lines, b.content.lines, c.content.lines, Number(divisions)) : [];
  }, [a, b, c, mode, steps, divisions]);
  const analyses = useMemo(() => blend.map((step) => analyse(step.lines, library)), [blend, library]);
  const materials = blend[0]?.lines.map((line) => line.material) ?? [];
  const additions = blend[0]?.lines.some((line) => line.addition) ?? false;
  const oxides = OXIDES.filter((oxide) => analyses.some((x) => (x?.result?.umf[oxide] ?? 0) > 0));
  // Bodies blended with bodies are read as bodies, and a step saved from them is one too.
  const bodies = ready && picked.every((r) => isBody(r?.content.type));
  const type = bodies && new Set(picked.map((r) => r?.content.type)).size === 1 ? a?.content.type : undefined;
  const size = amountOf(testSize);
  const names = blend.map((step) => blendName(recipeNames, step.shares));
  /** A step as its column shows it: "75 : 25" in a line blend, its number in a triaxial. */
  const label = (step: BlendStep, i: number) =>
    mode === 'line' ? step.shares.map((s) => String(Math.round(s))).join(' : ') : String(i + 1);
  const title = mode === 'line' ? 'Line blend' : 'Triaxial blend';
  const of =
    mode === 'line'
      ? `${recipeNames[0]} and ${recipeNames[1]}`
      : `${recipeNames[0]}, ${recipeNames[1]} and ${recipeNames[2]}`;

  const labels = barLabels(blend, parseCones(cones));
  const key = recipeNames.map((name, i) => `${RECIPE_LETTERS[i]}: ${name || 'Untitled'}`).join(' · ');
  const printPaper = (which: Paper) => {
    setPaper(which);
    setPrintRequest((n) => n + 1);
  };

  const save = async (index: number) => {
    setError('');
    try {
      const lines = blend[index].lines.filter((line) => Number(line.amount) > 0);
      await onSave({ name: names[index], lines, notes: `A ${title.toLowerCase()} of ${of}.`, ...(type ? { type } : {}) });
      setSaved((list) => [...list, names[index]]);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const recipePicker = (id: string, text: string, value: string, set: (value: string) => void) => (
    <div className="detail">
      <label htmlFor={id}>{text}</label>
      <select id={id} value={value} onChange={(e) => set(e.target.value)}>
        {recipes.map((r) => (
          <option key={r.recordId} value={r.recordId}>
            {r.content.name || 'Untitled'}
          </option>
        ))}
      </select>
    </div>
  );

  const header = (step: BlendStep, i: number) =>
    mode === 'line' ? (
      label(step, i)
    ) : (
      <>
        {i + 1}
        <span className="hint shares">{step.shares.map(shareText).join(' : ')}</span>
      </>
    );

  return (
    <>
      <main className="settings compare no-print">
        <div className="row">
          <h1>{title}</h1>
          <button type="button" className="end" onClick={onClose}>
            Done
          </button>
        </div>
        <fieldset className="plain row" aria-label="Kind of blend">
          <label className="check">
            <input type="radio" name="blend-mode" checked={mode === 'line'} onChange={() => setMode('line')} />
            Line blend of two recipes
          </label>
          <label className="check">
            <input
              type="radio"
              name="blend-mode"
              checked={mode === 'triaxial'}
              disabled={recipes.length < 3}
              onChange={() => setMode('triaxial')}
            />
            Triaxial of three{recipes.length < 3 && <span className="hint"> (needs three recipes)</span>}
          </label>
        </fieldset>
        <p className="hint">
          {mode === 'line'
            ? 'Two recipes mixed in steps, from all of the first to all of the second.'
            : 'Three recipes mixed over a triangle: each corner is all of one recipe, and the points between are mixtures.'}{' '}
          Each recipe’s base counts as 100 parts, its additions on top.
        </p>
        <div className="details">
          {recipePicker('blend-first', 'First recipe', first, setFirst)}
          {recipePicker('blend-second', 'Second recipe', second, setSecond)}
          {mode === 'triaxial' && recipePicker('blend-third', 'Third recipe', third, setThird)}
          {mode === 'line' ? (
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
          ) : (
            <div className="detail narrow">
              <label htmlFor="blend-divisions">Steps along a side</label>
              <select id="blend-divisions" value={divisions} onChange={(e) => setDivisions(e.target.value)}>
                {[2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} ({((n + 1) * (n + 2)) / 2} tests)
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="detail narrow">
            <label htmlFor="blend-size">Each test, g</label>
            <input id="blend-size" inputMode="decimal" value={testSize} onChange={(e) => setTestSize(e.target.value)} />
          </div>
        </div>
        {!ready || !blend.length ? (
          <p className="hint">Choose {mode === 'line' ? 'two' : 'three'} different recipes.</p>
        ) : (
          <>
            {mode === 'triaxial' && <TriangleKey steps={blend} names={recipeNames} />}
            <div className="table-scroll">
              <table className="compare-table blend">
                <caption>Parts of each material</caption>
                <thead>
                  <tr>
                    <th scope="col">Material</th>
                    {blend.map((step, i) => (
                      <th key={i} scope="col" className="num">
                        {header(step, i)}
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
            </div>
            {bodies ? (
              <BodyBlendTables steps={blend} analyses={analyses} library={library} />
            ) : (
              <div className="table-scroll">
                <table className="compare-table blend">
                  <caption>Unity formula</caption>
                  <tbody>
                    {oxides.map((oxide) => (
                      <tr key={oxide}>
                        <th scope="row">{oxideLabel(oxide)}</th>
                        {analyses.map((x, i) => (
                          <td key={i} className="num">
                            {x?.result ? (x.result.umf[oxide] ?? 0).toFixed(3) : '—'}
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
              </div>
            )}
            {canSave && (
              <div className="row wrap">
                {blend.map((step, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Save ${names[i]} as a recipe`}
                    disabled={saved.includes(names[i])}
                    onClick={() => void save(i)}
                  >
                    {saved.includes(names[i]) ? 'Saved' : `Save ${label(step, i)}`}
                  </button>
                ))}
              </div>
            )}
            {saved.length > 0 && (
              <p className="hint" role="status">
                Saved as recipes: {saved.join(', ')}.
              </p>
            )}
            {canPrint(picked.flatMap((r) => (r ? [r.recordId] : []))) && (
              <>
                <div className="row">
                  <button type="button" disabled={!(size > 0)} onClick={() => printPaper('weights')}>
                    Print the weights…
                  </button>
                </div>
                <fieldset className="plain bar-label-options">
                  <legend>Bar labels</legend>
                  <p className="hint">
                    A label for each test at each cone, to keep with its bar. Each recipe goes by its letter: {key}.
                  </p>
                  <div className="details">
                    <div className="detail">
                      <label htmlFor="label-name">Name on the labels</label>
                      <input
                        id="label-name"
                        value={labelName}
                        placeholder={title}
                        onChange={(e) => setLabelName(e.target.value)}
                      />
                    </div>
                    <div className="detail">
                      <label htmlFor="label-cones">Cones</label>
                      <input id="label-cones" value={cones} placeholder="4, 5, 6" onChange={(e) => setCones(e.target.value)} />
                    </div>
                  </div>
                  <button type="button" onClick={() => printPaper('labels')}>
                    Print {labels.length} bar labels…
                  </button>
                </fieldset>
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </>
        )}
      </main>

      {ready && blend.length > 0 && paper === 'labels' && (
        <section className="print-only paper" aria-hidden="true">
          <p className="confidential">Confidential · Printed {new Date().toLocaleString()} from Glaze Vault</p>
          <p className="meta">
            {title}: {key}
          </p>
          <ul className="bar-labels">
            {labels.map((label, i) => (
              <li key={i} className="bar-label">
                <strong>
                  {labelName.trim() || title} · {label.test}
                </strong>
                <span>{label.shares}</span>
                <span>Cone {label.cone || '______'}</span>
                <span className="mark">Mark</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ready && blend.length > 0 && paper === 'weights' && size > 0 && (
        <section className="print-only paper" aria-hidden="true">
          <p className="confidential">Confidential · Printed {new Date().toLocaleString()} from Glaze Vault</p>
          <h1>
            {title}: {of}
          </h1>
          <p className="meta">
            Each test {size} g{additions ? ' of base, additions on top' : ''}, weights in grams
          </p>
          {mode === 'triaxial' && <TriangleKey steps={blend} names={recipeNames} />}
          <table className="paper-table">
            <thead>
              <tr>
                <th scope="col">Material</th>
                {blend.map((step, i) => (
                  <th key={i} scope="col" className="num">
                    {mode === 'line' ? `${i + 1}: ${label(step, i)}` : i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {materials.map((material, row) => (
                <tr key={material}>
                  <td>{material}</td>
                  {blend.map((step, i) => {
                    const base = baseOf(usableLines(step.lines));
                    const parts = Number(step.lines[row].amount);
                    return (
                      <td key={i} className="num">
                        {parts && base ? ((parts / base) * size).toFixed(1) : '—'}
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

/** Each step of a blend of bodies: its oxides as fired weight %, its formula with Al₂O₃ = 1, and
 * how much of it is plastic clay and added silica. */
function BodyBlendTables({
  steps,
  analyses,
  library
}: {
  steps: BlendStep[];
  analyses: ReturnType<typeof analyse>[];
  library: MaterialLibrary;
}) {
  const chemistry = analyses.map((x) => (x?.result ? bodyChemistry(x.result) : null));
  const makeups = steps.map((step) => bodyMakeup(step.lines, library.own));
  const weighed = OXIDES.filter((oxide) => analyses.some((x) => (x?.result?.analysis[oxide] ?? 0) >= 0.005));
  const formula = OXIDES.filter((oxide) => chemistry.some((c) => c?.alumina?.some(([o]) => o === oxide)));
  const cell = (value: number | undefined | null, decimals: number) => (value == null ? '—' : value.toFixed(decimals));
  return (
    <>
      <div className="table-scroll">
        <table className="compare-table blend">
          <caption>Oxides, fired weight %</caption>
          <tbody>
            {weighed.map((oxide) => (
              <tr key={oxide}>
                <th scope="row">{oxideLabel(oxide)}</th>
                {analyses.map((x, i) => (
                  <td key={i} className="num">
                    {x?.result ? (x.result.analysis[oxide] ?? 0).toFixed(2) : '—'}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="fact">
              <th scope="row">Plastic : non-plastic</th>
              {makeups.map((m, i) => (
                <td key={i} className="num">
                  {m ? `${Math.round(m.plastic)} : ${Math.round(100 - m.plastic)}` : '—'}
                </td>
              ))}
            </tr>
            <tr className="fact">
              <th scope="row">Added silica</th>
              {makeups.map((m, i) => (
                <td key={i} className="num">
                  {m ? `${m.silica.toFixed(1)}%` : '—'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="table-scroll">
        <table className="compare-table blend">
          <caption>Formula with Al₂O₃ = 1</caption>
          <tbody>
            {formula.map((oxide) => (
              <tr key={oxide}>
                <th scope="row">{oxideLabel(oxide)}</th>
                {chemistry.map((c, i) => (
                  <td key={i} className="num">
                    {c?.alumina ? cell(c.alumina.find(([o]) => o === oxide)?.[1] ?? 0, 3) : '—'}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="fact">
              <th scope="row">KNaO, mol%</th>
              {chemistry.map((c, i) => (
                <td key={i} className="num">
                  {cell(c?.knaoMol, 1)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Where each numbered test sits on the triangle: the first recipe at the top, the second at the
 * bottom left, the third at the bottom right. */
function TriangleKey({ steps, names }: { steps: BlendStep[]; names: string[] }) {
  const [width, height, pad] = [320, 250, 28];
  const corners = [
    [width / 2, pad],
    [pad, height - pad],
    [width - pad, height - pad]
  ];
  const at = (shares: number[]) =>
    [0, 1].map((axis) => shares.reduce((sum, share, i) => sum + (share / 100) * corners[i][axis], 0));
  return (
    <figure className="triangle-key">
      <svg
        viewBox={`0 0 ${width} ${height + 20}`}
        role="img"
        aria-label={`Test 1 is all ${names[0] || 'Untitled'}; the bottom corners are ${names[1] || 'Untitled'} and ${names[2] || 'Untitled'}`}
      >
        <polygon points={corners.map((p) => p.join(',')).join(' ')} className="triangle" />
        {steps.map((step, i) => {
          const [x, y] = at(step.shares);
          return (
            <g key={i}>
              <circle cx={x} cy={y} r="11" className="point" />
              <text x={x} y={y} dy="0.35em" textAnchor="middle">
                {i + 1}
              </text>
            </g>
          );
        })}
        <text x={corners[0][0]} y={corners[0][1] - 16} textAnchor="middle" className="corner">
          {names[0] || 'Untitled'}
        </text>
        <text x={corners[1][0]} y={height + 8} textAnchor="start" className="corner">
          {names[1] || 'Untitled'}
        </text>
        <text x={corners[2][0]} y={height + 8} textAnchor="end" className="corner">
          {names[2] || 'Untitled'}
        </text>
      </svg>
    </figure>
  );
}
