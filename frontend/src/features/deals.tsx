import { useState } from 'react';
import { Handshake, Plus, TrendingUp, CalendarClock, Trophy } from 'lucide-react';
import { Badge, Button, Drawer, Empty, Field, Input, KV, Modal, PageHeader, Segmented, Select } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { actions, attempt, ok } from '@/data/actions';
import { useCan, useLookup, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { DEAL_STAGES, LOST_REASONS } from '@/lib/domain';
import { DAY, fmtDate, fromLocalInput, inr, relTime } from '@/lib/format';
import { cx } from '@/lib/util';
import type { DealStage } from '@/store/types';
import { MemberChip } from './shared';
import { LeadTimeline } from './leads';

export function DealsPage({ params }: { params: URLSearchParams }) {
  const deals = useOrgList('deals');
  const canEdit = useCan('deals.edit');
  const [over, setOver] = useState<DealStage | null>(null);
  const [creating, setCreating] = useState(false);
  const [showClosed, setShowClosed] = useState<'open' | 'all'>('open');
  const openId = params.get('id');
  const now = Date.now();

  const visibleStages = DEAL_STAGES.filter((s) => showClosed === 'all' || !['won', 'lost'].includes(s.key));
  const recent = deals.filter((d) => showClosed === 'all' ? (!['won', 'lost'].includes(d.stage) || now - d.stageChangedAt < 90 * DAY) : !['won', 'lost'].includes(d.stage));
  const open = deals.filter((d) => !['won', 'lost'].includes(d.stage));
  const pipeline = open.reduce((s, d) => s + d.value, 0);
  const weighted = open.reduce((s, d) => s + (d.value * d.commissionPct) / 100 * (DEAL_STAGES.find((x) => x.key === d.stage)?.probability ?? 0), 0);
  const won90 = deals.filter((d) => d.stage === 'won' && now - d.stageChangedAt < 90 * DAY);
  const stalled = open.filter((d) => now - d.stageChangedAt > 14 * DAY);

  const drop = async (stage: DealStage, id: string) => {
    setOver(null);
    const d = deals.find((x) => x.id === id);
    if (!d || d.stage === stage) return;
    let reason: string | undefined;
    if (stage === 'lost') {
      const r = await confirm({ title: `Mark “${d.title}” lost?`, reasons: LOST_REASONS, confirmLabel: 'Mark lost', danger: true });
      if (!r.ok) return;
      reason = r.value;
    }
    if (stage === 'won') {
      const r = await confirm({ title: 'Close as won?', body: `${inr(d.value)} · commission estimate ${inr((d.value * d.commissionPct) / 100)} goes to finance for approval. The property is marked ${'sold/let'}.`, confirmLabel: 'Close won' });
      if (!r.ok) return;
    }
    if (!(await ok(() => actions.moveDeal(id, stage, reason)))) return;
    toast({ kind: stage === 'won' ? 'success' : 'info', title: `Moved to ${DEAL_STAGES.find((s) => s.key === stage)?.label}`, action: stage === 'won' || stage === 'lost' ? undefined : { label: 'Undo', run: () => void ok(() => actions.moveDeal(id, d.stage)) } });
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${open.length} open deals ]`}
        title="Deals"
        sub="Drag between stages. Every stage change is timestamped, and won deals create a commission estimate for finance."
        actions={
          <>
            <Segmented value={showClosed} onChange={setShowClosed} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'Include closed' }]} />
            {canEdit && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>New deal</Button>}
          </>
        }
      />
      <div className="grid g-kpi" style={{ marginBottom: 16 }}>
        <Stat label="Pipeline value" value={inr(pipeline)} icon={<Handshake size={14} />} note={`${open.length} open`} />
        <Stat label="Weighted commission" value={inr(weighted)} icon={<TrendingUp size={14} />} note="By stage probability" />
        <Stat label="Won · last 90 days" value={inr(won90.reduce((s, d) => s + d.value, 0))} icon={<Trophy size={14} />} note={`${won90.length} deals`} />
        <Stat label="Stalled > 14 days" value={String(stalled.length)} icon={<CalendarClock size={14} />} note="No stage change" warn={stalled.length > 0} />
      </div>
      <div className="kanban">
        {visibleStages.map((st) => {
          const list = recent.filter((d) => d.stage === st.key).sort((a, b) => b.value - a.value);
          return (
            <div
              key={st.key}
              className={cx('kb-col', over === st.key && 'over')}
              onDragOver={(e) => { if (!canEdit) return; e.preventDefault(); setOver(st.key); }}
              onDragLeave={() => setOver((o) => (o === st.key ? null : o))}
              onDrop={(e) => { e.preventDefault(); void drop(st.key, e.dataTransfer.getData('text/plain')); }}
            >
              <div className="kb-head">
                {st.label}
                <span className="count">{list.length}</span>
                <span className="sum">{inr(list.reduce((s, d) => s + d.value, 0))}</span>
              </div>
              <div className="kb-list">
                {list.map((d) => (
                  <button key={d.id} className="kb-card" draggable={canEdit} onDragStart={(e) => e.dataTransfer.setData('text/plain', d.id)} onClick={() => setParam('id', d.id)}>
                    <div className="kb-title">{d.title}</div>
                    <div className="row mt-8" style={{ gap: 6 }}>
                      <b className="num" style={{ fontSize: 14 }}>{inr(d.value)}</b>
                      <span className="faint" style={{ fontSize: 12 }}>· {d.commissionPct === 100 ? '1 mo rent' : `${d.commissionPct}%`}</span>
                    </div>
                    <div className="kb-meta">
                      <MemberChip id={d.ownerId} showName={false} />
                      {d.stage !== 'won' && d.stage !== 'lost' && now - d.stageChangedAt > 14 * DAY && <Badge tone="warning">Stalled</Badge>}
                      <span className="ml-auto">{['won', 'lost'].includes(d.stage) ? relTime(d.stageChangedAt) : `Close ${fmtDate(d.expectedClose)}`}</span>
                    </div>
                  </button>
                ))}
                {list.length === 0 && <div className="faint" style={{ fontSize: 12, textAlign: 'center', padding: '18px 0' }}>No deals</div>}
              </div>
            </div>
          );
        })}
      </div>
      {creating && <DealModal onClose={() => setCreating(false)} />}
      {openId && <DealDrawer id={openId} onClose={() => setParam('id', null)} />}
    </div>
  );
}

function Stat({ label, value, icon, note, warn }: { label: string; value: string; icon: React.ReactNode; note: string; warn?: boolean }) {
  return (
    <div className="card kpi">
      <div className="kpi-label"><span className={cx('icon-chip', warn && 'accent')}>{icon}</span>{label}</div>
      <div className="kpi-value" style={{ fontSize: 24 }}>{value}</div>
      <div className="kpi-foot">{note}</div>
    </div>
  );
}

export function DealModal({ onClose, preset }: { onClose: () => void; preset?: { leadId?: string } }) {
  const leads = useOrgList('leads');
  const properties = useOrgList('properties');
  const members = useOrgList('members');
  const [busy, setBusy] = useState(false);
  const lead = leads.find((l) => l.id === preset?.leadId);
  const [f, setF] = useState({
    leadId: preset?.leadId ?? '',
    propertyId: '',
    value: '',
    commissionPct: '2',
    stage: 'qualification' as DealStage,
    expectedClose: new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10),
    ownerId: lead?.assignedTo ?? '',
  });
  const [err, setErr] = useState('');
  const prop = properties.find((p) => p.id === f.propertyId);
  const submit = async () => {
    const l = leads.find((x) => x.id === f.leadId);
    if (!l) return setErr('Choose the lead this deal is for');
    const value = Number(f.value) || prop?.price || 0;
    if (!(value > 0)) return setErr('Enter the expected deal value');
    setBusy(true);
    const d = await attempt(() => actions.createDeal({
      title: `${l.name.split(' ').slice(-1)[0]} · ${prop ? prop.title.replace(/ at .*/, '') + ', ' + prop.locality : 'Requirement'}`,
      leadId: l.id, contactId: l.contactId, propertyId: prop?.id ?? null, stage: f.stage, value, commissionPct: Number(f.commissionPct) || 0,
      expectedClose: fromLocalInput(f.expectedClose + 'T12:00'), ownerId: f.ownerId || l.assignedTo,
    }), setErr);
    setBusy(false);
    if (!d) return;
    toast({ kind: 'success', title: 'Deal created', action: { label: 'Open', run: () => navigate('deals', { id: d.id }) } });
    onClose();
  };
  return (
    <Modal open onClose={onClose} title="New deal" description="Link the opportunity to a lead and, ideally, a specific property." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Create deal</Button></>}>
      <div className="form-grid">
        {err && <div className="banner danger full">{err}</div>}
        <Field label="Lead" className="full">
          <Select value={f.leadId} onChange={(e) => { const l = leads.find((x) => x.id === e.target.value); setF({ ...f, leadId: e.target.value, ownerId: l?.assignedTo ?? f.ownerId }); }}>
            <option value="">Choose a lead</option>
            {leads.filter((l) => !l.archived && !['won', 'lost'].includes(l.status)).slice(0, 300).map((l) => <option key={l.id} value={l.id}>{l.name} — {l.status.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
        <Field label="Property" className="full">
          <Select value={f.propertyId} onChange={(e) => { const p = properties.find((x) => x.id === e.target.value); setF({ ...f, propertyId: e.target.value, value: p ? String(p.price) : f.value, commissionPct: p?.listing === 'rent' ? '100' : f.commissionPct }); }}>
            <option value="">Not decided yet</option>
            {properties.filter((p) => ['active', 'under_offer', 'reserved'].includes(p.status)).map((p) => <option key={p.id} value={p.id}>{p.ref} · {p.title} · {inr(p.price)}</option>)}
          </Select>
        </Field>
        <Field label="Expected value (₹)"><Input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/[^\d]/g, '') })} inputMode="numeric" placeholder={prop ? String(prop.price) : ''} /></Field>
        <Field label="Commission %" hint={f.commissionPct === '100' ? 'Rental: one month’s rent' : undefined}><Input value={f.commissionPct} onChange={(e) => setF({ ...f, commissionPct: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Stage">
          <Select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value as DealStage })}>
            {DEAL_STAGES.filter((s) => !['won', 'lost'].includes(s.key)).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
        </Field>
        <Field label="Expected close"><Input type="date" value={f.expectedClose} onChange={(e) => setF({ ...f, expectedClose: e.target.value })} /></Field>
        <Field label="Owner" className="full">
          <Select value={f.ownerId ?? ''} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>
            {members.filter((m) => m.status === 'active' && m.role !== 'finance').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function DealDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useOrgList('deals').find((x) => x.id === id);
  const props = useLookup('properties');
  const leads = useLookup('leads');
  const commissions = useOrgList('commissions');
  const canEdit = useCan('deals.edit');
  if (!d) return null;
  const prop = d.propertyId ? props.get(d.propertyId) : undefined;
  const lead = d.leadId ? leads.get(d.leadId) : undefined;
  const com = commissions.find((c) => c.dealId === d.id);
  const stageIdx = DEAL_STAGES.findIndex((s) => s.key === d.stage);
  const closed = ['won', 'lost'].includes(d.stage);
  const next = DEAL_STAGES[stageIdx + 1];
  return (
    <Drawer
      open
      onClose={onClose}
      label="Deal"
      header={
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>{d.title}</h2>
          <div className="row mt-8">
            <Badge tone={d.stage === 'won' ? 'solid' : d.stage === 'lost' ? 'neutral' : 'accent'}>{DEAL_STAGES[stageIdx].label}</Badge>
            <span className="faint">In stage since {fmtDate(d.stageChangedAt)}</span>
          </div>
        </div>
      }
      footer={
        canEdit && !closed ? (
          <>
            <Button variant="danger" onClick={async () => {
              const r = await confirm({ title: 'Mark deal lost?', reasons: LOST_REASONS, confirmLabel: 'Mark lost', danger: true });
              if (r.ok && (await ok(() => actions.moveDeal(d.id, 'lost', r.value)))) toast({ kind: 'info', title: 'Deal lost', body: r.value });
            }}>Mark lost</Button>
            {next && next.key !== 'lost' && (
              <Button variant="primary" onClick={async () => {
                if (next.key === 'won') {
                  const r = await confirm({ title: 'Close as won?', body: 'A commission estimate is created for finance approval.', confirmLabel: 'Close won' });
                  if (!r.ok) return;
                }
                if (!(await ok(() => actions.moveDeal(d.id, next.key)))) return;
                toast({ kind: 'success', title: `Moved to ${next.label}` });
              }}>Advance to {next.label}</Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="stack stack-lg">
        <div className="row" style={{ gap: 4 }}>
          {DEAL_STAGES.filter((s) => s.key !== 'lost').map((s, i) => (
            <div key={s.key} title={s.label} style={{ flex: 1, height: 6, borderRadius: 4, background: d.stage === 'lost' ? 'var(--fill)' : i <= stageIdx ? 'var(--ember)' : 'var(--fill)' }} />
          ))}
        </div>
        <KV items={[
          ['Value', <b key="v" className="num">{inr(d.value, { compact: false })}</b>],
          ['Commission', <span key="c">{d.commissionPct === 100 ? 'One month’s rent' : `${d.commissionPct}%`} · {inr((d.value * d.commissionPct) / 100)}{com && <Badge tone="info">{com.status}</Badge>}</span>],
          ['Expected close', canEdit && !closed ? <Input key="e" type="date" inputSize="sm" style={{ width: 170 }} value={new Date(d.expectedClose).toISOString().slice(0, 10)} onChange={(e) => { const v = e.target.value; if (v) void ok(() => actions.updateDeal(d.id, { expectedClose: fromLocalInput(v + 'T12:00') })); }} /> : fmtDate(d.expectedClose, true)],
          ['Lead', lead ? <button key="l" className="link" onClick={() => navigate('leads', { id: lead.id })}>{lead.name}</button> : '—'],
          ['Property', prop ? <button key="p" className="link" onClick={() => navigate('properties', { id: prop.id })}>{prop.title}</button> : <span className="faint">Not linked</span>],
          ['Owner', <MemberChip key="o" id={d.ownerId} />],
          ...(d.lostReason ? ([['Lost reason', d.lostReason]] as [string, string][]) : []),
        ]} />
        <div className="banner" style={{ fontSize: 12.5 }}>AI can summarize this deal and suggest next steps, but never commits to price or terms — stage moves suggested by agents require approval.</div>
        <section>
          <h4 className="section-title">Timeline</h4>
          {d.leadId ? <LeadTimeline leadId={d.leadId} canEdit={canEdit} /> : <Empty icon={<Handshake size={18} />} title="No linked lead" />}
        </section>
      </div>
    </Drawer>
  );
}
