import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Bot,
  CalendarCheck,
  CalendarDays,
  CircleAlert,
  Download,
  Handshake,
  Info,
  Target,
  Timer,
  Trophy,
  UserRound,
  Zap,
  CheckCircle2,
  XCircle,
  Clock3,
} from 'lucide-react';
import { AreaChart, CountUp, Donut, Heatmap, Sparkline } from '@/components/charts';
import { Badge, Button, Card, Delta, Empty, PageHeader, Segmented, Switch } from '@/components/ui';
import { useStore } from '@/store/store';
import { useCan, useLookup, useMe, useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate } from '@/lib/router';
import { buckets, change, countIn, inWindow, median, windowOf, type RangeKey } from '@/lib/metrics';
import { DAY, fmtTime, inr, pct, relTime, sameDay, startOfDay } from '@/lib/format';
import { downloadCsv } from '@/lib/util';
import { LIVE } from '@/store/store';
import { useServerQuery } from '@/data/useServerQuery';
import * as liveApi from '@/backend/live';
import type { DashboardMetrics } from '@/backend/live';

/** What the dashboard renders — built from the server aggregate (live) or local sample data (demo). */
interface DashView {
  labels: string[];
  leadSeries: number[];
  prevSeries: number[];
  qualSeries: number[];
  apptSeries: number[];
  wonSeries: number[];
  leads: number;
  prevLeads: number;
  qual: number;
  prevQual: number;
  viewings: number;
  prevViewings: number;
  conv: number;
  prevConv: number;
  activeDeals: number;
  pipeline: number;
  newDeals: number;
  prevDeals: number;
  wonValue: number;
  prevWonValue: number;
  respMedian: number;
  prevRespMedian: number;
  withinSla: number;
  awaiting: number;
  sources: [string, { n: number; q: number }][];
  funnel: { label: string; n: number }[];
  heat: number[][];
  blocks: number[];
}

const BUCKET: Record<RangeKey, 'day' | 'week' | 'month'> = { '7d': 'day', '30d': 'day', '90d': 'week', '12m': 'month' };
const BLOCKS = [8, 10, 12, 14, 16, 18, 20, 22];

function fromServer(r: DashboardMetrics, range: RangeKey): DashView {
  const tz = r.range.timezone;
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-IN', range === '7d' ? { weekday: 'short', timeZone: tz } : range === '12m' ? { month: 'short', timeZone: tz } : { day: 'numeric', month: 'short', timeZone: tz }).format(new Date(iso));
  const heat = [1, 2, 3, 4, 5, 6, 7].map((dow) => BLOCKS.map((_, b) => r.arrivals.find((a) => a.dow === dow && a.block === b)?.n ?? 0));
  const k = r.kpis;
  return {
    labels: r.series.map((x) => fmt(x.start)),
    leadSeries: r.series.map((x) => x.leads),
    prevSeries: r.series.map((x) => x.previous_leads),
    qualSeries: r.series.map((x) => x.qualified),
    apptSeries: r.series.map((x) => x.viewings),
    wonSeries: r.series.map((x) => Number(x.won_value)),
    leads: k.new_leads.current,
    prevLeads: k.new_leads.previous,
    qual: k.qualified.current,
    prevQual: k.qualified.previous,
    viewings: k.viewings_booked.current,
    prevViewings: k.viewings_booked.previous,
    conv: Number(k.lead_to_visit.current),
    prevConv: Number(k.lead_to_visit.previous),
    activeDeals: k.active_deals.current,
    pipeline: Number(k.active_deals.pipeline_value),
    newDeals: k.active_deals.opened,
    prevDeals: k.active_deals.opened_previous,
    wonValue: Number(k.won_value.current),
    prevWonValue: Number(k.won_value.previous),
    respMedian: r.response.median_minutes ?? NaN,
    prevRespMedian: r.response.previous_median_minutes ?? NaN,
    withinSla: Number(r.response.within_sla),
    awaiting: r.response.awaiting_first_contact,
    sources: r.sources.map((x) => [x.source, { n: x.leads, q: x.qualified }]),
    funnel: r.funnel,
    heat,
    blocks: BLOCKS,
  };
}
import { MemberChip } from './shared';

