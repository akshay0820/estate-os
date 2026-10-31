import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Compass, PlugZap } from 'lucide-react';
import { Shell } from '@/layout/Shell';
import { AuthGate } from '@/layout/AuthGate';
import { LIVE, useStore } from '@/store/store';
import { regionKey } from '@/store/regionSync';
import { NAV_FLAT } from '@/layout/nav';
import { ConfirmHost, Toaster } from '@/components/dialogs';
import { Button, Empty } from '@/components/ui';
import { NoAccess } from '@/features/shared';
import { useMe } from '@/store/hooks';
import { can } from '@/lib/permissions';
import { navigate, useRoute } from '@/lib/router';

type Page = ComponentType<{ params: URLSearchParams }>;

// Each page's code loads on first visit; once the app is idle every page is fetched in the background, so moving
// between pages is instant. The promise is shared, so a page is never downloaded twice.
const pageLoaders: (() => Promise<unknown>)[] = [];
const lazyPage = (load: () => Promise<Record<string, unknown>>, name: string) => {
  let loading: Promise<{ default: Page }> | null = null;
  const get = () => (loading ??= load().then((m) => ({ default: m[name] as Page })));
  pageLoaders.push(get);
  return lazy(get);
};

function preloadPages() {
  const run = () => pageLoaders.forEach((get) => void get().catch(() => undefined));
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 4000 });
  else setTimeout(run, 2000);
}

const PAGES: Record<string, Page> = {
  dashboard: lazyPage(() => import('@/features/dashboard'), 'Dashboard'),
  sales: lazyPage(() => import('@/features/salesIntelligence'), 'SalesIntelligencePage'),
  activity: lazyPage(() => import('@/features/activity'), 'ActivityPage'),
  leads: lazyPage(() => import('@/features/leads'), 'LeadsPage'),
  contacts: lazyPage(() => import('@/features/contacts'), 'ContactsPage'),
  properties: lazyPage(() => import('@/features/properties'), 'PropertiesPage'),
  deals: lazyPage(() => import('@/features/deals'), 'DealsPage'),
  appointments: lazyPage(() => import('@/features/appointments'), 'AppointmentsPage'),
  tasks: lazyPage(() => import('@/features/tasks'), 'TasksPage'),
  inbox: lazyPage(() => import('@/features/inbox'), 'InboxPage'),
  calls: lazyPage(() => import('@/features/calls'), 'CallsPage'),
  followups: lazyPage(() => import('@/features/followups'), 'FollowUpsPage'),
  pilot: lazyPage(() => import('@/features/pilot'), 'PilotPage'),
  agents: lazyPage(() => import('@/features/agents'), 'AgentsPage'),
  automations: lazyPage(() => import('@/features/automations'), 'AutomationsPage'),
  workflows: lazyPage(() => import('@/features/workflows'), 'WorkflowsPage'),
  approvals: lazyPage(() => import('@/features/approvals'), 'ApprovalsPage'),
  dataquality: lazyPage(() => import('@/features/dataQuality'), 'DataQualityPage'),
  logs: lazyPage(() => import('@/features/logs'), 'LogsPage'),
  team: lazyPage(() => import('@/features/team'), 'TeamPage'),
  finance: lazyPage(() => import('@/features/finance'), 'FinancePage'),
  reports: lazyPage(() => import('@/features/reports'), 'ReportsPage'),
  documents: lazyPage(() => import('@/features/documents'), 'DocumentsPage'),
  integrations: lazyPage(() => import('@/features/integrations'), 'IntegrationsPage'),
  audit: lazyPage(() => import('@/features/audit'), 'AuditPage'),
  settings: lazyPage(() => import('@/features/settings'), 'SettingsPage'),
};

// Pages whose data depends on providers or engines that are not built yet. In live mode they say so
// instead of showing sample data; demo mode keeps the illustrative versions.
const NOT_CONNECTED: Record<string, string> = {
  inbox: 'Messaging needs an approved WhatsApp/SMS/email provider and the consent-gated send pipeline.',
  workflows: 'The workflow engine (durable jobs, retries, exit rules) is the next milestone.',
  approvals: 'Approvals arrive with AI agents and workflows; nothing requests approval yet.',
  logs: 'Execution logs record agent and workflow runs, which start in the next milestone.',
};

export default function App() {
  useEffect(preloadPages, []);
  return (
    <>
      <AuthGate>
        <Routed />
      </AuthGate>
      <Toaster />
      <ConfirmHost />
    </>
  );
}

function Routed() {
  const { page, params } = useRoute();
  const me = useMe();
  const nav = NAV_FLAT.find((n) => n.key === page);
  const Page = PAGES[page];
  const region = useStore(regionKey);
  const allowed = !nav?.cap || can(me.role, nav.cap);

  return (
    <>
      <Shell page={page}>
        <Suspense fallback={<PageSkeleton />}>
          {!Page ? (
            <div className="card" style={{ marginTop: 40 }}>
              <Empty icon={<Compass size={20} />} title="Page not found" description="That address doesn't match anything in Estate OS." action={<Button onClick={() => navigate('dashboard')}>Back to dashboard</Button>} />
            </div>
          ) : !allowed ? (
            <NoAccess what={nav?.label.toLowerCase()} />
          ) : LIVE && NOT_CONNECTED[page] ? (
            <NotConnected title={nav?.label ?? page} reason={NOT_CONNECTED[page]} />
          ) : (
            <Page key={`${page}:${region}`} params={params} />
          )}
        </Suspense>
      </Shell>
    </>
  );
}

function NotConnected({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">[ Not connected yet ]</div>
          <h1 className="page-title">{title}</h1>
        </div>
      </div>
      <div className="card">
        <Empty icon={<PlugZap size={20} />} title="This area isn’t connected to live data yet" description={reason} action={<Button onClick={() => navigate('dashboard')}>Back to dashboard</Button>} />
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="page" aria-busy="true">
      <div className="skeleton" style={{ height: 14, width: 120, marginTop: 20 }} />
      <div className="skeleton" style={{ height: 32, width: 280, marginTop: 10 }} />
      <div className="grid g-kpi mt-24">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 118, borderRadius: 16 }} />
        ))}
      </div>
      <div className="skeleton mt-16" style={{ height: 320, borderRadius: 16 }} />
    </div>
  );
}
