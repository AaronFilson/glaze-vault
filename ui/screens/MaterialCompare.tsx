// Materials side by side, to choose a substitute for one: what their data sheets say they do, then
// what they are made of. Each column's numbers show their difference from the first one's.
import { useState } from 'react';
import type { MaterialHead } from '../api';
import { oxideLabel } from '../chemistry';
import { classLabel, compareAnalyses, compareSheets, sheetCones } from '../materialCompare';

export function MaterialCompare({
  materials,
  initial,
  onClose
}: {
  materials: MaterialHead[];
  /** The material to start from: the first column. */
  initial: string | null;
  onClose: () => void;
}) {
  // In the order chosen: the first is what the others are compared with.
  const [picked, setPicked] = useState<string[]>(initial ? [initial] : []);
  const sorted = [...materials].sort((a, b) => a.content.name.localeCompare(b.content.name));
  const shown = picked.flatMap((id) => materials.find((m) => m.recordId === id) ?? []);
  const contents = shown.map((m) => m.content);
  const sheets = compareSheets(contents);
  const { cones, differ } = sheetCones(contents);
  const analyses = compareAnalyses(contents);
  const classes = contents.map(classLabel);

  const toggle = (id: string, on: boolean) =>
    setPicked((list) => (on ? [...list, id] : list.filter((p) => p !== id)));

  const head = (
    <thead>
      <tr>
        <th scope="col" />
        {shown.map((m) => (
          <th key={m.recordId} scope="col" className="num">
            {m.content.name || 'Untitled'}
          </th>
        ))}
      </tr>
    </thead>
  );
  const cell = (value: string, difference: string, i: number) => (
    <td key={i} className="num">
      {value || '—'}
      {difference && <span className="change"> {difference}</span>}
    </td>
  );

  return (
    <main className="settings compare no-print">
      <div className="settings-head">
        <h1>Compare materials</h1>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
      <p className="hint">
        A substitute for a clay is matched first on what it does: its shrinkage, absorption, plasticity and particle
        size, from its data sheet. Each number after the first column shows how far it is from the first.
      </p>
      <fieldset className="plain material-picks">
        <legend>Materials to compare</legend>
        {sorted.map((m) => (
          <label key={m.recordId} className="check">
            <input
              type="checkbox"
              checked={picked.includes(m.recordId)}
              onChange={(e) => toggle(m.recordId, e.target.checked)}
            />
            {m.content.name || 'Untitled'}
          </label>
        ))}
      </fieldset>

      {shown.length < 2 ? (
        <p className="hint">Choose two or more materials.</p>
      ) : (
        <div className="table-scroll">
          <table className="compare-table">
            <caption>Data sheets</caption>
            {head}
            <tbody>
              <tr>
                <th scope="row">Class</th>
                {classes.map((label, i) => cell(label, '', i))}
              </tr>
              <tr>
                <th scope="row">Fired at cone</th>
                {cones.map((cone, i) => cell(cone, '', i))}
              </tr>
              {sheets.map((row) => (
                <tr key={row.field}>
                  <th scope="row">
                    {row.label}
                    {row.unit && <span className="hint"> ({row.unit})</span>}
                  </th>
                  {row.values.map((value, i) => cell(value, row.changes[i], i))}
                </tr>
              ))}
            </tbody>
          </table>
          {differ && (
            <p className="warn" role="note">
              The sheets give their firing shrinkage and absorption at different cones, so those values are not like for
              like. Fire test bars of each at the same cones to compare them.
            </p>
          )}
          {sheets.length === 0 && <p className="hint">None of these materials has a data sheet yet.</p>}

          {analyses.length > 0 && (
            <table className="compare-table">
              <caption>Analysis, weight % of the raw material</caption>
              {head}
              <tbody>
                {analyses.map((row) => (
                  <tr key={row.oxide}>
                    <th scope="row">{row.oxide === 'LOI' ? 'Loss on ignition' : oxideLabel(row.oxide)}</th>
                    {row.values.map((value, i) => cell(value === null ? '' : value.toFixed(2), row.changes[i], i))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}
