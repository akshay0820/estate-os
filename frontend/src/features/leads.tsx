import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Bot,
  Building2,
  CalendarPlus,
  Check,
  CheckSquare,
  Download,
  FileUp,
  GitMerge,
  Handshake,
  KanbanSquare,
  List,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  PhoneCall,
  Plus,
  ShieldOff,
  Sparkles,
  StickyNote,
  UserRound,
  UserPlus,
  AlertTriangle,
  CircleDot,
} from 'lucide-react';
import {
  AiBadge,
  Avatar,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Field,
  Input,
  KV,
  Menu,
  Modal,
  PageHeader,
  Pager,
  PropertyImage,
  SearchInput,
  Segmented,
  Select,
  Switch,
  TableSkeleton,
  Tabs,
  Textarea,
} from '@/components/ui';
import { askConsentSource, confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { useCan, useLookup, useMe, useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { CHANNEL_LABEL, findDuplicates, LEAD_FLOW, LEAD_STATUS, LOST_REASONS, matchProperties, OPEN_LEAD, outboundPolicy } from '@/lib/domain';
import { fmtDateTime, money, relTime, toLocalInput, fromLocalInput, budgetInputUnit, currencySymbol, moneyPrecise } from '@/lib/format';
import { cx, downloadCsv, parseCsv, getPhoneCountry } from '@/lib/util';
import { phonePlaceholder } from '@/lib/region';
import { IMPORT_MAX_ROWS, checkImportHeaders } from '@/lib/leadImport';
import type { Channel, ConsentState, Lead, LeadStatus } from '@/store/types';
import { CHANNEL_ICON, LeadStatusBadge, MemberChip, PolicyChecks, ScorePill, SortHeader } from './shared';
import { LIVE, actions, attempt, ok } from '@/data/actions';
import { LiveCallModal, LeadCallsPanel } from './voice';
import { QualificationPanel } from './qualification';
import { PropertyMatchesPanel } from './propertyMatches';
import { FollowUpsPanel } from './followUpsLive';
import { RecordQualityPanel } from './dataQuality';
import { useDebounced, useServerQuery } from '@/data/useServerQuery';
import * as live from '@/backend/live';
import { BookAppointmentModal } from './appointments';
import { TaskModal } from './tasks';
import { DealModal } from './deals';

type View = 'table' | 'board';
type Quick = 'open' | 'mine' | 'new' | 'hot' | 'overdue' | 'closed' | 'archived';
type SortKey = 'name' | 'status' | 'score' | 'budgetMax' | 'createdAt' | 'nextFollowUpAt';

export function LeadsPage({ params }: { params: URLSearchParams }) {
  const leads = useOrgList('leads');
  const members = useOrgList('members');
  const me = useMe();
  const canEdit = useCan('leads.edit');
  const canAssign = useCan('leads.assign');
  const canImport = useCan('leads.import');
  const canExport = useCan('leads.export');

  const [view, setView] = useState<View>(() => (localStorage.getItem('estate-os:leads-view') as View) || 'table');
  const [quick, setQuick] = useState<Quick>('open');
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const importControl = useRef({ cancelled: false });
  const [source, setSource] = useState('');
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'createdAt', dir: -1 });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(params.get('new') === '1');
  const fileRef = useRef<HTMLInputElement>(null);
  const openId = params.get('id');

  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
  }, [params]);
  useEffect(() => {
    try {
      localStorage.setItem('estate-os:leads-view', view);
    } catch {
      /* ignore */
    }
  }, [view]);

  const now = Date.now();
  const quickFilter = (l: Lead) => {
    if (quick === 'archived') return l.archived;
    if (l.archived) return false;
    switch (quick) {
      case 'open': return OPEN_LEAD.includes(l.status);
      case 'mine': return l.assignedTo === me.id && OPEN_LEAD.includes(l.status);
      case 'new': return l.status === 'new';
      case 'hot': return l.score >= 75 && OPEN_LEAD.includes(l.status);
      case 'overdue': return OPEN_LEAD.includes(l.status) && !!l.nextFollowUpAt && l.nextFollowUpAt < now;
      case 'closed': return ['won', 'lost', 'nurture'].includes(l.status);
    }
  };

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out = leads.filter(
      (l) =>
        quickFilter(l) &&
        (!source || l.source === source) &&
        (!owner || (owner === 'none' ? !l.assignedTo : l.assignedTo === owner)) &&
        (!status || l.status === status) &&
        (!term || l.name.toLowerCase().includes(term) || l.locations.some((x) => x.toLowerCase().includes(term)) || (l.campaign ?? '').toLowerCase().includes(term)),
    );
    const val = (l: Lead) => (sort.key === 'status' ? LEAD_FLOW.indexOf(l.status) : sort.key === 'name' ? l.name : (l[sort.key] ?? -1));
    return out.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, quick, q, source, owner, status, sort, me.id]);

  useEffect(() => setPage(0), [quick, q, source, owner, status, pageSize]);
  useEffect(() => setSelected(new Set()), [quick]);

  const counts = useMemo(() => {
    const c: Record<Quick, number> = { open: 0, mine: 0, new: 0, hot: 0, overdue: 0, closed: 0, archived: 0 };
    for (const l of leads) {
      if (l.archived) { c.archived++; continue; }
      const open = OPEN_LEAD.includes(l.status);
      if (open) c.open++;
      if (open && l.assignedTo === me.id) c.mine++;
      if (l.status === 'new') c.new++;
      if (open && l.score >= 75) c.hot++;
      if (open && l.nextFollowUpAt && l.nextFollowUpAt < now) c.overdue++;
      if (!open) c.closed++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, me.id]);

  // Live mode: the table is paged, filtered, sorted and searched on the server.
  const debouncedQ = useDebounced(q);
  const server = useServerQuery(LIVE, () => live.queryLeads({ quick, q: debouncedQ, status, source, owner, sort, page, pageSize }), [quick, debouncedQ, status, source, owner, sort.key, sort.dir, page, pageSize]);
  const liveCounts = useServerQuery(LIVE, () => live.leadCounts(), []);
  const liveSources = useServerQuery(LIVE, () => live.leadSources(), []);
  const viewCounts = LIVE ? liveCounts.data ?? { open: 0, mine: 0, new: 0, hot: 0, overdue: 0, closed: 0, archived: 0 } : counts;
  const total = LIVE ? server.data?.total ?? 0 : filtered.length;
  const pageRows = LIVE ? server.data?.rows ?? [] : filtered.slice(page * pageSize, (page + 1) * pageSize);
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const someOnPage = pageRows.some((r) => selected.has(r.id));
  const demoSources = useMemo(() => [...new Set(leads.map((l) => l.source))].sort(), [leads]);
  const sources = LIVE ? liveSources.data ?? [] : demoSources;
  const agents = members.filter((m) => m.status === 'active' && ['agent', 'manager', 'owner', 'admin'].includes(m.role));

  const toggleSort = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }));

  const exportAll = async () => {
    if (!LIVE) return exportRows(filtered);
    const rows = await attempt(() => live.exportLeads({ quick, q, status, source, owner, sort }));
    if (rows) exportRows(rows);
  };

  const exportRows = (rows: Lead[]) => {
    downloadCsv(`leads-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Name', 'Status', 'Score', 'Type', 'Source', 'Campaign', 'Budget max', 'Locations', 'Bedrooms', 'Timeline', 'Owner', 'Created'],
      ...rows.map((l) => [l.name, l.status, l.score, l.type, l.source, l.campaign, l.budgetMax, l.locations.join('; '), l.bedrooms, l.timeline, members.find((m) => m.id === l.assignedTo)?.name ?? '', new Date(l.createdAt).toISOString()]),
    ]);
    if (LIVE) void attempt(() => live.recordExport('leads', rows.length));
    else useStore.getState().log('lead.exported', 'lead', null, `${rows.length} rows`);
    toast({ kind: 'success', title: `Exported ${rows.length} leads` });
  };

  const onImport = async (file: File) => {
    if (/\.(xlsx|xls|ods|numbers)$/i.test(file.name)) {
      toast({ kind: 'error', title: 'Save the sheet as CSV first', body: 'Google Sheets: File → Download → Comma-separated values (.csv). Excel: File → Save As → CSV UTF-8.' });
      return;
    }
    const rows = parseCsv(await file.text());
    if (!rows.length) {
      toast({ kind: 'error', title: 'Nothing to import', body: 'The file has a header row but no leads under it.' });
      return;
    }
    const headerProblem = checkImportHeaders(rows);
    if (headerProblem) {
      toast({ kind: 'error', title: 'Columns not recognised', body: `${headerProblem} Found: ${Object.keys(rows[0]).slice(0, 8).join(', ')}.` });
      return;
    }
    if (rows.length > IMPORT_MAX_ROWS) toast({ kind: 'warning', title: 'Large file', body: `Only the first ${IMPORT_MAX_ROWS.toLocaleString('en-IN')} rows are imported per file.` });
    setImporting(true);
    importControl.current = { cancelled: false };
    const r = await attempt(() => actions.importLeads(rows, { control: importControl.current, onProgress: (done, total) => setImportProgress({ done, total }) }))
      .finally(() => { setImporting(false); setImportProgress(null); });
    if (!r) return;
    const why = r.errors.slice(0, 3).map((e) => `Row ${e.row}: ${e.reason}`).join(' · ');
    const more = r.errors.length > 3 ? ` · and ${r.errors.length - 3} more` : '';
    toast({
      kind: r.created ? (r.invalid ? 'warning' : 'success') : 'error',
      title: `Imported ${r.created} lead${r.created === 1 ? '' : 's'}${r.cancelled ? ' before you stopped the import' : ''}`,
      body: `${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped · ${r.invalid} row${r.invalid === 1 ? '' : 's'} not imported${why ? ` — ${why}${more}` : ''}`,
    });
  };

  const bulkStatus = async (s: LeadStatus) => {
    const ids = [...selected];
    let reason: string | undefined;
    if (s === 'lost') {
      const r = await confirm({ title: `Mark ${ids.length} leads as lost?`, reasons: LOST_REASONS, confirmLabel: 'Mark lost' });
      if (!r.ok) return;
      reason = r.value;
    }
    let done = 0;
    for (const id of ids) if (await ok(() => actions.setLeadStatus(id, s, reason))) done++;
    if (done) toast({ kind: 'success', title: `${done} lead${done === 1 ? '' : 's'} → ${LEAD_STATUS[s].label}` });
    setSelected(new Set());
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${viewCounts.open} open · ${viewCounts.new} new ]`}
        title="Leads"
        sub="Every enquiry from every channel, deduplicated, assigned and tracked from first touch to close."
        actions={
          <>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,text/tab-separated-values" hidden onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0]).finally(() => (e.target.value = ''))} />
            {canImport && <Button icon={<FileUp size={15} />} loading={importing} disabled={importing} onClick={() => fileRef.current?.click()} title="CSV from Google Sheets or Excel with columns such as Name, Phone, Email, Source, Budget, Location">{importing ? (importProgress?.total ? `Importing ${importProgress.done.toLocaleString()} / ${importProgress.total.toLocaleString()}` : 'Importing…') : 'Import'}</Button>}
            {importing && <Button variant="ghost" onClick={() => { importControl.current.cancelled = true; }} title="Stops after the batch being sent; rows already imported stay">Stop import</Button>}
            {canExport && <Button icon={<Download size={15} />} onClick={() => void exportAll()}>Export</Button>}
            {canEdit && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>New lead</Button>}
          </>
        }
      />

      <div className="card">
        <div style={{ padding: '4px 14px 0' }}>
          <Tabs
            value={quick}
            onChange={setQuick}
            tabs={[
              { value: 'open', label: 'All open', count: viewCounts.open },
              { value: 'mine', label: 'Assigned to me', count: viewCounts.mine },
              { value: 'new', label: 'New', count: viewCounts.new },
              { value: 'hot', label: 'Hot', count: viewCounts.hot },
              { value: 'overdue', label: 'Follow-up overdue', count: viewCounts.overdue },
              { value: 'closed', label: 'Closed', count: viewCounts.closed },
              { value: 'archived', label: 'Archived', count: viewCounts.archived },
            ]}
          />
        </div>
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search name, locality, campaign" width={260} />
          <Select selectSize="sm" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }} aria-label="Status">
            <option value="">Any status</option>
            {LEAD_FLOW.map((s) => <option key={s} value={s}>{LEAD_STATUS[s].label}</option>)}
          </Select>
          <Select selectSize="sm" value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 150 }} aria-label="Source">
            <option value="">All sources</option>
            {sources.map((s) => <option key={s}>{s}</option>)}
          </Select>
          <Select selectSize="sm" value={owner} onChange={(e) => setOwner(e.target.value)} style={{ width: 160 }} aria-label="Owner">
            <option value="">Any owner</option>
            <option value="none">Unassigned</option>
            {agents.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          {(q || source || owner || status) && (
            <button className="text-btn" onClick={() => { setQ(''); setSource(''); setOwner(''); setStatus(''); }}>Clear filters</button>
          )}
          <div className="ml-auto">
            <Segmented value={view} onChange={setView} options={[{ value: 'table', label: <><List size={14} /> Table</> }, { value: 'board', label: <><KanbanSquare size={14} /> Board</> }]} />
          </div>
        </div>

        {view === 'table' ? (
          LIVE && server.error ? (
            <Empty icon={<UserRound size={20} />} title="Couldn’t load leads" description={server.error} action={<Button onClick={server.reload}>Retry</Button>} />
          ) : LIVE && server.loading && !server.data ? (
            <TableSkeleton />
          ) : total === 0 ? (
            <Empty icon={<UserRound size={20} />} title={LIVE && viewCounts.open + viewCounts.closed + viewCounts.archived === 0 ? 'No leads yet' : 'No leads match'} description={LIVE && viewCounts.open + viewCounts.closed + viewCounts.archived === 0 ? 'Create your first lead, import a CSV, or connect a lead source in Integrations.' : 'Try a different view or clear the filters.'} action={canEdit && <Button icon={<Plus size={14} />} onClick={() => setCreating(true)}>New lead</Button>} />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="w-check">
                        <Checkbox
                          checked={allOnPage}
                          indeterminate={!allOnPage && someOnPage}
                          onChange={(v) => setSelected((s) => { const n = new Set(s); pageRows.forEach((r) => (v ? n.add(r.id) : n.delete(r.id))); return n; })}
                          aria="Select page"
                        />
                      </th>
                      <SortHeader label="Lead" k="name" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Status" k="status" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Score" k="score" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Budget" k="budgetMax" sort={sort} onSort={toggleSort} align="right" />
                      <th>Looking in</th>
                      <th>Source</th>
                      <th>Owner</th>
                      <SortHeader label="Follow-up" k="nextFollowUpAt" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Created" k="createdAt" sort={sort} onSort={toggleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((l) => (
                      <tr key={l.id} className={cx('clickable', selected.has(l.id) && 'selected')} onClick={() => setParam('id', l.id)}>
                        <td className="w-check">
                          <Checkbox checked={selected.has(l.id)} onChange={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(l.id); else n.delete(l.id); return n; })} aria={`Select ${l.name}`} />
                        </td>
                        <td>
                          <div className="cell-main">
                            <Avatar name={l.name} size="sm" />
                            <div style={{ minWidth: 0 }}>
                              <div className="cell-title truncate" style={{ maxWidth: 200 }}>{l.name}</div>
                              <div className="cell-sub">{l.type} · {l.intent}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="row" style={{ gap: 6 }}>
                            <LeadStatusBadge status={l.status} />
                            {l.intakeStatus === 'review_required' && <Badge tone="warning" title="Possible duplicate — waiting for review">Review</Badge>}
                          </span>
                        </td>
                        <td><ScorePill score={l.score} reasons={l.scoreReasons} /></td>
                        <td className="right num">
                          {l.budgetMax ? (
                            <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                              {l.aiFields.includes('budget') && <Sparkles size={11} className="accent-text" aria-label="AI-extracted" />}
                              {money(l.budgetMax)}{l.intent === 'rent' && <span className="faint">/mo</span>}
                            </span>
                          ) : <span className="faint">Unknown</span>}
                        </td>
                        <td className="truncate" style={{ maxWidth: 180 }}>{l.locations.join(', ') || <span className="faint">—</span>}</td>
                        <td>
                          <div className="cell-sub" style={{ color: 'var(--text-2)' }}>{l.source}</div>
                        </td>
                        <td><MemberChip id={l.assignedTo} /></td>
                        <td>
                          {l.nextFollowUpAt && OPEN_LEAD.includes(l.status) ? (
                            <span className={l.nextFollowUpAt < now ? 'badge badge-danger' : 'faint'}>{relTime(l.nextFollowUpAt)}</span>
                          ) : <span className="faint">—</span>}
                        </td>
                        <td className="faint num">{relTime(l.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />
            </>
          )
        ) : (
          <div style={{ padding: 12 }}>
            <LeadBoard leads={filtered} canEdit={canEdit} />
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
          <b className="num">{selected.size} selected</b>
          {canAssign && (
            <Menu
              up
              align="left"
              trigger={(p) => <Button size="sm" icon={<UserPlus size={14} />} {...p}>Assign</Button>}
              items={[{ heading: 'Assign to' }, ...agents.map((m) => ({ label: m.name, onSelect: async () => { const ids = [...selected]; if (await ok(() => actions.assignLeads(ids, m.id))) { toast({ kind: 'success', title: `Assigned ${ids.length} to ${m.name}` }); setSelected(new Set()); } } }))]}
            />
          )}
          {canEdit && (
            <Menu
              up
              align="left"
              trigger={(p) => <Button size="sm" icon={<CircleDot size={14} />} {...p}>Status</Button>}
              items={[{ heading: 'Move to' }, ...LEAD_FLOW.map((s) => ({ label: LEAD_STATUS[s].label, onSelect: () => void bulkStatus(s) }))]}
            />
          )}
          {canExport && <Button size="sm" icon={<Download size={14} />} onClick={() => exportRows(leads.filter((l) => selected.has(l.id)))}>Export</Button>}
          {canEdit && (
            <Button
              size="sm"
              icon={quick === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              onClick={async () => {
                const ids = [...selected];
                if (quick !== 'archived') {
                  const r = await confirm({ title: `Archive ${ids.length} lead${ids.length > 1 ? 's' : ''}?`, body: 'Archived leads are hidden from lists and reports but keep their full history. You can restore them anytime.', confirmLabel: 'Archive' });
                  if (!r.ok) return;
                }
                if (!(await ok(() => actions.archiveLeads(ids, quick !== 'archived')))) return;
                toast({ kind: 'success', title: quick === 'archived' ? 'Restored' : 'Archived', body: `${ids.length} lead${ids.length > 1 ? 's' : ''}`, action: { label: 'Undo', run: () => void ok(() => actions.archiveLeads(ids, quick === 'archived')) } });
                setSelected(new Set());
              }}
            >
              {quick === 'archived' ? 'Restore' : 'Archive'}
            </Button>
          )}
          <Button size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {creating && <NewLeadModal onClose={() => { setCreating(false); if (params.get('new')) setParam('new', null); }} />}
      {openId && <LeadDrawer id={openId} onClose={() => setParam('id', null)} />}
    </div>
  );
}

/* ─────────── Kanban ─────────── */

function LeadBoard({ leads, canEdit }: { leads: Lead[]; canEdit: boolean }) {
  const [over, setOver] = useState<LeadStatus | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const cols: LeadStatus[] = ['new', 'attempting', 'contacted', 'qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won', 'lost'];
  const grouped = useMemo(() => {
    const g = Object.fromEntries(cols.map((c) => [c, [] as Lead[]])) as Record<LeadStatus, Lead[]>;
    leads.forEach((l) => g[l.status]?.push(l));
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads]);

  const drop = async (status: LeadStatus, id: string) => {
    setOver(null);
    const lead = leads.find((l) => l.id === id);
    if (!lead || lead.status === status) return;
    let reason: string | undefined;
    if (status === 'lost') {
      const r = await confirm({ title: `Mark ${lead.name} as lost?`, body: 'Lost is terminal for this opportunity; the person can still enquire again later.', reasons: LOST_REASONS, confirmLabel: 'Mark lost' });
      if (!r.ok) return;
      reason = r.value;
    }
    if (!(await ok(() => actions.setLeadStatus(id, status, reason)))) return;
    toast({ kind: 'success', title: `${lead.name} → ${LEAD_STATUS[status].label}` });
  };

  return (
    <div className="kanban">
      {cols.map((c) => (
        <div
          key={c}
          className={cx('kb-col', over === c && 'over')}
          onDragOver={(e) => { if (!canEdit) return; e.preventDefault(); setOver(c); }}
          onDragLeave={() => setOver((o) => (o === c ? null : o))}
          onDrop={(e) => { e.preventDefault(); void drop(c, e.dataTransfer.getData('text/plain')); }}
        >
          <div className="kb-head">
            {LEAD_STATUS[c].label}
            <span className="count">{grouped[c].length}</span>
            <span className="sum">{money(grouped[c].reduce((s, l) => s + (l.budgetMax ?? 0), 0))}</span>
          </div>
          <div className="kb-list">
            {grouped[c].slice(0, 40).map((l) => (
              <button
                key={l.id}
                className={cx('kb-card', dragging === l.id && 'dragging')}
                draggable={canEdit}
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', l.id); setDragging(l.id); }}
                onDragEnd={() => setDragging(null)}
                onClick={() => setParam('id', l.id)}
              >
                <div className="row row-between">
                  <span className="kb-title truncate">{l.name}</span>
                  <ScorePill score={l.score} />
                </div>
                <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
                  {l.budgetMax ? money(l.budgetMax) : 'Budget unknown'} · {l.locations[0] ?? 'Location unknown'}
                </div>
                <div className="kb-meta">
                  <MemberChip id={l.assignedTo} showName={false} />
                  <span>{l.source}</span>
                  <span className="ml-auto">{relTime(l.createdAt)}</span>
                </div>
              </button>
            ))}
            {grouped[c].length > 40 && <div className="faint" style={{ fontSize: 12, textAlign: 'center', padding: 6 }}>+{grouped[c].length - 40} more — use the table to page through</div>}
            {grouped[c].length === 0 && <div className="faint" style={{ fontSize: 12, textAlign: 'center', padding: '18px 0' }}>Drop here</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─────────── New lead ─────────── */

export function NewLeadModal({ onClose }: { onClose: () => void }) {
  const contacts = useOrgList('contacts');
  const members = useOrgList('members');
  const org = useOrg();
  const [f, setF] = useState({ name: '', phone: '', email: '', source: 'Walk-in', type: 'buyer' as Lead['type'], budget: '', location: '', propertyType: '', bedrooms: '', timeline: '', notes: '', assignedTo: 'auto' });
  const [consent, setConsent] = useState<Channel[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<'link' | 'create' | null>(null);
  const [serverDupes, setServerDupes] = useState<{ contactId: string; name: string; reasons: string[] }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    if (k === 'phone' || k === 'email') { setServerDupes(null); setChoice(null); }
  };
  // Demo mode can preview duplicates locally; live mode asks the server, which sees every contact.
  const localDupes = useMemo(() => (!LIVE && (f.phone.replace(/\D/g, '').length >= 10 || /@.+\./.test(f.email)) ? findDuplicates({ phone: f.phone, email: f.email }, contacts) : []), [f.phone, f.email, contacts]);
  const dupes = serverDupes ?? localDupes.map((d) => ({ contactId: d.contact.id, name: d.contact.name, reasons: d.reasons }));
  const localities = useMemo(() => [...new Set(useStore.getState().properties.filter((p) => p.orgId === org.id).map((p) => p.locality))].sort(), [org.id]);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'Name is required';
    if (!f.phone.trim() && !f.email.trim()) e.phone = 'Add a phone number or email';
    if (f.phone && f.phone.replace(/\D/g, '').length < 10) e.phone = 'Enter a 10-digit mobile number';
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) e.email = 'Enter a valid email';
    if (f.budget && !(Number(f.budget) > 0)) e.budget = 'Budget must be a positive number';
    setErrors(e);
    if (Object.keys(e).length) return;
    if (dupes.length && !choice) return setErrors({ dup: 'Choose whether to link to the existing contact or create a separate one.' });
    const multiplier = f.type === 'tenant' ? 1 : budgetInputUnit().multiplier;
    setBusy(true);
    const r = await attempt(() => actions.createLead({
      name: f.name.trim(), phone: f.phone, email: f.email, source: f.source, type: f.type,
      budgetMax: f.budget ? Math.round(Number(f.budget) * multiplier) : null, locations: f.location.trim() ? [f.location.trim()] : [],
      propertyType: (f.propertyType || null) as Lead['propertyType'] | null, bedrooms: f.bedrooms ? Number(f.bedrooms) : null, timeline: f.timeline || null, notes: f.notes,
      assignedTo: f.assignedTo === 'auto' ? undefined : f.assignedTo || null,
      existingContactId: choice === 'link' && dupes[0] ? dupes[0].contactId : null,
      consentChannels: consent,
    }, choice ?? 'ask'));
    setBusy(false);
    if (!r) return;
    if (r.status === 'duplicate') {
      setServerDupes(r.candidates);
      return;
    }
    toast({ kind: 'success', title: 'Lead created', body: r.lead ? `${r.lead.name} · score ${r.lead.score}` : undefined, action: { label: 'Open', run: () => navigate('leads', { id: r.leadId }) } });
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="wide"
      title="New lead"
      description="Phone and email are normalized and checked for duplicates before anything is saved."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>{choice === 'link' ? 'Create enquiry for existing contact' : 'Create lead'}</Button>
        </>
      }
    >
      <div className="stack">
        {dupes.length > 0 && (
          <div className="banner warning" style={{ alignItems: 'flex-start' }}>
            <AlertTriangle size={16} style={{ marginTop: 2 }} />
            <div className="grow">
              <b>Possible duplicate</b> — {dupes[0].name} ({dupes[0].reasons.join(', ').toLowerCase()}).
              <div style={{ marginTop: 6 }} className="row">
                <label className="check"><input type="radio" checked={choice === 'link'} onChange={() => setChoice('link')} /> Link to existing contact</label>
                <label className="check"><input type="radio" checked={choice === 'create'} onChange={() => setChoice('create')} /> Create separate contact</label>
              </div>
              {errors.dup && <div className="field-error" style={{ marginTop: 4 }}>{errors.dup}</div>}
            </div>
          </div>
        )}
        <div className="form-grid">
          <Field label="Full name" error={errors.name}><Input value={f.name} onChange={set('name')} invalid={!!errors.name} placeholder="e.g. Riya Malhotra" data-autofocus /></Field>
          <Field label="Lead type">
            <Select value={f.type} onChange={set('type')}>
              {['buyer', 'tenant', 'investor', 'seller', 'landlord'].map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </Select>
          </Field>
          <Field label="Mobile" error={errors.phone}><Input value={f.phone} onChange={set('phone')} invalid={!!errors.phone} placeholder={phonePlaceholder(getPhoneCountry())} inputMode="tel" /></Field>
          <Field label="Email" error={errors.email}><Input value={f.email} onChange={set('email')} invalid={!!errors.email} placeholder="name@example.com" type="email" /></Field>
          <Field label="Source">
            <Select value={f.source} onChange={set('source')}>
              {['Walk-in', 'Referral', 'Website form', '99acres', 'MagicBricks', 'Housing.com', 'Meta Ads', 'Google Ads', 'Phone enquiry'].map((s) => <option key={s}>{s}</option>)}
            </Select>
          </Field>
          <Field
            label="Owner"
            hint={f.assignedTo !== 'auto' ? undefined
              // Auto-assignment only picks active members with the Agent role (private.pick_assignee).
              : members.some((m) => m.status === 'active' && m.role === 'agent') ? `Rule: ${org.assignment.replace(/_/g, ' ')}`
              : 'No team member has the Agent role, so auto-assign will leave this lead unassigned. Pick an owner, or give someone the Agent role in Team.'}
          >
            <Select value={f.assignedTo} onChange={set('assignedTo')}>
              <option value="auto">Auto-assign</option>
              <option value="">Leave unassigned</option>
              {members.filter((m) => m.status === 'active' && m.role !== 'finance').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label={f.type === 'tenant' ? `Monthly rent up to (${currencySymbol()})` : `Budget up to (${budgetInputUnit().label})`} error={errors.budget} hint="Leave blank if unknown — it stays unknown.">
            <Input value={f.budget} onChange={set('budget')} invalid={!!errors.budget} inputMode="decimal" placeholder={f.type === 'tenant' ? '85000' : '160'} />
          </Field>
          <Field label="Preferred locality" hint="Leave blank if unknown.">
            <Input value={f.location} onChange={set('location')} list="lead-localities" placeholder="e.g. Powai" />
            <datalist id="lead-localities">{localities.map((l) => <option key={l} value={l} />)}</datalist>
          </Field>
          <Field label="Property type">
            <Select value={f.propertyType} onChange={set('propertyType')}>
              <option value="">Unknown</option>
              {['apartment', 'villa', 'penthouse', 'plot', 'office', 'retail'].map((t) => <option key={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Bedrooms">
            <Select value={f.bedrooms} onChange={set('bedrooms')}>
              <option value="">Unknown</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} BHK</option>)}
            </Select>
          </Field>
          <Field label="Timeline">
            <Select value={f.timeline} onChange={set('timeline')}>
              <option value="">Unknown</option>
              {['Immediate', '1 month', '0-3 months', '3-6 months', '6-12 months'].map((t) => <option key={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Notes" className="full"><Textarea value={f.notes} onChange={set('notes')} placeholder="Anything the team should know" /></Field>
          <Field label="Contact permission" className="full" hint="Tick only channels the person agreed to. Unticked channels stay “unknown”, which never counts as permission.">
            <div className="row wrap" style={{ gap: 14 }}>
              {(['phone', 'whatsapp', 'sms', 'email'] as Channel[]).map((ch) => (
                <label key={ch} className="check">
                  <input type="checkbox" checked={consent.includes(ch)} onChange={(e) => setConsent((c) => (e.target.checked ? [...c, ch] : c.filter((x) => x !== ch)))} /> {CHANNEL_LABEL[ch]}
                </label>
              ))}
            </div>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ─────────── Lead drawer ─────────── */

type DrawerTab = 'overview' | 'matches' | 'activity' | 'comms';

export function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const lead = useOrgList('leads').find((l) => l.id === id);
  const contacts = useLookup('contacts');
  const members = useOrgList('members');
  const org = useOrg();
  const canEdit = useCan('leads.edit');
  const canAssign = useCan('leads.assign');
  const canCall = useCan('calls.place');
  const canMerge = useCan('leads.merge');
  const store = useStore.getState();
  const [tab, setTab] = useState<DrawerTab>('overview');
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState<string | null | false>(false);
  const [tasking, setTasking] = useState(false);
  const [dealing, setDealing] = useState(false);
  const [callCheck, setCallCheck] = useState(false);
  const allLeads = useOrgList('leads');
  // Live mode: load the lead and its full timeline even if it's outside the cached working set.
  const [fetching, setFetching] = useState(LIVE);
  useEffect(() => {
    if (!LIVE) return;
    setFetching(true);
    live.ensureLead(id).catch(() => undefined).finally(() => setFetching(false));
  }, [id]);

  if (!lead && fetching) {
    return (
      <Drawer open wide onClose={onClose} label="Lead" header={<div className="skeleton" style={{ height: 24, width: 200 }} />}>
        <TableSkeleton rows={6} />
      </Drawer>
    );
  }
  if (!lead) {
    return (
      <Drawer open onClose={onClose} label="Lead" header={<b>Lead not found</b>}>
        <Empty icon={<UserRound size={20} />} title="This lead isn't in this workspace" description="It may have been merged, or it belongs to another organization." />
      </Drawer>
    );
  }
  const contact = contacts.get(lead.contactId);
  const siblings = allLeads.filter((l) => l.contactId === lead.contactId && l.id !== lead.id);

  const changeStatus = async (s: LeadStatus) => {
    let reason: string | undefined;
    if (s === 'lost') {
      const r = await confirm({ title: 'Mark as lost?', reasons: LOST_REASONS, confirmLabel: 'Mark lost' });
      if (!r.ok) return;
      reason = r.value;
    }
    if (await ok(() => actions.setLeadStatus(lead.id, s, reason))) toast({ kind: 'success', title: `Status → ${LEAD_STATUS[s].label}` });
  };

  const openConversation = () => {
    if (!contact) return;
    const ch: Channel = contact.preferredChannel === 'phone' ? 'whatsapp' : contact.preferredChannel;
    const convId = store.startConversation(contact.id, ch);
    navigate('inbox', { id: convId });
  };

  return (
    <Drawer
      open
      wide
      onClose={onClose}
      label={`Lead ${lead.name}`}
      header={
        <div className="row row-top" style={{ gap: 14 }}>
          <Avatar name={lead.name} size="lg" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <h2 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.02em' }}>{lead.name}</h2>
              <ScorePill score={lead.score} reasons={lead.scoreReasons} />
              {lead.archived && <Badge>Archived</Badge>}
              {lead.intakeStatus === 'review_required' && <Badge tone="warning"><GitMerge size={11} /> Duplicate review</Badge>}
              {contact?.lifecycle === 'do_not_contact' && <Badge tone="danger"><ShieldOff size={11} /> Do not contact</Badge>}
            </div>
            <div className="faint" style={{ fontSize: 12.5, marginTop: 3 }}>
              {contact?.phone} · {contact?.email} · via {lead.source}{lead.campaign ? ` / ${lead.campaign}` : ''} · {relTime(lead.createdAt)}
            </div>
            <div className="row wrap mt-12" style={{ gap: 6 }}>
              <Select selectSize="sm" value={lead.status} disabled={!canEdit} onChange={(e) => void changeStatus(e.target.value as LeadStatus)} style={{ width: 180 }} aria-label="Lead status">
                {LEAD_FLOW.map((s) => <option key={s} value={s}>{LEAD_STATUS[s].label}</option>)}
              </Select>
              <Select selectSize="sm" value={lead.assignedTo ?? ''} disabled={!canAssign} onChange={async (e) => { const v = e.target.value || null; if (await ok(() => actions.assignLeads([lead.id], v))) toast({ kind: 'success', title: 'Owner updated' }); }} style={{ width: 170 }} aria-label="Owner">
                <option value="">Unassigned</option>
                {members.filter((m) => m.status === 'active' && m.role !== 'finance' && m.role !== 'viewer').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </div>
          </div>
        </div>
      }
      footer={
        <div className="row wrap" style={{ width: '100%', gap: 6 }}>
          {canCall && !LIVE && <Button variant="accent" icon={<Bot size={15} />} onClick={() => setCallCheck(true)}>AI qualification call</Button>}
          {canCall && LIVE && <Button variant="accent" icon={<Bot size={15} />} onClick={() => setCallCheck(true)}>AI call</Button>}
          {!LIVE && <Button icon={<MessageCircle size={15} />} onClick={openConversation}>Message</Button>}
          {canEdit && <Button icon={<CalendarPlus size={15} />} onClick={() => setBooking(null)}>Book visit</Button>}
          <Menu
            up
            trigger={(p) => <Button iconOnly icon={<MoreHorizontal size={16} />} aria-label="More actions" {...p} />}
            items={[
              { label: 'Add task', icon: <CheckSquare size={14} />, onSelect: () => setTasking(true), disabled: !canEdit },
              { label: 'Open deal', icon: <Handshake size={14} />, onSelect: () => setDealing(true), disabled: !canEdit },
              { label: 'Edit requirements', icon: <Pencil size={14} />, onSelect: () => { setTab('overview'); setEditing(true); }, disabled: !canEdit },
              ...(siblings.length && canMerge ? [{ label: `Merge ${siblings.length} other enquir${siblings.length > 1 ? 'ies' : 'y'}`, icon: <GitMerge size={14} />, onSelect: async () => {
                const r = await confirm({ title: 'Merge duplicate enquiries?', body: `${siblings.length} other enquir${siblings.length > 1 ? 'ies' : 'y'} from ${lead.name} will be merged into this lead. Activities, calls and visits are preserved.`, confirmLabel: 'Merge' });
                if (!r.ok) return;
                for (const sib of siblings) if (!(await ok(() => actions.mergeLeads(lead.id, sib.id)))) return;
                toast({ kind: 'success', title: 'Merged', body: 'History preserved on this lead.' });
              } }] : []),
              'sep',
              { label: 'Record opt-out (all channels)', icon: <ShieldOff size={14} />, danger: true, disabled: !canEdit || !contact, onSelect: async () => {
                const r = await confirm({ title: `Opt ${lead.name} out of all channels?`, body: 'Pending calls, messages and follow-ups are cancelled immediately and future workflows will check this suppression.', confirmLabel: 'Record opt-out', danger: true });
                if (r.ok && contact && (await ok(() => actions.optOutAll(contact.id)))) toast({ kind: 'warning', title: 'Opt-out recorded', body: 'All automated outreach stopped.' });
              } },
              { label: lead.archived ? 'Restore' : 'Archive', icon: lead.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />, disabled: !canEdit, onSelect: async () => { if (await ok(() => actions.archiveLeads([lead.id], !lead.archived))) toast({ kind: 'success', title: lead.archived ? 'Restored' : 'Archived' }); } },
            ]}
          />
          <span className="ml-auto faint" style={{ fontSize: 12 }}>Updated {relTime(lead.updatedAt)}</span>
        </div>
      }
    >
      {siblings.length > 0 && (
        <div className="banner warning" style={{ marginBottom: 14 }}>
          <GitMerge size={15} />
          <span>{siblings.length} other enquir{siblings.length > 1 ? 'ies' : 'y'} from this contact ({siblings.map((s) => s.source).join(', ')}).</span>
          {canMerge && <Button size="xs" onClick={async () => { for (const sib of siblings) if (!(await ok(() => actions.mergeLeads(lead.id, sib.id)))) return; toast({ kind: 'success', title: 'Merged', body: 'History preserved.' }); }}>Merge</Button>}
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'matches', label: 'Property matches' }, { value: 'activity', label: 'Activity' }, { value: 'comms', label: 'Calls & messages' }]} />
      <div className="mt-16">
        {tab === 'overview' && (editing ? <RequirementsForm lead={lead} onDone={() => setEditing(false)} /> : <Overview lead={lead} onEdit={() => setEditing(true)} canEdit={canEdit} />)}
        {tab === 'matches' && (LIVE ? <PropertyMatchesPanel lead={lead} onBook={(pid) => setBooking(pid)} /> : <Matches lead={lead} onBook={(pid) => setBooking(pid)} />)}
        {tab === 'activity' && <LeadTimeline leadId={lead.id} canEdit={canEdit} />}
        {tab === 'comms' && <Comms leadId={lead.id} contactId={lead.contactId} />}
      </div>

      {callCheck && LIVE && <LiveCallModal lead={lead} contactId={lead.contactId} onClose={() => setCallCheck(false)} />}
      {callCheck && !LIVE && contact && (
        <CallPolicyModal
          onClose={() => setCallCheck(false)}
          result={outboundPolicy(org, contact, 'phone', { purpose: 'ai_call' })}
          name={lead.name}
          onPlace={() => {
            const r = store.placeCall(lead.id, { byAi: true });
            setCallCheck(false);
            if (r.allowed) { toast({ kind: 'info', title: 'Call queued', body: `Qualification Agent is calling ${lead.name}…` }); setTab('comms'); }
            else toast({ kind: 'error', title: 'Call blocked', body: r.reason });
          }}
        />
      )}
      {booking !== false && <BookAppointmentModal onClose={() => setBooking(false)} preset={{ leadId: lead.id, propertyId: booking ?? undefined }} />}
      {tasking && <TaskModal onClose={() => setTasking(false)} preset={{ related: { type: 'lead', id: lead.id }, assignedTo: lead.assignedTo }} />}
      {dealing && <DealModal onClose={() => setDealing(false)} preset={{ leadId: lead.id }} />}
    </Drawer>
  );
}

function CallPolicyModal({ result, name, onClose, onPlace }: { result: ReturnType<typeof outboundPolicy>; name: string; onClose: () => void; onPlace: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={`Call ${name}?`}
      description="Every outbound call passes a deterministic policy check immediately before dialing."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" icon={<PhoneCall size={15} />} disabled={!result.allowed} onClick={onPlace}>
            {result.allowed ? 'Place AI call' : 'Blocked by policy'}
          </Button>
        </>
      }
    >
      <PolicyChecks result={result} />
      {!result.allowed && <div className="banner danger mt-12">{result.reason}</div>}
    </Modal>
  );
}

function Overview({ lead, onEdit, canEdit }: { lead: Lead; onEdit: () => void; canEdit: boolean }) {
  const contact = useLookup('contacts').get(lead.contactId);
  const ai = (k: string) => lead.aiFields.includes(k) && <AiBadge />;
  return (
    <div className="stack stack-lg">
      {lead.summary && (
        <div className="tl-body" style={{ marginTop: 0 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="section-title" style={{ margin: 0 }}>Summary</span>
            {lead.aiFields.length > 0 && <AiBadge title="Generated from call/message — check before relying on it" />}
          </div>
          {lead.summary}
        </div>
      )}
      <section>
        <div className="row row-between">
          <h4 className="section-title">Requirements</h4>
          {canEdit && <button className="text-btn" onClick={onEdit}><Pencil size={12} /> Edit</button>}
        </div>
        <KV
          items={[
            ['Intent', <span key="i" style={{ textTransform: 'capitalize' }}>{lead.intent}</span>],
            ['Budget', lead.budgetMax ? <>{lead.budgetMin ? `${money(lead.budgetMin)} – ` : 'Up to '}{money(lead.budgetMax)}{lead.intent === 'rent' ? '/mo' : ''} {ai('budget')}</> : <span className="faint">Unknown</span>],
            ['Locations', lead.locations.length ? <>{lead.locations.map((l) => <span key={l} className="tag">{l}</span>)} {ai('locations')}</> : <span className="faint">Unknown</span>],
            ['Configuration', lead.propertyType || lead.bedrooms != null ? <>{lead.bedrooms != null ? `${lead.bedrooms} BHK ` : ''}{lead.propertyType ?? <span className="faint">type unknown</span>} {ai('bedrooms') || ai('propertyType')}</> : <span className="faint">Unknown</span>],
            ['Timeline', lead.timeline ? <>{lead.timeline} {ai('timeline')}</> : <span className="faint">Unknown</span>],
            ['Must-haves', lead.amenities.length ? lead.amenities.map((a) => <span key={a} className="tag">{a}</span>) : <span className="faint">None stated</span>],
          ]}
        />
        {lead.missing.length > 0 && (
          <div className="banner mt-12" style={{ fontSize: 12.5 }}>
            <Sparkles size={14} className="accent-text" />
            <span>Missing: <b>{lead.missing.join(', ')}</b>. The qualification agent will ask for these — it never guesses.</span>
          </div>
        )}
      </section>
      {LIVE && <IntakePanel lead={lead} />}
      {LIVE && <LeadCallsPanel leadId={lead.id} />}
      {LIVE && <QualificationPanel lead={lead} />}
      {LIVE && <RecordQualityPanel entityType="lead" id={lead.id} />}
      <section>
        <h4 className="section-title">Why this score</h4>
        <div className="row wrap" style={{ gap: 6 }}>
          {lead.scoreReasons.length ? lead.scoreReasons.map((r) => <span key={r} className="tag"><Check size={11} style={{ marginRight: 4 }} />{r}</span>) : <span className="faint">Not enough information yet.</span>}
        </div>
        <p className="faint mt-8" style={{ fontSize: 12 }}>Scores use only stated requirements and engagement — never personal or protected characteristics.</p>
      </section>
      <section>
        <h4 className="section-title">Next follow-up</h4>
        <div className="row">
          <Input type="datetime-local" inputSize="sm" style={{ width: 220 }} disabled={!canEdit} value={lead.nextFollowUpAt ? toLocalInput(lead.nextFollowUpAt) : ''} onChange={(e) => { const v = e.target.value; if (v) void ok(() => actions.updateLead(lead.id, { nextFollowUpAt: fromLocalInput(v) })); }} aria-label="Next follow-up" />
          {lead.nextFollowUpAt && lead.nextFollowUpAt < Date.now() && <Badge tone="danger">Overdue</Badge>}
          <span className="faint" style={{ fontSize: 12 }}>First response: {lead.firstResponseAt ? `${Math.max(1, Math.round((lead.firstResponseAt - lead.createdAt) / 60000))} min after enquiry` : 'not yet'}</span>
        </div>
      </section>
      {contact && (
        <section>
          <h4 className="section-title">Communication consent</h4>
          <div className="card" style={{ boxShadow: 'none' }}>
            {(['phone', 'whatsapp', 'sms', 'email'] as Channel[]).map((ch) => {
              const state = contact.consents[ch];
              return (
                <div key={ch} className="list-row" style={{ padding: '10px 14px' }}>
                  <span className="icon-chip">{CHANNEL_ICON[ch]}</span>
                  <span className="grow">{CHANNEL_LABEL[ch]}</span>
                  <ConsentBadge state={state} />
                  <Switch
                    on={state === 'granted'}
                    disabled={!canEdit || contact.lifecycle === 'do_not_contact'}
                    label={`${CHANNEL_LABEL[ch]} consent`}
                    onChange={async (v) => {
                      const source = v ? await askConsentSource(CHANNEL_LABEL[ch]) : undefined;
                      if (source === null) return;
                      if (!(await ok(() => actions.setConsent(contact.id, ch, v ? 'granted' : 'revoked', source)))) return;
                      toast({ kind: v ? 'success' : 'warning', title: v ? `${CHANNEL_LABEL[ch]} consent granted` : `${CHANNEL_LABEL[ch]} opt-out recorded`, body: v ? 'Recorded with source and timestamp.' : 'Pending follow-ups on this channel cancelled.' });
                    }}
                  />
                </div>
              );
            })}
          </div>
          <p className="faint mt-8" style={{ fontSize: 12 }}>Unknown consent is never treated as permission. Checked again immediately before every send or call.</p>
        </section>
      )}
    </div>
  );
}

export function ConsentBadge({ state }: { state: ConsentState }) {
  const map: Record<ConsentState, [string, 'success' | 'neutral' | 'danger' | 'warning']> = { granted: ['Granted', 'success'], unknown: ['Unknown', 'warning'], denied: ['Denied', 'danger'], revoked: ['Opted out', 'danger'] };
  return <Badge tone={map[state][1]}>{map[state][0]}</Badge>;
}

function RequirementsForm({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const org = useOrg();
  const localities = useMemo(() => [...new Set(useStore.getState().properties.filter((p) => p.orgId === org.id).map((p) => p.locality))].sort(), [org.id]);
  const rent = lead.intent === 'rent' || lead.intent === 'let';
  const [f, setF] = useState({
    budgetMax: lead.budgetMax ? String(rent ? lead.budgetMax : lead.budgetMax / budgetInputUnit().multiplier) : '',
    locations: lead.locations,
    bedrooms: lead.bedrooms != null ? String(lead.bedrooms) : '',
    propertyType: lead.propertyType ?? '',
    timeline: lead.timeline ?? '',
    priority: lead.priority,
    intent: lead.intent,
  });
  const save = async () => {
    const bm = f.budgetMax ? Number(f.budgetMax) * (f.intent === 'rent' ? 1 : budgetInputUnit().multiplier) : null;
    setBusy(true);
    const saved = await ok(() => actions.updateLead(lead.id, {
      budgetMax: bm, budgetMin: bm ? Math.round(bm * 0.8) : null, locations: f.locations, bedrooms: f.bedrooms ? Number(f.bedrooms) : null,
      propertyType: (f.propertyType || null) as Lead['propertyType'], timeline: f.timeline || null, priority: f.priority, intent: f.intent,
    }));
    setBusy(false);
    if (!saved) return;
    toast({ kind: 'success', title: 'Requirements saved', body: 'Edited values are now marked as verified by a person.' });
    onDone();
  };
  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Intent">
          <Select value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value as Lead['intent'] })}>
            {['buy', 'rent', 'invest', 'sell', 'let'].map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
        </Field>
        <Field label={f.intent === 'rent' ? `Max rent (${currencySymbol()} / month)` : `Max budget (${budgetInputUnit().label})`}>
          <Input value={f.budgetMax} onChange={(e) => setF({ ...f, budgetMax: e.target.value })} inputMode="decimal" placeholder="Unknown" />
        </Field>
        <Field label="Property type">
          <Select value={f.propertyType} onChange={(e) => setF({ ...f, propertyType: e.target.value })}>
            <option value="">Unknown</option>
            {['apartment', 'villa', 'penthouse', 'plot', 'office', 'retail'].map((t) => <option key={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Bedrooms">
          <Select value={f.bedrooms} onChange={(e) => setF({ ...f, bedrooms: e.target.value })}>
            <option value="">Unknown</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} BHK</option>)}
          </Select>
        </Field>
        <Field label="Timeline">
          <Select value={f.timeline} onChange={(e) => setF({ ...f, timeline: e.target.value })}>
            <option value="">Unknown</option>
            {['Immediate', '1 month', '0-3 months', '3-6 months', '6-12 months'].map((t) => <option key={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as Lead['priority'] })}>
            {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label="Preferred localities" className="full">
          <div className="row wrap" style={{ gap: 6 }}>
            {localities.map((l) => {
              const on = f.locations.includes(l);
              return (
                <button key={l} className={cx('tool-chip', on && 'on')} onClick={() => setF({ ...f, locations: on ? f.locations.filter((x) => x !== l) : [...f.locations, l] })} aria-pressed={on}>
                  {l}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>Save requirements</Button>
      </div>
    </div>
  );
}

function Matches({ lead, onBook }: { lead: Lead; onBook: (propertyId: string) => void }) {
  const properties = useOrgList('properties');
  const [includeStale, setIncludeStale] = useState(true);
  const matches = useMemo(() => matchProperties(lead, properties).filter((m) => includeStale || !m.stale).slice(0, 8), [lead, properties, includeStale]);
  return (
    <div className="stack">
      <div className="row">
        <p className="faint grow" style={{ fontSize: 12.5 }}>
          Hard constraints (available, {lead.intent === 'rent' ? 'for rent' : 'for sale'}, within budget) are applied first; the rest are ranked and explained.
        </p>
        <label className="check" style={{ fontSize: 12.5 }}>
          <input type="checkbox" checked={includeStale} onChange={(e) => setIncludeStale(e.target.checked)} /> Include unverified
        </label>
      </div>
      {matches.length === 0 && (
        <Empty icon={<Building2 size={20} />} title="No suitable property right now" description={lead.budgetMax ? 'Nothing active meets the hard constraints. Widen locations or check new inventory.' : 'Budget is unknown — capture it first so matching can apply hard constraints.'} />
      )}
      {matches.map((m) => (
        <div key={m.property.id} className="card" style={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr) auto', gap: 14, padding: 10, alignItems: 'center', boxShadow: 'none' }}>
          <div className="prop-media" style={{ margin: 0, aspectRatio: '4/3', borderRadius: 10 }}>
            <PropertyImage index={m.property.image} alt={m.property.title} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <b className="truncate">{m.property.title}</b>
              <span className="mono faint" style={{ fontSize: 11 }}>{m.property.ref}</span>
            </div>
            <div className="faint" style={{ fontSize: 12.5 }}>{m.property.locality} · {money(m.property.price)}{m.property.listing === 'rent' ? '/mo' : ''} · {m.property.area.toLocaleString('en-IN')} sq ft</div>
            <div className="row wrap mt-8" style={{ gap: 5 }}>
              {m.reasons.map((r) => <span key={r} className="badge badge-success"><Check size={10} /> {r}</span>)}
              {m.gaps.map((g) => <span key={g} className={cx('badge', g.includes('verified') ? 'badge-warning' : '')}>{g}</span>)}
            </div>
          </div>
          <div className="stack stack-sm" style={{ alignItems: 'flex-end' }}>
            <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{m.score}</span>
            <div className="row" style={{ gap: 4 }}>
              <Button size="xs" onClick={() => navigate('properties', { id: m.property.id })}>View</Button>
              <Button size="xs" onClick={async () => {
                // Recorded on the timeline; sending it to the customer happens through a connected channel.
                if (!(await ok(() => actions.addNote(lead.id, `Shared ${m.property.title} (${m.property.ref}) — ${m.reasons.join(' · ')}`)))) return;
                if (['qualified', 'contacted'].includes(lead.status)) await ok(() => actions.setLeadStatus(lead.id, 'matching'));
                toast({ kind: 'success', title: 'Recorded as shared', body: m.stale ? 'Note: availability is unverified — confirm before promising.' : undefined });
              }}>Share</Button>
              <Button size="xs" variant="primary" onClick={() => onBook(m.property.id)}>Visit</Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LeadTimeline({ leadId, canEdit, contactId }: { leadId?: string; contactId?: string; canEdit: boolean }) {
  const activities = useOrgList('activities');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const items = useMemo(() => activities.filter((a) => (leadId ? a.leadId === leadId : a.contactId === contactId)).sort((a, b) => b.at - a.at), [activities, leadId, contactId]);
  return (
    <div className="stack">
      {canEdit && leadId && (
        <div className="row row-top">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an internal note…" style={{ minHeight: 44 }} />
          <Button icon={<StickyNote size={14} />} loading={saving} disabled={!note.trim()} onClick={async () => { setSaving(true); const done = await ok(() => actions.addNote(leadId, note.trim())); setSaving(false); if (done) { setNote(''); toast({ kind: 'success', title: 'Note added' }); } }}>Add</Button>
        </div>
      )}
      <div className="timeline mt-8">
        {items.length === 0 && <span className="faint">No activity yet.</span>}
        {items.map((a) => (
          <div key={a.id} className="tl-item">
            <span className={cx('tl-icon', a.actor.type === 'ai_agent' && 'ai')}>{ACT_ICON[a.kind] ?? <ArrowRight size={13} />}</span>
            <div>
              <div className="tl-title">{a.title}</div>
              <div className="tl-meta">
                {a.actor.type === 'ai_agent' ? <><Sparkles size={10} className="accent-text" /> </> : null}
                {a.actor.name} · {fmtDateTime(a.at)}
              </div>
              {a.body && <div className="tl-body">{a.body}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const ACT_ICON: Record<string, React.ReactNode> = {
  created: <Plus size={13} />,
  status: <CircleDot size={13} />,
  assigned: <UserPlus size={13} />,
  call: <PhoneCall size={13} />,
  message: <MessageCircle size={13} />,
  note: <StickyNote size={13} />,
  appointment: <CalendarPlus size={13} />,
  property_sent: <Building2 size={13} />,
  ai_update: <Sparkles size={13} />,
  opt_out: <ShieldOff size={13} />,
  deal: <Handshake size={13} />,
  task: <CheckSquare size={13} />,
  workflow: <Bot size={13} />,
  updated: <Pencil size={13} />,
};

function Comms({ leadId, contactId }: { leadId: string; contactId: string }) {
  if (LIVE) return <FollowUpsPanel leadId={leadId} />;
  return <DemoComms leadId={leadId} contactId={contactId} />;
}

function DemoComms({ leadId, contactId }: { leadId: string; contactId: string }) {
  const calls = useOrgList('calls');
  const conversations = useOrgList('conversations');
  const canRecord = useCan('calls.recordings');
  const mine = calls.filter((c) => c.leadId === leadId).sort((a, b) => b.startedAt - a.startedAt);
  const convs = conversations.filter((c) => c.contactId === contactId);
  return (
    <div className="stack stack-lg">
      <section>
        <h4 className="section-title">Calls</h4>
        {mine.length === 0 && <span className="faint">No calls yet.</span>}
        <div className="stack stack-sm">
          {mine.map((c) => (
            <div key={c.id} className="card" style={{ padding: 12, boxShadow: 'none' }}>
              <div className="row">
                <span className="icon-chip">{c.agentId ? <Bot size={14} /> : <PhoneCall size={14} />}</span>
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{c.agentId ? 'AI call' : 'Manual call'} · {c.direction}</div>
                  <div className="faint" style={{ fontSize: 12 }}>{fmtDateTime(c.startedAt)}{c.duration ? ` · ${Math.floor(c.duration / 60)}m ${c.duration % 60}s` : ''}{c.cost ? ` · ${moneyPrecise(c.cost)}` : ''}</div>
                </div>
                <CallStatusInline status={c.status} />
              </div>
              {c.summary && <div className="tl-body">{c.summary}</div>}
              {c.policyNote && <div className="banner danger mt-8" style={{ fontSize: 12.5 }}>{c.policyNote}</div>}
              {c.recording && <div className="faint mt-8" style={{ fontSize: 12 }}>{canRecord ? 'Recording available (access is logged).' : 'Recording restricted to authorized roles.'}</div>}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h4 className="section-title">Conversations</h4>
        {convs.length === 0 && <span className="faint">No conversations yet.</span>}
        {convs.map((c) => (
          <button key={c.id} className="list-row card" style={{ marginBottom: 6, boxShadow: 'none' }} onClick={() => navigate('inbox', { id: c.id })}>
            <span className="icon-chip">{CHANNEL_ICON[c.channel]}</span>
            <span className="grow truncate">{c.messages[c.messages.length - 1]?.body ?? 'No messages'}</span>
            <span className="faint" style={{ fontSize: 12 }}>{relTime(c.lastMessageAt)}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

function CallStatusInline({ status }: { status: string }) {
  const live = ['queued', 'initiating', 'ringing', 'in_progress'].includes(status);
  const tone = status === 'completed' ? 'success' : status === 'blocked' || status === 'failed' ? 'danger' : live ? 'accent' : 'warning';
  return (
    <Badge tone={tone}>
      {live && <span className="status-dot live" style={{ width: 6, height: 6 }} />}
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}

export { CallStatusInline };

const INTAKE_SOURCE: Record<string, string> = { webhook: 'Signed webhook', manual: 'Added in the OS', import: 'CSV import', voice: 'Inbound call', integration: 'Integration' };
const DUPLICATE_LABEL: Record<string, string> = {
  none: 'No existing contact matched',
  match: 'Linked to an existing contact (same phone/email)',
  same_external_id: 'Same enquiry id from this source',
  ambiguous: 'Possible duplicate — kept separate',
  checked_by_user: 'Checked by the person who added it',
};
const ASSIGN_LABEL: Record<string, string> = {
  property_listing_agent: 'Listing agent of the enquired property',
  source_rule: 'Source rule',
  contact_owner: "Contact's existing owner",
  policy_least_loaded: 'Least-loaded agent',
  policy_round_robin: 'Round robin',
  policy_by_locality: 'Agent covering the locality',
  fallback: 'Fallback assignee',
  unassigned_queue: 'Unassigned queue (no eligible agent)',
  set_at_creation: 'Chosen at creation',
  kept_existing: 'Kept existing owner',
};
const REVIEW_REASON: Record<string, string> = {
  phone_and_email_match_different_contacts: 'Phone matches one contact and email matches another',
  same_phone_different_email: 'Same phone, different email',
  same_email_different_phone: 'Same email, different phone',
  same_phone_different_name: 'Same phone, different name',
};
const HANDOFF_LABEL: Record<string, string> = {
  pending: 'Queued for the Sales & Qualification agent',
  processing: 'Being picked up by the Sales & Qualification agent',
  delivered: 'Received by the Sales & Qualification agent',
  dead_letter: 'Handoff failed — needs attention',
};
const humanize = (code: string) => code.replace(/_/g, ' ');

/** Intake outcome as recorded by the backend: source, dedupe, assignment, handoff, and any open duplicate review. */
function IntakePanel({ lead }: { lead: Lead }) {
  const canMerge = useCan('leads.merge');
  const q = useServerQuery(true, () => live.leadIntakeSummary(lead.id), [lead.id, lead.intakeStatus]);
  const [busy, setBusy] = useState(false);
  if (q.loading && !q.data) return <section><h4 className="section-title">Intake</h4><div className="skeleton" style={{ height: 60 }} /></section>;
  if (q.error) return <section><h4 className="section-title">Intake</h4><p className="faint" style={{ fontSize: 12.5 }}>Couldn't load intake details. {q.error}</p></section>;
  const s = q.data;
  if (!s?.run) return null;
  const review = s.review?.status === 'open' ? s.review : null;

  const resolve = async (decision: 'distinct' | 'duplicate', keep?: string) => {
    setBusy(true);
    const done = await ok(() => live.resolveIntakeReview(review!.id, decision, keep));
    setBusy(false);
    if (!done) return;
    toast({ kind: 'success', title: decision === 'distinct' ? 'Kept as a separate person' : 'Merged into the existing lead' });
    if (decision === 'duplicate' && keep) setParam('id', keep);
    q.reload();
  };

  return (
    <section>
      <h4 className="section-title">Intake</h4>
      {review && (
        <div className="banner warning" style={{ display: 'block', fontSize: 12.5, marginBottom: 10 }}>
          <div className="row" style={{ gap: 6 }}><AlertTriangle size={14} /><b>Possible duplicate — qualification waits for a decision</b></div>
          <div className="faint mt-8">{review.reasons.map((r) => REVIEW_REASON[r] ?? humanize(r)).join(' · ')}</div>
          <div className="stack mt-8" style={{ gap: 6 }}>
            {review.candidates.map((c) => (
              <div key={c.contact_id} className="row wrap" style={{ gap: 6 }}>
                <span className="grow"><b>{c.name}</b>{c.leads.length === 0 && <span className="faint"> · no open enquiry</span>}</span>
                {canMerge && c.leads.map((l) => (
                  <Button key={l.id} size="sm" icon={<GitMerge size={13} />} disabled={busy} onClick={() => void resolve('duplicate', l.id)}>
                    Same person — merge into {l.source} enquiry ({LEAD_STATUS[l.status as LeadStatus]?.label ?? l.status})
                  </Button>
                ))}
              </div>
            ))}
          </div>
          {canMerge ? (
            <div className="row mt-8"><Button size="sm" variant="primary" disabled={busy} onClick={() => void resolve('distinct')}>Different person — continue</Button></div>
          ) : (
            <p className="faint mt-8">A manager or admin needs to resolve this.</p>
          )}
        </div>
      )}
      <KV
        items={[
          ['Received', <>{INTAKE_SOURCE[s.run.source_kind] ?? s.run.source_kind} · {relTime(new Date(s.run.received_at).getTime())}</>],
          ['Duplicates', s.duplicate_status === 'resolved_distinct' ? 'Reviewed: different person' : s.duplicate_status === 'merged' ? 'Reviewed: merged into another lead' : DUPLICATE_LABEL[s.run.duplicate ?? ''] ?? '—'],
          ['Assignment', ASSIGN_LABEL[s.run.assignment ?? ''] ?? '—'],
          ['Qualification', s.handoff ? HANDOFF_LABEL[s.handoff.status] ?? humanize(s.handoff.status) : review ? 'Waiting for duplicate review' : 'Not handed off'],
          ...(s.run.model_outcome && s.run.model_outcome !== 'disabled'
            ? [['AI extraction', s.run.model_outcome.startsWith('ok') ? `Used for ${(s.run.ai_fields ?? []).join(', ') || 'no fields'}` : `Skipped (${humanize(s.run.model_outcome)}) — form fields used`] as [string, string]]
            : []),
        ]}
      />
      {(s.run.warnings ?? []).length > 0 && (
        <p className="faint mt-8" style={{ fontSize: 12 }}>Data notes: {(s.run.warnings ?? []).map(humanize).join(', ')}</p>
      )}
    </section>
  );
}
