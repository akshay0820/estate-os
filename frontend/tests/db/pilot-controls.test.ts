// Phase 4 — per-tenant agent pause (server-enforced) and the pilot overview.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, admin: string, manager: string, agent: string, viewer: string;
let orgB: string, ownerB: string;
let seq = 0;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const setControl = (user: string, o: string, agentId: string, paused: boolean, reason = 'Pilot stage control') =>
  t.as<{ r: R }>(user, `select public.agent_control_set($1, $2, $3, $4) r`, [o, agentId, paused, reason]).then((x) => x[0].r);
const qTick = () => t.asService(`select public.qualification_tick(50)`);
const current = (lead: string) => one(`select status from public.lead_qualifications where lead_id = $1 and is_current`, [lead]);
const handoff = (lead: string) => one(`select status from public.outbox_events where record_id = $1 and event_type = 'lead.ready_for_qualification'`, [lead]);
const newLead = (user: string, o: string, n: string) => t.lead(user, o, { name: n, phone: `98111${String(++seq).padStart(5, '0')}`, type: 'buyer', locations: ['Worli'],
  budget_max: 40000000, property_type: 'apartment', bedrooms: 3, timeline: '0-3 months' });

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Owner A');
  admin = await t.user('Admin A');
  manager = await t.user('Manager A');
  agent = await t.user('Agent A');
  viewer = await t.user('Viewer A');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, admin, 'admin');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent', ['Worli']);
  await t.member(org, viewer, 'viewer');
  ownerB = await t.user('Owner B');
  orgB = await t.org(ownerB, 'Harbor Homes');
}, 120000);

