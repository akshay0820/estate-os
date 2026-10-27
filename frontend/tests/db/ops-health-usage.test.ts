// Phase 5 — platform health signal (service role only) and per-tenant AI usage metering.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, orgB: string, ownerB: string;

const health = async () => (await t.asService<{ r: R }>(`select public.ops_health() r`))[0].r;
const usage = (user: string, o: string) => t.as<{ r: R }>(user, `select public.ai_usage_summary($1, now() - interval '1 day', now() + interval '1 minute') r`, [o]).then((x) => x[0].r);

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Owner A');
  manager = await t.user('Manager A');
  agent = await t.user('Agent A');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent');
  ownerB = await t.user('Owner B');
  orgB = await t.org(ownerB, 'Harbor Homes');
  await t.lead(manager, org, { name: 'Usage Buyer', phone: '9811100071', source: 'Website' });
  await t.lead(ownerB, orgB, { name: 'Other Buyer', phone: '9811100072', source: 'Website' });
}, 120000);

describe('ops_health', () => {
  it('is callable only by the service role', async () => {
    expect((await t.fails(owner, `select public.ops_health()`)).message).toMatch(/permission denied/);
    expect(await t.asAnon(`select public.ops_health()`).catch((e) => e.message)).toMatch(/permission denied/);
  });

  it('reports ok with no tenant data, and null (not zero) for signals this database cannot observe', async () => {
    const h = await health();
    expect(h.status).toBe('ok');
    expect(h.reasons).toEqual([]);
    expect(h.signals.cron_failed_15m).toBeNull(); // no pg_cron in the test database
    expect(h.signals.worker_errors_15m).toBeNull(); // no pg_net
    expect(JSON.stringify(h)).not.toMatch(/Skyline|Harbor|Usage Buyer|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('degrades on dead-lettered events and on a stale backlog', async () => {
    const [{ id }] = await t.asService<{ id: string }>(`select id from public.outbox_events where organization_id = $1 limit 1`, [org]);
    await t.db.query(`update public.outbox_events set status = 'dead_letter' where id = $1`, [id]);
    let h = await health();
    expect(h).toMatchObject({ status: 'degraded', reasons: ['dead_letters'] });
    await t.db.query(`update public.outbox_events set status = 'delivered' where id = $1`, [id]);
    await t.db.query(`update public.outbox_events set status = 'pending', available_at = now() - interval '1 hour', created_at = now() - interval '1 hour' where id = $1`, [id]);
    h = await health();
    expect(h.reasons).toContain('event_backlog');
    await t.db.query(`update public.outbox_events set status = 'delivered' where id = $1`, [id]);
    expect((await health()).status).toBe('ok');
  });

  it('an older dead letter is reported in the signals but no longer flips the status', async () => {
    const [{ id }] = await t.asService<{ id: string }>(`select id from public.outbox_events where organization_id = $1 limit 1`, [org]);
    await t.db.query(`update public.outbox_events set status = 'dead_letter', created_at = now() - interval '2 hours', locked_until = now() - interval '1 hour' where id = $1`, [id]);
    const h = await health();
    expect(h.status).toBe('ok');
    expect(h.signals.dead_letter_events_24h).toBeGreaterThanOrEqual(1);
    expect(h.signals.dead_letters_15m).toBe(0);
    await t.db.query(`update public.outbox_events set status = 'delivered' where id = $1`, [id]);
  });

  it("events held by a workspace's paused agent are not a backlog", async () => {
    const [{ id, consumer }] = await t.asService<{ id: string; consumer: string }>(
      `select id, consumer from public.outbox_events where organization_id = $1 and consumer = 'sales_qualification_agent' limit 1`, [org]);
    await t.db.query(`update public.outbox_events set status = 'pending', available_at = now() - interval '1 hour', created_at = now() - interval '1 hour' where id = $1`, [id]);
    expect((await health()).reasons).toContain('event_backlog');
    await t.as(owner, `select public.agent_control_set($1, $2, true, 'Paused for the health test')`, [org, consumer]);
    expect((await health()).reasons).not.toContain('event_backlog');
    await t.as(owner, `select public.agent_control_set($1, $2, false, 'Resumed after the health test')`, [org, consumer]);
    await t.db.query(`update public.outbox_events set status = 'delivered' where id = $1`, [id]);
  });
});

describe('AI usage metering', () => {
  it('records provider-reported tokens on user-triggered requests; the four-argument call still works', async () => {
    const [{ r: a }] = await t.as<{ r: R }>(manager, `select public.ai_request_begin($1, 'sales_analyst') r`, [org]);
    expect((await t.as<{ ok: boolean }>(manager, `select public.ai_request_finish($1, 'ok', 900, 'claude-opus-5-5', 1200, 300) ok`, [a.request_id]))[0].ok).toBe(true);
    const [{ r: b }] = await t.as<{ r: R }>(manager, `select public.ai_request_begin($1, 'sales_analyst') r`, [org]);
    expect((await t.as<{ ok: boolean }>(manager, `select public.ai_request_finish(p_request => $1, p_status => 'model_error', p_duration_ms => 50, p_model => 'claude-opus-5-5') ok`, [b.request_id]))[0].ok).toBe(true);
    expect(await t.asService(`select input_tokens, output_tokens from public.ai_requests where id = $1`, [a.request_id])).toEqual([{ input_tokens: 1200, output_tokens: 300 }]);
    // Out-of-range values are dropped, not stored.
    const [{ r: c }] = await t.as<{ r: R }>(manager, `select public.ai_request_begin($1, 'sales_analyst') r`, [org]);
    await t.as(manager, `select public.ai_request_finish($1, 'ok', 10, 'm', -5, 99999999)`, [c.request_id]);
    expect(await t.asService(`select input_tokens, output_tokens from public.ai_requests where id = $1`, [c.request_id])).toEqual([{ input_tokens: null, output_tokens: null }]);
  });

  it('summarizes tokens per agent from stored provider usage, for this organization only', async () => {
    await t.db.query(`update public.agent_runs set model_meta = '{"model": "claude-opus-5-5", "input_tokens": 500, "output_tokens": 80, "outcome": "ok"}'
      where id = (select id from public.agent_runs where organization_id = $1 and agent_id = 'lead_intake_agent' limit 1)`, [org]);
    await t.db.query(`update public.agent_runs set model_meta = '{"model": "claude-opus-5-5", "outcome": "not_configured"}'
      where id = (select id from public.agent_runs where organization_id = $1 and agent_id = 'lead_intake_agent' limit 1)`, [orgB]);
    const u = await usage(manager, org);
    expect(u.cost.available).toBe(false);
    expect(u.by_agent.lead_intake_agent).toMatchObject({ model_responses: 1, input_tokens: 500, output_tokens: 80, models: ['claude-opus-5-5'] });
    expect(u.by_agent.sales_intelligence_agent).toMatchObject({ model_responses: 1, not_reaching_model: 2, input_tokens: 1200, output_tokens: 300 });
    const ub = await usage(ownerB, orgB);
    expect(ub.by_agent.lead_intake_agent).toMatchObject({ model_responses: 0, not_reaching_model: 1, input_tokens: 0 });
    expect(ub.by_agent.sales_intelligence_agent).toBeUndefined();
  });

  it('keeps the usage of an earlier call when a later call replaces the stored meta; appends do not double-count', async () => {
    const l = await t.lead(manager, org, { name: 'Complete Buyer', phone: '9811100073', type: 'buyer', locations: ['Worli'], budget_max: 40000000,
      property_type: 'apartment', bedrooms: 3, timeline: '0-3 months' });
    await t.asService(`select public.qualification_tick(50)`);
    await t.asService(`select public.property_matching_tick(50)`);
    const [{ id }] = await t.asService<{ id: string }>(`select id from public.property_match_runs where lead_id = $1 limit 1`, [l.lead_id]);
    await t.db.query(`update public.property_match_runs set model_meta = '{"model": "claude-opus-5-5", "input_tokens": 100, "output_tokens": 10, "latency_ms": 900, "outcome": "invalid_output"}' where id = $1`, [id]);
    await t.db.query(`update public.property_match_runs set model_meta = '{"model": "claude-opus-5-5", "input_tokens": 200, "output_tokens": 20, "latency_ms": 700, "outcome": "ok"}' where id = $1`, [id]);
    // A timeout mark appends to the same call's meta: not a new call.
    await t.db.query(`update public.property_match_runs set model_meta = coalesce(model_meta, '{}') || '{"outcome": "timeout"}' where id = $1`, [id]);
    const u = await usage(manager, org);
    expect(u.by_agent.property_matching_agent).toMatchObject({ model_responses: 2, input_tokens: 300, output_tokens: 30 });
  });

  it('needs usage access in the organization', async () => {
    expect((await t.fails(agent, `select public.ai_usage_summary($1)`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(ownerB, `select public.ai_usage_summary($1)`, [org])).detail).toBe('NOT_FOUND');
    expect(await t.asAnon(`select public.ai_usage_summary($1)`, [org]).catch((e) => e.message)).toMatch(/permission denied/);
  });
});
