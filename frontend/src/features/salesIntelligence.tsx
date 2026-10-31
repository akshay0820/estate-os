// Agent 08 — Sales intelligence, live mode: the executive dashboard, funnel, source / team breakdowns, trends, insights,
// forecasts, the analyst, and the live Reports page. Every number comes from the server's metric layer (si_*), with its
// definition, comparison window, sample flags and data quality caveats. Unavailable or restricted metrics say so.
import { useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Download, Lightbulb, LineChart, MessageSquareText, RefreshCw, Sparkles } from 'lucide-react';
import { AreaChart } from '@/components/charts';
import { Badge, Button, Checkbox, Empty, Input, PageHeader, Select, Tabs } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { toast } from '@/store/ui';
import { useOrgList } from '@/store/hooks';
import { fmtDateTime, relTime } from '@/lib/format';
import { downloadCsv } from '@/lib/util';
import { navigate } from '@/lib/router';
import type { Tone } from '@/lib/domain';
import { LIVE } from '@/store/store';
import { usePollWhile, useServerQuery, type ServerQuery } from '@/data/useServerQuery';
import { attempt, ok } from '@/data/actions';
import * as live from '@/backend/live';

const PRESETS: { value: live.SiPreset; label: string }[] = [
  { value: 'last_7_days', label: 'Last 7 days' }, { value: 'last_30_days', label: 'Last 30 days' }, { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' }, { value: 'this_quarter', label: 'This quarter' }, { value: 'last_quarter', label: 'Last quarter' },
  { value: 'last_90_days', label: 'Last 90 days' }, { value: 'this_year', label: 'This year' },
];

export function fmtMetric(v: number | undefined | null, unit: string, currency?: string) {
  if (v === undefined || v === null) return '—';
  if (unit === 'rate') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'minutes') return v >= 120 ? `${(v / 60).toFixed(1)} h` : `${Math.round(v)} min`;
  if (unit === 'days') return `${v.toFixed(1)} d`;
  if (unit === 'money') return `${currency ?? ''} ${Math.round(v).toLocaleString('en-US')}`.trim();
  return Math.round(v).toLocaleString('en-US');
}

function change(r: live.SiRow, unit: string) {
  if (r.previous_value === undefined) return null;
  if (unit === 'rate') {
    const pts = ((r.value ?? 0) - r.previous_value) * 100;
    return `${pts >= 0 ? '+' : ''}${pts.toFixed(1)} pts vs ${fmtMetric(r.previous_value, unit)}`;
  }
  return `vs ${fmtMetric(r.previous_value, unit, r.currency)}${r.change_pct !== undefined ? ` (${r.change_pct > 0 ? '+' : ''}${r.change_pct}%)` : ''}`;
}

/* ─────────────────────────── page ─────────────────────────── */

type Tab = 'overview' | 'funnel' | 'sources' | 'team' | 'trends' | 'insights' | 'forecast' | 'analyst';

export function SalesIntelligencePage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [preset, setPreset] = useState<live.SiPreset>('last_30_days');
  const [filters, setFilters] = useState<live.SiFilters>({});
  const ov = useServerQuery(LIVE, () => live.siOverview(preset, filters), [preset, JSON.stringify(filters)]);
  const can = ov.data?.can;
  if (!LIVE) {
    return (
      <div className="page">
        <PageHeader eyebrow="[ Sales Intelligence Agent ]" title="Sales intelligence" />
        <Empty icon={<LineChart size={20} />} title="Available with live data" description="Sales intelligence is computed from the workspace database; the demo has no server to compute it." />
      </div>
    );
  }
  const tabs: { value: Tab; label: string }[] = [
    { value: 'overview', label: 'Overview' }, { value: 'funnel', label: 'Funnel' }, { value: 'sources', label: 'Lead sources' },
    ...(can?.team ? [{ value: 'team' as Tab, label: 'Team' }] : []), { value: 'trends', label: 'Trends' }, { value: 'insights', label: 'Insights' },
    ...(can?.finance ? [{ value: 'forecast' as Tab, label: 'Forecast' }] : []), { value: 'analyst', label: 'Ask' },
  ];
  return (
    <div className="page">
      <PageHeader eyebrow="[ Sales Intelligence Agent ]" title="Sales intelligence"
        sub="Metrics computed from your CRM with fixed definitions. Every rate shows its denominator and every comparison its window; AI only interprets these numbers." />
      <FilterBar preset={preset} setPreset={setPreset} filters={filters} setFilters={setFilters} canTeam={can?.team ?? false} />
      {ov.data && ov.data.caveats.length > 0 && (
        <div className="banner warning mt-8" style={{ display: 'block', fontSize: 12.5 }}>
          <AlertTriangle size={14} /> {ov.data.caveats.map((c) => c.text).join(' · ')}
          {ov.data.caveats.some((c) => c.code !== 'immature_cohort') && <> · <button className="link" onClick={() => navigate('dataquality')}>Data quality</button></>}
        </div>
      )}
      <div className="mt-12"><Tabs value={tab} onChange={setTab} tabs={tabs} /></div>
      {tab === 'overview' && <OverviewTab q={ov} />}
      {tab === 'funnel' && <FunnelTab preset={preset} filters={filters} />}
      {tab === 'sources' && <BreakdownTab dim="source" preset={preset} filters={filters} finance={can?.finance ?? false} />}
      {tab === 'team' && <BreakdownTab dim="assignee" preset={preset} filters={filters} finance={can?.finance ?? false} />}
      {tab === 'trends' && <TrendsTab preset={preset} filters={filters} />}
      {tab === 'insights' && <InsightsTab canManage={(can?.team || can?.settings) ?? false} />}
      {tab === 'forecast' && <ForecastTab />}
      {tab === 'analyst' && <AnalystTab />}
    </div>
  );
}

