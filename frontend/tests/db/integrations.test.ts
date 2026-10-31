// Migration 0030 (integration catalog): connecting stores the credential only in Vault, never in a plain column;
// reconnecting rotates it in place; only owners and admins (integrations.manage) can connect, disconnect or check one.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let owner: string, admin: string, manager: string, agent: string, org: string;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const connect = (user: string, provider: string, credential: string, type = 'messaging', scopes: string[] = ['messages:write']) =>
  t.as<{ r: R }>(user, `select public.integration_connect_api_key($1, $2, $3, $4, $5, $6) r`, [org, provider, type, provider, credential, scopes]);

beforeAll(async () => {
  t = await createDb({ region: 'US' });
  owner = await t.user('Jordan Ellis');
  admin = await t.user('Michael Torres');
  manager = await t.user('Rachel Kim');
  agent = await t.user('David Chen');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, admin, 'admin');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent');
}, 120000);

describe('connecting an integration', () => {
  it('stores the credential only in Vault and marks it connected', async () => {
    const [{ r }] = await connect(owner, 'Twilio SMS', 'ACxxxx:secrettoken', 'messaging', ['messages:write', 'messages:read']);
    expect(r).toMatchObject({ provider: 'Twilio SMS', integration_type: 'messaging', status: 'connected', scopes: ['messages:write', 'messages:read'] });
    expect(r.secret_reference).toBeUndefined();
    const row = await one<{ secret_reference: string; decrypted: string }>(
      `select i.secret_reference, (select decrypted_secret from vault.decrypted_secrets where id = i.secret_reference) decrypted
       from public.integrations i where i.organization_id = $1 and i.provider = $2`, [org, 'Twilio SMS']);
    expect(row.secret_reference).toBeTruthy();
    expect(row.decrypted).toBe('ACxxxx:secrettoken');
  });

  it('reconnecting the same provider rotates the credential in place, not a second row', async () => {
    await connect(owner, 'Postmark', 'token-v1', 'email', ['send']);
    const first = await one<{ id: string }>(`select id from public.integrations where organization_id = $1 and provider = $2`, [org, 'Postmark']);
    await connect(owner, 'Postmark', 'token-v2', 'email', ['send']);
    const after = await one<{ id: string; decrypted: string }>(
      `select i.id, (select decrypted_secret from vault.decrypted_secrets where id = i.secret_reference) decrypted
       from public.integrations i where i.organization_id = $1 and i.provider = $2`, [org, 'Postmark']);
    expect(after.id).toBe(first.id);
    expect(after.decrypted).toBe('token-v2');
    expect((await t.db.query(`select count(*)::int n from public.integrations where organization_id = $1 and provider = $2`, [org, 'Postmark'])).rows[0].n).toBe(1);
  });

  it('refuses an empty credential and an unknown integration type', async () => {
    expect((await t.fails(owner, `select public.integration_connect_api_key($1, 'Slack', 'messaging', 'Slack', '', '{}')`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(owner, `select public.integration_connect_api_key($1, 'Odd Tool', 'not_a_type', 'Odd Tool', 'key', '{}')`, [org])).detail).toBeTruthy();
  });

  it('is refused for managers and agents, only owners and admins may connect', async () => {
    expect((await t.fails(manager, `select public.integration_connect_api_key($1, 'Mailchimp', 'marketing', 'Mailchimp', 'key', '{}')`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(agent, `select public.integration_connect_api_key($1, 'Mailchimp', 'marketing', 'Mailchimp', 'key', '{}')`, [org])).detail).toBe('FORBIDDEN');
    const [{ r }] = await connect(admin, 'Mailchimp', 'key', 'marketing', ['audience:write']);
    expect(r.status).toBe('connected');
  });
});

describe('disconnecting and checking', () => {
  it('disconnect keeps the row and stops the status being connected', async () => {
    const [{ r }] = await connect(owner, 'Stripe', 'rk_live_x', 'payments', ['payment_links:write']);
    await t.as(owner, `select public.integration_disconnect($1)`, [r.id]);
    expect(await one(`select status from public.integrations where id = $1`, [r.id])).toEqual({ status: 'disconnected' });
    // Same single permission gates read and manage here (the RLS read policy also requires integrations.manage), so a
    // manager — who legitimately cannot see this row — gets NOT_FOUND, not FORBIDDEN.
    expect((await t.fails(manager, `select public.integration_disconnect($1)`, [r.id])).detail).toBe('NOT_FOUND');
  });

  it('check confirms the credential still decrypts and refreshes last_synced_at, without calling any provider', async () => {
    const [{ r }] = await connect(owner, 'HubSpot', 'token', 'marketing', ['crm.objects.contacts']);
    const [{ r: checked }] = await t.as<{ r: R }>(owner, `select public.integration_check($1) r`, [r.id]);
    expect(checked).toMatchObject({ ok: true, status: 'connected' });
    expect(checked.last_synced_at).toBeTruthy();
  });

  it('refuses another workspace’s integration and an unknown id', async () => {
    const stranger = await t.user('Sam Stranger');
    const otherOrg = await t.org(stranger, 'Other Realty');
    const [{ r }] = await connect(owner, 'Dropbox', 'token', 'productivity', ['files.content.write']);
    expect((await t.fails(stranger, `select public.integration_disconnect($1)`, [r.id])).detail).toBe('NOT_FOUND');
    expect((await t.fails(owner, `select public.integration_check($1)`, ['00000000-0000-0000-0000-000000000000'])).detail).toBe('NOT_FOUND');
    expect(otherOrg).toBeTruthy();
  });
});
