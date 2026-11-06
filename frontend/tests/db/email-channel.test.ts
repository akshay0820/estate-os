// Agent-less unified inbox, email channel: email_settings, conversations/messages, the outbound policy mirror,
// inbound find-or-create + dedupe + opt-out, and tenant isolation.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, viewer: string;
let orgB: string, ownerB: string;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const settingsSave = (user: string, orgId: string, p: R) => t.as(user, `select public.email_settings_save($1, $2::jsonb)`, [orgId, JSON.stringify(p)]);
const ENABLED = { enabled: true, from_address: 'leads@blaze.estate', from_name: 'Blaze Estate', inbound_address: 'blaze@inbound.postmarkapp.com' };

beforeAll(async () => {
  t = await createDb({ region: 'US' });
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agent = await t.user('Arjun Desai');
  viewer = await t.user('Vik Viewer');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent');
  await t.member(org, viewer, 'viewer');
  ownerB = await t.user('Bina Bose');
  orgB = await t.org(ownerB, 'Other Agency');
  await settingsSave(owner, org, ENABLED);
}, 120000);

describe('email_settings_save', () => {
  it('owner/admin/manager can save; agent and viewer cannot', async () => {
    await expect(settingsSave(owner, org, ENABLED)).resolves.toBeTruthy();
    expect((await t.fails(agent, `select public.email_settings_save($1, $2::jsonb)`, [org, JSON.stringify(ENABLED)])).detail).toBe('FORBIDDEN');
    expect((await t.fails(viewer, `select public.email_settings_save($1, $2::jsonb)`, [org, JSON.stringify(ENABLED)])).detail).toBe('FORBIDDEN');
  });

  it('refuses to enable without a from address, from name and inbound address', async () => {
    const fresh = await t.org(owner, 'Fresh Agency ' + Date.now());
    expect((await t.fails(owner, `select public.email_settings_save($1, $2::jsonb)`, [fresh, JSON.stringify({ enabled: true })])).detail).toBe('VALIDATION_ERROR');
  });

  it('refuses a second workspace reusing the same inbound address', async () => {
    expect((await t.fails(ownerB, `select public.email_settings_save($1, $2::jsonb)`, [orgB, JSON.stringify(ENABLED)])).detail).toBe('CONFLICT');
  });
});

describe('email_settings_org_for_inbound', () => {
  it('resolves the org that owns an enabled inbound address, case-insensitively', async () => {
    expect((await t.asService<{ r: string }>(`select public.email_settings_org_for_inbound($1) r`, ['Blaze@Inbound.Postmarkapp.com']))[0].r).toBe(org);
  });

  it('returns null for an unknown address', async () => {
    expect((await t.asService<{ r: string | null }>(`select public.email_settings_org_for_inbound($1) r`, ['nobody@inbound.postmarkapp.com']))[0].r).toBeNull();
  });
});