const SOURCE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', '#7a6f69', '#c0b5ad', '#4f4844'];
const QUALIFIED = ['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];

export function Dashboard() {
  const me = useMe();
  const org = useOrg();
  const leads = useOrgList('leads');
  const appts = useOrgList('appointments');
  const deals = useOrgList('deals');
  const tasks = useOrgList('tasks');
  const runs = useOrgList('runs');
  const leadMap = useLookup('leads');
  const canSeeLogs = useCan('logs.view');
  const simulate = useStore((s) => s.simulateInboundLead);

  const [range, setRange] = useState<RangeKey>(() => (localStorage.getItem('estate-os:range') as RangeKey) || '30d');
  const [compare, setCompare] = useState(true);
  const [simulating, setSimulating] = useState(false);
  const setRangeSaved = (r: RangeKey) => {
    setRange(r);
    try {
      localStorage.setItem('estate-os:range', r);
    } catch {
      /* ignore */
    }
  };

  const now = Date.now();
  const m = useMemo(() => {
    const w = windowOf(range, now);
    const pw = windowOf(range, now, true);
    const live = leads.filter((l) => !l.archived);
    const bs = buckets(range, now);
    const pbs = buckets(range, now, 1);
    const newLeads = live.filter((l) => inWindow(l.createdAt, w));
    const prevLeads = live.filter((l) => inWindow(l.createdAt, pw));
    const qualified = newLeads.filter((l) => QUALIFIED.includes(l.status));
    const prevQualified = prevLeads.filter((l) => QUALIFIED.includes(l.status));
    const booked = appts.filter((a) => inWindow(a.createdAt, w) && a.type === 'viewing');
    const prevBooked = appts.filter((a) => inWindow(a.createdAt, pw) && a.type === 'viewing');
    const leadsWithAppt = new Set(appts.filter((a) => a.leadId && a.status !== 'cancelled').map((a) => a.leadId));
    const conv = newLeads.length ? newLeads.filter((l) => leadsWithAppt.has(l.id)).length / newLeads.length : 0;
    const prevConv = prevLeads.length ? prevLeads.filter((l) => leadsWithAppt.has(l.id)).length / prevLeads.length : 0;
    const activeDeals = deals.filter((d) => !['won', 'lost'].includes(d.stage));
    const newDeals = deals.filter((d) => inWindow(d.createdAt, w)).length;
    const prevDeals = deals.filter((d) => inWindow(d.createdAt, pw)).length;
    const won = deals.filter((d) => d.stage === 'won' && inWindow(d.stageChangedAt, w));
    const prevWon = deals.filter((d) => d.stage === 'won' && inWindow(d.stageChangedAt, pw));
    const responses = newLeads.filter((l) => l.firstResponseAt).map((l) => (l.firstResponseAt! - l.createdAt) / 60000);
    const prevResponses = prevLeads.filter((l) => l.firstResponseAt).map((l) => (l.firstResponseAt! - l.createdAt) / 60000);
    const withinSla = responses.filter((r) => r <= org.slaMinutes).length / (responses.length || 1);

    const leadSeries = countIn(live, bs, (l) => l.createdAt);
    const prevSeries = countIn(live, pbs, (l) => l.createdAt);
    const qualSeries = countIn(live.filter((l) => QUALIFIED.includes(l.status)), bs, (l) => l.createdAt);
    const apptSeries = countIn(appts.filter((a) => a.type === 'viewing'), bs, (a) => a.createdAt);
    const wonSeries = countIn(deals.filter((d) => d.stage === 'won'), bs, (d) => d.stageChangedAt, (d) => d.value);

    const bySource = new Map<string, { n: number; q: number }>();
    newLeads.forEach((l) => {
      const s = bySource.get(l.source) ?? { n: 0, q: 0 };
      s.n++;
      if (QUALIFIED.includes(l.status)) s.q++;
      bySource.set(l.source, s);
    });
    const sources = [...bySource.entries()].sort((a, b) => b[1].n - a[1].n);

    const funnel = [
      { label: 'New enquiries', n: newLeads.length },
      { label: 'Contacted', n: newLeads.filter((l) => !['new', 'attempting'].includes(l.status) || l.firstResponseAt).length },
      { label: 'Qualified', n: qualified.length },
      { label: 'Visit booked', n: newLeads.filter((l) => leadsWithAppt.has(l.id)).length },
      { label: 'Negotiation', n: newLeads.filter((l) => ['negotiation', 'won'].includes(l.status)).length },
      { label: 'Won', n: newLeads.filter((l) => l.status === 'won').length },
    ];

    // Arrival heatmap: weekday × 2-hour block, across the window.
    const blocks = [8, 10, 12, 14, 16, 18, 20, 22];
    const heat = [1, 2, 3, 4, 5, 6, 0].map((dow) => blocks.map((h) => newLeads.filter((l) => { const d = new Date(l.createdAt); return d.getDay() === dow && d.getHours() >= h && d.getHours() < h + 2; }).length));


    return {
      bs, newLeads, prevLeads, qualified, prevQualified, booked, prevBooked, conv, prevConv, activeDeals, newDeals, prevDeals, won, prevWon,
      responses, prevResponses, withinSla, leadSeries, prevSeries, qualSeries, apptSeries, wonSeries, sources, funnel, heat, blocks,
    };
  }, [range, leads, appts, deals, org.slaMinutes, now]);

  const metrics = useServerQuery(LIVE, () => {
    const [from, to] = windowOf(range, Date.now());
    return liveApi.dashboardMetrics(from, to, BUCKET[range]);
  }, [range]);
  const v = useMemo<DashView>(() => {
    if (LIVE && metrics.data) return fromServer(metrics.data, range);
    return {
      labels: m.bs.map((b) => b.label),
      leadSeries: m.leadSeries,
      prevSeries: m.prevSeries,
      qualSeries: m.qualSeries,
      apptSeries: m.apptSeries,
      wonSeries: m.wonSeries,
      leads: m.newLeads.length,
      prevLeads: m.prevLeads.length,
      qual: m.qualified.length,
      prevQual: m.prevQualified.length,
      viewings: m.booked.length,
      prevViewings: m.prevBooked.length,
      conv: m.conv,
      prevConv: m.prevConv,
      activeDeals: m.activeDeals.length,
      pipeline: m.activeDeals.reduce((s, d) => s + d.value, 0),
      newDeals: m.newDeals,
      prevDeals: m.prevDeals,
      wonValue: m.won.reduce((s, d) => s + d.value, 0),
      prevWonValue: m.prevWon.reduce((s, d) => s + d.value, 0),
      respMedian: median(m.responses),
      prevRespMedian: median(m.prevResponses),
      withinSla: m.withinSla,
      awaiting: m.newLeads.filter((l) => !l.firstResponseAt).length,
      sources: m.sources,
      funnel: m.funnel,
      heat: m.heat,
      blocks: m.blocks,
    };
  }, [m, metrics.data, range]);
  const todayLeads = leads.filter((l) => !l.archived && sameDay(l.createdAt, now)).length;

  const upcoming = appts.filter((a) => a.start > now && ['confirmed', 'pending', 'requested'].includes(a.status)).sort((a, b) => a.start - b.start).slice(0, 6);
  const attention = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled' && t.dueAt < startOfDay(now) + DAY && (t.assignedTo === me.id || me.role === 'owner' || me.role === 'manager')).sort((a, b) => a.dueAt - b.dueAt).slice(0, 6);
  const recentRuns = runs.slice(0, 7);
  const failures = runs.filter((r) => ['failed', 'dead_letter'].includes(r.status) && now - r.startedAt < 3 * DAY);
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const periodLabel = { '7d': '7D', '30d': '30D', '90d': '90D', '12m': '12M' }[range];

  const exportSummary = () => {
    downloadCsv(`dashboard-${range}.csv`, [
      ['Metric', 'Current', 'Previous', 'Definition'],
      ['New leads', v.leads, v.prevLeads, 'Leads created in the period (by created_at, org time zone)'],
      ['Qualified leads', v.qual, v.prevQual, 'Leads created in the period that reached Qualified or later'],
      ['Viewings booked', v.viewings, v.prevViewings, 'Viewing appointments created in the period'],
      ['Lead → appointment', pct(v.conv), pct(v.prevConv), 'Share of new leads with a non-cancelled appointment'],
      ['Won value', v.wonValue, v.prevWonValue, 'Deal value closed-won in the period'],
      ['Median first response (min)', Number.isFinite(v.respMedian) ? v.respMedian.toFixed(1) : '', Number.isFinite(v.prevRespMedian) ? v.prevRespMedian.toFixed(1) : '', 'Lead created → first contact attempt'],
    ]);
    toast({ kind: 'success', title: 'Summary exported', body: 'Includes the definition of every metric.' });
  };

  const kpis = [
    { key: 'leads', label: 'New leads', icon: <UserRound size={14} />, value: v.leads, prev: v.prevLeads, spark: v.leadSeries, def: 'Leads created in the period, by created time in the organization time zone.', to: 'leads' },
    { key: 'qual', label: 'Qualified', icon: <Target size={14} />, value: v.qual, prev: v.prevQual, spark: v.qualSeries, def: 'Leads created in the period that reached Qualified or a later stage.', to: 'leads' },
    { key: 'appt', label: 'Viewings booked', icon: <CalendarCheck size={14} />, value: v.viewings, prev: v.prevViewings, spark: v.apptSeries, def: 'Viewing appointments created in the period (any status).', to: 'appointments' },
    { key: 'conv', label: 'Lead → visit', icon: <ArrowUpRight size={14} />, value: v.conv, prev: v.prevConv, fmt: (v: number) => pct(v), def: 'Share of new leads in the period with a non-cancelled appointment.', to: 'reports' },
    { key: 'deals', label: 'Active deals', icon: <Handshake size={14} />, value: v.activeDeals, prev: v.activeDeals - v.newDeals + v.prevDeals, spark: undefined, sub: inr(v.pipeline) + ' pipeline', def: 'Deals not in Won or Lost right now. Delta compares deals opened this period vs last.', to: 'deals' },
    { key: 'won', label: 'Won value', icon: <Trophy size={14} />, value: v.wonValue, prev: v.prevWonValue, spark: v.wonSeries, bars: true, fmt: (v: number) => inr(v), def: 'Sum of deal value for deals moved to Won in the period. Not commission or cash received.', to: 'deals' },
  ];

  if (LIVE && !metrics.data) {
    return (
      <div className="page" aria-busy={!metrics.error}>
        <PageHeader eyebrow={`[ ${org.name} ]`} title={<>{greeting}, <span className="serif">{me.name.split(' ')[0]}</span></>} />
        {metrics.error ? (
          <div className="banner danger">{metrics.error}<Button size="sm" onClick={metrics.reload}>Retry</Button></div>
        ) : (
          <div className="grid g-kpi-6">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 118, borderRadius: 16 }} />)}</div>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${org.name} · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} ]`}
        title={<>{greeting}, <span className="serif">{me.name.split(' ')[0]}</span></>}
        sub={
          org.outboundPaused
            ? 'Outbound communication is paused. Agents are drafting only — nothing is being sent.'
            : `${todayLeads} lead${todayLeads === 1 ? '' : 's'} arrived today. ${upcoming.filter((a) => sameDay(a.start, now)).length} visits still ahead of you.`
        }
        actions={
          <>
            <Segmented mono value={range} onChange={setRangeSaved} options={[{ value: '7d', label: '7D' }, { value: '30d', label: '30D' }, { value: '90d', label: '90D' }, { value: '12m', label: '12M' }]} />
            <label className="row desktop-only" style={{ gap: 8, fontSize: 13, color: 'var(--text-2)', cursor: 'pointer' }}>
              <Switch on={compare} onChange={setCompare} label="Compare to previous period" /> Compare
            </label>
            <Button icon={<Download size={15} />} onClick={exportSummary}>Export</Button>
            {!LIVE && <Button
              variant="accent"
              icon={<Zap size={15} />}
              loading={simulating}
              onClick={async () => {
                setSimulating(true);
                await simulate();
                setSimulating(false);
              }}
              title="Sends a signed test webhook through the full intake pipeline"
            >
              Simulate lead
            </Button>}
          </>
        }
      />

      <div className="grid g-kpi-6">
        {kpis.map((k) => (
          <button key={k.key} className="card kpi" onClick={() => navigate(k.to)}>
            <div className="kpi-label" title={k.def}>
              <span className="icon-chip">{k.icon}</span>
              {k.label}
              <span className="period">{periodLabel}</span>
            </div>
            <div className="kpi-value"><CountUp value={k.value} format={k.fmt ?? ((v) => Math.round(v).toLocaleString('en-IN'))} /></div>
            <div className="kpi-foot">
              <span className="row" style={{ gap: 6 }}>
                {compare ? <><Delta value={k.key === 'conv' ? k.value - k.prev : change(k.value, k.prev)} /> <span>vs prev</span></> : k.sub ? <span>{k.sub}</span> : <span title={k.def}><Info size={11} /> definition</span>}
              </span>
              {k.spark && <Sparkline data={k.spark} bars={k.bars} color={k.key === 'won' ? 'var(--chart-3)' : 'var(--chart-1)'} width={84} height={30} />}
            </div>
          </button>
        ))}
      </div>

      <div className="grid g-main-side mt-16">
        <Card
          title="Lead flow"
          sub={`New vs qualified leads${compare ? ' · dashed is the previous period' : ''}`}
          actions={
            <div className="legend desktop-only">
              <span><i style={{ background: 'var(--chart-1)' }} /> New</span>
              <span><i style={{ background: 'var(--chart-2)' }} /> Qualified</span>
              {compare && <span><i className="dash" /> Previous</span>}
            </div>
          }
        >
          <AreaChart
            height={262}
            labels={v.labels}
            series={[
              ...(compare ? [{ name: 'Previous', values: v.prevSeries, color: 'var(--text-3)', dashed: true }] : []),
              { name: 'Qualified', values: v.qualSeries, color: 'var(--chart-2)', fill: false },
              { name: 'New', values: v.leadSeries, color: 'var(--chart-1)' },
            ]}
          />
        </Card>
        <Card title="Where leads come from" sub={`${v.leads} leads · ${periodLabel}`}>
          {v.sources.length === 0 ? <Empty icon={<UserRound size={18} />} title="No leads in this period" /> : (
            <div className="stack">
              <div className="row" style={{ justifyContent: 'center', padding: '4px 0 6px' }}>
                <Donut
                  size={152}
                  thickness={16}
                  segments={v.sources.map(([s, v], i) => ({ label: s, value: v.n, color: SOURCE_COLORS[i % SOURCE_COLORS.length] }))}
                  center={<div><div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.03em' }} className="num">{v.leads}</div><div className="faint" style={{ fontSize: 11.5 }}>leads</div></div>}
                />
              </div>
              <div className="stack stack-sm">
                {v.sources.slice(0, 6).map(([s, v], i) => (
                  <div key={s} className="row" style={{ fontSize: 13 }}>
                    <i style={{ width: 8, height: 8, borderRadius: 2, background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} />
                    <span className="grow">{s}</span>
                    <span className="faint mono" style={{ fontSize: 11.5 }} title="Qualification rate">{pct(v.q / v.n, 0)} qual</span>
                    <b className="num" style={{ width: 34, textAlign: 'right' }}>{v.n}</b>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="grid g-3 mt-16">
        <Card title="Conversion funnel" sub="Cohort: leads created in the period">
          {v.funnel.map((f, i) => (
            <div key={f.label} className="funnel-row">
              <span className="faint" style={{ fontSize: 12.5 }}>{f.label}</span>
              <div className="funnel-bar"><i className={i === v.funnel.length - 1 ? 'accent' : ''} style={{ width: `${(f.n / (v.funnel[0].n || 1)) * 100}%`, opacity: 1 - i * 0.1 }} /></div>
              <span className="mono num" style={{ textAlign: 'right', fontSize: 12 }}>{f.n}<span className="faint"> · {pct(f.n / (v.funnel[0].n || 1), 0)}</span></span>
            </div>
          ))}
        </Card>
        <Card title="When leads arrive" sub="Day × time — staff accordingly">
          <Heatmap rows={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']} cols={v.blocks.map((h) => (h > 12 ? `${h - 12}p` : h === 12 ? '12p' : `${h}a`))} values={v.heat} format={(v, r, c) => `${r} ${c}: ${v} lead${v === 1 ? '' : 's'}`} />
          <div className="row mt-12 faint" style={{ fontSize: 11.5, justifyContent: 'flex-end', gap: 4 }}>
            Less {[15, 35, 60, 85, 100].map((p) => <i key={p} style={{ width: 10, height: 10, borderRadius: 3, background: `color-mix(in srgb, var(--ember) ${p}%, var(--fill))` }} />)} More
          </div>
        </Card>
        <Card title="Speed to lead" sub={`SLA: first contact within ${org.slaMinutes} min`}>
          <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
            <div className="kpi-value" style={{ marginTop: 0, fontSize: 36 }}>{Number.isFinite(v.respMedian) ? v.respMedian.toFixed(1) : '—'}<span className="faint" style={{ fontSize: 15, fontWeight: 500 }}> min</span></div>
            {compare && <Delta value={change(v.respMedian, v.prevRespMedian)} invert />}
          </div>
          <div className="faint" style={{ fontSize: 12.5 }}>Median time from enquiry to first contact attempt</div>
          <div className="mt-16 stack stack-sm">
            <div className="row row-between" style={{ fontSize: 13 }}><span>Within SLA</span><b className="num">{pct(v.withinSla, 0)}</b></div>
            <div className="progress accent"><i style={{ width: `${v.withinSla * 100}%` }} /></div>
            <div className="row row-between mt-8" style={{ fontSize: 13 }}><span>Still waiting for first contact</span><b className="num">{v.awaiting}</b></div>
          </div>
          <Button size="sm" className="mt-16" onClick={() => navigate('leads')} icon={<Timer size={14} />}>Open uncontacted leads</Button>
        </Card>
      </div>

      <div className="grid g-3 mt-16">
        <Card title="Upcoming visits" icon={<CalendarDays size={14} />} actions={<button className="text-btn" onClick={() => navigate('appointments')}>Calendar <ArrowUpRight size={12} /></button>} flush>
          {upcoming.length === 0 ? <Empty icon={<CalendarDays size={18} />} title="No upcoming visits" /> : upcoming.map((a) => (
            <button key={a.id} className="list-row" onClick={() => navigate('appointments', { id: a.id })}>
              <div style={{ width: 46, textAlign: 'center' }}>
                <div className="mono faint" style={{ fontSize: 10.5, textTransform: 'uppercase' }}>{sameDay(a.start, now) ? 'Today' : new Date(a.start).toLocaleDateString('en-IN', { weekday: 'short' })}</div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{fmtTime(a.start)}</div>
              </div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 500, fontSize: 13 }}>{a.leadId ? leadMap.get(a.leadId)?.name : a.title}</div>
                <div className="faint truncate" style={{ fontSize: 12 }}>{a.title.replace('Site visit — ', '')}</div>
              </div>
              <MemberChip id={a.assignedTo} showName={false} />
            </button>
          ))}
        </Card>
        <Card title="Needs your attention" icon={<CircleAlert size={14} />} actions={<button className="text-btn" onClick={() => navigate('tasks')}>All tasks <ArrowUpRight size={12} /></button>} flush>
          {attention.length === 0 ? <Empty icon={<CheckCircle2 size={18} />} title="All clear" description="Nothing overdue or due today." /> : attention.map((t) => (
            <button key={t.id} className="list-row" onClick={() => navigate('tasks')}>
              <span className="status-dot" style={{ background: t.dueAt < now ? 'var(--blaze)' : 'var(--amber)' }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{t.title}</div>
                <div className="faint" style={{ fontSize: 12 }}>{t.related?.type === 'lead' ? leadMap.get(t.related.id)?.name : ''}</div>
              </div>
              <span className="mono" style={{ fontSize: 11.5, color: t.dueAt < now ? 'var(--danger)' : 'var(--text-3)' }}>{relTime(t.dueAt)}</span>
            </button>
          ))}
        </Card>
        {canSeeLogs && !LIVE ? (
          <Card title="Automation activity" icon={<Bot size={14} />} actions={failures.length ? <Badge tone="danger">{failures.length} failed · 72h</Badge> : <Badge tone="success">Healthy</Badge>} flush>
            {recentRuns.map((r) => (
              <button key={r.id} className="list-row" onClick={() => navigate('logs', { id: r.id })}>
                <span className={`step-dot ${r.status === 'succeeded' ? 'ok' : ['failed', 'dead_letter'].includes(r.status) ? 'fail' : r.status === 'running' ? 'run' : 'skip'}`}>
                  {r.status === 'succeeded' ? <CheckCircle2 size={12} /> : ['failed', 'dead_letter'].includes(r.status) ? <XCircle size={12} /> : <Clock3 size={12} />}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</div>
                  <div className="faint truncate" style={{ fontSize: 12 }}>{r.error ?? r.trigger}</div>
                </div>
                <span className="faint mono" style={{ fontSize: 11 }}>{relTime(r.startedAt)}</span>
              </button>
            ))}
          </Card>
        ) : (
          <Card title="Your pipeline" flush>
            <Empty icon={<Handshake size={18} />} title={`${deals.filter((x) => !['won', 'lost'].includes(x.stage) && x.ownerId === me.id).length} deals you own`} action={<Button size="sm" onClick={() => navigate('deals')}>Open deals</Button>} />
          </Card>
        )}
      </div>

      {failures.length > 0 && canSeeLogs && (
        <div className="banner danger mt-16">
          <CircleAlert size={16} />
          <span><b>{failures.length} automation run{failures.length > 1 ? 's' : ''} failed</b> in the last 72 hours. Latest: {failures[0].name} — {failures[0].error}</span>
          <Button size="sm" onClick={() => navigate('logs', { status: 'failed' })}>Review</Button>
        </div>
      )}
      <p className="faint mt-16" style={{ fontSize: 11.5 }}>
        Figures update as records change; provider data (calls, delivery) can lag by a few minutes. Times in {org.timezone}. A call or message counts as delivered only when the provider confirms it, not when the request is sent.
      </p>
    </div>
  );
}
