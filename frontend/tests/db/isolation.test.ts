import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, nextWeekdayAt, type TestDb } from './harness';

// Two agencies, several roles each, plus an outsider with no membership.
let t: TestDb;
let A: string, B: string;
let ownerA: string, adminA: string, managerA: string, agentA: string, viewerA: string, financeA: string, ownerB: string, agentB: string, outsider: string;
let leadA: string, leadB: string, contactB: string, propA: string, propB: string;

beforeAll(async () => {
  t = await createDb();
  ownerA = await t.user('Owner A');
  adminA = await t.user('Admin A');
  managerA = await t.user('Manager A');
  agentA = await t.user('Agent A');
  viewerA = await t.user('Viewer A');
  financeA = await t.user('Finance A');
  ownerB = await t.user('Owner B');
  agentB = await t.user('Agent B');
  outsider = await t.user('Outsider');
  A = await t.org(ownerA, 'Skyline Realty');
  B = await t.org(ownerB, 'Harbor Homes');
  await t.member(A, adminA, 'admin');
  await t.member(A, managerA, 'manager');
  await t.member(A, agentA, 'agent', ['Powai']);
  await t.member(A, viewerA, 'viewer');
  await t.member(A, financeA, 'finance');
  await t.member(B, agentB, 'agent');

  leadA = (await t.lead(ownerA, A, { name: 'Riya Shah', phone: '9820000001', source: 'Website form', locations: ['Powai'] })).lead_id;
  const rb = await t.lead(ownerB, B, { name: 'Omkar Patil', phone: '9850000002', source: 'Referral' });
  leadB = rb.lead_id;
  contactB = rb.contact_id;
  [{ id: propA }] = await t.as<{ id: string }>(ownerA, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality) values ($1, 'SK-1', '2 BHK at Lodha Park', 'apartment', 'sale', 'active', 24500000, 900, 'Powai') returning id`, [A]);
  [{ id: propB }] = await t.as<{ id: string }>(ownerB, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality) values ($1, 'HH-1', '3 BHK in Baner', 'apartment', 'sale', 'active', 15500000, 1200, 'Baner') returning id`, [B]);
}, 120000);

