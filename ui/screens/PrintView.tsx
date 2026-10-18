import type { RecipeHead } from '../api';
import { bodyMakeup, bodyPart, isBody } from '../body';
import { BATCH_UNITS, baseOf, formatWeight, scaleBatch, usableLines, type BatchUnit } from '../batch';
import type { Analysis, MaterialContent, RecipeContent } from '../chemistry';
import { batchCosts, money, type PricesContent } from '../prices';
import { describeDetails } from '../recipeFields';
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
  sheet = false,
  prices = null,
  own = []
}: {
  job: PrintJob;
  content: RecipeContent;
  saved: RecipeHead | null;
  changed: boolean;
  analysis: Analysis;
  /** A batch sheet, whose materials are codes. */
  sheet?: boolean;
  /** For what a batch costs. */
  prices?: PricesContent | null;
  /** The person's materials, for what a body's are. */
  own?: MaterialContent[];
}) {
  const body = isBody(content.type);
  // A batch sheet names its materials by codes, so its silica cannot be told.
  const makeup = body && !sheet ? bodyMakeup(content.lines, own) : null;
  const silica =
    job.kind === 'batch' && makeup
      ? (scaleBatch(content.lines, job.size)?.lines ?? [])
          .filter((line) => bodyPart(line.material, own) === 'silica')
          .reduce((total, line) => total + line.weight, 0)
      : 0;
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
      {!sheet && describeDetails(content) && <p className="meta">{describeDetails(content)}</p>}
      {!sheet && !!content.tags?.length && <p className="meta">Tags: {content.tags.join(', ')}</p>}
      {job.kind === 'batch' ? <BatchTable content={content} size={job.size} unit={job.unit} heading={sheet ? 'Code' : 'Material'} prices={prices} /> : <RecipeTable content={content} />}
      {content.notes.trim() && (
        <>
          <h2>Notes</h2>
          <p className="notes">{content.notes}</p>
        </>
      )}
      {job.kind === 'recipe' && analysis?.result && (
        <div className="paper-analysis">
          <AnalysisPanel analysis={analysis} body={body} makeup={makeup} bodyClass={content.bodyClass} />
        </div>
      )}
      {job.kind === 'batch' && body && (
        <p className="dust">
          <strong>Dust:</strong>{' '}
          {silica > 0
            ? `this batch has ${formatWeight(silica, job.unit)} ${job.unit} of added silica, and its clays carry more. `
            : 'clay bodies carry silica. '}
          Mix the dry materials wet as soon as you can, wear a fitted N95 or P100 respirator, and clean up wet: never
          sweep.
        </p>
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

/** A line's name, marked when it is added on top of the base. */
const lineName = (line: { material: string; addition: boolean }) =>
  line.addition ? `+ ${line.material} (addition)` : line.material;

function RecipeTable({ content }: { content: RecipeContent }) {
  const lines = usableLines(content.lines);
  const sum = lines.reduce((total, line) => total + line.amount, 0);
  const base = baseOf(lines);
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
            <td>{lineName(line)}</td>
            <td className="num">{line.amount.toLocaleString()}</td>
            <td className="num">{((line.amount / base) * 100).toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td className="num">{sum.toLocaleString()}</td>
          <td className="num">{((sum / base) * 100).toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** A batch of `size`, line by line; on a batch sheet the materials are codes, under `heading`. With
 * prices for any of its materials, what each line and the batch cost. */
export function BatchTable({
  content,
  size,
  unit,
  heading = 'Material',
  prices = null
}: {
  content: RecipeContent;
  size: number;
  unit: BatchUnit;
  heading?: string;
  prices?: PricesContent | null;
}) {
  const batch = scaleBatch(content.lines, size);
  const unitLabel = BATCH_UNITS.find((u) => u.unit === unit)?.label ?? unit;
  if (!batch) return <p>This recipe has no amounts to scale.</p>;
  const costs = prices && batchCosts(batch.lines, unit, prices);
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
            {costs && (
              <th scope="col" className="num">
                Cost
              </th>
            )}
            <th scope="col">Lot</th>
            <th scope="col">Done</th>
          </tr>
        </thead>
        <tbody>
          {batch.lines.map((line, i) => (
            <tr key={i}>
              <td>{lineName(line)}</td>
              <td className="num">{line.percent.toFixed(2)}</td>
              <td className="num weight">{formatWeight(line.weight, unit)}</td>
              <td className="num">{formatWeight(runningTotals[i], unit)}</td>
              {costs && prices && (
                <td className="num">{costs.lines[i] === null ? '—' : money(costs.lines[i]!, prices)}</td>
              )}
              <td className="blank" />
              <td className="box">☐</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="num">{batch.lines.reduce((total, line) => total + line.percent, 0).toFixed(2)}</td>
            <td className="num weight">{formatWeight(batch.total, unit)}</td>
            <td />
            {costs && prices && <td className="num">{money(costs.total, prices)}</td>}
            <td />
            <td />
          </tr>
        </tfoot>
      </table>
      {costs && costs.missing.length > 0 && (
        <p className="meta">The cost leaves out {costs.missing.join(', ')}, which have no price.</p>
      )}
    </>
  );
}
