import { useMemo, useState } from 'react';
import { Check, Download, Plus, Receipt, Wallet } from 'lucide-react';
import { BarChart } from '@/components/charts';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Tabs } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { LIVE, actions, ok } from '@/data/actions';
import { useCan, useLookup, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate } from '@/lib/router';
import { fmtDate, money, currencySymbol } from '@/lib/format';
import { downloadCsv } from '@/lib/util';
import type { Commission, Expense } from '@/store/types';
import { MemberChip } from './shared';

const C_TONE = { estimated: 'neutral', approved: 'info', payable: 'warning', paid: 'success', void: 'neutral' } as const;
const NEXT: Partial<Record<Commission['status'], Commission['status']>> = { estimated: 'approved', approved: 'payable', payable: 'paid' };
const NEXT_LABEL: Partial<Record<Commission['status'], string>> = { estimated: 'Approve', approved: 'Mark payable', payable: 'Mark paid' };

export function FinancePage() {
  const commissions = useOrgList('commissions');
  const expenses = useOrgList('expenses');
  const deals = useLookup('deals');
  const canEdit = useCan('finance.edit');
  const { setExpenseStatus } = useStore.getState();
  const [tab, setTab] = useState<'commissions' | 'expenses'>('commissions');
  const [adding, setAdding] = useState(false);

  const sum = (s: Commission['status'][]) => commissions.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.gross, 0);
  const months = useMemo(() => {
    const out: { label: string; start: number; end: number }[] = [];
    const d = new Date();
    for (let i = 5; i >= 0; i--) {
      const s = new Date(d.getFullYear(), d.getMonth() - i, 1).getTime();
      const e = new Date(d.getFullYear(), d.getMonth() - i + 1, 1).getTime();
      out.push({ label: new Date(s).toLocaleDateString('en-IN', { month: 'short' }), start: s, end: e });
    }
    return out;
  }, []);
  const received = months.map((m) => commissions.filter((c) => c.status === 'paid' && c.paidAt && c.paidAt >= m.start && c.paidAt < m.end).reduce((a, c) => a + c.gross, 0));
  const spent = months.map((m) => expenses.filter((e) => e.date >= m.start && e.date < m.end).reduce((a, e) => a + e.amount, 0));

  return (
    <div className="page">
      <PageHeader
        eyebrow="[ Operational tracking — not an accounting system ]"
        title="Finance"
        sub="Commission lifecycle and operating expenses. Expected, approved and received amounts are kept separate, and every change is attributed."
        actions={
          <>
            <Button icon={<Download size={15} />} onClick={() => {
              downloadCsv('commissions.csv', [['Deal', 'Beneficiary', 'Gross (INR)', 'Status', 'Created', 'Paid'], ...commissions.map((c) => [deals.get(c.dealId)?.title, c.beneficiaryId, c.gross, c.status, new Date(c.createdAt).toISOString().slice(0, 10), c.paidAt ? new Date(c.paidAt).toISOString().slice(0, 10) : ''])]);
              toast({ kind: 'success', title: 'Commissions exported' });
            }}>Export</Button>
            {canEdit && !LIVE && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add expense</Button>}
          </>
        }
      />
      <div className="grid g-kpi">
        <div className="card kpi"><div className="kpi-label">Expected (estimated)</div><div className="kpi-value">{money(sum(['estimated']))}</div><div className="kpi-foot">Awaiting approval</div></div>
        <div className="card kpi"><div className="kpi-label">Approved & payable</div><div className="kpi-value">{money(sum(['approved', 'payable']))}</div><div className="kpi-foot">Invoiced, not received</div></div>
        <div className="card kpi"><div className="kpi-label">Received · 6 months</div><div className="kpi-value">{money(received.reduce((a, b) => a + b, 0))}</div><div className="kpi-foot">Cash in</div></div>
        <div className="card kpi"><div className="kpi-label">Expenses · 6 months</div><div className="kpi-value">{LIVE ? '—' : money(spent.reduce((a, b) => a + b, 0))}</div><div className="kpi-foot">{LIVE ? 'Expense tracking arrives with finance M2' : `${expenses.filter((e) => e.status === 'pending').length} unpaid`}</div></div>
      </div>
      <Card title="Commission received vs expenses" className="mt-16" actions={<div className="legend"><span><i style={{ background: 'var(--chart-1)' }} /> Received</span><span><i style={{ background: 'var(--chart-5)' }} /> Expenses</span></div>}>
        <BarChart height={220} labels={months.map((m) => m.label)} format={(v) => money(v)} series={[{ name: 'Received', values: received, color: 'var(--chart-1)' }, { name: 'Expenses', values: spent, color: 'var(--chart-5)' }]} />
      </Card>
      <div className="card mt-16">
        <div style={{ padding: '4px 14px 0' }}>
          <Tabs value={tab} onChange={setTab} tabs={LIVE ? [{ value: 'commissions', label: 'Commissions', count: commissions.length }] : [{ value: 'commissions', label: 'Commissions', count: commissions.length }, { value: 'expenses', label: 'Expenses', count: expenses.length }]} />
        </div>
        {tab === 'commissions' ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Deal</th><th>Beneficiary</th><th className="right">Gross</th><th>Status</th><th>Recorded</th><th>Paid</th><th /></tr></thead>
              <tbody>
                {[...commissions].sort((a, b) => b.createdAt - a.createdAt).map((c) => (
                  <tr key={c.id}>
                    <td><button className="link truncate" style={{ maxWidth: 300, display: 'inline-block' }} onClick={() => navigate('deals', { id: c.dealId })}>{deals.get(c.dealId)?.title ?? 'Deal'}</button></td>
                    <td><MemberChip id={c.beneficiaryId} /></td>
                    <td className="right num">{money(c.gross, { compact: false })}</td>
                    <td><Badge tone={C_TONE[c.status]} dot>{c.status}</Badge></td>
                    <td className="faint">{fmtDate(c.createdAt, true)}</td>
                    <td className="faint">{c.paidAt ? fmtDate(c.paidAt, true) : '—'}</td>
                    <td className="right">
                      {canEdit && NEXT[c.status] && (
                        <Button size="xs" icon={<Check size={12} />} onClick={async () => {
                          const to = NEXT[c.status]!;
                          if (to === 'paid') {
                            const r = await confirm({ title: 'Mark as paid?', body: `${money(c.gross, { compact: false })} recorded as received. This doesn't move money — it records a payment that already happened.`, confirmLabel: 'Mark paid' });
                            if (!r.ok) return;
                          }
                          if (await ok(() => actions.advanceCommission(c.id, to as 'approved' | 'payable' | 'paid'))) toast({ kind: 'success', title: `Commission ${to}` });
                        }}>{NEXT_LABEL[c.status]}</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Vendor</th><th>Category</th><th className="right">Amount</th><th>Date</th><th>Status</th><th /></tr></thead>
              <tbody>
                {[...expenses].sort((a, b) => b.date - a.date).map((e) => (
                  <tr key={e.id}>
                    <td><div className="cell-main"><span className="icon-chip"><Receipt size={13} /></span>{e.vendor}</div></td>
                    <td><Badge>{e.category.replace('_', ' ')}</Badge></td>
                    <td className="right num">{money(e.amount, { compact: false })}</td>
                    <td className="faint">{fmtDate(e.date, true)}</td>
                    <td><Badge tone={e.status === 'paid' ? 'success' : 'warning'} dot>{e.status}</Badge></td>
                    <td className="right">{canEdit && e.status === 'pending' && <Button size="xs" icon={<Wallet size={12} />} onClick={() => { setExpenseStatus(e.id, 'paid'); toast({ kind: 'success', title: 'Expense marked paid' }); }}>Mark paid</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {adding && <ExpenseModal onClose={() => setAdding(false)} />}
    </div>
  );
}

function ExpenseModal({ onClose }: { onClose: () => void }) {
  const addExpense = useStore((s) => s.addExpense);
  const [f, setF] = useState({ vendor: '', category: 'marketing' as Expense['category'], amount: '', date: new Date().toISOString().slice(0, 10), status: 'pending' as Expense['status'] });
  const [err, setErr] = useState('');
  return (
    <Modal open onClose={onClose} title="Add expense" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => {
      if (!f.vendor.trim()) return setErr('Vendor is required');
      const amount = Number(f.amount);
      if (!Number.isInteger(amount) || amount <= 0) return setErr('Enter a whole rupee amount greater than zero');
      addExpense({ vendor: f.vendor.trim(), category: f.category, amount, date: new Date(f.date + 'T12:00').getTime(), status: f.status });
      toast({ kind: 'success', title: 'Expense added' });
      onClose();
    }}>Add</Button></>}>
      <div className="form-grid">
        {err && <div className="banner danger full">{err}</div>}
        <Field label="Vendor" className="full"><Input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} data-autofocus /></Field>
        <Field label="Category"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Expense['category'] })}>{['marketing', 'ai_usage', 'telephony', 'software', 'operations'].map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}</Select></Field>
        <Field label={`Amount (${currencySymbol()})`}><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, '') })} inputMode="numeric" /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Expense['status'] })}><option value="pending">Pending</option><option value="paid">Paid</option></Select></Field>
      </div>
    </Modal>
  );
}