describe('tenant isolation', () => {
  it('a member of A cannot read B records', async () => {
    for (const table of ['leads', 'contacts', 'properties', 'activities', 'lead_status_history', 'communication_consents']) {
      const rows = await t.as(ownerA, `select id from public.${table} where organization_id = $1`, [B]);
      expect(rows, table).toHaveLength(0);
    }
    expect(await t.as(ownerA, `select id from public.leads where id = $1`, [leadB])).toHaveLength(0);
    expect(await t.as(ownerA, `select id from public.organizations where id = $1`, [B])).toHaveLength(0);
  });

  it('a member of A cannot modify B properties (update silently affects nothing)', async () => {
    const rows = await t.as(ownerA, `update public.properties set price = 1 where id = $1 returning id`, [propB]);
    expect(rows).toHaveLength(0);
    const [p] = await t.as<{ price: string }>(ownerB, `select price from public.properties where id = $1`, [propB]);
    expect(Number(p.price)).toBe(15500000);
  });

  it('cannot insert rows into another organization', async () => {
    const e = await t.fails(ownerA, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, price, area_value, locality) values ($1, 'X', 'Sneaky listing', 'apartment', 'sale', 1, 1, 'Baner')`, [B]);
    expect(e.message).toMatch(/row-level security/);
  });

  it('cannot move a record to another organization', async () => {
    const e = await t.fails(ownerA, `update public.leads set organization_id = $1 where id = $2`, [B, leadA]);
    expect(e.message).toMatch(/permission denied/);
  });

  it('rejects cross-tenant references', async () => {
    const start = nextWeekdayAt(11);
    const e1 = await t.fails(ownerA, `insert into public.appointments (organization_id, title, lead_id, assigned_to, starts_at, ends_at) values ($1, 'Visit', $2, $3, $4, $5)`, [A, leadB, ownerA, start, new Date(start.getTime() + 45 * 60e3)]);
    expect(e1.detail).toBe('INVALID_REFERENCE');
    const e2 = await t.fails(ownerA, `insert into public.tasks (organization_id, title, due_at, related_lead_id) values ($1, 'Call', now(), $2)`, [A, leadB]);
    expect(e2.detail).toBe('INVALID_REFERENCE');
    const e3 = await t.fails(ownerA, `insert into public.deals (organization_id, title, primary_contact_id, property_id, expected_value) values ($1, 'Deal', $2, $3, 100)`, [A, contactB, propA]);
    expect(e3.detail).toBe('INVALID_REFERENCE');
    const e4 = await t.fails(ownerA, `select public.create_lead($1, $2::jsonb, 'create')`, [A, JSON.stringify({ contact_id: contactB })]);
    expect(e4.detail).toBe('INVALID_REFERENCE');
  });

  it('rejects assigning work to someone outside the organization', async () => {
    const e = await t.fails(ownerA, `update public.leads set assigned_to = $1 where id = $2`, [agentB, leadA]);
    expect(e.detail).toBe('INVALID_REFERENCE');
  });

  it('RPCs refuse other tenants', async () => {
    const e1 = await t.fails(ownerA, `select public.dashboard_metrics($1, now() - interval '30 days', now())`, [B]);
    expect(e1.detail).toBe('FORBIDDEN');
    const e2 = await t.fails(ownerA, `select public.create_lead($1, '{"name":"x","phone":"9820000009"}'::jsonb)`, [B]);
    expect(e2.detail).toBe('FORBIDDEN');
    const [counts] = await t.as<{ c: Record<string, number> }>(ownerA, `select public.lead_view_counts($1) c`, [B]);
    expect(Object.values(counts.c).every((n) => n === 0)).toBe(true);
  });

  it('documents and storage objects are tenant scoped', async () => {
    const docId = '11111111-1111-4111-8111-111111111111';
    await t.as(ownerB, `insert into public.documents (id, organization_id, name, storage_path, mime_type, file_size_bytes, uploaded_by) values ($1, $2, 'deed.pdf', $3, 'application/pdf', 1000, $4)`, [docId, B, `${B}/${docId}/deed.pdf`, ownerB]);
    await t.as(ownerB, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${B}/${docId}/deed.pdf`]);
    expect(await t.as(ownerA, `select id from public.documents where id = $1`, [docId])).toHaveLength(0);
    expect(await t.as(ownerA, `select id from storage.objects where name like $1`, [`${B}/%`])).toHaveLength(0);
    const e = await t.fails(ownerA, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${B}/${docId}/evil.pdf`]);
    expect(e.message).toMatch(/row-level security/);
    // Objects without a metadata row cannot be uploaded at all.
    const e2 = await t.fails(ownerA, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${A}/no-row/file.pdf`]);
    expect(e2.message).toMatch(/row-level security/);
    // Paths must be scoped to the org and document id.
    const e3 = await t.fails(ownerA, `insert into public.documents (organization_id, name, storage_path, mime_type, file_size_bytes, uploaded_by) values ($1, 'x.pdf', $2, 'application/pdf', 10, $3)`, [A, `${B}/x/x.pdf`, ownerA]);
    expect(e3.message).toMatch(/documents_path_scoped/);
  });

  it('anonymous callers see nothing', async () => {
    await expect(t.asAnon(`select * from public.leads`)).rejects.toThrow(/permission denied/);
    await expect(t.asAnon(`select public.create_organization('Anon org')`)).rejects.toThrow(/permission denied/);
  });

  it('a user with no membership sees nothing', async () => {
    expect(await t.as(outsider, `select id from public.leads`)).toHaveLength(0);
    expect(await t.as(outsider, `select id from public.organizations`)).toHaveLength(0);
    expect(await t.as(outsider, `select id from public.profiles where id <> $1`, [outsider])).toHaveLength(0);
  });

  it('suspended members lose access immediately', async () => {
    const temp = await t.user('Temp Agent');
    await t.member(A, temp, 'agent');
    expect((await t.as(temp, `select id from public.leads where organization_id = $1`, [A])).length).toBeGreaterThan(0);
    await t.as(ownerA, `update public.organization_memberships set status = 'suspended' where user_id = $1 and organization_id = $2`, [temp, A]);
    expect(await t.as(temp, `select id from public.leads where organization_id = $1`, [A])).toHaveLength(0);
  });
});

