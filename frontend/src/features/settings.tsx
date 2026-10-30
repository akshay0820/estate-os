import { useEffect, useState } from 'react';
import { Bell, Building, Clock, Database, Moon, OctagonPause, Palette, RotateCcw, Route, Sun, Timer } from 'lucide-react';
import { Button, Card, Field, Input, PageHeader, Segmented, Select, Switch } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { LIVE, actions, ok } from '@/data/actions';
import { useCan, useOrg } from '@/store/hooks';
import { toast, useUi } from '@/store/ui';
import { LEAD_STATUS } from '@/lib/domain';
import { navigate } from '@/lib/router';
import type { Organization } from '@/store/types';

const CURRENCIES: [string, string][] = [['USD', 'US Dollar'], ['CAD', 'Canadian Dollar'], ['GBP', 'British Pound'], ['EUR', 'Euro'], ['AED', 'UAE Dirham'], ['INR', 'Indian Rupee']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PREF_KEY = 'estate-os:notification-prefs';
const PREFS = [
  { key: 'assigned', label: 'A lead is assigned to me' },
  { key: 'appt', label: 'Appointment booked, moved or cancelled' },
  { key: 'approval', label: 'An approval needs my decision' },
  { key: 'failure', label: 'Workflow or integration failures' },
  { key: 'digest', label: 'Daily summary at 8:00 am' },
];

export function SettingsPage() {
  const org = useOrg();
  const canManage = useCan('settings.manage');
  const [saving, setSaving] = useState(false);
  const reset = useStore((s) => s.resetDemo);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const [f, setF] = useState<Organization>(org);
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY) ?? '') as Record<string, boolean>;
    } catch {
      return { assigned: true, appt: true, approval: true, failure: true, digest: false };
    }
  });
  useEffect(() => setF(org), [org]);
  const dirty = JSON.stringify(f) !== JSON.stringify(org);
  const hoursOk = f.businessHours.start < f.businessHours.end && f.callingHours.start < f.callingHours.end;

  const save = async () => {
    if (!f.name.trim()) return toast({ kind: 'error', title: 'Organization name is required' });
    if (!hoursOk) return toast({ kind: 'error', title: 'Check the hours', body: 'Start must be before end.' });
    setSaving(true);
    const done = await ok(() => actions.updateOrg(org, { name: f.name.trim(), timezone: f.timezone, currency: f.currency, businessHours: f.businessHours, callingHours: f.callingHours, slaMinutes: f.slaMinutes, assignment: f.assignment, leadStages: f.leadStages }));
    setSaving(false);
    if (!done) return;
    toast({ kind: 'success', title: 'Settings saved', body: 'Workflows pick up the new rules on their next step.' });
  };

  const hourOptions = Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'am' : 'pm'}`}</option>);
  const optional = ['matching', 'visit_completed', 'nurture'] as const;

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <PageHeader
        eyebrow="[ Organization ]"
        title="Settings"
        sub="Rules that automations and people both follow. Changes are versioned in the audit log."
        actions={canManage && <><Button disabled={!dirty} onClick={() => setF(org)}>Discard</Button><Button variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>Save changes</Button></>}
      />
      <div className="stack stack-lg">
        <Card title="Organization" icon={<Building size={14} />}>
          <div className="form-grid">
            <Field label="Name"><Input value={f.name} disabled={!canManage} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Time zone" hint="All dates and SLA timers use this zone">
              <Select value={f.timezone} disabled={!canManage} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
                {['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London'].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Currency" hint="Used for every budget, price and deal. Changing it does not convert amounts already saved.">
              <Select value={f.currency} disabled={!canManage} onChange={(e) => setF({ ...f, currency: e.target.value })}>
                {CURRENCIES.map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
              </Select>
            </Field>
            <Field label="Workspace ID"><Input value={f.slug} disabled /></Field>
          </div>
        </Card>

        <Card title="Hours & response targets" icon={<Clock size={14} />}>
          <div className="form-grid">
            <Field label="Business hours" hint="Appointments can only be booked inside these hours">
              <div className="row">
                <Select value={f.businessHours.start} disabled={!canManage} onChange={(e) => setF({ ...f, businessHours: { ...f.businessHours, start: Number(e.target.value) } })}>{hourOptions}</Select>
                <span className="faint">to</span>
                <Select value={f.businessHours.end} disabled={!canManage} onChange={(e) => setF({ ...f, businessHours: { ...f.businessHours, end: Number(e.target.value) } })}>{hourOptions}</Select>
              </div>
            </Field>
            <Field label="Outbound calling window" hint="Calls outside this window are blocked, not queued silently" error={!hoursOk ? 'Start must be before end' : null}>
              <div className="row">
                <Select value={f.callingHours.start} disabled={!canManage} onChange={(e) => setF({ ...f, callingHours: { ...f.callingHours, start: Number(e.target.value) } })}>{hourOptions}</Select>
                <span className="faint">to</span>
                <Select value={f.callingHours.end} disabled={!canManage} onChange={(e) => setF({ ...f, callingHours: { ...f.callingHours, end: Number(e.target.value) } })}>{hourOptions}</Select>
              </div>
            </Field>
            <Field label="Working days" className="full">
              <div className="row wrap" style={{ gap: 6 }}>
                {DAYS.map((d, i) => {
                  const on = f.businessHours.days.includes(i);
                  return <button key={d} className={`tool-chip ${on ? 'on' : ''}`} disabled={!canManage} aria-pressed={on} onClick={() => setF({ ...f, businessHours: { ...f.businessHours, days: on ? f.businessHours.days.filter((x) => x !== i) : [...f.businessHours.days, i].sort() } })}>{d}</button>;
                })}
              </div>
            </Field>
            <Field label={<><Timer size={13} /> First-response SLA</>} hint="Escalates to the manager when breached">
              <Select value={f.slaMinutes} disabled={!canManage} onChange={(e) => setF({ ...f, slaMinutes: Number(e.target.value) })}>
                {[2, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </Select>
            </Field>
            <Field label={<><Route size={13} /> Lead assignment</>} hint="Applied to every new lead unless an owner is picked">
              <Select value={f.assignment} disabled={!canManage} onChange={(e) => setF({ ...f, assignment: e.target.value as Organization['assignment'] })}>
                <option value="by_locality">By locality, then least loaded</option>
                <option value="least_loaded">Least loaded</option>
                <option value="round_robin">Round robin</option>
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="Lead pipeline" sub="Core stages are fixed; optional stages can be switched off for simpler teams.">
          <div className="row wrap" style={{ gap: 6 }}>
            {(Object.keys(LEAD_STATUS) as (keyof typeof LEAD_STATUS)[]).map((s) => {
              const isOptional = (optional as readonly string[]).includes(s);
              const on = f.leadStages.includes(s);
              return (
                <button key={s} className={`tool-chip ${on ? 'on' : ''}`} disabled={!canManage || !isOptional || LIVE} aria-pressed={on} title={isOptional ? 'Optional stage' : 'Required stage'} onClick={() => setF({ ...f, leadStages: on ? f.leadStages.filter((x) => x !== s) : [...f.leadStages, s] })}>
                  {LEAD_STATUS[s].label}
                </button>
              );
            })}
          </div>
        </Card>

        <Card title="Outbound safety" icon={<OctagonPause size={14} />}>
          <div className="switch-row">
            <div className="grow"><b>Pause all outbound communication</b><div className="faint" style={{ fontSize: 12.5 }}>Kill switch for every AI and workflow call or message in this organization.</div></div>
            <Switch on={org.outboundPaused} danger disabled={!canManage} label="Pause all outbound" onChange={async (v) => {
              if (v) { const r = await confirm({ title: 'Pause all outbound?', confirmLabel: 'Pause', danger: true }); if (!r.ok) return; }
              if (!(await ok(() => actions.setOutboundPaused(org, v)))) return;
              toast({ kind: v ? 'warning' : 'success', title: v ? 'Outbound paused' : 'Outbound resumed' });
            }} />
          </div>
          <div className="switch-row">
            <div className="grow"><b>Identify AI in every conversation</b><div className="faint" style={{ fontSize: 12.5 }}>Agents introduce themselves as an AI assistant and offer a person.</div></div>
            <Switch on disabled label="Identify AI" onChange={() => undefined} />
          </div>
          <div className="row"><Button size="sm" onClick={() => navigate('agents')}>Manage agents</Button></div>
        </Card>

        <Card title="Appearance" icon={<Palette size={14} />}>
          <div className="switch-row">
            <div className="grow"><b>Theme</b><div className="faint" style={{ fontSize: 12.5 }}>Saved on this device.</div></div>
            <Segmented value={theme} onChange={(v) => v !== theme && toggleTheme()} options={[{ value: 'light', label: <><Sun size={13} /> Light</> }, { value: 'dark', label: <><Moon size={13} /> Dark</> }]} />
          </div>
        </Card>

        <Card title="My notifications" icon={<Bell size={14} />} sub="Personal preference, applies only to you">
          {PREFS.map((p) => (
            <div key={p.key} className="switch-row">
              <span className="grow">{p.label}</span>
              <Switch on={!!prefs[p.key]} label={p.label} onChange={(v) => {
                const next = { ...prefs, [p.key]: v };
                setPrefs(next);
                try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch { /* ignore */ }
                toast({ kind: 'success', title: 'Preference saved' });
              }} />
            </div>
          ))}
        </Card>

        {!LIVE && <Card title="Data & privacy" icon={<Database size={14} />}>
          <div className="form-grid">
            <Field label="Call recordings kept for"><Select defaultValue="90" disabled={!canManage} onChange={() => toast({ kind: 'success', title: 'Retention updated', body: 'Applies to new recordings; existing ones follow the old schedule.' })}><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option></Select></Field>
            <Field label="Message history kept for"><Select defaultValue="730" disabled={!canManage} onChange={() => toast({ kind: 'success', title: 'Retention updated' })}><option value="365">1 year</option><option value="730">2 years</option><option value="1825">5 years</option></Select></Field>
          </div>
          <div className="row mt-16" style={{ gap: 8 }}>
            <Button disabled={!canManage} onClick={async () => {
              const r = await confirm({ title: 'Request full data export?', body: 'Exports are generated by a background job, require a second approver and produce a link that expires in 24 hours.', confirmLabel: 'Request export' });
              if (r.ok) {
                const s = useStore.getState();
                const rows = s.leads.filter((l) => l.orgId === s.session.orgId).length;
                useStore.setState({ approvals: [{ id: `apr_${Date.now()}`, orgId: s.session.orgId, action: 'bulk_export', summary: `Full workspace export (${rows} leads + related records)`, risk: 'critical', requestedBy: { type: 'user', name: s.me().name }, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 864e5, decidedBy: null, decidedAt: null, note: null, payload: { kind: 'bulk_export', entity: 'leads', rows } }, ...s.approvals] });
                s.log('export.requested', 'organization', s.session.orgId, 'full workspace');
                toast({ kind: 'info', title: 'Export requested', body: 'Waiting for a second approver in Approvals.', action: { label: 'Open', run: () => navigate('approvals') } });
              }
            }}>Request data export</Button>
          </div>
        </Card>}

        {!LIVE && <Card title="Demo data">
          <div className="row">
            <span className="grow faint" style={{ fontSize: 13 }}>Everything here runs in your browser. Reset to regenerate fresh sample data for both workspaces.</span>
            <Button variant="danger" icon={<RotateCcw size={14} />} onClick={async () => {
              const r = await confirm({ title: 'Reset all demo data?', body: 'Your changes in this browser are discarded.', confirmLabel: 'Reset', danger: true, typeToConfirm: 'RESET' });
              if (r.ok) { reset(); navigate('dashboard'); toast({ kind: 'success', title: 'Demo data reset' }); }
            }}>Reset</Button>
          </div>
        </Card>}
      </div>
    </div>
  );
}
