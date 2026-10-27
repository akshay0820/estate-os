// Agent 08 — Sales Intelligence: catalogue-validated queries, cohort and period metrics, comparisons, currency separation,
// permissions (team, finance), funnel with maturity, honest unavailability, forecasts with backtesting, anomalies and findings
// with expiry, insight lifecycle, recommendation snapshots, reports and tenant isolation.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, viewer: string, fin: string;
let ownerB: string;
const L: Record<string, R> = {};
let seq = 0;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const rows = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
const key = () => `k_si_${++seq}_${Date.now()}`;
const day = (offset: number) => new Date(Date.now() + offset * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
// The fixture cohort: leads created 40 days ago → a custom window 45..35 days ago.
const W = () => ({ from: day(-45), to: day(-35) });
const q = (user: string, spec: R) => t.as<{ r: R }>(user, `select public.si_query($1, $2::jsonb) r`, [org, JSON.stringify(spec)]).then((x) => x[0].r);
const value = (r: R, k = 'all') => r.rows.find((x: R) => x.key === k)?.value;
const tick = () => t.asService<{ r: R }>(`select public.sales_intelligence_tick(10) r`).then((x) => x[0].r);
const replica = async (sql: string, params: unknown[] = []) => {
  await t.db.query(`set session_replication_role = replica`);
  try { return (await t.db.query(sql, params)).rows; } finally { await t.db.query(`set session_replication_role = origin`); }
};

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agent = await t.user('Arjun Desai');
  viewer = await t.user('Vik Viewer');
  fin = await t.user('Farah Finance');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent');
  await t.member(org, viewer, 'viewer');
  await t.member(org, fin, 'finance');
  ownerB = await t.user('Bina Bose');
  await t.org(ownerB, 'Other Agency');

  const mk = async (name: string, phone: string, source: string, extra: R = {}) =>
    (await t.lead(manager, org, { name, phone, source, type: 'buyer', intent: 'buy', property_type: 'apartment', assigned_to: agent, ...extra }));
  L.l1 = await mk('One Website', '9811000001', 'Website');
  L.l2 = await mk('Two Website', '9811000002', 'Website');
  L.l3 = await mk('Three Website', '9811000003', 'Website');
  L.l4 = await mk('Four Website', '9811000004', 'Website');
  L.l5 = await mk('Five Referral', '9811000005', 'Referral');
  L.l6 = await mk('Six Referral', '9811000006', 'Referral');
  L.l7 = await mk('Seven Archived', '9811000007', 'Website');
  for (const [k, s] of [['l1', 'qualified'], ['l2', 'contacted'], ['l4', 'qualified'], ['l5', 'qualified'], ['l6', 'qualified']] as const) {
    await t.as(manager, `update public.leads set status = $2 where id = $1`, [L[k].lead_id, s]);
  }
  // Six reached qualified and was later lost: it still counts as having been qualified.
  await t.as(manager, `update public.leads set status = 'lost', lost_reason = 'Bought elsewhere' where id = $1`, [L.l6.lead_id]);
  await t.as(manager, `update public.leads set archived_at = now() where id = $1`, [L.l7.lead_id]);
  await t.db.query(`update public.leads set created_at = now() - interval '40 days' where organization_id = $1`, [org]);

  const appt = (lead: string, status: string, startDays: number, confirmed: boolean) => replica(`insert into public.appointments (organization_id, title, appointment_type, status, lead_id,
      assigned_to, starts_at, ends_at, confirmed_at, created_at, cancellation_reason) values ($1, 'Visit', 'consultation', $2, $3, $4, now() + make_interval(days => $5), now() + make_interval(days => $5) + interval '1 hour',
      case when $6 then now() - interval '30 days' end, now() - interval '30 days', case when $2 = 'cancelled' then 'test' end)`, [org, status, lead, agent, startDays, confirmed]);
  await appt(L.l1.lead_id, 'completed', -20, true);
  await appt(L.l4.lead_id, 'confirmed', 5, true);
  await appt(L.l5.lead_id, 'requested', 6, false); // a proposal, not a booking
  await appt(L.l2.lead_id, 'no_show', -21, true);

  const contact = async (lead: string) => (await one(`select contact_id from public.leads where id = $1`, [lead])).contact_id;
  const deal = async (lead: string | null, o: R) => (await replica(`insert into public.deals (organization_id, title, lead_id, primary_contact_id, stage, expected_value, currency, commission_pct,
      expected_close_date, owner_user_id, closed_at, created_at, lost_reason) values ($1, $2, $3, $4, $5, $6, $7, 2, $8, $9, $10, now() - interval '30 days', $11) returning id`,
    [org, o.title, lead, await contact(lead ?? L.l3.lead_id), o.stage, o.value, o.currency ?? 'INR', o.close ?? null, agent, o.closed ?? null, o.stage === 'lost' ? 'lost' : null]))[0].id;
  L.d1 = { id: await deal(L.l1.lead_id, { title: 'Won deal', stage: 'won', value: 20000000, closed: new Date(Date.now() - 38 * 864e5).toISOString() }) };
  L.d2 = { id: await deal(L.l4.lead_id, { title: 'Open offer', stage: 'offer', value: 15000000, close: day(20) }) };
  L.d3 = { id: await deal(null, { title: 'USD deal', stage: 'negotiation', value: 500000, currency: 'USD', close: day(25) }) };
  await replica(`insert into public.commissions (organization_id, deal_id, gross_commission, status) values ($1, $2, 400000, 'approved')`, [org, L.d1.id]);
  await replica(`insert into public.voice_calls (organization_id, lead_id, direction, status, idempotency_key, initiated_by, initiated_at, started_at, outcome)
    values ($1, $2, 'outbound', 'completed', 'vc-fixture-0001', 'user', now() - interval '39 days', now() - interval '39 days', 'connected')`, [org, L.l2.lead_id]);
  for (const [k, st] of [['f1', 'sent'], ['f2', 'failed']] as const) {
    await replica(`insert into public.follow_ups (organization_id, lead_id, contact_id, trigger, purpose, kind, channel, status, reason, idempotency_key, sent_at, sent_via, created_at)
      values ($1, $2, $3, 'test', 'clarify_requirements', 'message', 'whatsapp', $4, 'test', $5, case when $4 = 'sent' then now() - interval '39 days' end, case when $4 = 'sent' then 'manual' end, now() - interval '39 days')`,
      [org, L.l3.lead_id, await contact(L.l3.lead_id), st, k]);
  }
}, 120000);