describe('privilege escalation', () => {
  it('nobody can add themselves to an organization', async () => {
    const e = await t.fails(outsider, `insert into public.organization_memberships (organization_id, user_id, role) values ($1, $2, 'owner')`, [A, outsider]);
    expect(e.message).toMatch(/permission denied/);
  });

  it('agents cannot change roles or memberships', async () => {
    const rows = await t.as(agentA, `update public.organization_memberships set role = 'admin' where user_id = $1 and organization_id = $2 returning id`, [agentA, A]);
    expect(rows).toHaveLength(0);
    const [m] = await t.as<{ role: string }>(ownerA, `select role from public.organization_memberships where user_id = $1 and organization_id = $2`, [agentA, A]);
    expect(m.role).toBe('agent');
  });

  it('admins cannot change their own role or mint owners', async () => {
    const e1 = await t.fails(adminA, `update public.organization_memberships set role = 'manager' where user_id = $1 and organization_id = $2`, [adminA, A]);
    expect(e1.detail).toBe('FORBIDDEN');
    const e2 = await t.fails(adminA, `update public.organization_memberships set role = 'owner' where user_id = $1 and organization_id = $2`, [managerA, A]);
    expect(e2.detail).toBe('FORBIDDEN');
  });

  it('the last active owner cannot be demoted or suspended', async () => {
    const solo = await t.user('Solo Owner');
    const org = await t.org(solo, 'Solo Realty');
    const other = await t.user('Solo Admin');
    await t.member(org, other, 'admin');
    const e = await t.fails(other, `update public.organization_memberships set status = 'suspended' where user_id = $1 and organization_id = $2`, [solo, org]);
    expect(['LAST_OWNER', 'FORBIDDEN']).toContain(e.detail);
  });

  it('agents cannot invite, change settings, read audit logs or reassign leads', async () => {
    expect((await t.fails(agentA, `select public.invite_member($1, 'x@example.com', 'agent')`, [A])).detail).toBe('FORBIDDEN');
    expect(await t.as(agentA, `update public.organizations set name = 'Hacked' where id = $1 returning id`, [A])).toHaveLength(0);
    expect(await t.as(agentA, `select id from public.audit_logs where organization_id = $1`, [A])).toHaveLength(0);
    const own = await t.lead(agentA, A, { name: 'Agent Lead', phone: '9820000011', assigned_to: agentA });
    expect((await t.fails(agentA, `update public.leads set assigned_to = $1 where id = $2`, [managerA, own.lead_id])).detail).toBe('FORBIDDEN');
  });

  it('agents may only edit leads assigned to them', async () => {
    const other = await t.lead(ownerA, A, { name: 'Manager Lead', phone: '9820000012', assigned_to: managerA });
    expect(await t.as(agentA, `update public.leads set priority = 'urgent' where id = $1 returning id`, [other.lead_id])).toHaveLength(0);
  });

  it('agents cannot verify listings; viewers cannot create leads; finance cannot edit CRM', async () => {
    expect((await t.fails(agentA, `update public.properties set verified_at = now() where id = $1`, [propA])).detail).toBe('FORBIDDEN');
    expect((await t.fails(viewerA, `select public.create_lead($1, '{"name":"V","phone":"9820000013"}'::jsonb)`, [A])).detail).toBe('FORBIDDEN');
    expect(await t.as(financeA, `update public.properties set price = 2 where id = $1 returning id`, [propA])).toHaveLength(0);
  });

  it('computed and protected columns cannot be written by clients', async () => {
    expect((await t.fails(ownerA, `update public.leads set lead_score = 99 where id = $1`, [leadA])).message).toMatch(/permission denied/);
    expect((await t.fails(ownerA, `update public.leads set created_at = now() - interval '1 year' where id = $1`, [leadA])).message).toMatch(/permission denied/);
  });

  it('audit logs are append-only, even for owners', async () => {
    expect((await t.fails(ownerA, `delete from public.audit_logs`)).message).toMatch(/permission denied/);
    expect((await t.fails(ownerA, `insert into public.audit_logs (organization_id, actor_type, action) values ($1, 'user', 'fake')`, [A])).message).toMatch(/permission denied/);
    expect((await t.fails(ownerA, `update public.audit_logs set action = 'x'`)).message).toMatch(/permission denied/);
  });

  it('activities cannot be forged', async () => {
    const e1 = await t.fails(ownerA, `insert into public.activities (organization_id, lead_id, activity_type, title, source, created_by) values ($1, $2, 'status', 'Status → won', 'user', $3)`, [A, leadA, ownerA]);
    expect(e1.message).toMatch(/row-level security/);
    const e2 = await t.fails(ownerA, `insert into public.activities (organization_id, lead_id, activity_type, title, source, created_by) values ($1, $2, 'note', 'Note', 'user', $3)`, [A, leadA, agentA]);
    expect(e2.message).toMatch(/row-level security/);
  });

  it('restricted documents are hidden from roles without permission', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    await t.as(ownerA, `insert into public.documents (id, organization_id, name, storage_path, mime_type, file_size_bytes, uploaded_by, classification) values ($1, $2, 'pan.pdf', $3, 'application/pdf', 100, $4, 'restricted')`, [id, A, `${A}/${id}/pan.pdf`, ownerA]);
    expect(await t.as(ownerA, `select id from public.documents where id = $1`, [id])).toHaveLength(1);
    expect(await t.as(agentA, `select id from public.documents where id = $1`, [id])).toHaveLength(0);
  });

  it('notifications are private to their recipient', async () => {
    await t.as(ownerA, `update public.leads set assigned_to = $1 where id = $2`, [agentA, leadA]);
    expect((await t.as(agentA, `select id from public.notifications where organization_id = $1`, [A])).length).toBeGreaterThan(0);
    expect(await t.as(managerA, `select id from public.notifications where user_id = $1`, [agentA])).toHaveLength(0);
  });

  it('exports are audited server-side and require permission', async () => {
    await t.as(ownerA, `select public.record_export($1, 'leads', 12)`, [A]);
    const [row] = await t.as<{ actor_user_id: string; details: { rows: number } }>(ownerA, `select actor_user_id, details from public.audit_logs where action = 'leads.exported' and organization_id = $1`, [A]);
    expect(row).toEqual({ actor_user_id: ownerA, details: { rows: 12 } });
    expect((await t.fails(viewerA, `select public.record_export($1, 'leads', 1)`, [A])).detail).toBe('FORBIDDEN');
    expect((await t.fails(ownerA, `select public.record_export($1, 'leads', 1)`, [B])).detail).toBe('FORBIDDEN');
  });

  it('webhook ingestion is not callable by signed-in users', async () => {
    const e = await t.fails(ownerA, `select public.ingest_lead($1, 'webhook', 'e1', '{}'::jsonb, true)`, [A]);
    expect(e.message).toMatch(/permission denied/);
  });
});
