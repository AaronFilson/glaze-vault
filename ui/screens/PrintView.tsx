import type { RecipeHead } from '../api';
import { BATCH_UNITS, formatWeight, scaleBatch, usableLines, type BatchUnit } from '../batch';
import type { Analysis, RecipeContent } from '../chemistry';
import { AnalysisPanel } from './AnalysisPanel';

export type PrintJob = { kind: 'recipe' } | { kind: 'batch'; size: number; unit: BatchUnit };

/** What goes on paper. It is always in the page, hidden on screen (styles.css), so it is ready
 * whenever the print dialog takes its copy. */
export function PrintView({
  job,
  content,
  saved,
  changed,
  analysis,
  sheet = false
}: {
  job: PrintJob;
  content: RecipeContent;
  saved: RecipeHead | null;
  changed: boolean;
  analysis: Analysis;
  /** A batch sheet, whose materials are codes. */
  sheet?: boolean;
}) {
  const printed = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const status = changed
    ? 'Not saved: printed with unsaved changes'
    : saved
      ? `Revision ${saved.number}, saved ${new Date(saved.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
      : '';

  return (
    <section className="print-only paper" aria-hidden="true">
      <p className="confidential">Confidential · Printed {printed} from Glaze Vault</p>
      <h1>
        {job.kind === 'batch' ? 'Batch sheet: ' : ''}
        {content.name || 'Untitled'}
      </h1>
      {status && <p className="meta">{status}</p>}
      {job.kind === 'batch' ? <BatchTable content={content} size={job.size} unit={job.unit} heading={sheet ? 'Code' : 'Material'} /> : <RecipeTable content={content} />}
      {content.notes.trim() && (
        <>
          <h2>Notes</h2>
          <p className="notes">{content.notes}</p>
        </>
      )}
      {job.kind === 'recipe' && analysis?.result && (
        <div className="paper-analysis">
          <AnalysisPanel analysis={analysis} />
        </div>
      )}
      {job.kind === 'batch' && (
        <dl className="signoff">
          <dt>Weighed by</dt>
          <dd />
          <dt>Date</dt>
          <dd />
          <dt>Checked by</dt>
          <dd />
        </dl>
      )}
    </section>
  );
}

function RecipeTable({ content }: { content: RecipeContent }) {
  const lines = usableLines(content.lines);
  const sum = lines.reduce((total, line) => total + line.amount, 0);
  return (
    <table className="paper-table">
      <thead>
        <tr>
          <th scope="col">Material</th>
          <th scope="col" className="num">
            Amount
          </th>
          <th scope="col" className="num">
            %
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, i) => (
          <tr key={i}>
            <td>{line.material}</td>
            <td className="num">{line.amount.toLocaleString()}</td>
            <td className="num">{((line.amount / sum) * 100).toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td className="num">{sum.toLocaleString()}</td>
          <td className="num">100.00</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** A batch of `size`, line by line; on a batch sheet the materials are codes, under `heading`. */
export function BatchTable({
  content,
  size,
  unit,
  heading = 'Material'
}: {
  content: RecipeContent;
  size: number;
  unit: BatchUnit;
  heading?: string;
}) {
  const batch = scaleBatch(content.lines, size);
  const unitLabel = BATCH_UNITS.find((u) => u.unit === unit)?.label ?? unit;
  if (!batch) return <p>This recipe has no amounts to scale.</p>;
  // What the scale reads after each material, when everything is weighed into one bucket.
  let sum = 0;
  const runningTotals = batch.lines.map((line) => (sum += line.weight));
  return (
    <>
      <p className="meta">
        Batch size {formatWeight(size, unit)} {unitLabel}
      </p>
      <table className="paper-table batch">
        <thead>
          <tr>
            <th scope="col">{heading}</th>
            <th scope="col" className="num">
              %
            </th>
            <th scope="col" className="num">
              Weight ({unit})
            </th>
            <th scope="col" className="num">
              Running total
            </th>
            <th scope="col">Lot</th>
            <th scope="col">Done</th>
          </tr>
        </thead>
        <tbody>
          {batch.lines.map((line, i) => (
            <tr key={i}>
              <td>{line.material}</td>
              <td className="num">{line.percent.toFixed(2)}</td>
              <td className="num weight">{formatWeight(line.weight, unit)}</td>
              <td className="num">{formatWeight(runningTotals[i], unit)}</td>
              <td className="blank" />
              <td className="box">☐</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="num">100.00</td>
            <td className="num weight">{formatWeight(batch.total, unit)}</td>
            <td />
            <td />
            <td />
          </tr>
        </tfoot>
      </table>
    </>
  );
}