function FilterBar({ preset, setPreset, filters, setFilters, canTeam }: { preset: live.SiPreset; setPreset: (p: live.SiPreset) => void; filters: live.SiFilters;
  setFilters: (f: live.SiFilters) => void; canTeam: boolean }) {
  const sources = useServerQuery(true, () => live.leadSources(), []);
  const members = useOrgList('members');
  const set = (k: keyof live.SiFilters, v: string) => setFilters(Object.fromEntries(Object.entries({ ...filters, [k]: v || undefined }).filter(([, x]) => x)) as live.SiFilters);
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      <Select selectSize="sm" value={preset} onChange={(e) => setPreset(e.target.value as live.SiPreset)} style={{ width: 150 }} aria-label="Period">
        {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </Select>
      <Select selectSize="sm" value={filters.source ?? ''} onChange={(e) => set('source', e.target.value)} style={{ width: 150 }} aria-label="Lead source">
        <option value="">All sources</option>
        {(sources.data ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
      </Select>
      {canTeam && (
        <Select selectSize="sm" value={filters.assignee ?? ''} onChange={(e) => set('assignee', e.target.value)} style={{ width: 160 }} aria-label="Owner">
          <option value="">Whole team</option>
          {members.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
      )}
      <Select selectSize="sm" value={filters.property_type ?? ''} onChange={(e) => set('property_type', e.target.value)} style={{ width: 150 }} aria-label="Property type">
        <option value="">Any property type</option>
        {['apartment', 'penthouse', 'villa', 'house', 'townhouse', 'plot', 'office', 'retail', 'commercial', 'other'].map((x) => <option key={x} value={x}>{x}</option>)}
      </Select>
      <Select selectSize="sm" value={filters.transaction ?? ''} onChange={(e) => set('transaction', e.target.value)} style={{ width: 140 }} aria-label="Transaction">
        <option value="">Any transaction</option>
        {['buy', 'rent', 'sell', 'let', 'invest'].map((x) => <option key={x} value={x}>{x}</option>)}
      </Select>
    </div>
  );
}

const GROUPS: { title: string; ids: string[] }[] = [
  { title: 'Leads', ids: ['leads_created', 'leads_contacted', 'leads_qualified', 'qualification_rate', 'leads_awaiting_qualification', 'leads_human_review', 'leads_no_next_action', 'leads_follow_up_overdue'] },
  { title: 'Response & activity', ids: ['median_first_response_minutes', 'median_first_call_minutes', 'calls_attempted', 'calls_connected', 'follow_ups_sent', 'follow_ups_delivered', 'follow_ups_failed'] },
  { title: 'Appointments', ids: ['appointments_booked', 'qualified_to_appointment_rate', 'appointments_completed', 'attendance_rate', 'appointments_no_show', 'appointments_cancelled', 'appointments_outcome_unknown'] },
  { title: 'Deals & revenue', ids: ['deals_opened', 'deals_won', 'deal_win_rate', 'open_deals', 'pipeline_value', 'closed_deal_value', 'average_deal_value', 'commission_revenue'] },
];

function OverviewTab({ q }: { q: ServerQuery<live.SiOverview> }) {
  if (q.error) return <Empty icon={<BarChart3 size={20} />} title="Couldn't load sales intelligence" description={q.error} action={<Button onClick={q.reload}>Retry</Button>} />;
  if (!q.data) return <div className="skeleton mt-8" style={{ height: 240 }} />;
  const d = q.data;
  return (
    <div className="stack mt-8">
      <p className="faint" style={{ fontSize: 12 }}>
        {fmtDateTime(new Date(d.period.from).getTime())} – {fmtDateTime(new Date(d.period.to).getTime())} ({d.period.timezone}), compared with
        {' '}{fmtDateTime(new Date(d.previous_period.from).getTime())} – {fmtDateTime(new Date(d.previous_period.to).getTime())}. Computed {relTime(new Date(d.computed_at).getTime())}.
        {' '}{d.unavailable.attribution}. {d.unavailable.cost_per_lead}; cost per lead and ROI are not shown.{d.unavailable.targets ? ` ${d.unavailable.targets}.` : ''}
      </p>
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h4 className="section-title">{g.title}</h4>
          <div className="grid g-kpi">
            {g.ids.map((id) => d.kpis[id] && <Kpi key={id} r={d.kpis[id]} target={d.targets[id]} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function Kpi({ r, target }: { r: live.SiResult; target?: number }) {
  const body = r.restricted ? <span className="faint" style={{ fontSize: 12.5 }}>Needs finance access</span>
    : r.available === false ? <span className="faint" style={{ fontSize: 12.5 }}>Unavailable: {r.reason}</span>
    : r.rows.length === 0 ? <span className="faint" style={{ fontSize: 12.5 }}>{r.unit === 'money' ? 'No deals in this window' : 'No data in this window'}</span>
    : r.rows.map((row) => (
      <div key={(row.currency ?? '') + row.key}>
        <div className="kpi-value" style={{ fontSize: 22, marginTop: 4 }}>{fmtMetric(row.value, r.unit, row.currency)}</div>
        <div className="faint" style={{ fontSize: 11.5 }}>
          {r.basis === 'snapshot' ? 'right now' : change(row, r.unit)}
          {r.unit === 'rate' && row.denominator !== undefined ? ` · ${row.numerator ?? 0}/${row.denominator}` : ''}
          {row.low_sample ? ' · small sample' : ''}
          {target !== undefined && r.unit === 'count' ? ` · target ${target}` : ''}
        </div>
      </div>
    ));
  return (
    <div className="card kpi" title={r.definition}>
      <div className="kpi-label">{r.label}{r.basis === 'cohort' && <span className="period">cohort</span>}</div>
      {body}
    </div>
  );
}

function FunnelTab({ preset, filters }: { preset: live.SiPreset; filters: live.SiFilters }) {
  const [mature, setMature] = useState(false);
  const q = useServerQuery(true, () => live.siFunnel(preset, filters, mature), [preset, JSON.stringify(filters), mature]);
  const d = q.data;
  return (
    <div className="card mt-8">
      <div className="toolbar">
        <Checkbox checked={mature} onChange={setMature} label={`Only leads older than ${d?.cohort.maturity_days ?? 30} days (mature cohort)`} />
      </div>
      {q.error ? <p className="faint" style={{ padding: 12 }}>Couldn't load the funnel. {q.error}</p> : !d ? <div className="skeleton" style={{ height: 200 }} /> : (
        <div style={{ padding: 14 }}>
          <p className="faint" style={{ fontSize: 12.5 }}>{d.cohort.leads} leads created in the period{d.cohort.immature ? `; ${d.cohort.immature} are younger than ${d.cohort.maturity_days} days and may still progress` : ''}. {d.definition}</p>
          {d.cohort.leads === 0 ? <Empty icon={<BarChart3 size={20} />} title="No leads in this cohort" /> : (
            <table className="table mt-8">
              <thead><tr><th>Stage</th><th>Leads</th><th /><th>Step conversion</th><th>Drop-off</th><th>Median days from capture</th></tr></thead>
              <tbody>
                {d.stages.map((s) => (
                  <tr key={s.stage}>
                    <td>{s.label}</td>
                    <td>{s.leads}</td>
                    <td style={{ width: 200 }}><div style={{ height: 8, borderRadius: 4, background: 'var(--accent)', width: `${Math.max(2, (s.share_of_cohort ?? 0) * 100)}%` }} /></td>
                    <td>{s.step_conversion !== undefined && s.step_conversion !== null ? `${(s.step_conversion * 100).toFixed(1)}% of ${s.step_base}` : s.stage === 'captured' ? '—' : 'n/a'}
                      {s.low_sample && s.stage !== 'captured' ? <span className="faint"> · small sample</span> : null}</td>
                    <td>{s.drop_off ?? '—'}</td>
                    <td>{s.median_days_from_capture ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const BREAKDOWN: Record<string, string[]> = {
  source: ['leads_created', 'qualification_rate', 'qualified_to_appointment_rate', 'appointments_booked', 'attendance_rate', 'deals_won', 'median_days_to_qualified'],
  assignee: ['leads_created', 'leads_contacted', 'median_first_response_minutes', 'leads_qualified', 'appointments_booked', 'appointments_completed', 'deals_won', 'leads_no_next_action'],
};

function BreakdownTab({ dim, preset, filters, finance }: { dim: 'source' | 'assignee'; preset: live.SiPreset; filters: live.SiFilters; finance: boolean }) {
  const metrics = [...BREAKDOWN[dim], ...(finance ? ['closed_deal_value'] : [])];
  const q = useServerQuery(true, () => live.siBreakdown(dim, metrics, preset, dim === 'assignee' ? { ...filters, assignee: undefined } : filters), [dim, preset, JSON.stringify(filters)]);
  const d = q.data;
  const keys = useMemo(() => {
    if (!d) return [] as { key: string; label: string }[];
    const m = new Map<string, string>();
    Object.values(d.metrics).forEach((r) => r.rows?.forEach((row) => m.set(row.key, row.label ?? row.key)));
    const lc = d.metrics.leads_created?.rows ?? [];
    return [...m.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => (lc.find((r) => r.key === b.key)?.value ?? 0) - (lc.find((r) => r.key === a.key)?.value ?? 0));
  }, [d]);
  return (
    <div className="card mt-8">
      {q.error ? <p className="faint" style={{ padding: 12 }}>Couldn't load the breakdown. {q.error}</p> : !d ? <div className="skeleton" style={{ height: 200 }} />
        : keys.length === 0 ? <Empty icon={<BarChart3 size={20} />} title="No activity in this period" /> : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{dim === 'source' ? 'Source' : 'Owner'}</th>{metrics.map((m) => <th key={m} title={d.metrics[m]?.definition}>{d.metrics[m]?.label ?? m}</th>)}</tr></thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.key}>
                      <td>{k.label}</td>
                      {metrics.map((m) => {
                        const r = d.metrics[m];
                        const rowsFor = r?.rows?.filter((x) => x.key === k.key) ?? [];
                        return <td key={m} style={{ fontSize: 12.5 }}>{r?.restricted ? '—' : rowsFor.length === 0 ? '—' : rowsFor.map((x) => (
                          <div key={x.currency ?? 'x'}>{fmtMetric(x.value, r.unit, x.currency)}{x.low_sample ? <span className="faint"> *</span> : null}</div>))}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="faint" style={{ fontSize: 12, padding: '8px 14px' }}>* small sample. {d.notes.join('. ')}.</p>
          </>
        )}
    </div>
  );
}

function TrendsTab({ preset, filters }: { preset: live.SiPreset; filters: live.SiFilters }) {
  const bucket = ['last_7_days', 'last_30_days', 'this_month', 'last_month'].includes(preset) ? 'day' : 'week';
  const q = useServerQuery(true, () => live.siBreakdown(bucket, ['leads_created', 'leads_qualified', 'appointments_booked'], preset, filters), [preset, JSON.stringify(filters)]);
  const d = q.data;
  const chart = useMemo(() => {
    if (!d) return null;
    const keys = [...new Set(Object.values(d.metrics).flatMap((r) => r.rows.map((x) => x.key)))].sort();
    const series = (id: string, color: string) => ({ name: d.metrics[id].label, color, values: keys.map((k) => d.metrics[id].rows.find((x) => x.key === k)?.value ?? 0) });
    return { keys, series: [series('leads_created', 'var(--chart-1)'), series('leads_qualified', 'var(--chart-2)'), series('appointments_booked', 'var(--chart-3)')] };
  }, [d]);
  return (
    <div className="card mt-8" style={{ padding: 14 }}>
      {q.error ? <p className="faint">Couldn't load trends. {q.error}</p> : !chart ? <div className="skeleton" style={{ height: 240 }} />
        : chart.keys.length === 0 ? <Empty icon={<LineChart size={20} />} title="No activity in this period" /> : (
          <>
            <AreaChart labels={chart.keys} series={chart.series} />
            <p className="faint mt-8" style={{ fontSize: 12 }}>Per {bucket} in the organization's time zone. New and qualified leads by creation date (cohort); appointments by booking date. Periods without activity show zero.</p>
          </>
        )}
    </div>
  );
}

const PRIORITY: Record<string, Tone> = { high: 'danger', medium: 'warning', low: 'neutral' };
const NEXT: Record<live.SiInsight['status'], { to: live.SiInsight['status']; label: string; note?: string }[]> = {
  new: [{ to: 'accepted', label: 'Accept' }, { to: 'reviewed', label: 'Mark reviewed' }, { to: 'dismissed', label: 'Dismiss', note: 'Why is it dismissed?' }],
  reviewed: [{ to: 'accepted', label: 'Accept' }, { to: 'dismissed', label: 'Dismiss', note: 'Why is it dismissed?' }],
  accepted: [{ to: 'in_progress', label: 'Start' }, { to: 'completed', label: 'Mark done', note: 'What was done?' }],
  in_progress: [{ to: 'completed', label: 'Mark done', note: 'What was done?' }, { to: 'dismissed', label: 'Drop', note: 'Why is it dropped?' }],
  dismissed: [], completed: [], expired: [{ to: 'dismissed', label: 'Dismiss', note: 'Why is it dismissed?' }],
};

function InsightsTab({ canManage }: { canManage: boolean }) {
  const [view, setView] = useState<'open' | 'closed'>('open');
  const q = useServerQuery(true, () => live.siInsights(view === 'open' ? ['new', 'reviewed', 'accepted', 'in_progress'] : ['completed', 'dismissed', 'expired']), [view]);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack mt-8">
      <div className="row wrap" style={{ gap: 8 }}>
        <Select selectSize="sm" value={view} onChange={(e) => setView(e.target.value as 'open' | 'closed')} style={{ width: 160 }} aria-label="Show">
          <option value="open">Open</option><option value="closed">Closed and expired</option>
        </Select>
        {canManage && <Button size="sm" icon={<RefreshCw size={14} />} loading={busy} onClick={async () => {
          setBusy(true); const r = await attempt(() => live.siEvaluateNow()); setBusy(false);
          if (r) toast({ kind: 'info', title: 'Checks re-run', body: r.detected.length ? `${r.detected.length} conditions detected.` : 'Nothing unusual detected.' });
        }}>Re-run checks</Button>}
        {canManage && <Button size="sm" icon={<Sparkles size={14} />} loading={busy} onClick={async () => {
          setBusy(true); const r = await attempt(() => live.siGenerateRecommendations()); setBusy(false);
          if (!r) return;
          const msg: Record<string, string> = { not_configured: 'AI recommendations are not configured for this workspace. Rule-based findings below still apply.',
            timeout: 'The AI did not answer in time.', model_error: 'The AI request failed.', invalid_output: 'The AI answer failed validation and was discarded.', rejected: r.message ?? 'Rejected.',
            rate_limited: 'Too many AI requests right now. Try again later.', guard_unavailable: 'AI requests are unavailable right now.', paused: 'This AI feature is paused for your agency.', refused: r.message ?? 'Not allowed.' };
          toast(r.status === 'ok' ? { kind: 'success', title: `${r.saved ?? 0} recommendations saved`, body: r.rejected?.length ? `${r.rejected.length} were discarded because they cited numbers not in the data.` : 'Each cites the metrics it is based on.' }
            : { kind: 'info', title: 'No recommendations', body: msg[r.status] ?? r.message ?? 'The request could not be completed.' });
        }}>Generate AI recommendations</Button>}
      </div>
      {q.error ? <p className="faint">Couldn't load insights. {q.error}</p> : !q.data ? <div className="skeleton" style={{ height: 160 }} />
        : q.data.length === 0 ? <Empty icon={<Lightbulb size={20} />} title="Nothing here" description="Checks run daily: intake, qualification, cancellations, response time, follow-up failures, workload, funnel drop-off, attendance, unmatched leads and data quality." />
        : q.data.map((x) => (
          <div key={x.id} className="card" style={{ padding: 14 }}>
            <div className="row wrap" style={{ gap: 6 }}>
              <Badge tone={PRIORITY[x.priority]}>{x.priority}</Badge>
              <Badge tone={x.kind === 'recommendation' ? 'accent' : x.kind === 'anomaly' ? 'warning' : 'info'}>{x.kind}{x.generated_by === 'ai' ? ' · AI' : ''}</Badge>
              <b className="grow">{x.title}</b>
              <span className="faint" style={{ fontSize: 12 }}>{x.status.replace('_', ' ')} · {relTime(new Date(x.last_detected_at).getTime())}</span>
            </div>
            <p style={{ fontSize: 13, marginTop: 6 }}>{x.summary}</p>
            {x.observation && <p className="faint" style={{ fontSize: 12.5 }}><b>Observed:</b> {x.observation}</p>}
            {x.interpretation && <p className="faint" style={{ fontSize: 12.5 }}><b>May mean:</b> {x.interpretation}</p>}
            {x.recommended_action && <p style={{ fontSize: 12.5 }}><b>Suggested next step:</b> {x.recommended_action}</p>}
            {x.supporting_metrics.length > 0 && <p className="faint mono" style={{ fontSize: 11.5 }}>Evidence: {x.supporting_metrics.map((m) => `${m.metric} = ${m.value}`).join(' · ')}</p>}
            {x.limitations.length > 0 && <p className="faint" style={{ fontSize: 12 }}>Limitations: {x.limitations.join('; ')}</p>}
            {x.observation_from && <p className="faint" style={{ fontSize: 11.5 }}>Window: {fmtDateTime(new Date(x.observation_from).getTime())} – {x.observation_to ? fmtDateTime(new Date(x.observation_to).getTime()) : 'now'}</p>}
            {x.feedback_note && <p className="faint" style={{ fontSize: 12 }}>Note: {x.feedback_note}</p>}
            {canManage && NEXT[x.status].length > 0 && (
              <div className="row wrap mt-8" style={{ gap: 4 }}>
                {NEXT[x.status].map((n) => (
                  <Button key={n.to} size="xs" variant={n.to === 'accepted' ? 'primary' : 'ghost'} onClick={async () => {
                    let note: string | undefined;
                    if (n.note) { const c = await confirm({ title: n.label, input: { label: n.note, required: true }, confirmLabel: n.label }); if (!c.ok) return; note = c.value; }
                    if (await ok(() => live.siInsightFeedback(x.id, n.to, note))) q.reload();
                  }}>{n.label}</Button>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

function ForecastTab() {
  const q = useServerQuery(true, () => live.siForecasts(), []);
  usePollWhile(!!q.data?.some((f) => f.status === 'queued'), q.reload);
  const [days, setDays] = useState('30');
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return (
    <div className="stack mt-8">
      <div className="row wrap" style={{ gap: 8 }}>
        <Select selectSize="sm" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 160 }} aria-label="Horizon">
          <option value="30">Next 30 days</option><option value="90">Next 90 days</option><option value="180">Next 180 days</option>
        </Select>
        <Button size="sm" icon={<LineChart size={14} />} onClick={async () => {
          const r = await attempt(() => live.siForecastRequest(iso(today), iso(new Date(today.getTime() + Number(days) * 864e5))));
          if (r) toast({ kind: 'info', title: 'Forecast queued', body: 'It is computed in the background within a minute.' });
        }}>Run forecast</Button>
      </div>
      {q.error ? <p className="faint">Couldn't load forecasts. {q.error}</p> : !q.data ? <div className="skeleton" style={{ height: 120 }} />
        : q.data.length === 0 ? <Empty icon={<LineChart size={20} />} title="No forecasts yet" description="A forecast weights open deals closing in the horizon by the historical win rate (or configured stage probabilities)." />
        : q.data.map((f) => (
          <div key={f.id} className="card" style={{ padding: 14 }}>
            <div className="row" style={{ gap: 8 }}>
              <b className="grow">{f.horizon_start} → {f.horizon_end}</b>
              <Badge tone={f.status === 'completed' ? 'success' : f.status === 'queued' ? 'neutral' : 'warning'}>{f.status.replace('_', ' ')}</Badge>
              <span className="faint" style={{ fontSize: 12 }}>{f.method?.replace(/_/g, ' ') ?? ''}</span>
            </div>
            {Object.entries(f.results).map(([cur, r]) => (
              <div key={cur} className="mt-8" style={{ fontSize: 12.5 }}>
                <b>{cur}</b>: {r.status === 'completed' ? <>forecast {fmtMetric(r.forecast_value, 'money', cur)} · commission {fmtMetric(r.commission_forecast, 'money', cur)}</>
                  : <>insufficient history ({r.closed_deals_in_history} closed deals; {r.min_closed_deals} needed)</>}
                <div className="faint">Scenarios (not a confidence interval): under contract {fmtMetric(r.scenario_low_committed, 'money', cur)} · all open in window {fmtMetric(r.scenario_high_all_open, 'money', cur)}.
                  {' '}{r.open_deals_in_window} open deals in window; {r.open_deals_without_close_date} without a close date and {r.open_deals_overdue} overdue are excluded.
                  {r.historical_win_rate !== null ? ` Win rate ${(r.historical_win_rate * 100).toFixed(1)}% over ${r.closed_deals_in_history} closed deals.` : ''}</div>
                {f.actuals && <div className="faint">Actual closed: {fmtMetric(f.actuals[cur] ?? 0, 'money', cur)}{f.abs_error?.[cur] !== undefined ? ` · absolute error ${fmtMetric(f.abs_error[cur], 'money', cur)}` : ''}</div>}
              </div>
            ))}
            {f.assumptions.length > 0 && <p className="faint mt-8" style={{ fontSize: 11.5 }}>Assumptions: {f.assumptions.join(' · ')}</p>}
          </div>
        ))}
    </div>
  );
}

function AnalystTab() {
  const cat = useServerQuery(true, () => live.siCatalogue(), []);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; result?: live.SiResult; spec?: Record<string, unknown> } | null>(null);
  const [prev, setPrev] = useState<Record<string, unknown> | null>(null);
  const [spec, setSpec] = useState<{ metric: string; group_by: string; preset: live.SiPreset; compare: boolean }>({ metric: 'leads_created', group_by: '', preset: 'last_30_days', compare: true });
  const ask = async () => {
    setBusy(true);
    const r = await attempt(() => live.siAsk(question, prev));
    setBusy(false);
    if (!r) return;
    const msg: Record<string, string> = { not_configured: 'Natural-language questions are not configured for this workspace (no model key). Use the query builder below.',
      unsupported: `That cannot be answered from the available data: ${r.message}`, refused: r.message ?? 'Not allowed.', invalid_output: 'The question could not be mapped to a supported metric.',
      timeout: 'The AI did not answer in time.', model_error: 'The AI request failed.',
      rate_limited: 'Too many AI requests right now. Try again later.', guard_unavailable: 'AI requests are unavailable right now.', paused: 'This AI feature is paused for your agency.', };
    if (r.status === 'ok') { setAnswer({ text: r.answer!, result: r.result, spec: r.spec }); setPrev(r.spec ?? null); }
    else setAnswer({ text: msg[r.status] ?? r.message ?? 'The question could not be answered.' });
  };
  const run = async () => {
    const r = await attempt(() => live.siQuery({ metric: spec.metric, preset: spec.preset, compare: spec.compare, ...(spec.group_by ? { group_by: spec.group_by } : {}) }));
    if (r) setAnswer({ text: `${r.label}${spec.group_by ? ` by ${spec.group_by.replace('_', ' ')}` : ''}`, result: r, spec });
  };
  const m = cat.data?.[spec.metric];
  return (
    <div className="stack mt-8">
      <div className="card" style={{ padding: 14 }}>
        <div className="row" style={{ gap: 8 }}>
          <Input value={question} maxLength={500} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which source produced the most qualified leads last quarter?"
            onKeyDown={(e) => { if (e.key === 'Enter' && question.trim().length >= 3) void ask(); }} />
          <Button variant="primary" icon={<MessageSquareText size={14} />} loading={busy} disabled={question.trim().length < 3} onClick={() => void ask()}>Ask</Button>
        </div>
        <p className="faint mt-8" style={{ fontSize: 12 }}>Questions are mapped to the metric catalogue and answered from computed results only. {prev ? 'Follow-up questions build on the previous query.' : ''}</p>
      </div>
      <div className="card" style={{ padding: 14 }}>
        <h4 className="section-title">Query builder</h4>
        <div className="row wrap" style={{ gap: 8 }}>
          <Select selectSize="sm" value={spec.metric} onChange={(e) => setSpec({ ...spec, metric: e.target.value, group_by: '' })} style={{ width: 220 }} aria-label="Metric">
            {Object.entries(cat.data ?? {}).sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([id, x]) => <option key={id} value={id}>{x.label}</option>)}
          </Select>
          <Select selectSize="sm" value={spec.group_by} onChange={(e) => setSpec({ ...spec, group_by: e.target.value })} style={{ width: 160 }} aria-label="Group by">
            <option value="">No breakdown</option>
            {(m?.dims ?? []).map((d) => <option key={d} value={d}>by {d.replace('_', ' ')}</option>)}
          </Select>
          <Select selectSize="sm" value={spec.preset} onChange={(e) => setSpec({ ...spec, preset: e.target.value as live.SiPreset })} style={{ width: 150 }} aria-label="Period">
            {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
          <Checkbox checked={spec.compare} onChange={(v) => setSpec({ ...spec, compare: v })} label="Compare with previous period" />
          <Button size="sm" onClick={() => void run()}>Run</Button>
        </div>
        {m && <p className="faint mt-8" style={{ fontSize: 12 }}>{m.definition}</p>}
      </div>
      {answer && (
        <div className="card" style={{ padding: 14 }}>
          <p style={{ fontSize: 13.5 }}>{answer.text}</p>
          {answer.result && answer.result.rows.length > 0 && (
            <table className="table mt-8" style={{ fontSize: 12.5 }}>
              <thead><tr><th>{answer.result.group_by ? answer.result.group_by.replace('_', ' ') : ''}</th><th>Value</th><th>Previous</th><th>Base</th></tr></thead>
              <tbody>
                {answer.result.rows.map((r) => (
                  <tr key={r.key + (r.currency ?? '')}>
                    <td>{r.label ?? r.key}</td><td>{fmtMetric(r.value, answer.result!.unit, r.currency)}{r.low_sample ? ' *' : ''}</td>
                    <td>{fmtMetric(r.previous_value, answer.result!.unit, r.currency)}</td><td>{r.denominator ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {answer.result?.caveats && answer.result.caveats.length > 0 && <p className="faint mt-8" style={{ fontSize: 12 }}>Caveats: {answer.result.caveats.map((c) => c.text).join(' · ')}</p>}
          {answer.result?.definition && <p className="faint" style={{ fontSize: 11.5 }}>Definition: {answer.result.definition}</p>}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── reports (live) ─────────────────────────── */

const REPORTS: { value: string; label: string; needs?: 'team' | 'finance' }[] = [
  { value: 'executive_summary', label: 'Executive sales summary' }, { value: 'lead_sources', label: 'Lead source performance' }, { value: 'funnel', label: 'Sales funnel analysis' },
  { value: 'team', label: 'Representative performance', needs: 'team' }, { value: 'appointments_follow_ups', label: 'Appointments and follow-ups' },
  { value: 'pipeline_forecast', label: 'Pipeline and forecast', needs: 'finance' }, { value: 'data_quality_impact', label: 'Data quality impact' },
  { value: 'recommendations', label: 'Sales intelligence recommendations' },
];

function reportCsv(result: Record<string, unknown>) {
  const out: (string | number | null | undefined)[][] = [['Report', String(result.title)], ['Organization', String(result.organization)],
    ['Period', `${(result.period as { from: string }).from} – ${(result.period as { to: string }).to}`], ['Generated', String(result.generated_at)], [],
    ['Metric', 'Group', 'Currency', 'Value', 'Previous', 'Numerator', 'Denominator', 'Small sample', 'Definition']];
  for (const [id, r] of Object.entries((result.metrics ?? {}) as Record<string, live.SiResult>)) {
    if (r.available === false) { out.push([r.label ?? id, '', '', `unavailable: ${r.reason}`]); continue; }
    for (const row of r.rows ?? []) out.push([r.label, row.label ?? row.key, row.currency, row.value, row.previous_value, row.numerator, row.denominator, row.low_sample ? 'yes' : '', r.definition]);
  }
  const caveats = (result.caveats ?? []) as { text: string }[];
  if (caveats.length) { out.push([]); caveats.forEach((c) => out.push(['Caveat', c.text])); }
  return out;
}

export function LiveReportsPage() {
  const ov = useServerQuery(true, () => live.siOverview('last_30_days', {}), []);
  const q = useServerQuery(true, () => live.siReports(), []);
  usePollWhile(!!q.data?.some((r) => r.status === 'queued'), q.reload);
  const [kind, setKind] = useState('executive_summary');
  const [preset, setPreset] = useState<live.SiPreset>('last_30_days');
  const can = ov.data?.can;
  const allowed = REPORTS.filter((r) => !r.needs || (r.needs === 'team' ? can?.team : can?.finance));
  const download = async (r: live.SiReport, format: 'csv' | 'json') => {
    const res = await attempt(() => live.siReportResult(r.id));
    if (!res) return;
    const name = `${r.kind}-${r.period_from.slice(0, 10)}`;
    if (format === 'csv') downloadCsv(`${name}.csv`, reportCsv(res));
    else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' }));
      a.download = `${name}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };
  return (
    <div className="page">
      <PageHeader eyebrow="[ Sales Intelligence Agent ]" title="Reports"
        sub="Reports are generated in the background from the same metric definitions as the dashboard, and include only what your role may see." />
      <div className="row wrap" style={{ gap: 8 }}>
        <Select selectSize="sm" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 240 }} aria-label="Report">
          {allowed.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </Select>
        <Select selectSize="sm" value={preset} onChange={(e) => setPreset(e.target.value as live.SiPreset)} style={{ width: 150 }} aria-label="Period">
          {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </Select>
        <Button variant="primary" size="sm" onClick={async () => {
          const r = await attempt(() => live.siReportRequest(kind, preset, {}));
          if (r) { toast({ kind: 'info', title: 'Report queued', body: 'It is generated in the background within a minute.' }); q.reload(); }
        }}>Generate report</Button>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={q.reload}>Refresh</Button>
      </div>
      <div className="card mt-8">
        {q.error ? <p className="faint" style={{ padding: 12 }}>Couldn't load reports. {q.error}</p> : !q.data ? <div className="skeleton" style={{ height: 120 }} />
          : q.data.length === 0 ? <Empty icon={<BarChart3 size={20} />} title="No reports yet" description="Generate one above." /> : (
            <table className="table">
              <thead><tr><th>Report</th><th>Period</th><th>Status</th><th>Requested</th><th /></tr></thead>
              <tbody>
                {q.data.map((r) => (
                  <tr key={r.id}>
                    <td>{REPORTS.find((x) => x.value === r.kind)?.label ?? r.kind}{r.includes_financials ? <span className="faint" style={{ fontSize: 11 }}> · includes financials</span> : null}</td>
                    <td className="faint" style={{ fontSize: 12.5 }}>{r.period_from.slice(0, 10)} – {r.period_to.slice(0, 10)}</td>
                    <td><Badge tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'neutral'}>{r.status}</Badge>{r.error ? <div className="faint" style={{ fontSize: 11 }}>{r.error}</div> : null}</td>
                    <td className="faint" style={{ fontSize: 12.5 }}>{relTime(new Date(r.created_at).getTime())}</td>
                    <td>{r.status === 'completed' && (
                      <div className="row" style={{ gap: 4 }}>
                        <Button size="xs" icon={<Download size={12} />} onClick={() => void download(r, 'csv')}>CSV</Button>
                        <Button size="xs" variant="ghost" onClick={() => void download(r, 'json')}>JSON</Button>
                      </div>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}