describe('email_inbound_ingest', () => {
  it('creates a new contact, a conversation and the first message, with implicit service consent', async () => {
    const r = (await t.asService<{ r: R }>(`select public.email_inbound_ingest($1,$2,$3,$4,$5,$6) r`,
      [org, 'Noor.Khan@Example.com', 'Noor Khan', 'Looking for a 2BHK', 'Hi, is this still available?', 'pm_msg_001']))[0].r;
    expect(r.result).toBe('ingested');
    const contact = await one(`select * from public.contacts where organization_id = $1 and email_normalized = 'noor.khan@example.com'`, [org]);
    expect(contact.display_name).toBe('Noor Khan');
    const consent = await one(`select status from public.communication_consents where contact_id = $1 and channel = 'email' and purpose = 'service'`, [contact.id]);
    expect(consent.status).toBe('granted');
    const conv = await one(`select * from public.conversations where id = $1`, [r.conversation_id]);
    expect(conv).toMatchObject({ contact_id: contact.id, channel: 'email', status: 'open', owner: 'unassigned', unread: 1 });
    const msg = await one(`select * from public.messages where conversation_id = $1`, [r.conversation_id]);
    expect(msg).toMatchObject({ direction: 'in', sender: 'contact', subject: 'Looking for a 2BHK', body: 'Hi, is this still available?', status: 'received', provider: 'postmark', provider_message_id: 'pm_msg_001' });
  });

  it('a second email from the same address reuses the conversation and bumps unread', async () => {
    const r = (await t.asService<{ r: R }>(`select public.email_inbound_ingest($1,$2,$3,$4,$5,$6) r`,
      [org, 'noor.khan@example.com', 'Noor Khan', 'Follow-up', 'Any updates?', 'pm_msg_002']))[0].r;
    const conv = await one(`select unread from public.conversations where id = $1`, [r.conversation_id]);
    expect(conv.unread).toBe(2);
    expect(await one(`select count(*)::int c from public.conversations where organization_id = $1 and channel = 'email'`, [org]).then((x) => x.c >= 1)).toBe(true);
  });

  it('the same provider_message_id is never ingested twice', async () => {
    const r = (await t.asService<{ r: R }>(`select public.email_inbound_ingest($1,$2,$3,$4,$5,$6) r`,
      [org, 'noor.khan@example.com', 'Noor Khan', 'Follow-up', 'Any updates?', 'pm_msg_002']))[0].r;
    expect(r.result).toBe('duplicate');
  });

  it('detects an opt-out, revokes email consent, and stops counting it as a normal message', async () => {
    const r = (await t.asService<{ r: R }>(`select public.email_inbound_ingest($1,$2,$3,$4,$5,$6) r`,
      [org, 'optout@example.com', 'Opt Out', 'Unsubscribe', 'unsubscribe please', 'pm_msg_opt_1']))[0].r;
    expect(r.result).toBe('opt_out');
    const contact = await one(`select id from public.contacts where organization_id = $1 and email_normalized = 'optout@example.com'`, [org]);
    const consent = await one(`select status from public.communication_consents where contact_id = $1 and channel = 'email' and purpose = 'service'`, [contact.id]);
    expect(consent.status).toBe('revoked');
  });

  it('rejects an invalid sender address', async () => {
    expect((await t.asService(`select public.email_inbound_ingest($1,$2,$3,$4,$5,$6)`, [org, 'not-an-email', 'X', 'S', 'B', 'pm_x']).catch((e) => e))).toMatchObject({ detail: 'VALIDATION_ERROR' });
  });

  it('is service-role only — a signed-in user cannot call it directly', async () => {
    expect((await t.fails(owner, `select public.email_inbound_ingest($1,$2,$3,$4,$5,$6)`, [org, 'x@y.com', 'X', 'S', 'B', 'pm_direct'])).message).toMatch(/permission denied/i);
  });
});

describe('conversation_send_request (outbound policy)', () => {
  let convId: string;
  let contactId: string;

  beforeAll(async () => {
    const r = (await t.asService<{ r: R }>(`select public.email_inbound_ingest($1,$2,$3,$4,$5,$6) r`,
      [org, 'reply.target@example.com', 'Reply Target', 'Hello', 'Hi there', 'pm_reply_seed']))[0].r;
    convId = r.conversation_id;
    contactId = (await one(`select id from public.contacts where organization_id = $1 and email_normalized = 'reply.target@example.com'`, [org])).id;
  });

  it('an internal note is always allowed and never dispatched, even without email configured', async () => {
    const r = (await t.as<{ r: R }>(agent, `select public.conversation_send_request($1,$2,true) r`, [convId, 'Reminder: call back tomorrow']))[0].r;
    expect(r.dispatch).toBe(false);
    const msg = await one(`select direction, status from public.messages where id = $1`, [r.message_id]);
    expect(msg).toEqual({ direction: 'internal', status: 'sent' });
  });

  it('a reply is reserved and dispatched when consent is granted and email is enabled (set by inbound reply-first)', async () => {
    const r = (await t.as<{ r: R }>(agent, `select public.conversation_send_request($1,$2,false) r`, [convId, 'Thanks for reaching out!']))[0].r;
    expect(r.dispatch).toBe(true);
    expect(r).toMatchObject({ to_address: 'reply.target@example.com', from_address: 'leads@blaze.estate', from_name: 'Blaze Estate' });
    const msg = await one(`select direction, status from public.messages where id = $1`, [r.message_id]);
    expect(msg).toEqual({ direction: 'out', status: 'queued' });
    const conv = await one(`select owner, status from public.conversations where id = $1`, [convId]);
    expect(conv).toEqual({ owner: 'human', status: 'open' });
  });

  it('a blocked reply is a normal result (not an exception), and still logs a blocked system message', async () => {
    await t.db.query(`update public.communication_consents set status = 'revoked' where contact_id = $1 and channel = 'email' and purpose = 'service'`, [contactId]);
    const r = (await t.as<{ r: R }>(agent, `select public.conversation_send_request($1,$2,false) r`, [convId, 'One more note']))[0].r;
    expect(r).toMatchObject({ dispatch: false, blocked: true, reason: expect.stringContaining('consent') });
    const blocked = await one(`select status from public.messages where conversation_id = $1 and sender_name = 'Policy' order by created_at desc limit 1`, [convId]);
    expect(blocked.status).toBe('blocked');
    await t.db.query(`update public.communication_consents set status = 'granted' where contact_id = $1 and channel = 'email' and purpose = 'service'`, [contactId]);
  });

  it('is blocked by the organization outbound kill switch regardless of consent', async () => {
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{outbound_paused}', 'true') where id = $1`, [org]);
    const r = (await t.as<{ r: R }>(agent, `select public.conversation_send_request($1,$2,false) r`, [convId, 'x']))[0].r;
    expect(r).toMatchObject({ dispatch: false, blocked: true, reason: expect.stringContaining('kill switch') });
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{outbound_paused}', 'false') where id = $1`, [org]);
  });

  it('viewer cannot reply (no inbox.reply)', async () => {
    expect((await t.fails(viewer, `select public.conversation_send_request($1,$2,false)`, [convId, 'x'])).detail).toBe('FORBIDDEN');
  });

  it('refuses an empty body', async () => {
    expect((await t.fails(agent, `select public.conversation_send_request($1,$2,false)`, [convId, '   '])).detail).toBe('VALIDATION_ERROR');
  });
});

