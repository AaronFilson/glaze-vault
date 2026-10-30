// Comparing a recipe's unity formula with a limit formula, and the sets people make
// (docs/adr/0015-chemistry-tools.md).
import { useState } from 'react';
import { api, errorText, type Revision } from '../api';
import { oxideLabel } from '../chemistry';
import {
  BUILT_IN_LIMITS,
  checkLimits,
  LIMIT_OXIDES,
  rangeText,
  type LimitRange,
  type LimitSet,
  type LimitsContent
} from '../limits';
import { ConfirmNotice } from './Deleted';
import { ForkChoice } from './ForkChoice';
import { CheckoutBar } from './CheckoutBar';

const CHOICE_KEY = 'glaze-vault.limits';

/** Every set to compare with: the built-in ones, then the person's own. */
export function limitSets(own: Revision<LimitsContent>[]): LimitSet[] {
  return [
    ...BUILT_IN_LIMITS,
    ...own.map((r) => ({ ...r.content, id: r.recordId, builtIn: false }))
  ];
}

/** The set last chosen on this computer, if there is one. */
export function savedLimitChoice(): string {
  try {
    return localStorage.getItem(CHOICE_KEY) ?? '';
  } catch {
    return '';
  }
}

const label = (oxide: string) => (oxide === 'KNaO' ? 'KNaO' : oxideLabel(oxide));

