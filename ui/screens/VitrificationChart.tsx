// A vitrification chart (docs/adr/0014-firing-log-and-photos.md): a recipe's absorption and total
// shrinkage against cone, from its firings' test bars. Both are percentages, on one axis. A body's
// targets are bands, and the cones inside all of them are its firing range. The same numbers are
// in a table below, so nothing is only in the picture or the tooltip.
import { useState } from 'react';
import { insideTargets, type Targets, type VitrificationPoint } from '../firing';
import { rangeText } from '../recipeFields';

const WIDTH = 560;
const HEIGHT = 240;
const PAD = { top: 16, right: 92, bottom: 36, left: 44 };

const SERIES = [
  { key: 'absorption', label: 'Absorption', color: 'var(--series-1)' },
  { key: 'shrinkage', label: 'Total shrinkage', color: 'var(--series-2)' }
] as const;

/** A clean top for the axis: the next step of 1, 2 or 5 above the highest value. */
function niceTop(max: number): { top: number; step: number } {
  const raw = Math.max(max, 1) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  return { top: Math.ceil(max / step) * step || step, step };
}

const percent = (value: number | undefined) => (value === undefined ? '—' : `${value.toFixed(1)}%`);

/** "cones 5 and 6", "cones 5, 6 and 7", "cone 6". */
function conesText(cones: string[]): string {
  if (cones.length === 1) return `cone ${cones[0]}`;
  return `cones ${cones.slice(0, -1).join(', ')} and ${cones[cones.length - 1]}`;
}

