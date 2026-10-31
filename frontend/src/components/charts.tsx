import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Monotone cubic interpolation (Fritsch–Carlson) — smooth without overshooting the data. */
export function monotonePath(points: [number, number][]): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M${points[0][0]},${points[0][1]}`;
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    dy.push(points[i + 1][1] - points[i][1]);
    m.push(dy[i] / (dx[i] || 1));
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += `C${x0 + h},${y0 + t[i] * h} ${x1 - h},${y1 - t[i + 1] * h} ${x1},${y1}`;
  }
  return d;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/* ─────────── Sparkline ─────────── */

export function Sparkline({ data, color = 'var(--chart-1)', height = 36, width = 110, bars }: { data: number[]; color?: string; height?: number; width?: number; bars?: boolean }) {
  const gid = useId().replace(/:/g, '');
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  if (bars) {
    const bw = width / data.length;
    return (
      <svg width={width} height={height} aria-hidden>
        {data.map((v, i) => {
          const h = Math.max(2, ((v - min) / span) * (height - 2));
          return <rect key={i} x={i * bw + bw * 0.18} y={height - h} width={bw * 0.64} height={h} rx={1.5} fill={color} opacity={0.35 + (i / data.length) * 0.65} />;
        })}
      </svg>
    );
  }
  const pts: [number, number][] = data.map((v, i) => [(i / (data.length - 1 || 1)) * width, height - 3 - ((v - min) / span) * (height - 6)]);
  const line = monotonePath(pts);
  return (
    <svg width={width} height={height} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${width},${height}L0,${height}Z`} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.6} fill={color} />
    </svg>
  );
}

/* ─────────── Area / line chart ─────────── */

export interface Series {
  name: string;
  values: number[];
  color: string;
  dashed?: boolean;
  fill?: boolean;
}

