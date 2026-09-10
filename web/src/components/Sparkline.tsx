import type { UsagePoint } from '@shared/types.ts';

/** Tiny inline SVG of 5h utilisation over the given span (default 48h). */
export function Sparkline({
  points,
  hours = 48,
  width = 160,
  height = 32,
}: {
  points: UsagePoint[] | null;
  hours?: number;
  width?: number;
  height?: number;
}) {
  if (!points) return <div className="spark spark-loading" style={{ width, height }} aria-hidden="true" />;
  const now = Date.now();
  const start = now - hours * 3600_000;
  const pts = points
    .map((p) => ({ t: Date.parse(p.ts), v: p.fiveHourPct }))
    .filter((p): p is { t: number; v: number } => p.v != null && !Number.isNaN(p.t) && p.t >= start)
    .sort((a, b) => a.t - b.t);

  const label = `5-hour utilisation over the last ${hours} hours`;
  if (pts.length < 2) {
    return (
      <svg className="spark" width={width} height={height} role="img" aria-label={`${label}: not enough data`}>
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} className="spark-base" />
      </svg>
    );
  }

  const x = (t: number) => ((t - start) / (now - start)) * width;
  const y = (v: number) => height - 1 - (Math.max(0, Math.min(100, v)) / 100) * (height - 2);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(pts[pts.length - 1].t).toFixed(1)},${height}L${x(pts[0].t).toFixed(1)},${height}Z`;
  const peak = Math.max(...pts.map((p) => p.v));

  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: peak ${Math.round(peak)}%`}>
      <line x1={0} x2={width} y1={y(90)} y2={y(90)} className="spark-crit" />
      <line x1={0} x2={width} y1={y(70)} y2={y(70)} className="spark-warn" />
      <path d={area} className="spark-area" />
      <path d={line} className="spark-line" />
    </svg>
  );
}
