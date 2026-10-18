import { bodyChemistry } from '../body';
import { GROUP_TITLES, oxideLabel, oxidesByGroup, type Analysis } from '../chemistry';

/**
 * The unity formula and what follows from it, or for a clay body its oxide percentages and a
 * formula with alumina as one. Used on screen and on the printed recipe.
 */
export function AnalysisPanel({ analysis, body = false }: { analysis: Analysis; body?: boolean }) {
  if (!analysis) {
    return <p className="hint">Add materials and amounts to see {body ? 'the chemistry' : 'the unity formula'}.</p>;
  }
  if (!analysis.result) return <p className="error">{analysis.problem}</p>;
  const { result } = analysis;
  return (
    <>
      {body ? <BodyTables analysis={analysis} /> : <UnityTables analysis={analysis} />}
      <dl className="facts">
        {result.siAlRatio !== null && (
          <>
            <dt>SiO₂ : Al₂O₃</dt>
            <dd>{result.siAlRatio.toFixed(2)}</dd>
          </>
        )}
        {body && <BodyFacts analysis={analysis} />}
        {result.expansion !== null && (
          <>
            <dt>Expansion</dt>
            <dd>{result.expansion.toFixed(2)} × 10⁻⁶/°C</dd>
          </>
        )}
        <dt>Loss on ignition</dt>
        <dd>{result.loi.toFixed(1)}%</dd>
      </dl>
      {body && result.expansion !== null && (
        <p className="hint">
          The expansion counts every oxide as glass. A body keeps some of its silica as quartz, and may grow cristobalite,
          which expand far more, so its real expansion is higher: compare bodies with it, but test glaze fit.
        </p>
      )}
      {analysis.noOxides.length > 0 && (
        <p className="hint">
          {listOf(analysis.noOxides)} {analysis.noOxides.length > 1 ? 'add' : 'adds'} no oxides, so{' '}
          {analysis.noOxides.length > 1 ? 'they are' : 'it is'} left out of the {body ? 'chemistry' : 'unity formula'}.{' '}
          {analysis.noOxides.length > 1 ? 'They still count' : 'It still counts'} in the batch.
        </p>
      )}
      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {body && (
        <details className="no-print">
          <summary>Unity formula</summary>
          <UnityTables analysis={analysis} />
        </details>
      )}
    </>
  );
}

type Calculated = Extract<Analysis, { result: object }>;

function UnityTables({ analysis }: { analysis: Calculated }) {
  const groups = oxidesByGroup(analysis.result);
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
    </>
  );
}

function BodyTables({ analysis }: { analysis: Calculated }) {
  const body = bodyChemistry(analysis.result);
  return (
    <>
      <h2>Chemistry</h2>
      <table className="umf">
        <caption>Oxides, fired weight %</caption>
        <tbody>
          {body.percent.map(([oxide, percent]) => (
            <tr key={oxide}>
              <th scope="row">{oxideLabel(oxide)}</th>
              <td className="num">{percent.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {body.alumina && (
        <table className="umf">
          <caption>Formula with Al₂O₃ = 1</caption>
          <tbody>
            {body.alumina.map(([oxide, moles]) => (
              <tr key={oxide}>
                <th scope="row">{oxideLabel(oxide)}</th>
                <td className="num">{moles.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function BodyFacts({ analysis }: { analysis: Calculated }) {
  const body = bodyChemistry(analysis.result);
  return (
    <>
      <dt>KNaO</dt>
      <dd>{body.knaoMol.toFixed(1)} mol%</dd>
      <dt>All fluxes</dt>
      <dd>{body.fluxMol.toFixed(1)} mol%</dd>
      <dt>Fe₂O₃ + TiO₂</dt>
      <dd>{body.ironTitania.toFixed(2)}%</dd>
    </>
  );
}

/** "A", "A and B", "A, B and C" */
function listOf(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