describe('query layer', () => {
  it('only runs catalogue metrics, dimensions and filters', async () => {
    for (const spec of [{ metric: 'drop table leads' }, { metric: 'leads_created', group_by: 'phone' }, { metric: 'leads_created', filters: { email: 'x' } },
      { metric: 'leads_created', sql: 'select 1' }, { metric: 'leads_created', preset: 'forever' }, { metric: 'open_deals', group_by: 'week' }]) {
      expect((await t.fails(manager, `select public.si_query($1, $2::jsonb)`, [org, JSON.stringify(spec)])).detail).toBe('VALIDATION_ERROR');
    }
    const cat = (await t.as<{ r: R }>(viewer, `select public.si_metric_catalogue() r`))[0].r;
    expect(cat.closed_deal_value).toMatchObject({ unit: 'money', perm: 'finance.view' });
    expect(cat.pipeline_value.dims).toEqual(['source', 'assignee']);
  });

  it('counts the cohort from persisted evidence: archived duplicates excluded, history counts, small samples flagged', async () => {
    expect(value(await q(manager, { metric: 'leads_created', ...W() }))).toBe(6);
    expect(value(await q(manager, { metric: 'leads_qualified', ...W() }))).toBe(4);
    const rate = await q(manager, { metric: 'qualification_rate', ...W() });
    expect(rate.rows[0]).toMatchObject({ value: 0.6667, numerator: 4, denominator: 6, low_sample: true });
    expect(value(await q(manager, { metric: 'leads_contacted', ...W() }))).toBe(5);
    const bySource = await q(manager, { metric: 'leads_created', group_by: 'source', ...W() });
    expect(Object.fromEntries(bySource.rows.map((r: R) => [r.key, r.value]))).toEqual({ Website: 4, Referral: 2 });
    expect(bySource.caveats.map((c: R) => c.code)).toContain('no_quality_scan');
  });

  it('compares with the previous period without inventing percentages', async () => {
    const r = await q(manager, { metric: 'leads_created', compare: true, ...W() });
    expect(r.rows[0]).toMatchObject({ value: 6, previous_value: 0, change: 6 });
    expect(r.rows[0].change_pct).toBeUndefined();
    expect(r.previous_period).toBeTruthy();
    const snap = await q(manager, { metric: 'open_deals', compare: true });
    expect(snap.previous_period).toBeFalsy();
  });

  it('treats only confirmed appointments as bookings and excludes unknown outcomes from attendance', async () => {
    expect(value(await q(manager, { metric: 'appointments_booked', preset: 'last_90_days' }))).toBe(3);
    const att = await q(manager, { metric: 'attendance_rate', preset: 'last_30_days' });
    expect(att.rows[0]).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(value(await q(manager, { metric: 'qualified_to_appointment_rate', ...W() }))).toBe(0.5);
  });

  it('reports delivery as unavailable without a messaging provider, and sent separately', async () => {
    const d = await q(manager, { metric: 'follow_ups_delivered', preset: 'last_90_days' });
    expect(d).toMatchObject({ available: false });
    expect(d.reason).toContain('No messaging provider');
    expect(value(await q(manager, { metric: 'follow_ups_sent', preset: 'last_90_days' }))).toBe(1);
    expect(value(await q(manager, { metric: 'follow_ups_failed', preset: 'last_90_days' }))).toBe(1);
    expect(value(await q(manager, { metric: 'calls_connected', preset: 'last_90_days' }))).toBe(1);
  });

  it('keeps money behind finance access, never mixes currencies, and separates commission from transaction value', async () => {
    expect((await t.fails(manager, `select public.si_query($1, $2::jsonb)`, [org, JSON.stringify({ metric: 'closed_deal_value', preset: 'last_90_days' })])).detail).toBe('FORBIDDEN');
    const won = await q(fin, { metric: 'closed_deal_value', preset: 'last_90_days' });
    expect(won.rows).toEqual([expect.objectContaining({ currency: 'INR', value: 20000000 })]);
    const comm = await q(fin, { metric: 'commission_revenue', preset: 'last_90_days' });
    expect(comm.rows).toEqual([expect.objectContaining({ currency: 'INR', value: 400000 })]);
    const pipe = await q(viewer, { metric: 'pipeline_value' });
    expect(Object.fromEntries(pipe.rows.map((r: R) => [r.currency, r.value]))).toEqual({ INR: 15000000, USD: 500000 });
    const none = await q(fin, { metric: 'closed_deal_value', preset: 'last_7_days' });
    expect(none.rows).toEqual([]); // no won deals → no value, not a zero revenue
    const ov = (await t.as<{ r: R }>(manager, `select public.si_overview($1, 'last_90_days', null, null, '{}') r`, [org]))[0].r;
    expect(ov.kpis.closed_deal_value).toMatchObject({ restricted: true });
    expect(ov.kpis.open_deals.rows[0].value).toBe(2);
    expect(ov.unavailable.cost_per_lead).toBe('No advertising spend is recorded');
  });

  it('limits team breakdowns to people with team access', async () => {
    const team = await q(manager, { metric: 'leads_created', group_by: 'assignee', ...W() });
    expect(team.rows).toEqual([expect.objectContaining({ key: agent, label: 'Arjun Desai', value: 6 })]);
    expect((await t.fails(viewer, `select public.si_query($1, $2::jsonb)`, [org, JSON.stringify({ metric: 'leads_created', group_by: 'assignee' })])).detail).toBe('FORBIDDEN');
    expect((await t.fails(viewer, `select public.si_query($1, $2::jsonb)`, [org, JSON.stringify({ metric: 'leads_created', filters: { assignee: agent } })])).detail).toBe('FORBIDDEN');
    expect((await t.fails(agent, `select public.si_query($1, $2::jsonb)`, [org, JSON.stringify({ metric: 'leads_created' })])).detail).toBe('NOT_FOUND');
  });
});

