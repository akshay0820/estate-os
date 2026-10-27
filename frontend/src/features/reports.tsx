import { useMemo, useState } from 'react';
import { BookOpen, Download, Printer } from 'lucide-react';
import { AreaChart } from '@/components/charts';
import { Button, Card, PageHeader, Segmented } from '@/components/ui';
import { useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { buckets, countIn, inWindow, median, windowOf, type RangeKey } from '@/lib/metrics';
import { pct } from '@/lib/format';
import { downloadCsv } from '@/lib/util';
import { MemberChip } from './shared';
import { LiveReportsPage } from './salesIntelligence';
import { LIVE } from '@/store/store';

const QUAL = ['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];

export function ReportsPage() {
  if (LIVE) return <LiveReportsPage />;
  return <DemoReportsPage />;
}

function DemoReportsPage() {
  const leads = useOrgList('leads');
  const appts = useOrgList('appointments');
  const runs = useOrgList('runs');
  const tasks = useOrgList('tasks');
  const members = useOrgList('members');
  const org = useOrg();
  const [range, setRange] = useState<RangeKey>('30d');

  const r = useMemo(() => {
    const w = windowOf(range);
    const cohort = leads.filter((l) => !l.archived && inWindow(l.createdAt, w));
    const withAppt = new Set(appts.filter((a) => a.leadId && ['confirmed', 'completed', 'no_show'].includes(a.status)).map((a) => a.leadId));
    const confirmed = appts.filter((a) => inWindow(a.start, w) && ['confirmed', 'completed', 'no_show'].includes(a.status) && a.start < Date.now());
    const terminalRuns = runs.filter((x) => inWindow(x.startedAt, w) && ['succeeded', 'failed', 'dead_letter'].includes(x.status) && !x.name.includes('(test)'));
    const wfRuns = terminalRuns.filter((x) => x.kind === 'workflow');
    const tasksDue = tasks.filter((t) => inWindow(t.dueAt, w) && t.dueAt < Date.now() && t.source !== 'manual');
    const firstAttempt = cohort.filter((l) => l.firstResponseAt).map((l) => (l.firstResponseAt! - l.createdAt) / 60000);
    const metrics = [
      { name: 'Lead response time (median)', value: Number.isFinite(median(firstAttempt)) ? `${median(firstAttempt).toFixed(1)} min` : '—', def: 'Lead created → first qualifying contact attempt. Successful contact is reported separately.', num: 'Σ first attempt − created', den: 'Leads with an attempt' },
      { name: 'Qualification rate', value: pct(cohort.filter((l) => QUAL.includes(l.status)).length / (cohort.length || 1)), def: 'Qualified leads ÷ eligible leads in the same creation cohort.', num: 'Qualified or later', den: 'Leads created in period' },
      { name: 'Appointment booking rate', value: pct(cohort.filter((l) => withAppt.has(l.id)).length / (cohort.length || 1)), def: 'Leads with a confirmed appointment ÷ the eligible cohort.', num: 'Leads with confirmed visit', den: 'Leads created in period' },
      { name: 'Show rate', value: pct(confirmed.filter((a) => a.status === 'completed').length / (confirmed.length || 1)), def: 'Completed appointments ÷ confirmed appointments that have occurred; cancellations excluded.', num: 'Completed', den: 'Confirmed & past' },
      { name: 'Workflow success rate', value: pct(wfRuns.filter((x) => x.status === 'succeeded').length / (wfRuns.length || 1)), def: 'Successful runs ÷ runs that reached a terminal state. Test runs and cancellations excluded.', num: 'Succeeded', den: 'Terminal workflow runs' },
      { name: 'Automation rate', value: pct(1 - tasksDue.length / Math.max(1, wfRuns.length), 0), def: 'Eligible workflow instances completed without a human task ÷ eligible instances.', num: 'Runs without hand-off', den: 'Eligible workflow runs' },
    ];
    const bs = buckets(range === '12m' ? '90d' : range);
    const respSeries = bs.map((b) => {
      const v = leads.filter((l) => l.firstResponseAt && l.createdAt >= b.start && l.createdAt < b.end).map((l) => (l.firstResponseAt! - l.createdAt) / 60000);
      return Number.isFinite(median(v)) ? +median(v).toFixed(1) : 0;
    });
    const team = members.filter((m) => m.role === 'agent' && m.status === 'active').map((m) => {
      const mine = cohort.filter((l) => l.assignedTo === m.id);
      const resp = mine.filter((l) => l.firstResponseAt).map((l) => (l.firstResponseAt! - l.createdAt) / 60000);
      return { m, n: mine.length, q: mine.filter((l) => QUAL.includes(l.status)).length, v: mine.filter((l) => withAppt.has(l.id)).length, resp: median(resp), sla: resp.filter((x) => x <= org.slaMinutes).length / (resp.length || 1) };
    });
    return { metrics, bs, respSeries, team, cohort: cohort.length, qualSeries: countIn(cohort.filter((l) => QUAL.includes(l.status)), bs, (l) => l.createdAt) };
  }, [range, leads, appts, runs, tasks, members, org.slaMinutes]);

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ Cohort: ${r.cohort} leads · ${org.timezone} ]`}
        title="Reports"
        sub="Every metric has a written definition, numerator, denominator and date basis — so the numbers mean the same thing to everyone."
        actions={
          <>
            <Segmented mono value={range} onChange={setRange} options={[{ value: '7d', label: '7D' }, { value: '30d', label: '30D' }, { value: '90d', label: '90D' }, { value: '12m', label: '12M' }]} />
            <Button icon={<Printer size={15} />} onClick={() => window.print()}>Print</Button>
            <Button icon={<Download size={15} />} onClick={() => { downloadCsv(`report-${range}.csv`, [['Metric', 'Value', 'Definition', 'Numerator', 'Denominator'], ...r.metrics.map((m) => [m.name, m.value, m.def, m.num, m.den]), [], ['Agent', 'Leads', 'Qualified', 'Visits', 'Median response (min)', 'Within SLA'], ...r.team.map((t) => [t.m.name, t.n, t.q, t.v, Number.isFinite(t.resp) ? t.resp.toFixed(1) : '', pct(t.sla, 0)])]); toast({ kind: 'success', title: 'Report exported' }); }}>Export CSV</Button>
          </>
        }
      />
      <div className="grid g-3">
        {r.metrics.map((m) => (
          <div key={m.name} className="card" style={{ padding: 18 }}>
            <div className="faint" style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</div>
            <div className="kpi-value" style={{ marginTop: 6 }}>{m.value}</div>
            <div className="divider" style={{ margin: '12px 0' }} />
            <div className="row row-top" style={{ gap: 8, fontSize: 12.5, color: 'var(--text-2)' }}><BookOpen size={13} style={{ marginTop: 2, flexShrink: 0 }} className="faint" />{m.def}</div>
            <div className="mono faint mt-8" style={{ fontSize: 11 }}>{m.num} ÷ {m.den}</div>
          </div>
        ))}
      </div>
      <div className="grid g-2 mt-16">
        <Card title="Median response time" sub="Minutes from enquiry to first attempt, by creation date">
          <AreaChart height={220} labels={r.bs.map((b) => b.label)} format={(v) => `${v.toFixed(0)}m`} series={[{ name: 'Median minutes', values: r.respSeries, color: 'var(--chart-3)' }]} />
        </Card>
        <Card title="Qualified leads" sub="By creation date">
          <AreaChart height={220} labels={r.bs.map((b) => b.label)} series={[{ name: 'Qualified', values: r.qualSeries, color: 'var(--chart-1)' }]} />
        </Card>
      </div>
      <Card title="Team performance" sub={`SLA ${org.slaMinutes} min · same cohort`} className="mt-16" flush>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Agent</th><th className="right">Leads</th><th className="right">Qualified</th><th className="right">Visits</th><th className="right">Lead → visit</th><th className="right">Median response</th><th className="right">Within SLA</th></tr></thead>
            <tbody>
              {r.team.map((t) => (
                <tr key={t.m.id}>
                  <td><MemberChip id={t.m.id} /></td>
                  <td className="right num">{t.n}</td>
                  <td className="right num">{t.q}</td>
                  <td className="right num">{t.v}</td>
                  <td className="right num">{pct(t.v / (t.n || 1), 0)}</td>
                  <td className="right num">{Number.isFinite(t.resp) ? `${t.resp.toFixed(1)} min` : '—'}</td>
                  <td className="right num">{pct(t.sla, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
