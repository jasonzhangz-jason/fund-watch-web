import { useMemo } from 'react';

/** 与矩阵序号一致的多条曲线配色（1..8） */
export const SERIES_COLORS = [
  '#1977FF',
  '#E8303C',
  '#1C9574',
  '#F5A524',
  '#8B5CF6',
  '#0EA5E9',
  '#EC4899',
  '#64748B',
];

/**
 * 归一化走势对比图（起点 = 100 的多条折线）
 *   各基金净值量级不同（1.x vs 3.x），归一化后画在同一坐标系才能直观比较走势相似程度。
 */
export default function TrendCompare({
  dates,
  series,
}: {
  dates: string[];
  series: Array<{ code: string; name: string; points: number[] }>;
}) {
  const W = 340;
  const H = 150;
  const PAD = { top: 8, right: 6, bottom: 16, left: 26 };

  const { lines, yMin, yMax, ticks } = useMemo(() => {
    const all = series.flatMap((s) => s.points).filter((v) => Number.isFinite(v));
    const lo = Math.min(...all, 100);
    const hi = Math.max(...all, 100);
    const span = Math.max(1, hi - lo);
    const pad = span * 0.12;
    const min = lo - pad;
    const max = hi + pad;
    const n = Math.max(1, dates.length - 1);
    const x = (i: number) => PAD.left + (i / n) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);
    return {
      lines: series.map((s) => ({ code: s.code, d: s.points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ') })),
      yMin: min,
      yMax: max,
      // 三条参考刻度：区间最低、100（起点）、区间最高
      ticks: [lo, 100, hi].filter((v, i, arr) => arr.indexOf(v) === i),
    };
  }, [dates.length, series]);

  if (!series.length || dates.length < 2) return null;

  const yOf = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);
  const label = (d: string) => d.slice(5); // MM-DD

  return (
    <div>
      <svg
        data-testid="trend-compare"
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="基金归一化走势对比"
      >
        {/* 参考线与刻度 */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke={t === 100 ? '#C8CDD6' : '#EFF1F4'}
              strokeWidth={t === 100 ? 1 : 1}
              strokeDasharray={t === 100 ? '3 3' : undefined}
            />
            <text x={PAD.left - 4} y={yOf(t) + 3} textAnchor="end" fontSize="8" fill="#9AA0AA">
              {t.toFixed(t === 100 ? 0 : 1)}
            </text>
          </g>
        ))}
        {/* 各基金走势 */}
        {lines.map((l, i) => (
          <path key={l.code} d={l.d} fill="none" stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth="1.4" />
        ))}
        {/* 时间轴首尾 */}
        <text x={PAD.left} y={H - 4} fontSize="8" fill="#9AA0AA">
          {label(dates[0])}
        </text>
        <text x={W - PAD.right} y={H - 4} textAnchor="end" fontSize="8" fill="#9AA0AA">
          {label(dates[dates.length - 1])}
        </text>
      </svg>

      {/* 图例：序号与矩阵一致 */}
      <ul data-testid="trend-legend" className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {series.map((s, i) => (
          <li key={s.code} className="flex items-center gap-1 text-[11px] text-ink-2">
            <i
              className="inline-block h-[3px] w-[12px] rounded-full"
              style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            <span className="tnum text-ink-3">{i + 1}</span>
            <span className="max-w-[92px] truncate">{s.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