describe('funnel', () => {
  it('counts each stage from evidence with step conversion, drop-off and maturity', async () => {
    const f = (await t.as<{ r: R }>(manager, `select public.si_funnel($1, null, $2::date, $3::date, '{}', false) r`, [org, W().from, W().to]))[0].r;
    const s = Object.fromEntries(f.stages.map((x: R) => [x.stage, x]));
    expect(f.cohort).toMatchObject({ leads: 6, immature: 0 });
    expect([s.captured.leads, s.contacted.leads, s.qualified.leads, s.booked.leads, s.attended.leads, s.deal.leads, s.won.leads]).toEqual([6, 5, 4, 3, 1, 2, 1]);
    expect(s.qualified).toMatchObject({ step_base: 5, step_conversion: 0.8, drop_off: 1 });
    expect(s.won.median_days_from_capture).toBeCloseTo(2, 0);
  });
});

describe('forecast', () => {
  it('needs finance access, reports insufficient history honestly, uses configured probabilities per currency, and backtests', async () => {
    expect((await t.fails(manager, `select public.si_forecast_request($1, $2, $3, $4)`, [org, day(0), day(30), key()])).detail).toBe('FORBIDDEN');
    const a = (await t.as<{ r: R }>(owner, `select public.si_forecast_request($1, $2, $3, $4) r`, [org, day(0), day(30), key()]))[0].r;
    expect(a.status).toBe('queued');
    await tick();
    const r1 = await one(`select * from public.sales_forecast_runs where id = $1`, [a.forecast_id]);
    expect(r1.status).toBe('insufficient_data');
    expect(r1.results.INR).toMatchObject({ status: 'insufficient_data', closed_deals_in_history: 1, open_deals_in_window: 1, scenario_high_all_open: 15000000 });

    await t.as(owner, `select public.si_settings_save($1, '{"stage_probabilities": {"offer": 0.4, "negotiation": 0.6, "under_contract": 0.9}}'::jsonb)`, [org]);
    const b = (await t.as<{ r: R }>(owner, `select public.si_forecast_request($1, $2, $3, $4) r`, [org, day(0), day(30), key()]))[0].r;
    await tick();
    const r2 = await one(`select * from public.sales_forecast_runs where id = $1`, [b.forecast_id]);
    expect(r2).toMatchObject({ status: 'completed', method: 'configured_stage_probabilities' });
    expect(Number(r2.results.INR.forecast_value)).toBe(6000000);
    expect(Number(r2.results.INR.commission_forecast)).toBe(120000);
    expect(Number(r2.results.USD.forecast_value)).toBe(300000);
    expect(r2.caveats[0]).toContain('not a statistical confidence interval');

    // A past horizon is evaluated against what actually closed.
    const c = (await t.as<{ r: R }>(owner, `select public.si_forecast_request($1, $2, $3, $4) r`, [org, day(-40), day(-36), key()]))[0].r;
    await tick();
    await tick();
    const r3 = await one(`select * from public.sales_forecast_runs where id = $1`, [c.forecast_id]);
    expect(r3.actuals).toEqual({ INR: 20000000 });
    expect(r3.evaluated_at).not.toBeNull();
    await t.as(owner, `select public.si_settings_save($1, '{}'::jsonb)`, [org]);
  });
});