describe('agent_control_set', () => {
  it('is restricted to owners and admins of the organization and validated', async () => {
    expect((await t.fails(manager, `select public.agent_control_set($1, 'sales_qualification_agent', true, 'reason here')`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(agent, `select public.agent_control_set($1, 'sales_qualification_agent', true, 'reason here')`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(ownerB, `select public.agent_control_set($1, 'sales_qualification_agent', true, 'reason here')`, [org])).detail).toBe('NOT_FOUND');
    expect((await t.fails(owner, `select public.agent_control_set($1, 'lead_intake_agent', true, 'reason here')`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(owner, `select public.agent_control_set($1, 'made_up_agent', true, 'reason here')`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(owner, `select public.agent_control_set($1, 'follow_up_agent', true, 'no')`, [org])).detail).toBe('VALIDATION_ERROR');
    await expect(setControl(admin, org, 'follow_up_agent', false)).resolves.toMatchObject({ agent_id: 'follow_up_agent', paused: false });
  });

  it('clients cannot write controls directly; every member can see them; changes are audited', async () => {
    await setControl(owner, org, 'crm_data_agent', true, 'Shadow stage: data quality review only');
    for (const sql of [`update public.agent_controls set paused = false`, `delete from public.agent_controls`,
      `insert into public.agent_controls (organization_id, agent_id, paused, reason) values ('${org}', 'voice_calling_agent', false, 'sneaky')`]) {
      expect((await t.fails(owner, sql)).message).toMatch(/permission denied/);
    }
    expect(await t.as(viewer, `select agent_id, paused from public.agent_controls where organization_id = $1 and agent_id = 'crm_data_agent'`, [org])).toEqual([{ agent_id: 'crm_data_agent', paused: true }]);
    expect(await t.as(ownerB, `select 1 from public.agent_controls where organization_id = $1`, [org])).toHaveLength(0);
    const audit = await one(`select count(*)::int n from public.audit_logs where organization_id = $1 and action like 'agent_controls.%'`, [org]);
    expect(audit.n).toBeGreaterThanOrEqual(2);
    await setControl(owner, org, 'crm_data_agent', false);
  });
});

describe('pausing an agent holds its work for that organization only', () => {
  it('events wait, manual requests wait, the other agency is unaffected, and resume processes everything once', async () => {
    await setControl(owner, org, 'sales_qualification_agent', true, 'Pilot stage 0: configuration check');
    const a = await newLead(manager, org, 'Paused Buyer');
    const b = await newLead(ownerB, orgB, 'Other Agency Buyer');
    await qTick();
    expect(await current(a.lead_id)).toBeUndefined();
    expect((await handoff(a.lead_id)).status).toBe('pending');
    expect((await current(b.lead_id))?.status).toBe('qualified');

    // A staff request while paused is accepted but held, not processed.
    const [{ r: req }] = await t.as<{ r: R }>(manager, `select public.qualification_request($1, $2) r`, [a.lead_id, `k_pause_${Date.now()}`]);
    await qTick();
    expect(await current(a.lead_id)).toBeUndefined();
    expect((await one(`select next_attempt_at = 'infinity'::timestamptz held from public.agent_runs where id = $1`, [req.run_id])).held).toBe(true);

    // A retry scheduled while paused is held too.
    await t.db.query(`update public.agent_runs set status = 'retry_scheduled', next_attempt_at = now() where id = $1`, [req.run_id]);
    expect((await one(`select next_attempt_at = 'infinity'::timestamptz held from public.agent_runs where id = $1`, [req.run_id])).held).toBe(true);

    const resumed = await setControl(owner, org, 'sales_qualification_agent', false, 'Stage 1 approved by agency');
    expect(resumed.released_runs).toBeGreaterThanOrEqual(1);
    await qTick();
    await qTick();
    expect((await current(a.lead_id))?.status).toBe('qualified');
    expect((await handoff(a.lead_id)).status).toBe('delivered');
    expect((await one(`select count(*)::int n from public.lead_qualifications where lead_id = $1 and is_current`, [a.lead_id])).n).toBe(1);
  });

  it('a paused voice agent refuses new calls with AGENT_PAUSED; resuming allows them again', async () => {
    await t.db.query(`update public.organizations set settings = jsonb_set(jsonb_set(settings, '{calling_hours}', '{"start":0,"end":24}'), '{business_hours,days}', '[1,2,3,4,5,6,7]') where id = $1`, [org]);
    await t.as(owner, `select public.voice_settings_save($1, $2::jsonb)`, [org, JSON.stringify({ enabled: true, outbound_agent_id: 'agent_outbound_P1', inbound_agent_id: 'agent_inbound_P1',
      from_number: '+918000000009', agency_spoken_name: 'Skyline Realty', store_transcripts: true, analysis_enabled: true, recording_access: true,
      max_attempts_per_lead_per_day: 10, min_minutes_between_attempts: 5 })]);
    const l = await newLead(manager, org, 'Voice Paused Buyer');
    await t.as(owner, `select public.set_ai_call_consent($1, 'granted', 'Verbal consent at walk-in')`, [l.contact_id]);
    await setControl(owner, org, 'voice_calling_agent', true, 'Voice stays off for the pilot');
    const err = await t.fails(owner, `select public.voice_call_request($1, $2)`, [l.lead_id, `k_voice_${Date.now()}`]);
    expect(err.detail).toBe('AGENT_PAUSED');
    expect((await one(`select count(*)::int n from public.voice_calls where lead_id = $1`, [l.lead_id])).n).toBe(0);
    await setControl(owner, org, 'voice_calling_agent', false, 'Voice test window');
    const [{ r }] = await t.as<{ r: R }>(owner, `select public.voice_call_request($1, $2) r`, [l.lead_id, `k_voice2_${Date.now()}`]);
    expect(r.status).toBe('initiating');
  });

  it('a paused agent refuses its user-triggered AI features; other agents and agencies are unaffected', async () => {
    await setControl(owner, org, 'sales_intelligence_agent', true, 'AI recommendations not in pilot scope');
    expect((await t.fails(owner, `select public.ai_request_begin($1, 'sales_analyst')`, [org])).detail).toBe('AGENT_PAUSED');
    expect((await t.fails(owner, `select public.ai_request_begin($1, 'sales_recommendations')`, [org])).detail).toBe('AGENT_PAUSED');
    await expect(t.as(owner, `select public.ai_request_begin($1, 'crm_enrichment')`, [org])).resolves.toHaveLength(1);
    await expect(t.as(ownerB, `select public.ai_request_begin($1, 'sales_analyst')`, [orgB])).resolves.toHaveLength(1);
    // Permission is still checked first: a viewer gets FORBIDDEN, not a hint about the pause.
    expect((await t.fails(viewer, `select public.ai_request_begin($1, 'crm_enrichment')`, [org])).detail).toBe('FORBIDDEN');
    await setControl(owner, org, 'sales_intelligence_agent', false);
    await expect(t.as(owner, `select public.ai_request_begin($1, 'sales_analyst')`, [org])).resolves.toHaveLength(1);
  });
});

describe('pilot_overview', () => {
  it('needs operations access in the organization', async () => {
    expect((await t.fails(agent, `select public.pilot_overview($1)`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(viewer, `select public.pilot_overview($1)`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(ownerB, `select public.pilot_overview($1)`, [org])).detail).toBe('NOT_FOUND');
    expect((await t.fails(owner, `select public.pilot_overview($1, now(), now() - interval '1 day')`, [org])).detail).toBe('VALIDATION_ERROR');
  });

  it('reports real counts for the organization only, the control state, and unavailable metrics as unavailable', async () => {
    await setControl(owner, org, 'follow_up_agent', true, 'Follow-up drafts reviewed manually this week');
    const [{ r }] = await t.as<{ r: R }>(manager, `select public.pilot_overview($1, now() - interval '1 day', now() + interval '1 minute') r`, [org]);
    const direct = await one(`select count(*)::int n from public.leads where organization_id = $1 and created_at > now() - interval '1 day'`, [org]);
    expect(r.intake.leads_created).toBe(direct.n);
    expect(r.organization.name).toBe('Skyline Realty');
    expect(r.controls).toHaveLength(7);
    expect(r.controls.find((c: R) => c.agent_id === 'follow_up_agent')).toMatchObject({ paused: true, reason: 'Follow-up drafts reviewed manually this week' });
    expect(r.agents.sales_qualification_agent.succeeded).toBeGreaterThanOrEqual(1);
    expect(r.qualification.results).toBeGreaterThanOrEqual(1);
    expect(r.unavailable.map((u: R) => u.metric)).toEqual(['ai_cost', 'voice_cost', 'messaging_cost', 'staff_time_saved']);
    expect(r.settings.voice_enabled).toBe(true);

    const [{ r: rb }] = await t.as<{ r: R }>(ownerB, `select public.pilot_overview($1, now() - interval '1 day', now() + interval '1 minute') r`, [orgB]);
    const directB = await one(`select count(*)::int n from public.leads where organization_id = $1 and created_at > now() - interval '1 day'`, [orgB]);
    expect(rb.intake.leads_created).toBe(directB.n);
    expect(rb.controls.every((c: R) => c.paused === false)).toBe(true);
    await setControl(owner, org, 'follow_up_agent', false);
  });
});