/** Below the unity formula: a set to compare with, and where the recipe falls in each range. */
export function LimitsPanel({
  sets,
  chosen,
  onChoose,
  umf
}: {
  sets: LimitSet[];
  chosen: string;
  onChoose: (id: string) => void;
  umf: Record<string, number> | null;
}) {
  const set = sets.find((s) => s.id === chosen) ?? null;
  const checks = set && umf ? checkLimits(umf, set) : [];
  const outside = checks.filter((c) => c.outside).length;
  return (
    <div className="limits">
      <label htmlFor="limit-set">Compare with</label>
      <select
        id="limit-set"
        value={set ? set.id : ''}
        onChange={(e) => {
          onChoose(e.target.value);
          try {
            localStorage.setItem(CHOICE_KEY, e.target.value);
          } catch {
            // Remembering the choice is a convenience.
          }
        }}
      >
        <option value="">No limit formula</option>
        {sets.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name || 'Untitled'}
          </option>
        ))}
      </select>
      {set && umf && (
        <>
          <table className="umf limit-table">
            <caption>
              {outside ? `${outside} outside ${set.name}` : `Within ${set.name}`}
            </caption>
            <tbody>
              {checks.map((check) => (
                <tr key={check.oxide} className={check.outside ? 'outside' : undefined}>
                  <th scope="row">{label(check.oxide)}</th>
                  <td className="num">{check.value.toFixed(3)}</td>
                  <td className="num range">{rangeText(check)}</td>
                  <td>{check.outside === 'below' ? 'Below' : check.outside === 'above' ? 'Above' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {set.source && <p className="hint">From {set.source}. A guide from experience, not a rule.</p>}
        </>
      )}
    </div>
  );
}

const EMPTY_SET: LimitsContent = { name: '', source: '', ranges: [{ oxide: 'SiO2', min: '', max: '' }] };

/** Settings: the person's own limit formulas, to make, change and delete. */
export function LimitSets({
  own,
  canCreate,
  collection,
  onSaved,
  onDeleted
}: {
  own: Revision<LimitsContent>[];
  canCreate: boolean;
  /** Where a new set goes, in a team's vault. */
  collection: string | null;
  onSaved: (saved: Revision<LimitsContent>) => void;
  onDeleted: (recordId: string) => void;
}) {
  const [editing, setEditing] = useState<{ current: Revision<LimitsContent> | null; draft: LimitsContent } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  const start = (current: Revision<LimitsContent> | null, draft: LimitsContent) => {
    setError('');
    setConfirming(false);
    setEditing({ current, draft });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const { current, draft } = editing;
    const content: LimitsContent = {
      name: draft.name.trim(),
      source: draft.source.trim(),
      ranges: draft.ranges.filter((r) => r.min.trim() || r.max.trim())
    };
    if (!content.name) {
      setError('Give the set a name.');
      return;
    }
    try {
      const saved = current
        ? await api.saveRecord<LimitsContent>('limits', current.revisionId, content)
        : await api.saveRecord<LimitsContent>('limits', null, content, collection);
      onSaved(saved);
      setEditing(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remove = async () => {
    if (!editing?.current) return;
    try {
      const gone = await api.deleteRecord('limits', editing.current.revisionId);
      await api.eraseRecord('limits', gone.recordId);
      onDeleted(gone.recordId);
      setEditing(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const setRange = (index: number, change: Partial<LimitRange>) =>
    editing &&
    setEditing({
      ...editing,
      draft: { ...editing.draft, ranges: editing.draft.ranges.map((r, i) => (i === index ? { ...r, ...change } : r)) }
    });

  return (
    <>
      <p className="hint">
        Ranges of a unity formula to compare recipes with, beside the unity formula. Glaze Vault has{' '}
        {BUILT_IN_LIMITS.map((s) => s.name).join(', ')}; make your own from a book or your own tests.
      </p>
      {own.length > 0 && (
        <ul className="list">
          {own.map((set) => (
            <li key={set.recordId}>
              <button type="button" onClick={() => start(set, set.content)}>
                {set.content.name || 'Untitled'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {canCreate && !editing && (
        <div className="row">
          <button type="button" onClick={() => start(null, EMPTY_SET)}>
            New limit formula
          </button>
          {BUILT_IN_LIMITS.map((set) => (
            <button
              key={set.id}
              type="button"
              onClick={() => start(null, { name: `${set.name}, mine`, source: set.source, ranges: set.ranges })}
            >
              Copy {set.name}
            </button>
          ))}
        </div>
      )}
      {editing?.current && (
        <ForkChoice
          kind="limits"
          head={editing.current}
          name={editing.current.content.name}
          readOnly={!canCreate}
          onResolved={(saved) => {
            if (saved.deleted) {
              onDeleted(saved.recordId);
              setEditing(null);
            } else {
              onSaved(saved);
              start(saved, saved.content);
            }
          }}
        />
      )}
      {editing?.current && <CheckoutBar kind="limits" record={editing.current.recordId} readOnly={!canCreate} />}
      {editing && (
        <form className="notice" onSubmit={save}>
          <fieldset>
            <legend>{editing.current ? editing.current.content.name : 'New limit formula'}</legend>
            <label htmlFor="limits-name">Name</label>
            <input
              id="limits-name"
              value={editing.draft.name}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })}
            />
            <label htmlFor="limits-source">Source</label>
            <input
              id="limits-source"
              value={editing.draft.source}
              placeholder="A book, a page, or your own tests"
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, source: e.target.value } })}
            />
            <table className="lines">
              <thead>
                <tr>
                  <th scope="col">Oxide</th>
                  <th scope="col" className="num">
                    At least
                  </th>
                  <th scope="col" className="num">
                    At most
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {editing.draft.ranges.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <select aria-label={`Oxide ${i + 1}`} value={r.oxide} onChange={(e) => setRange(i, { oxide: e.target.value })}>
                        {LIMIT_OXIDES.map((oxide) => (
                          <option key={oxide} value={oxide}>
                            {label(oxide)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="num">
                      <input aria-label={`At least ${i + 1}`} inputMode="decimal" value={r.min} onChange={(e) => setRange(i, { min: e.target.value })} />
                    </td>
                    <td className="num">
                      <input aria-label={`At most ${i + 1}`} inputMode="decimal" value={r.max} onChange={(e) => setRange(i, { max: e.target.value })} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link"
                        aria-label={`Remove oxide ${i + 1}`}
                        onClick={() =>
                          setEditing({
                            ...editing,
                            draft: { ...editing.draft, ranges: editing.draft.ranges.filter((_, j) => j !== i) }
                          })
                        }
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              onClick={() =>
                setEditing({
                  ...editing,
                  draft: { ...editing.draft, ranges: [...editing.draft.ranges, { oxide: 'CaO', min: '', max: '' }] }
                })
              }
            >
              Add oxide
            </button>
          </fieldset>
          {confirming && (
            <ConfirmNotice confirm="Delete" onConfirm={() => void remove()} onCancel={() => setConfirming(false)}>
              <p>
                <strong>Delete {editing.draft.name || 'this set'}?</strong>
              </p>
            </ConfirmNotice>
          )}
          <div className="row">
            <button type="submit" className="primary">
              Save limit formula
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            {editing.current && (
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
        </form>
      )}
    </>
  );
}