describe('anomalies, findings and the insight lifecycle', () => {
  it('flags an intake drop only against a real baseline, refreshes idempotently and expires when it clears', async () => {
    await t.db.query(`update public.organizations set created_at = now() - interval '120 days' where id = $1`, [org]);
    expect((await one(`select private.si_evaluate($1) r`, [org])).r.detected).not.toContain('sales.intake_drop');
    // Eight earlier weeks with 12 leads each, and none in the last week.
    for (let w = 1; w <= 8; w++) {
      for (let i = 0; i < 12; i++) {
        const r = await t.lead(manager, org, { name: `Base ${w}-${i}`, phone: `97${String(w).padStart(2, '0')}${String(i).padStart(6, '0')}`, type: 'buyer' });
        await t.db.query(`update public.leads set created_at = now() - make_interval(days => $2) where id = $1`, [r.lead_id, 7 * w + 3]);
      }
    }
    // Parked leads: no follow-up date, appointment, follow-up or task.
    await t.db.query(`update public.leads set next_follow_up_at = null where organization_id = $1 and title like 'Base %'`, [org]);
    const r1 = (await one(`select private.si_evaluate($1) r`, [org])).r;
    expect(r1.detected).toContain('sales.intake_drop');
    await one(`select private.si_evaluate($1) r`, [org]);
    const ins = await rows(`select * from public.sales_insights where organization_id = $1 and rule_id = 'sales.intake_drop'`, [org]);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ kind: 'anomaly', status: 'new', generated_by: 'rules' });
    // The fixture cohort (6 leads, 40 days ago) falls in one of the baseline weeks: (8 × 12 + 6) / 8.
    expect(ins[0].evidence).toMatchObject({ current: 0, baseline_mean: 12.75, baseline_weeks: 8, metric: 'leads_created' });
    expect((await rows(`select * from public.outbox_events where event_type = 'sales.insight_detected' and record_id = $1`, [ins[0].id]))).toHaveLength(1);
    // Findings on the current state.
    expect(r1.detected).toContain('sales.no_next_action');
    // Intake recovers → the anomaly expires.
    await t.db.query(`update public.leads set created_at = now() - interval '2 days' where organization_id = $1 and title like 'Base 1-%'`, [org]);
    const r2 = (await one(`select private.si_evaluate($1) r`, [org])).r;
    expect(r2.detected).not.toContain('sales.intake_drop');
    expect((await one(`select status from public.sales_insights where id = $1`, [ins[0].id])).status).toBe('expired');
  });

  it('lets managers move insights through review; completion needs a note', async () => {
    const x = await one(`select id from public.sales_insights where organization_id = $1 and rule_id = 'sales.no_next_action'`, [org]);
    expect((await t.fails(viewer, `select public.si_insight_feedback($1, 'accepted')`, [x.id])).detail).toBe('FORBIDDEN');
    await t.as(manager, `select public.si_insight_feedback($1, 'accepted')`, [x.id]);
    expect((await t.fails(manager, `select public.si_insight_feedback($1, 'completed', '')`, [x.id])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.si_insight_feedback($1, 'new')`, [x.id])).detail).toBe('INVALID_TRANSITION');
    await t.as(manager, `select public.si_insight_feedback($1, 'completed', 'Assigned owners to every parked lead')`, [x.id]);
    expect(await one(`select status, feedback_note from public.sales_insights where id = $1`, [x.id])).toEqual({ status: 'completed', feedback_note: 'Assigned owners to every parked lead' });
    // A completed insight is not reopened by the next evaluation.
    await one(`select private.si_evaluate($1) r`, [org]);
    expect((await one(`select status from public.sales_insights where id = $1`, [x.id])).status).toBe('completed');
  });
});

describe('recommendations', () => {
  it('stores only recommendations whose cited numbers and findings are in the snapshot', async () => {
    const ctx = (await t.as<{ r: R }>(manager, `select public.si_recommendation_context($1) r`, [org]))[0].r;
    expect(ctx.data.metrics.closed_deal_value).toBeUndefined(); // managers have no finance access
    const lc = ctx.data.metrics.leads_created.rows[0].value;
    const finding = ctx.data.findings[0]?.id ?? null;
    const rec = (metricValue: number, findingIds: string[] = []) => [{ title: 'Respond faster', summary: 's', category: 'lead_response', priority: 'high',
      observation: 'o', interpretation: 'i', recommended_action: 'a', expected_direction: 'more contacted leads', supporting_metrics: [{ metric: 'leads_created', value: metricValue }],
      finding_ids: findingIds, assumptions: [], limitations: ['Correlation, not cause'] }];
    expect((await t.fails(manager, `select public.si_recommendations_save($1, $2::jsonb, 'claude-opus-5-5', 'v1')`, [ctx.snapshot_id, JSON.stringify(rec(lc + 1))])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.si_recommendations_save($1, $2::jsonb, 'claude-opus-5-5', 'v1')`,
      [ctx.snapshot_id, JSON.stringify(rec(lc, ['00000000-0000-0000-0000-000000000000']))])).detail).toBe('VALIDATION_ERROR');
    const saved = (await t.as<{ r: R }>(manager, `select public.si_recommendations_save($1, $2::jsonb, 'claude-opus-5-5', 'v1') r`,
      [ctx.snapshot_id, JSON.stringify(rec(lc, finding ? [finding] : []))]))[0].r;
    expect(saved.saved).toBe(1);
    expect(await one(`select kind, generated_by, status, snapshot_id from public.sales_insights where snapshot_id = $1`, [ctx.snapshot_id]))
      .toEqual({ kind: 'recommendation', generated_by: 'ai', status: 'new', snapshot_id: ctx.snapshot_id });
    expect((await t.fails(manager, `select public.si_recommendations_save($1, $2::jsonb, 'm', 'v1')`, [ctx.snapshot_id, JSON.stringify(rec(lc))])).detail).toBe('CONFLICT');
  });
});