export function AreaChart({ labels, series, height = 240, format = (v) => String(Math.round(v)), tickEvery }: { labels: string[]; series: Series[]; height?: number; format?: (v: number) => string; tickEvery?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');
  const pad = { l: 44, r: 8, t: 12, b: 26 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  // With no data the scale is a placeholder 0–1; labelling it would print fractions rounded to "0, 0, 1, 1".
  const empty = series.every((s) => s.values.every((v) => !(v > 0)));
  const n = labels.length;
  const x = (i: number) => pad.l + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => pad.t + h - (v / max) * h;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const every = tickEvery ?? Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));

  const onMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const rx = e.clientX - rect.left - pad.l;
    const i = Math.round((rx / (w || 1)) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <div className="chart" ref={ref} style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Chart of ${series.map((s) => s.name).join(', ')}`}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`${gid}-${i}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity="0.2" />
                <stop offset="1" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeDasharray={i === 0 ? undefined : '3 4'} />
              {(!empty || i === 0) && (
                <text x={pad.l - 10} y={y(t) + 3.5} textAnchor="end" className="axis-text">
                  {format(t)}
                </text>
              )}
            </g>
          ))}
          {labels.map((l, i) =>
            (i % every === 0 && n - 1 - i >= every * 0.7) || i === n - 1 ? (
              <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="axis-text">
                {l}
              </text>
            ) : null,
          )}
          {series.map((s, si) => {
            const pts = s.values.map((v, i) => [x(i), y(v)] as [number, number]);
            const d = monotonePath(pts);
            return (
              <g key={si}>
                {s.fill !== false && !s.dashed && <path d={`${d}L${x(n - 1)},${pad.t + h}L${x(0)},${pad.t + h}Z`} fill={`url(#${gid}-${si})`} />}
                <path d={d} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.4 : 2} strokeDasharray={s.dashed ? '4 4' : undefined} strokeLinecap="round" opacity={s.dashed ? 0.7 : 1} />
              </g>
            );
          })}
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} stroke="var(--text-3)" strokeDasharray="2 3" />
              {series.map((s, si) => (
                <circle key={si} cx={x(hover)} cy={y(s.values[hover])} r={4} fill="var(--surface)" stroke={s.color} strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover != null && width > 0 && (
        <div className="chart-tip" style={{ left: x(hover), top: y(Math.max(...series.map((s) => s.values[hover]))) }}>
          <div className="tip-label">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.name} className="tip-row">
              <i style={{ background: s.color }} />
              <span style={{ opacity: 0.7 }}>{s.name}</span>
              <b className="num" style={{ marginLeft: 'auto', paddingLeft: 12 }}>
                {format(s.values[hover])}
              </b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────── Bar chart (grouped or stacked) ─────────── */

export function BarChart({ labels, series, height = 220, stacked, format = (v) => String(Math.round(v)) }: { labels: string[]; series: Series[]; height?: number; stacked?: boolean; format?: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 4, t: 10, b: 26 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const n = labels.length;
  const totals = labels.map((_, i) => (stacked ? series.reduce((s, x) => s + x.values[i], 0) : Math.max(...series.map((x) => x.values[i]))));
  const max = niceMax(Math.max(1, ...totals));
  const empty = totals.every((t) => !(t > 0));
  const band = w / (n || 1);
  const inner = band * 0.62;
  const y = (v: number) => pad.t + h - (v / max) * h;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 46))));
  return (
    <div className="chart" ref={ref} style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Bar chart">
          {[0, 0.5, 1].map((f, i) => (
            <g key={i}>
              <line x1={pad.l} x2={pad.l + w} y1={y(f * max)} y2={y(f * max)} stroke="var(--chart-grid)" strokeDasharray={i ? '3 4' : undefined} />
              {(!empty || i === 0) && (
                <text x={pad.l - 10} y={y(f * max) + 3.5} textAnchor="end" className="axis-text">
                  {format(f * max)}
                </text>
              )}
            </g>
          ))}
          {labels.map((l, i) => {
            const x0 = pad.l + i * band + (band - inner) / 2;
            let acc = 0;
            return (
              <g key={i} onMouseEnter={() => setHover(i)} opacity={hover == null || hover === i ? 1 : 0.45} style={{ transition: 'opacity .15s' }}>
                <rect x={pad.l + i * band} y={pad.t} width={band} height={h} fill="transparent" />
                {series.map((s, si) => {
                  const v = s.values[i];
                  if (stacked) {
                    const top = y(acc + v);
                    const bh = y(acc) - top;
                    acc += v;
                    return <rect key={si} x={x0} y={top} width={inner} height={Math.max(0, bh - (si < series.length - 1 && bh > 2 ? 1.5 : 0))} rx={si === series.length - 1 ? 3 : 0} fill={s.color} />;
                  }
                  const bw = inner / series.length;
                  return <rect key={si} x={x0 + si * bw + 1} y={y(v)} width={Math.max(1, bw - 2)} height={pad.t + h - y(v)} rx={3} fill={s.color} />;
                })}
                {((i % every === 0 && n - 1 - i >= every * 0.7) || i === n - 1) && (
                  <text x={pad.l + i * band + band / 2} y={height - 6} textAnchor="middle" className="axis-text">
                    {l}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover != null && width > 0 && (
        <div className="chart-tip" style={{ left: pad.l + hover * band + band / 2, top: y(totals[hover]) }}>
          <div className="tip-label">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.name} className="tip-row">
              <i style={{ background: s.color }} />
              <span style={{ opacity: 0.7 }}>{s.name}</span>
              <b className="num" style={{ marginLeft: 'auto', paddingLeft: 12 }}>
                {format(s.values[hover])}
              </b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────── Donut ─────────── */

export function Donut({ segments, size = 168, thickness = 18, center }: { segments: { label: string; value: number; color: string }[]; size?: number; thickness?: number; center?: ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const gap = segments.length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} role="img" aria-label="Distribution">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill)" strokeWidth={thickness} />
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={hover === i ? thickness + 4 : thickness}
              strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
              strokeDashoffset={-offset}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ transition: 'stroke-width .15s', cursor: 'default' }}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none' }}>
        {hover != null ? (
          <div>
            <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.03em' }} className="num">
              {Math.round((segments[hover].value / total) * 100)}%
            </div>
            <div className="faint" style={{ fontSize: 11.5 }}>
              {segments[hover].label}
            </div>
          </div>
        ) : (
          center
        )}
      </div>
    </div>
  );
}

/* ─────────── Heatmap ─────────── */

export function Heatmap({ rows, cols, values, color = 'var(--ember)', format }: { rows: string[]; cols: string[]; values: number[][]; color?: string; format?: (v: number, r: string, c: string) => string }) {
  const max = Math.max(1, ...values.flat());
  return (
    <div className="heat" style={{ gridTemplateColumns: `44px repeat(${cols.length}, minmax(0, 1fr))` }}>
      <span />
      {cols.map((c) => (
        <span key={c} className="axis-text" style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>
          {c}
        </span>
      ))}
      {rows.map((r, ri) => (
        <Row key={r} label={r} values={values[ri]} max={max} color={color} title={(v, ci) => (format ? format(v, r, cols[ci]) : `${r} ${cols[ci]}: ${v}`)} />
      ))}
    </div>
  );
}

function Row({ label, values, max, color, title }: { label: string; values: number[]; max: number; color: string; title: (v: number, ci: number) => string }) {
  return (
    <>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)', alignSelf: 'center' }}>{label}</span>
      {values.map((v, ci) => {
        const t = v / max;
        return <span key={ci} className="heat-cell" title={title(v, ci)} style={{ background: v ? `color-mix(in srgb, ${color} ${Math.round(12 + t * 88)}%, var(--fill))` : undefined }} />;
      })}
    </>
  );
}

/* ─────────── Animated number ─────────── */

export function CountUp({ value, format = (v: number) => Math.round(v).toLocaleString('en-US') }: { value: number; format?: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    const b = value;
    if (a === b) return;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 600);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(a + (b - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(shown)}</>;
}

export function useSeries<T>(items: T[], buckets: { start: number; end: number }[], at: (x: T) => number, val: (x: T) => number = () => 1) {
  return useMemo(() => {
    const out = buckets.map(() => 0);
    for (const it of items) {
      const t = at(it);
      for (let i = 0; i < buckets.length; i++) {
        if (t >= buckets[i].start && t < buckets[i].end) {
          out[i] += val(it);
          break;
        }
      }
    }
    return out;
  }, [items, buckets, at, val]);
}