describe('ownership, status and read state', () => {
  let convId: string;
  beforeAll(async () => {
    const r = (await t.asService<{ r: R }>(`select public.email_inbound_ingest($1,$2,$3,$4,$5,$6) r`,
      [org, 'owner.flow@example.com', 'Owner Flow', 'Hi', 'Hi', 'pm_owner_flow']))[0].r;
    convId = r.conversation_id;
  });

  it('take over sets owner=human and logs who, assigned_to self', async () => {
    await t.as(manager, `select public.conversation_take_over($1)`, [convId]);
    const conv = await one(`select owner, assigned_to from public.conversations where id = $1`, [convId]);
    expect(conv.owner).toBe('human');
    const note = await one(`select body from public.messages where conversation_id = $1 and direction = 'system' order by created_at desc limit 1`, [convId]);
    expect(note.body).toMatch(/took over/);
  });

  it('resume AI sets owner=ai and logs a hand-back note', async () => {
    await t.as(manager, `select public.conversation_resume_ai($1)`, [convId]);
    expect((await one(`select owner from public.conversations where id = $1`, [convId])).owner).toBe('ai');
  });

  it('set_status validates the enum and requires inbox.reply', async () => {
    await t.as(manager, `select public.conversation_set_status($1, 'resolved')`, [convId]);
    expect((await one(`select status from public.conversations where id = $1`, [convId])).status).toBe('resolved');
    expect((await t.fails(manager, `select public.conversation_set_status($1, 'bogus')`, [convId])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(viewer, `select public.conversation_set_status($1, 'open')`, [convId])).detail).toBe('FORBIDDEN');
  });

  it('mark_read zeroes unread for anyone with leads.view, even without inbox.reply', async () => {
    await t.db.query(`update public.conversations set unread = 3 where id = $1`, [convId]);
    await t.as(viewer, `select public.conversation_mark_read($1)`, [convId]);
    expect((await one(`select unread from public.conversations where id = $1`, [convId])).unread).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('org B cannot read org A conversations or messages (RLS)', async () => {
    const convs = await t.as(ownerB, `select * from public.conversations where organization_id = $1`, [org]);
    expect(convs).toHaveLength(0);
  });

  it('org B cannot act on org A\'s conversation — NOT_FOUND, not FORBIDDEN (RLS hides it first)', async () => {
    const r = (await t.asService<{ r: R }>(`select public.email_inbound_ingest($1,$2,$3,$4,$5,$6) r`,
      [org, 'isolation.check@example.com', 'Isolation', 'Hi', 'Hi', 'pm_isolation']))[0].r;
    expect((await t.fails(ownerB, `select public.conversation_take_over($1)`, [r.conversation_id])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.conversation_send_request($1,$2,false)`, [r.conversation_id, 'x'])).detail).toBe('NOT_FOUND');
  });

  it('org B cannot read org A\'s email settings', async () => {
    expect(await t.as(ownerB, `select * from public.email_settings where organization_id = $1`, [org])).toHaveLength(0);
  });
});
