import { formatWeight } from '../batch';
import type { Mix, MixContent, MixStep } from '../mix';

export const STEP_FIELDS: { key: keyof MixStep; label: string; decimal?: boolean }[] = [
  { key: 'deflocculant', label: 'Deflocculant added', decimal: true },
  { key: 'water', label: 'Water added', decimal: true },
  { key: 'gravity', label: 'Specific gravity', decimal: true },
  { key: 'viscosity', label: 'Ford cup #4, s', decimal: true },
  { key: 'gel', label: 'Gel' }
];

/** Blank rows a printed mix record leaves for the steps still to come. */
const BLANK_STEPS = 8;

/** A mix record for the shop floor (ui/styles.css hides it on screen, once it is asked for): the batch as weighed, with
 * a place for each lot, then the slip's steps so far and blank rows for the rest, to fill in by
 * hand and type in later. */
export function PrintedMix({
  draft,
  name,
  changed,
  current,
  heading,
  rows,
  slip
}: {
  draft: MixContent;
  name: string;
  changed: boolean;
  current: Mix | null;
  heading: string;
  rows: { material: string; percent: number | null; weight: number | null; lot: string }[];
  slip: boolean;
}) {
  const unit = draft.unit ?? 'g';
  const steps = draft.steps ?? [];
  const printed = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const status = changed
    ? 'Not saved: printed with unsaved changes'
    : current
      ? `Revision ${current.number}, saved ${new Date(current.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
      : '';
  const hasWeights = rows.some((row) => row.weight !== null);
  return (
    <section className="print-only paper" aria-hidden="true">
      <p className="confidential">Confidential · Printed {printed} from Glaze Vault</p>
      <h1>Mix record: {name}</h1>
      {status && <p className="meta">{status}</p>}
      <p className="meta">
        {draft.sheet ? `Batch sheet revision ${draft.sheetNumber}` : `Recipe revision ${draft.recipeNumber}`} · Mixed on{' '}
        {draft.mixedOn}
        {draft.size?.trim() ? ` · Dry batch ${draft.size.trim()} ${unit}` : ''}
      </p>
      {rows.length > 0 && (
        <table className="paper-table">
          <thead>
            <tr>
              <th scope="col">{heading}</th>
              {hasWeights && (
                <>
                  <th scope="col" className="num">
                    %
                  </th>
                  <th scope="col" className="num">
                    Weight ({unit})
                  </th>
                </>
              )}
              <th scope="col">Lot</th>
              <th scope="col">Weighed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>{row.material}</td>
                {hasWeights && (
                  <>
                    <td className="num">{row.percent === null ? '' : row.percent.toFixed(2)}</td>
                    <td className="num">{row.weight === null ? '' : formatWeight(row.weight, unit)}</td>
                  </>
                )}
                <td className="write-in">{row.lot}</td>
                <td className="write-in" />
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(slip || steps.length > 0 || !!draft.water?.trim()) && (
        <>
          <h2>Water, deflocculant and readings</h2>
          <p className="meta">Water at the start: {draft.water?.trim() ? `${draft.water.trim()} ${unit}` : '________'}</p>
          <table className="paper-table steps">
            <thead>
              <tr>
                <th scope="col">Day</th>
                {STEP_FIELDS.map((f) => (
                  <th scope="col" key={f.key}>
                    {f.label}
                    {f.key === 'deflocculant' || f.key === 'water' ? ` (${unit})` : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {steps.map((step, i) => (
                <tr key={i}>
                  <td>{step.on}</td>
                  {STEP_FIELDS.map((f) => (
                    <td key={f.key}>{step[f.key]}</td>
                  ))}
                </tr>
              ))}
              {Array.from({ length: BLANK_STEPS }, (_, i) => (
                <tr key={`blank-${i}`}>
                  <td className="write-in" />
                  {STEP_FIELDS.map((f) => (
                    <td key={f.key} className="write-in" />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {draft.notes.trim() && (
        <>
          <h2>Notes</h2>
          <p className="notes">{draft.notes}</p>
        </>
      )}
      <dl className="signoff">
        <dt>Mixed by</dt>
        <dd />
        <dt>Date</dt>
        <dd />
        <dt>Checked by</dt>
        <dd />
      </dl>
    </section>
  );
}