describe('reports and isolation', () => {
  it('builds reports within the requester\'s permissions and hides financial reports from others', async () => {
    const m = (await t.as<{ r: R }>(manager, `select public.si_report_request($1, 'executive_summary', 'last_90_days', null, null, '{}', $2) r`, [org, key()]))[0].r;
    const o = (await t.as<{ r: R }>(owner, `select public.si_report_request($1, 'executive_summary', 'last_90_days', null, null, '{}', $2) r`, [org, key()]))[0].r;
    expect((await t.fails(manager, `select public.si_report_request($1, 'pipeline_forecast', 'last_90_days', null, null, '{}', $2)`, [org, key()])).detail).toBe('FORBIDDEN');
    await tick();
    const mr = await one(`select * from public.sales_report_runs where id = $1`, [m.report_id]);
    expect(mr.status).toBe('completed');
    expect(mr.result.metrics.closed_deal_value).toBeUndefined();
    expect(mr.result.excluded).toEqual(['Financial metrics (requires finance access)']);
    expect(mr.result.definitions.qualification_rate).toContain('same cohort');
    const or = await one(`select * from public.sales_report_runs where id = $1`, [o.report_id]);
    expect(or.result.metrics.closed_deal_value.rows[0]).toMatchObject({ currency: 'INR', value: 20000000 });
    expect(await t.as(manager, `select id from public.sales_report_runs where id = $1`, [o.report_id])).toEqual([]);
    expect(await t.as(manager, `select id from public.sales_report_runs where id = $1`, [m.report_id])).toHaveLength(1);
    expect(await t.as(ownerB, `select id from public.sales_report_runs where organization_id = $1`, [org])).toEqual([]);
  });

  it('keeps every analytics surface inside the workspace', async () => {
    for (const [sql, params] of [
      [`select public.si_query($1, '{"metric": "leads_created"}'::jsonb)`, [org]],
      [`select public.si_overview($1, 'last_30_days', null, null, '{}')`, [org]],
      [`select public.si_funnel($1, 'last_30_days', null, null, '{}', false)`, [org]],
      [`select public.si_breakdown($1, 'source', array['leads_created'], 'last_30_days', null, null, '{}')`, [org]],
      [`select public.si_recommendation_context($1)`, [org]],
      [`select public.si_forecast_request($1, current_date, current_date + 30, 'k_cross_tenant_1')`, [org]],
    ] as const) {
      expect((await t.fails(ownerB, sql, [...params])).detail).toBe('NOT_FOUND');
    }
    expect(await t.as(ownerB, `select id from public.sales_insights where organization_id = $1`, [org])).toEqual([]);
    expect(await t.as(ownerB, `select id from public.sales_forecast_runs where organization_id = $1`, [org])).toEqual([]);
    expect((await t.fails(manager, `select public.sales_intelligence_tick(1)`)).code).toBe('42501');
    expect((await t.fails(manager, `insert into public.sales_insights (organization_id, kind, category, priority, title, summary, generated_by, fingerprint)
      values ($1, 'finding', 'operations', 'low', 'x', 'x', 'rules', 'x')`, [org])).code).toBe('42501');
  });

  it('logs analyst queries as validated specs and outcomes, without the question', async () => {
    await t.as(manager, `select public.si_query($1, '{"metric": "leads_created", "preset": "last_30_days"}'::jsonb, true)`, [org]);
    const denied = (await t.as<{ r: R }>(manager, `select public.si_query($1, '{"metric": "closed_deal_value"}'::jsonb, true) r`, [org]))[0].r;
    expect(denied).toEqual({ error: 'FORBIDDEN', message: 'Financial metrics need finance access' });
    const logs = await rows(`select spec, status from public.sales_analyst_queries where organization_id = $1 order by created_at`, [org]);
    expect(logs.map((x) => x.status)).toEqual(['answered', 'forbidden']);
    expect(JSON.stringify(logs)).not.toContain('question');
  });
});
