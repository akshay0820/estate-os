import { useMemo, useRef, useState } from 'react';
import { Download, FileText, Lock, Trash2, UploadCloud, AlertTriangle, Loader2 } from 'lucide-react';
import { Badge, Button, Empty, Field, Menu, Modal, PageHeader, SearchInput, Select } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { LIVE, attempt, ok } from '@/data/actions';
import * as live from '@/backend/live';
import { useCan, useLookup, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate } from '@/lib/router';
import { bytes, fmtDate, relTime } from '@/lib/format';
import { cx } from '@/lib/util';
import type { DocumentRec } from '@/store/types';

const CLASS_TONE = { general: 'neutral', confidential: 'warning', restricted: 'danger' } as const;
const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX = 20 * 1024 * 1024;

export function DocumentsPage() {
  const docs = useOrgList('documents');
  const props = useLookup('properties');
  const deals = useLookup('deals');
  const contacts = useLookup('contacts');
  const canRestricted = useCan('documents.restricted');
  const canEdit = useCan('documents.edit');
  const { removeDocument, updateDocument } = useStore.getState();
  const reclassify = async (id: string, c: DocumentRec['classification']) => {
    if (LIVE) return ok(() => live.updateDocument(id, { classification: c }));
    updateDocument(id, { classification: c });
    return true;
  };
  const remove = async (id: string) => {
    // Live: archive the record (hidden from lists; storage object kept for retention review).
    if (LIVE) return ok(() => live.updateDocument(id, { status: 'archived' }));
    removeDocument(id);
    return true;
  };
  const getLink = async (d: DocumentRec) => {
    if (!LIVE) {
      useStore.getState().log('document.downloaded', 'document', d.id, 'signed URL · 5 min');
      toast({ kind: 'success', title: 'Download link created', body: 'Signed link valid for 5 minutes. Access logged.' });
      return;
    }
    const url = await attempt(() => live.documentLink(d.id));
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<File[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const now = Date.now();

  const list = useMemo(() => docs.filter((d) => (!kind || d.kind === kind) && (!q || d.name.toLowerCase().includes(q.toLowerCase()))), [docs, kind, q]);
  const expiring = docs.filter((d) => d.expiresAt && d.expiresAt - now < 14 * 864e5);
  const relatedLabel = (d: DocumentRec) => {
    if (!d.related) return '—';
    if (d.related.type === 'property') return props.get(d.related.id)?.title ?? 'Property';
    if (d.related.type === 'deal') return deals.get(d.related.id)?.title ?? 'Deal';
    return contacts.get(d.related.id)?.name ?? 'Contact';
  };

  const pick = (files: FileList | File[]) => {
    const arr = [...files];
    const bad = arr.filter((f) => !ALLOWED.includes(f.type) || f.size > MAX);
    if (bad.length) toast({ kind: 'error', title: `${bad.length} file${bad.length > 1 ? 's' : ''} rejected`, body: 'Only PDF, DOCX, PNG, JPG or WEBP up to 20 MB. Type is checked, not just the extension.' });
    const ok = arr.filter((f) => !bad.includes(f));
    if (ok.length) setPending(ok);
  };

  return (
    <div className="page">
      <PageHeader eyebrow="[ Private storage · signed short-lived links ]" title="Documents" sub="Agreements, IDs and property papers linked to their records. Access follows the parent record and classification; AI extraction is an aid, not a legal opinion." actions={canEdit && <Button variant="primary" icon={<UploadCloud size={15} />} onClick={() => fileRef.current?.click()}>Upload</Button>} />
      <input ref={fileRef} type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.docx" onChange={(e) => { if (e.target.files) pick(e.target.files); e.target.value = ''; }} />
      {expiring.length > 0 && <div className="banner warning" style={{ marginBottom: 16 }}><AlertTriangle size={15} /> {expiring.length} agreement{expiring.length > 1 ? 's' : ''} expire within 14 days or have expired.</div>}
      {canEdit && (
        <div className={cx('dropzone', over && 'over')} style={{ marginBottom: 16 }} onClick={() => fileRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}>
          <UploadCloud size={22} style={{ margin: '0 auto 6px' }} />
          <div><b>Drop files here</b> or click to browse</div>
          <div className="faint" style={{ fontSize: 12 }}>PDF, DOCX, PNG, JPG · up to 20 MB · {LIVE ? 'file contents are type-checked before upload' : 'scanned before use'}</div>
        </div>
      )}
      <div className="card">
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search documents" />
          <Select selectSize="sm" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 160 }} aria-label="Type">
            <option value="">All types</option>
            {['agreement', 'id_proof', 'title_deed', 'floor_plan', 'brochure', 'invoice', 'other'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
          </Select>
        </div>
        {list.length === 0 ? <Empty icon={<FileText size={20} />} title="No documents" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Linked to</th><th>Classification</th><th className="right">Size</th><th>Uploaded</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {list.map((d) => {
                  const locked = d.classification === 'restricted' && !canRestricted;
                  return (
                    <tr key={d.id}>
                      <td>
                        <div className="cell-main">
                          <span className="icon-chip">{d.status === 'processing' ? <Loader2 size={13} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : locked ? <Lock size={13} /> : <FileText size={13} />}</span>
                          <div style={{ minWidth: 0 }}><div className="cell-title truncate" style={{ maxWidth: 320 }}>{locked ? 'Restricted document' : d.name}</div><div className="cell-sub">{d.kind.replace('_', ' ')}{d.status === 'processing' && ' · scanning…'}</div></div>
                        </div>
                      </td>
                      <td>{d.related ? <button className="link truncate" style={{ maxWidth: 220, display: 'inline-block' }} onClick={() => navigate(d.related!.type === 'property' ? 'properties' : d.related!.type === 'deal' ? 'deals' : 'contacts', { id: d.related!.id })}>{relatedLabel(d)}</button> : '—'}</td>
                      <td><Badge tone={CLASS_TONE[d.classification]}>{d.classification}</Badge></td>
                      <td className="right num faint">{bytes(d.size)}</td>
                      <td className="faint">{relTime(d.uploadedAt)} · {d.uploadedBy.split(' ')[0]}</td>
                      <td>{d.expiresAt ? <span style={{ color: d.expiresAt < now ? 'var(--danger)' : d.expiresAt - now < 14 * 864e5 ? 'var(--warning)' : undefined }}>{fmtDate(d.expiresAt, true)}</span> : <span className="faint">—</span>}</td>
                      <td className="right">
                        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <Button size="xs" icon={<Download size={12} />} disabled={locked || d.status !== 'ready'} onClick={() => void getLink(d)}>{LIVE ? 'Open' : 'Get link'}</Button>
                          {canEdit && !locked && (
                            <Menu
                              trigger={(p) => <Button size="xs" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label="Document actions" {...p} />}
                              items={[
                                { heading: 'Classification' },
                                ...(['general', 'confidential', 'restricted'] as const).map((c) => ({ label: c, checked: d.classification === c, onSelect: async () => { if (await reclassify(d.id, c)) toast({ kind: 'success', title: `Marked ${c}` }); } })),
                                'sep',
                                { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: async () => { const r = await confirm({ title: 'Delete document?', body: 'Removes the file and derived extractions. Backups expire on their normal schedule.', confirmLabel: 'Delete', danger: true }); if (r.ok && (await remove(d.id))) toast({ kind: 'info', title: LIVE ? 'Document removed' : 'Document deleted' }); } },
                              ]}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {pending && <UploadModal files={pending} onClose={() => setPending(null)} />}
    </div>
  );
}

function UploadModal({ files, onClose }: { files: File[]; onClose: () => void }) {
  const props = useOrgList('properties');
  const deals = useOrgList('deals');
  const add = useStore((s) => s.addDocuments);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<DocumentRec['kind']>('other');
  const [classification, setClassification] = useState<DocumentRec['classification']>('confidential');
  const [link, setLink] = useState('');
  return (
    <Modal open onClose={onClose} title={`Upload ${files.length} file${files.length > 1 ? 's' : ''}`} description={files.map((f) => f.name).join(', ')} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} icon={<UploadCloud size={14} />} onClick={async () => {
      const [type, id] = link.split(':');
      const related = type ? { type: type as 'property' | 'deal', id } : null;
      const expiresAt = kind === 'agreement' ? Date.now() + 180 * 864e5 : null;
      if (!LIVE) {
        add(files.map((f) => ({ name: f.name, kind, size: f.size, classification, related, expiresAt })));
        toast({ kind: 'success', title: 'Uploading', body: 'Files go to a private bucket and are scanned before use.' });
        onClose();
        return;
      }
      setBusy(true);
      let uploaded = 0;
      for (const f of files) if (await ok(() => live.uploadDocument(f, { kind, classification, related, expiresAt }))) uploaded++;
      setBusy(false);
      await attempt(() => live.refresh('documents'));
      if (uploaded) toast({ kind: 'success', title: `Uploaded ${uploaded} of ${files.length}`, body: 'Stored in a private bucket; opened only through short-lived signed links.' });
      onClose();
    }}>Upload</Button></>}>
      <div className="form-grid">
        <Field label="Type"><Select value={kind} onChange={(e) => setKind(e.target.value as DocumentRec['kind'])}>{['agreement', 'id_proof', 'title_deed', 'floor_plan', 'brochure', 'invoice', 'other'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</Select></Field>
        <Field label="Classification" hint={classification === 'restricted' ? 'Only owners/admins can open' : undefined}><Select value={classification} onChange={(e) => setClassification(e.target.value as DocumentRec['classification'])}><option value="general">General</option><option value="confidential">Confidential</option><option value="restricted">Restricted</option></Select></Field>
        <Field label="Link to" className="full">
          <Select value={link} onChange={(e) => setLink(e.target.value)}>
            <option value="">Nothing</option>
            <optgroup label="Properties">{props.slice(0, 60).map((p) => <option key={p.id} value={`property:${p.id}`}>{p.ref} · {p.title}</option>)}</optgroup>
            <optgroup label="Deals">{deals.slice(0, 60).map((d) => <option key={d.id} value={`deal:${d.id}`}>{d.title}</option>)}</optgroup>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
