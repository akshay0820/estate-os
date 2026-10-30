import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Bath, BedDouble, Building2, CalendarPlus, Grid2X2, List, MapPin, Pencil, Plus, Ruler, ShieldAlert, Users, Archive } from 'lucide-react';
import { Badge, Button, Drawer, Empty, Field, Input, KV, Modal, PageHeader, Pager, PropertyImage, SearchInput, Segmented, Select, Textarea } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { actions, attempt, ok } from '@/data/actions';
import { useCan, useLookup, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { matchProperties, STALE_AFTER, type Tone } from '@/lib/domain';
import { fmtDate, money, relTime, currencySymbol, moneyCurrency } from '@/lib/format';
import { cx } from '@/lib/util';
import { AMENITIES } from '@/store/seed';
import type { Property } from '@/store/types';
import { MemberChip, ScorePill } from './shared';
import { BookAppointmentModal } from './appointments';
import { RecordQualityPanel } from './dataQuality';
import { LIVE } from '@/store/store';
import { useServerQuery } from '@/data/useServerQuery';
import * as live from '@/backend/live';

const STATUS: Record<Property['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Available', tone: 'success' },
  under_offer: { label: 'Under offer', tone: 'warning' },
  reserved: { label: 'Reserved', tone: 'info' },
  sold: { label: 'Sold', tone: 'solid' },
  let: { label: 'Let', tone: 'solid' },
  archived: { label: 'Archived', tone: 'neutral' },
};

function freshness(p: Property) {
  if (!p.verified || !p.verifiedAt) return { label: 'Unverified', tone: 'danger' as Tone };
  const age = Date.now() - p.verifiedAt;
  if (age > STALE_AFTER) return { label: `Stale · ${relTime(p.verifiedAt)}`, tone: 'warning' as Tone };
  return { label: `Verified ${relTime(p.verifiedAt)}`, tone: 'success' as Tone };
}

