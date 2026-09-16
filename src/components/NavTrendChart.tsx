/** 净值走势图（真实数据：/api/detail 的 trend，近 240 个交易日） */
export function NavTrendChart({ points, up = true }: { points: { date: string; nav: number }[]; up?: boolean }) {
  const W = 300;
  const H = 132;
  const padY = 6;

  if (points.length < 2) return null;

  const navs = points.map((p) => p.nav);
  const min = Math.min(...navs);
  const max = Math.max(...navs);
  const span = max - min || 1;

  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => padY + (1 - (v - min) / span) * (H - padY * 2);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.nav).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const stroke = up ? '#E8303C' : '#1C9574';
  const gid = up ? 'navFillUp' : 'navFillDown';
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[132px] w-full" role="img" aria-label="净值走势">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          x1="0"
          x2={W}
          y1={(H * t).toFixed(1)}
          y2={(H * t).toFixed(1)}
          stroke="#EEF0F4"
          strokeWidth="1"
          strokeDasharray={t === 0.5 ? '3 3' : undefined}
        />
      ))}

      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={x(points.length - 1)} cy={y(last.nav)} r="3" fill={stroke} />
    </svg>
  );
}