export function VitrificationChart({ points, targets = null }: { points: VitrificationPoint[]; targets?: Targets | null }) {
  const [active, setActive] = useState<number | null>(null);
  const values = [
    ...points.flatMap((p) => [p.absorption, p.shrinkage]),
    targets?.absorption?.max,
    targets?.shrinkage?.max,
    targets?.shrinkage?.min
  ].filter((v): v is number => v !== undefined);
  const { top, step } = niceTop(Math.max(...values));
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth);
  const y = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const column = plotWidth / Math.max(points.length - 1, 1);

  // End labels sit by each line's last point, unless they would run into each other.
  const ends = SERIES.map((series) => {
    const last = [...points.keys()].reverse().find((i) => points[i][series.key] !== undefined);
    return last === undefined ? null : { series, i: last, y: y(points[last][series.key]!) };
  });
  const labelled = ends[0] && ends[1] ? Math.abs(ends[0].y - ends[1].y) >= 14 : true;
  const inside = targets ? points.map((point) => insideTargets(point, targets)) : [];
  const range = points.filter((_, i) => inside[i]).map((p) => p.cone);
  const insideText = (i: number) => (inside[i] === null ? '—' : inside[i] ? 'Yes' : 'No');

  const shown = active === null ? null : points[active];
  return (
    <figure className="vitrification">
      <figcaption>
        <strong>Vitrification</strong>
        <span className="hint"> · from the test bars, averaged at each cone</span>
        {targets && (
          <p className="hint" role="status">
            {range.length
              ? `Inside the targets at ${conesText(range)}.`
              : 'No cone is inside the targets yet.'}{' '}
            Aimed for:{' '}
            {[
              targets.absorption && `absorption ${rangeText(targets.absorption.min?.toString(), targets.absorption.max?.toString())}`,
              targets.shrinkage && `total shrinkage ${rangeText(targets.shrinkage.min?.toString(), targets.shrinkage.max?.toString())}`
            ]
              .filter(Boolean)
              .join(', ')}
            .
          </p>
        )}
      </figcaption>
      <ul className="legend" aria-hidden="true">
        {SERIES.map((series) => (
          <li key={series.key}>
            <svg width="16" height="8">
              <line x1="0" y1="4" x2="16" y2="4" stroke={series.color} strokeWidth="2" strokeLinecap="round" />
            </svg>
            {series.label}
          </li>
        ))}
        {targets && (
          <li>
            <svg width="16" height="10">
              <rect width="16" height="10" fill="var(--muted)" className="target-swatch" />
            </svg>
            Shaded: the targets
          </li>
        )}
      </ul>
      <div className="chart-frame">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Absorption and total shrinkage against cone${targets ? ', with the targets as bands' : ''}; the table below has the values`}
          onPointerLeave={() => setActive(null)}
        >
          {SERIES.map((series) => {
            const band = targets?.[series.key];
            if (!band) return null;
            const [low, high] = [y(band.max ?? top), y(band.min ?? 0)];
            return (
              <rect
                key={series.key}
                className="target-band"
                x={PAD.left}
                width={plotWidth}
                y={low}
                height={Math.max(high - low, 1)}
                fill={series.color}
              />
            );
          })}
          {ticks.map((tick) => (
            <g key={tick} className="grid">
              <line x1={PAD.left} x2={PAD.left + plotWidth} y1={y(tick)} y2={y(tick)} />
              <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {tick}%
              </text>
            </g>
          ))}
          {points.map((point, i) => (
            <text key={point.cone} className="axis-label" x={x(i)} y={HEIGHT - PAD.bottom + 20} textAnchor="middle">
              {point.cone}
            </text>
          ))}
          <text className="axis-label" x={PAD.left + plotWidth / 2} y={HEIGHT - 2} textAnchor="middle">
            Cone
          </text>
          {active !== null && <line className="crosshair" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotHeight} />}
          {SERIES.map((series) => {
            const line = points
              .map((p, i) => (p[series.key] === undefined ? null : `${x(i)},${y(p[series.key]!)}`))
              .filter(Boolean)
              .join(' ');
            return (
              <g key={series.key}>
                <polyline points={line} fill="none" stroke={series.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {points.map((p, i) =>
                  p[series.key] === undefined ? null : (
                    <circle key={i} className="dot" cx={x(i)} cy={y(p[series.key]!)} r={active === i ? 5 : 4} fill={series.color} />
                  )
                )}
              </g>
            );
          })}
          {labelled &&
            ends.map(
              (end) =>
                end && (
                  <text key={end.series.key} className="end-label" x={x(end.i) + 10} y={end.y} dy="0.32em">
                    {end.series.label}
                  </text>
                )
            )}
          {/* A column per cone, wider than its dots, for the pointer and the keyboard. */}
          {points.map((point, i) => (
            <rect
              key={point.cone}
              className="hit"
              x={x(i) - column / 2}
              y={PAD.top}
              width={column}
              height={plotHeight}
              tabIndex={0}
              aria-label={`Cone ${point.cone}: absorption ${percent(point.absorption)}, total shrinkage ${percent(point.shrinkage)}${
                inside[i] === true ? ', inside the targets' : inside[i] === false ? ', outside the targets' : ''
              }`}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>
        {shown && active !== null && (
          <div
            className="chart-tooltip"
            role="status"
            style={{
              left: `${(x(active) / WIDTH) * 100}%`,
              top: `${(PAD.top / HEIGHT) * 100}%`,
              // Beside the crosshair, on whichever side has room.
              transform: x(active) > WIDTH / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)'
            }}
          >
            <div className="hint">
              Cone {shown.cone} · {shown.firings === 1 ? '1 firing' : `${shown.firings} firings`}
            </div>
            {SERIES.map((series) => (
              <div key={series.key} className="tooltip-row">
                <svg width="12" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="12" y2="4" stroke={series.color} strokeWidth="2" strokeLinecap="round" />
                </svg>
                <strong>{percent(shown[series.key])}</strong> <span className="hint">{series.label}</span>
              </div>
            ))}
            {inside[active] !== null && inside[active] !== undefined && (
              <div className="hint">{inside[active] ? 'Inside the targets' : 'Outside the targets'}</div>
            )}
          </div>
        )}
      </div>
      <details>
        <summary>As a table</summary>
        <table className="facts">
          <thead>
            <tr>
              <th scope="col">Cone</th>
              <th scope="col" className="num">
                Firings
              </th>
              <th scope="col" className="num">
                Absorption
              </th>
              <th scope="col" className="num">
                Total shrinkage
              </th>
              {targets && <th scope="col">Inside the targets</th>}
            </tr>
          </thead>
          <tbody>
            {points.map((point, i) => (
              <tr key={point.cone}>
                <th scope="row">{point.cone}</th>
                <td className="num">{point.firings}</td>
                <td className="num">{percent(point.absorption)}</td>
                <td className="num">{percent(point.shrinkage)}</td>
                {targets && <td>{insideText(i)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