export function PropertiesPage({ params }: { params: URLSearchParams }) {
  const properties = useOrgList('properties');
  const canEdit = useCan('properties.edit');
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [q, setQ] = useState('');
  const [listing, setListing] = useState('');
  const [status, setStatus] = useState('active');
  const [locality, setLocality] = useState('');
  const [beds, setBeds] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [sort, setSort] = useState<'new' | 'price_asc' | 'price_desc'>('new');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Property | 'new' | null>(params.get('new') === '1' ? 'new' : null);
  const openId = params.get('id');
  useEffect(() => {
    if (params.get('new') === '1') setEditing('new');
  }, [params]);

  const localities = useMemo(() => [...new Set(properties.map((p) => p.locality))].sort(), [properties]);
  const filtered = useMemo(() => {
    const term = q.toLowerCase();
    const max = maxPrice ? Number(maxPrice) * (listing === 'rent' || moneyCurrency() !== 'INR' ? 1000 : 1e5) : Infinity;
    return properties
      .filter((p) => (status ? p.status === status : p.status !== 'archived') && (!listing || p.listing === listing) && (!locality || p.locality === locality) && (!beds || p.bedrooms === Number(beds)) && p.price <= max && (!verifiedOnly || (p.verified && p.verifiedAt && Date.now() - p.verifiedAt < STALE_AFTER)) && (!term || p.title.toLowerCase().includes(term) || p.ref.toLowerCase().includes(term) || p.locality.toLowerCase().includes(term)))
      .sort((a, b) => (sort === 'new' ? b.createdAt - a.createdAt : sort === 'price_asc' ? a.price - b.price : b.price - a.price));
  }, [properties, q, listing, status, locality, beds, maxPrice, verifiedOnly, sort]);
  useEffect(() => setPage(0), [q, listing, status, locality, beds, maxPrice, verifiedOnly, sort]);
  const size = view === 'grid' ? 12 : 25;
  const rows = filtered.slice(page * size, (page + 1) * size);
  const stale = properties.filter((p) => p.status === 'active' && freshness(p).tone !== 'success').length;

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${properties.filter((p) => p.status === 'active').length} available · ${stale} need verification ]`}
        title="Properties"
        sub="Verified inventory is the only source AI agents may quote from. Stale listings are flagged, never presented as confirmed."
        actions={
          <>
            <Segmented value={view} onChange={setView} options={[{ value: 'grid', label: <><Grid2X2 size={14} /> Grid</> }, { value: 'table', label: <><List size={14} /> Table</> }]} />
            {canEdit && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>Add property</Button>}
          </>
        }
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar" style={{ borderBottom: 0 }}>
          <SearchInput value={q} onChange={setQ} placeholder="Search title, ref, locality" width={240} />
          <Select selectSize="sm" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 140 }} aria-label="Status">
            <option value="">All statuses</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Select selectSize="sm" value={listing} onChange={(e) => setListing(e.target.value)} style={{ width: 120 }} aria-label="Sale or rent">
            <option value="">Sale & rent</option>
            <option value="sale">For sale</option>
            <option value="rent">For rent</option>
          </Select>
          <Select selectSize="sm" value={locality} onChange={(e) => setLocality(e.target.value)} style={{ width: 150 }} aria-label="Locality">
            <option value="">All localities</option>
            {localities.map((l) => <option key={l}>{l}</option>)}
          </Select>
          <Select selectSize="sm" value={beds} onChange={(e) => setBeds(e.target.value)} style={{ width: 100 }} aria-label="Bedrooms">
            <option value="">Any BHK</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} BHK</option>)}
          </Select>
          <Input inputSize="sm" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.replace(/[^\d.]/g, ''))} placeholder={listing === 'rent' || moneyCurrency() !== 'INR' ? `Max ${listing === 'rent' ? 'rent' : 'price'} (${currencySymbol()}K)` : `Max price (${currencySymbol()}L)`} style={{ width: 130 }} aria-label="Maximum price" />
          <label className="check" style={{ fontSize: 12.5 }}><input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} /> Verified only</label>
          <Select selectSize="sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} style={{ width: 150 }} className="ml-auto" aria-label="Sort">
            <option value="new">Newest first</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
          </Select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card"><Empty icon={<Building2 size={20} />} title="No properties match" description="Loosen a filter or add a new listing." /></div>
      ) : view === 'grid' ? (
        <>
          <div className="prop-grid">
            {rows.map((p) => {
              const f = freshness(p);
              return (
                <button key={p.id} className="card prop-card" onClick={() => setParam('id', p.id)}>
                  <div className="prop-media">
                    <PropertyImage index={p.image} alt={p.title} />
                    <div className="overlay-badges">
                      <span className="badge">{p.listing === 'sale' ? 'For sale' : 'For rent'}</span>
                      {p.status !== 'active' && <span className="badge">{STATUS[p.status].label}</span>}
                    </div>
                  </div>
                  <div className="prop-body">
                    <div className="row row-between">
                      <span className="prop-price num">{money(p.price)}{p.listing === 'rent' && <span className="faint" style={{ fontSize: 13, fontWeight: 400 }}>/mo</span>}</span>
                      <span className="mono faint" style={{ fontSize: 11 }}>{p.ref}</span>
                    </div>
                    <div className="truncate" style={{ fontWeight: 500 }}>{p.title}</div>
                    <div className="faint row" style={{ fontSize: 12.5, gap: 4 }}><MapPin size={12} /> {p.locality}, {p.city}</div>
                    <div className="prop-specs">
                      {p.bedrooms > 0 && <span><BedDouble size={13} /> {p.bedrooms} BHK</span>}
                      <span><Bath size={13} /> {p.bathrooms}</span>
                      <span><Ruler size={13} /> {p.area.toLocaleString('en-IN')} ft²</span>
                    </div>
                    <div className="row mt-8" style={{ justifyContent: 'space-between' }}>
                      <Badge tone={f.tone} dot>{f.label}</Badge>
                      <MemberChip id={p.agentId} showName={false} />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="card mt-16"><Pager page={page} pageSize={size} total={filtered.length} onPage={setPage} /></div>
        </>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Property</th><th>Status</th><th className="right">Price</th><th>Config</th><th>Locality</th><th>Verification</th><th>Agent</th><th>Listed</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const f = freshness(p);
                  return (
                    <tr key={p.id} className="clickable" onClick={() => setParam('id', p.id)}>
                      <td><div className="cell-title truncate" style={{ maxWidth: 260 }}>{p.title}</div><div className="cell-sub mono">{p.ref}</div></td>
                      <td><Badge tone={STATUS[p.status].tone} dot>{STATUS[p.status].label}</Badge></td>
                      <td className="right num">{money(p.price)}{p.listing === 'rent' ? '/mo' : ''}</td>
                      <td>{p.bedrooms ? `${p.bedrooms} BHK` : p.type} · {p.area.toLocaleString('en-IN')} ft²</td>
                      <td>{p.locality}</td>
                      <td><Badge tone={f.tone}>{f.label}</Badge></td>
                      <td><MemberChip id={p.agentId} /></td>
                      <td className="faint">{fmtDate(p.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={size} total={filtered.length} onPage={setPage} />
        </div>
      )}
      {editing && <PropertyForm property={editing === 'new' ? undefined : editing} onClose={() => { setEditing(null); if (params.get('new')) setParam('new', null); }} />}
      {openId && <PropertyDrawer id={openId} onClose={() => setParam('id', null)} onEdit={(p) => setEditing(p)} />}
    </div>
  );
}

function PropertyDrawer({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (p: Property) => void }) {
  const p = useOrgList('properties').find((x) => x.id === id);
  const leads = useOrgList('leads');
  const contacts = useLookup('contacts');
  const canEdit = useCan('properties.edit');
  const canVerify = useCan('properties.verify');
  const [booking, setBooking] = useState(false);
  // LIVE: Agent 04's stored recommendations, so this panel agrees with the lead's own matches. Demo: the local matcher.
  const server = useServerQuery(LIVE, () => live.propertyCurrentMatches(id), [id]);
  const interested = useMemo(() => {
    if (!p) return [];
    if (LIVE) {
      const byId = new Map(leads.map((l) => [l.id, l]));
      return (server.data ?? []).flatMap((r) => {
        const lead = byId.get(r.lead_id);
        return lead ? [{ lead, m: { score: r.score, reasons: r.strengths.map((x) => x.text) } }] : [];
      });
    }
    return leads
      .filter((l) => !l.archived && !['won', 'lost', 'nurture'].includes(l.status))
      .map((l) => ({ lead: l, m: matchProperties(l, [p])[0] }))
      .filter((x) => x.m && x.m.score >= 60)
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, 6);
  }, [leads, p, server.data]);
  if (!p) return null;
  const f = freshness(p);
  const owner = p.ownerContactId ? contacts.get(p.ownerContactId) : undefined;
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      label={p.title}
      header={
        <div>
          <div className="row" style={{ gap: 8 }}>
            <h2 style={{ fontSize: 19, fontWeight: 600 }}>{p.title}</h2>
            <span className="mono faint">{p.ref}</span>
          </div>
          <div className="row mt-8 wrap">
            <Badge tone={STATUS[p.status].tone} dot>{STATUS[p.status].label}</Badge>
            <Badge tone={f.tone}>{f.label}</Badge>
            <span className="faint"><MapPin size={12} style={{ verticalAlign: -1 }} /> {p.locality}, {p.city}</span>
          </div>
        </div>
      }
      footer={
        <>
          {canEdit && p.status !== 'archived' && (
            <Button variant="danger" icon={<Archive size={15} />} onClick={async () => {
              const r = await confirm({ title: 'Archive listing?', body: 'It disappears from matching and agents can no longer quote it. History is kept.', confirmLabel: 'Archive' });
              if (r.ok && (await ok(() => actions.saveProperty({ id: p.id, status: 'archived' })))) toast({ kind: 'info', title: 'Listing archived' });
            }}>Archive</Button>
          )}
          {canEdit && <Button icon={<Pencil size={15} />} onClick={() => onEdit(p)}>Edit</Button>}
          {canVerify && <Button icon={<BadgeCheck size={15} />} onClick={async () => { if (await ok(() => actions.verifyProperty(p.id))) toast({ kind: 'success', title: 'Marked verified', body: 'Availability and price confirmed with the owner today.' }); }}>Verify now</Button>}
          {p.status === 'active' && <Button variant="primary" icon={<CalendarPlus size={15} />} onClick={() => setBooking(true)}>Book viewing</Button>}
        </>
      }
    >
      <div className="stack stack-lg">
        <div className="prop-media" style={{ margin: 0, aspectRatio: '16/8' }}>
          <PropertyImage index={p.image} alt={p.title} />
        </div>
        {f.tone !== 'success' && (
          <div className="banner warning"><ShieldAlert size={15} /> Availability isn't recently verified. Agents will describe this listing as “to be confirmed” and won't promise a viewing slot until it's re-verified.</div>
        )}
        <div className="grid g-3" style={{ gap: 10 }}>
          <div className="card" style={{ padding: 14, boxShadow: 'none' }}><div className="faint" style={{ fontSize: 12 }}>{p.listing === 'rent' ? 'Rent' : 'Price'}</div><div className="kpi-value" style={{ fontSize: 22, marginTop: 4 }}>{money(p.price)}{p.listing === 'rent' && <span className="faint" style={{ fontSize: 13 }}>/mo</span>}</div></div>
          <div className="card" style={{ padding: 14, boxShadow: 'none' }}><div className="faint" style={{ fontSize: 12 }}>Carpet area</div><div className="kpi-value" style={{ fontSize: 22, marginTop: 4 }}>{p.area.toLocaleString('en-IN')} ft²</div></div>
          <div className="card" style={{ padding: 14, boxShadow: 'none' }}><div className="faint" style={{ fontSize: 12 }}>{p.listing === 'sale' ? 'Per sq ft' : 'Configuration'}</div><div className="kpi-value" style={{ fontSize: 22, marginTop: 4 }}>{p.listing === 'sale' ? money(p.price / p.area, { compact: false }) : p.bedrooms ? `${p.bedrooms} BHK` : p.type}</div></div>
        </div>
        <p style={{ color: 'var(--text-2)' }}>{p.description}</p>
        <KV items={[
          ['Type', <span key="t" style={{ textTransform: 'capitalize' }}>{p.type} · {p.listing === 'sale' ? 'For sale' : 'For rent'}</span>],
          ['Bedrooms / baths', `${p.bedrooms || '—'} / ${p.bathrooms}`],
          ['Furnishing', <span key="f" style={{ textTransform: 'capitalize' }}>{p.furnishing === 'semi' ? 'Semi-furnished' : p.furnishing}</span>],
          ['Amenities', p.amenities.map((a) => <span key={a} className="tag">{a}</span>)],
          ['Listing agent', <MemberChip key="a" id={p.agentId} />],
          ['Owner', owner ? <button key="o" className="link" onClick={() => navigate('contacts', { id: owner.id })}>{owner.name}</button> : <span className="faint">Not linked</span>],
          ['Listed', fmtDate(p.createdAt, true)],
        ]} />
        <RecordQualityPanel entityType="property" id={p.id} />
        <section>
          <h4 className="section-title"><Users size={13} /> Leads this fits</h4>
          {LIVE && server.error ? <span className="faint">Couldn't load matches. {server.error}</span>
            : LIVE && !server.data ? <div className="skeleton" style={{ height: 48 }} />
            : interested.length === 0 ? <span className="faint">{LIVE ? 'No current property-matching recommendation includes this listing.' : 'No open lead meets the hard constraints for this listing.'}</span> : (
            <div className="card" style={{ boxShadow: 'none' }}>
              {interested.map(({ lead, m }) => (
                <button key={lead.id} className="list-row" onClick={() => navigate('leads', { id: lead.id })}>
                  <ScorePill score={m.score} />
                  <span className="grow truncate" style={{ fontWeight: 500 }}>{lead.name}</span>
                  <span className="faint truncate" style={{ fontSize: 12, maxWidth: 260 }}>{m.reasons.slice(0, 2).join(' · ')}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      {booking && <BookAppointmentModal onClose={() => setBooking(false)} preset={{ propertyId: p.id }} />}
    </Drawer>
  );
}

function PropertyForm({ property, onClose }: { property?: Property; onClose: () => void }) {
  const members = useOrgList('members');
  const properties = useOrgList('properties');
  const [busy, setBusy] = useState(false);
  const localities = useMemo(() => [...new Set(properties.map((p) => p.locality))].sort(), [properties]);
  const [f, setF] = useState({
    title: property?.title ?? '',
    description: property?.description ?? '',
    listing: property?.listing ?? 'sale',
    type: property?.type ?? 'apartment',
    status: property?.status ?? 'draft',
    price: property ? String(property.price) : '',
    bedrooms: String(property?.bedrooms ?? 2),
    bathrooms: String(property?.bathrooms ?? 2),
    area: String(property?.area ?? ''),
    locality: property?.locality ?? localities[0] ?? '',
    furnishing: property?.furnishing ?? 'semi',
    amenities: property?.amenities ?? [],
    agentId: property?.agentId ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async () => {
    const e: Record<string, string> = {};
    if (f.title.trim().length < 4) e.title = 'Add a descriptive title';
    if (!(Number(f.price) > 0)) e.price = 'Price must be greater than zero';
    if (!(Number(f.area) > 0)) e.area = 'Area is required';
    if (!f.locality.trim()) e.locality = 'Enter a locality';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const saved = await attempt(() => actions.saveProperty({
      id: property?.id, title: f.title.trim(), description: f.description, listing: f.listing as Property['listing'], type: f.type as Property['type'], status: f.status as Property['status'],
      price: Number(f.price), bedrooms: Number(f.bedrooms), bathrooms: Number(f.bathrooms), area: Number(f.area), locality: f.locality.trim(), furnishing: f.furnishing as Property['furnishing'],
      amenities: f.amenities, agentId: f.agentId || null,
    }));
    setBusy(false);
    if (!saved) return;
    toast({ kind: 'success', title: property ? 'Listing updated' : 'Listing created', body: property ? undefined : 'Saved as unverified — verify availability before agents can quote it.', action: property ? undefined : { label: 'Open', run: () => navigate('properties', { id: saved.id }) } });
    onClose();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open size="wide" onClose={onClose} title={property ? 'Edit listing' : 'Add property'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>{property ? 'Save changes' : 'Create listing'}</Button></>}>
      <div className="form-grid">
        <Field label="Title" className="full" error={errors.title}><Input value={f.title} onChange={set('title')} invalid={!!errors.title} placeholder="3 BHK at Lodha Park" data-autofocus /></Field>
        <Field label="Listing"><Select value={f.listing} onChange={set('listing')}><option value="sale">For sale</option><option value="rent">For rent</option></Select></Field>
        <Field label="Type"><Select value={f.type} onChange={set('type')}>{['apartment', 'villa', 'penthouse', 'plot', 'office', 'retail'].map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label={f.listing === 'rent' ? `Rent (${currencySymbol()} / month)` : `Price (${currencySymbol()})`} error={errors.price}><Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^\d]/g, '') })} invalid={!!errors.price} inputMode="numeric" placeholder={f.listing === 'rent' ? '85000' : '24500000'} /></Field>
        <Field label="Status"><Select value={f.status} onChange={set('status')}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select></Field>
        <Field label="Bedrooms"><Select value={f.bedrooms} onChange={set('bedrooms')}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n || 'N/A'}</option>)}</Select></Field>
        <Field label="Bathrooms"><Select value={f.bathrooms} onChange={set('bathrooms')}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</Select></Field>
        <Field label="Carpet area (ft²)" error={errors.area}><Input value={f.area} onChange={(e) => setF({ ...f, area: e.target.value.replace(/[^\d]/g, '') })} invalid={!!errors.area} inputMode="numeric" /></Field>
        <Field label="Locality" error={errors.locality}><Input value={f.locality} onChange={set('locality')} list="prop-localities" invalid={!!errors.locality} placeholder="e.g. Powai" /><datalist id="prop-localities">{localities.map((l) => <option key={l} value={l} />)}</datalist></Field>
        <Field label="Furnishing"><Select value={f.furnishing} onChange={set('furnishing')}><option value="unfurnished">Unfurnished</option><option value="semi">Semi-furnished</option><option value="full">Fully furnished</option></Select></Field>
        <Field label="Listing agent"><Select value={f.agentId ?? ''} onChange={set('agentId')}><option value="">Me</option>{members.filter((m) => m.status === 'active' && m.role !== 'finance').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label="Amenities" className="full">
          <div className="row wrap" style={{ gap: 6 }}>
            {AMENITIES.map((a) => {
              const on = f.amenities.includes(a);
              return <button key={a} type="button" className={cx('tool-chip', on && 'on')} aria-pressed={on} onClick={() => setF({ ...f, amenities: on ? f.amenities.filter((x) => x !== a) : [...f.amenities, a] })}>{a}</button>;
            })}
          </div>
        </Field>
        <Field label="Description" className="full" hint="Agents quote only verified facts — keep this accurate."><Textarea value={f.description} onChange={set('description')} /></Field>
      </div>
    </Modal>
  );
}
