// Fitting a recipe to a formula (docs/adr/0015-chemistry-tools.md): a target, from a limit set or
// typed in, the materials the fit may use, and the amounts it finds, to put in the editor or save
// as a recipe of their own.
import { useMemo, useState } from 'react';
import { errorText } from '../api';
import { analyse, oxideLabel, OXIDES, type MaterialLibrary, type RecipeContent, type RecipeLine } from '../chemistry';
import { fitInto, fitRecipe, moveInto, targetFrom, type FitChoice, type TargetLine } from '../fit';
import { checkLimits, type LimitSet } from '../limits';

type Fitted = { lines: RecipeLine[]; changed: boolean; outside?: string[] };

export function Fit({
  recipe,
  library,
  sets,
  initialSet,
  onUse,
  onSaveNew,
  onClose
}: {
  recipe: RecipeContent;
  library: MaterialLibrary;
  sets: LimitSet[];
  /** The limit set the recipe is being compared with, to start from. */
  initialSet: string;
  /** Puts the fitted lines in the editor as unsaved changes; absent when the recipe may not change. */
  onUse?: (lines: RecipeLine[]) => void;
  /** Saves the fitted recipe as a new one; absent when the person may not make recipes. */
  onSaveNew?: (content: RecipeContent) => Promise<void>;
  onClose: () => void;
}) {
  const analysis = useMemo(() => analyse(recipe.lines, library), [recipe.lines, library]);
  const umf = analysis?.result?.umf ?? null;
  const [goal, setGoal] = useState<'limits' | 'formula'>(sets.length ? 'limits' : 'formula');
  const [setId, setSetId] = useState(sets.some((s) => s.id === initialSet) ? initialSet : (sets[0]?.id ?? ''));
  const [typed, setTyped] = useState<TargetLine[]>(() => withEmpty(umf ? targetFrom(umf) : []));
  const [choices, setChoices] = useState<FitChoice[]>(() =>
    recipe.lines
      .filter((line) => line.material.trim())
      .map((line) => ({ material: line.material, amount: line.amount, addition: line.addition, change: !line.addition }))
  );
  const [trying, setTrying] = useState('');
  const [fitted, setFitted] = useState<Fitted | null>(null);
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState(false);
  const set = sets.find((s) => s.id === setId) ?? null;
  const moved = goal === 'limits' && set && umf ? moveInto(umf, set) : null;
  const target = goal === 'limits' ? (moved?.target ?? []) : typed;
  const result = useMemo(() => (fitted ? analyse(fitted.lines, library) : null), [fitted, library]);

  const run = () => {
    setSaved(false);
    const outcome = goal === 'limits' && set ? fitInto(choices, set, library) : fitRecipe(choices, typed, library);
    if ('problem' in outcome) {
      setProblem(outcome.problem);
      setFitted(null);
    } else {
      setProblem('');
      setFitted(outcome);
    }
  };
  const change = (next: FitChoice[]) => {
    setChoices(next);
    setFitted(null);
  };

  if (!umf) {
    return (
      <main className="settings compare no-print">
        <div className="row">
          <h1>Fit to a formula</h1>
          <button type="button" className="end" onClick={onClose}>
            Done
          </button>
        </div>
        <p className="hint">{analysis?.problem ?? 'This recipe has no unity formula to fit yet: give it materials and amounts.'}</p>
      </main>
    );
  }

  const oxidesShown = OXIDES.filter(
    (oxide) =>
      target.some((t) => t.oxide === oxide && Number(t.moles) > 0) ||
      (umf[oxide] ?? 0) >= 0.0005 ||
      (result?.result?.umf[oxide] ?? 0) >= 0.0005
  );
  const moles = (oxide: string) => target.find((t) => t.oxide === oxide)?.moles ?? '';

  return (
    <main className="settings compare no-print">
      <div className="row">
        <h1>Fit {recipe.name || 'Untitled'} to a formula</h1>
        <button type="button" className="end" onClick={onClose}>
          Done
        </button>
      </div>
      <p className="hint">
        New amounts for the recipe’s materials, and any you add, whose unity formula comes as near the target as they
        allow, changing the recipe as little as that does. Nothing changes until you use or save them.
      </p>

      <h2 className="section-heading">Target</h2>
      <fieldset className="plain">
        <label className="check">
          <input type="radio" name="fit-goal" checked={goal === 'limits'} disabled={!sets.length} onChange={() => setGoal('limits')} />
          Move it into a limit formula
        </label>
        {goal === 'limits' && (
          <div className="detail">
            <label htmlFor="fit-set">Limit formula</label>
            <select
              id="fit-set"
              value={setId}
              onChange={(e) => {
                setSetId(e.target.value);
                setFitted(null);
              }}
            >
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || 'Untitled'}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="check">
          <input type="radio" name="fit-goal" checked={goal === 'formula'} onChange={() => setGoal('formula')} />
          A unity formula I give
        </label>
      </fieldset>
      {goal === 'limits' && set && moved && (
        <p className="hint">
          {checkLimits(umf, set).some((c) => c.outside)
            ? `The target is the recipe’s formula with each oxide outside ${set.name} brought just inside it.`
            : `The recipe is within ${set.name} already, so the target is its own formula.`}
          {moved.unmet.length > 0 &&
            ` No unity formula of the recipe’s fluxes meets ${moved.unmet.join(', ')}: add a material with another flux to try.`}
        </p>
      )}
      {goal === 'formula' && (
        <>
          <table className="lines target">
            <thead>
              <tr>
                <th scope="col">Oxide</th>
                <th scope="col" className="num">
                  Moles
                </th>
              </tr>
            </thead>
            <tbody>
              {typed.map((line, i) => (
                <tr key={i}>
                  <td>
                    <select
                      aria-label={`Target oxide ${i + 1}`}
                      value={line.oxide}
                      onChange={(e) => {
                        setTyped(withEmpty(typed.map((t, j) => (j === i ? { ...t, oxide: e.target.value } : t))));
                        setFitted(null);
                      }}
                    >
                      <option value="">—</option>
                      {OXIDES.map((oxide) => (
                        <option key={oxide} value={oxide}>
                          {oxideLabel(oxide)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      aria-label={`Target moles ${i + 1}`}
                      inputMode="decimal"
                      value={line.moles}
                      onChange={(e) => {
                        setTyped(withEmpty(typed.map((t, j) => (j === i ? { ...t, moles: e.target.value } : t))));
                        setFitted(null);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() => {
              setTyped(withEmpty(targetFrom(umf)));
              setFitted(null);
            }}
          >
            Start from the recipe’s formula
          </button>
        </>
      )}

      <h2 className="section-heading">Materials</h2>
      <table className="lines">
        <thead>
          <tr>
            <th scope="col">Material</th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col">May change</th>
          </tr>
        </thead>
        <tbody>
          {choices.map((choice, i) => (
            <tr key={`${choice.material}-${i}`}>
              <td>
                {choice.material}
                {choice.addition && <span className="hint"> (addition)</span>}
              </td>
              <td className="num">{choice.amount.trim() || 'to try'}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${choice.material} may change`}
                  checked={choice.change}
                  onChange={(e) => change(choices.map((c, j) => (j === i ? { ...c, change: e.target.checked } : c)))}
                />
                {!choice.amount.trim() && (
                  <button
                    type="button"
                    className="link danger"
                    aria-label={`Do not try ${choice.material}`}
                    onClick={() => change(choices.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trying.trim()) return;
          change([...choices, { material: trying.trim(), amount: '', change: true }]);
          setTrying('');
        }}
      >
        <label htmlFor="fit-try">Also try</label>
        <input id="fit-try" list="fit-materials" value={trying} onChange={(e) => setTrying(e.target.value)} />
        <datalist id="fit-materials">
          {library.names.map(({ name }) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button type="submit" disabled={!trying.trim()}>
          Add
        </button>
      </form>

      <div className="row">
        <button type="button" className="primary" disabled={goal === 'limits' && !set} onClick={run}>
          Fit
        </button>
      </div>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}

      {fitted && result?.result && (
        <section aria-label="Fitted">
          <p role="status" className="hint">
            {!fitted.changed
              ? 'The recipe is as near the target as these materials come: nothing needs to change.'
              : fitted.outside?.length
                ? `As near as these materials come, still outside ${set?.name} for ${fitted.outside.join(', ')}. Try another material.`
                : goal === 'limits'
                  ? `Within ${set?.name}.`
                  : 'As near the target as these materials come.'}
          </p>
          <div className="table-scroll">
            <table className="compare-table">
              <caption>Amounts</caption>
              <thead>
                <tr>
                  <th scope="col">Material</th>
                  <th scope="col" className="num">
                    Now
                  </th>
                  <th scope="col" className="num">
                    Fitted
                  </th>
                </tr>
              </thead>
              <tbody>
                {choices.map((choice, i) => {
                  const now = fitted.lines.find((l) => l.material === choice.material)?.amount;
                  return (
                    <tr key={i}>
                      <th scope="row">{choice.material}</th>
                      <td className="num">{choice.amount.trim() || '—'}</td>
                      <td className="num">{now ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <table className="compare-table">
              <caption>Unity formula</caption>
              <thead>
                <tr>
                  <th scope="col">Oxide</th>
                  <th scope="col" className="num">
                    Now
                  </th>
                  <th scope="col" className="num">
                    Target
                  </th>
                  <th scope="col" className="num">
                    Fitted
                  </th>
                </tr>
              </thead>
              <tbody>
                {oxidesShown.map((oxide) => (
                  <tr key={oxide}>
                    <th scope="row">{oxideLabel(oxide)}</th>
                    <td className="num">{(umf[oxide] ?? 0).toFixed(3)}</td>
                    <td className="num">{moles(oxide) || '—'}</td>
                    <td className="num">{(result.result!.umf[oxide] ?? 0).toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {fitted.changed && (
            <div className="row">
              {onUse && (
                <button type="button" className="primary" onClick={() => onUse(fitted.lines)}>
                  Use these amounts
                </button>
              )}
              {onSaveNew && (
                <button
                  type="button"
                  disabled={saved}
                  onClick={() =>
                    void onSaveNew({ ...recipe, name: `${recipe.name || 'Untitled'}, fitted`, lines: fitted.lines })
                      .then(() => setSaved(true))
                      .catch((e) => setProblem(errorText(e)))
                  }
                >
                  {saved ? 'Saved' : 'Save as a new recipe'}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

/** A target always ends in an empty line to type the next oxide in. */
function withEmpty(lines: TargetLine[]): TargetLine[] {
  const last = lines[lines.length - 1];
  return last && !last.oxide && !last.moles ? lines : [...lines, { oxide: '', moles: '' }];
}
