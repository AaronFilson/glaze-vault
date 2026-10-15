import { GROUP_TITLES, oxideLabel, oxidesByGroup, type Analysis } from '../chemistry';

/** The unity formula and what follows from it. Used on screen and on the printed recipe. */
export function AnalysisPanel({ analysis }: { analysis: Analysis }) {
  if (!analysis) return <p className="hint">Add materials and amounts to see the unity formula.</p>;
  if (!analysis.result) return <p className="error">{analysis.problem}</p>;
  const { result } = analysis;
  const groups = oxidesByGroup(result);
  return (
    <>
      <h2>Unity formula</h2>
      {(Object.keys(groups) as (keyof typeof groups)[])
        .filter((group) => groups[group].length)
        .map((group) => (
          <table key={group} className="umf">
            <caption>{GROUP_TITLES[group]}</caption>
            <tbody>
              {groups[group].map(([oxide, moles]) => (
                <tr key={oxide}>
                  <th scope="row">{oxideLabel(oxide)}</th>
                  <td className="num">{moles.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      <dl className="facts">
        {result.siAlRatio !== null && (
          <>
            <dt>SiO₂ : Al₂O₃</dt>
            <dd>{result.siAlRatio.toFixed(2)}</dd>
          </>
        )}
        {result.expansion !== null && (
          <>
            <dt>Expansion</dt>
            <dd>{result.expansion.toFixed(2)} × 10⁻⁶/°C</dd>
          </>
        )}
        <dt>Loss on ignition</dt>
        <dd>{result.loi.toFixed(1)}%</dd>
      </dl>
      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </>
  );
}
