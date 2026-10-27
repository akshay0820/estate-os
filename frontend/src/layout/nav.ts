import {
  Activity,
  BadgeIndianRupee,
  Bot,
  Building2,
  CalendarDays,
  CheckSquare,
  ClipboardCheck,
  DatabaseZap,
  FileText,
  Handshake,
  Inbox,
  LayoutDashboard,
  PhoneCall,
  Plug,
  Repeat,
  Settings,
  ShieldCheck,
  SquareTerminal,
  UserRound,
  Users,
  UsersRound,
  Workflow,
  Gauge,
  BarChart3,
  LineChart,
  type LucideIcon,
} from 'lucide-react';
import type { Capability } from '@/lib/permissions';

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  cap?: Capability;
}

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { key: 'sales', label: 'Sales intelligence', icon: LineChart, cap: 'reports.view' },
      { key: 'activity', label: 'Activity feed', icon: Activity, cap: 'leads.view' },
    ],
  },
  {
    section: 'Sales',
    items: [
      { key: 'leads', label: 'Leads', icon: UserRound, cap: 'leads.view' },
      { key: 'contacts', label: 'Contacts', icon: Users, cap: 'leads.view' },
      { key: 'properties', label: 'Properties', icon: Building2, cap: 'leads.view' },
      { key: 'deals', label: 'Deals', icon: Handshake, cap: 'leads.view' },
      { key: 'appointments', label: 'Appointments', icon: CalendarDays, cap: 'leads.view' },
      { key: 'tasks', label: 'Tasks', icon: CheckSquare, cap: 'leads.view' },
    ],
  },
  {
    section: 'Communications',
    items: [
      { key: 'inbox', label: 'Unified inbox', icon: Inbox, cap: 'inbox.reply' },
      { key: 'calls', label: 'Calls', icon: PhoneCall, cap: 'calls.place' },
      { key: 'followups', label: 'Follow-ups', icon: Repeat, cap: 'inbox.reply' },
    ],
  },
  {
    section: 'AI operations',
    items: [
      { key: 'pilot', label: 'Pilot operations', icon: Gauge, cap: 'logs.view' },
      { key: 'agents', label: 'AI agents', icon: Bot, cap: 'logs.view' },
      { key: 'workflows', label: 'Workflows', icon: Workflow, cap: 'logs.view' },
      { key: 'approvals', label: 'Approvals', icon: ClipboardCheck, cap: 'approvals.decide' },
      { key: 'dataquality', label: 'Data quality', icon: DatabaseZap, cap: 'leads.view' },
      { key: 'logs', label: 'Execution logs', icon: SquareTerminal, cap: 'logs.view' },
    ],
  },
  {
    section: 'Business',
    items: [
      { key: 'team', label: 'Team', icon: UsersRound, cap: 'team.view' },
      { key: 'finance', label: 'Finance', icon: BadgeIndianRupee, cap: 'finance.view' },
      { key: 'reports', label: 'Reports', icon: BarChart3, cap: 'reports.view' },
    ],
  },
  {
    section: 'Administration',
    items: [
      { key: 'documents', label: 'Documents', icon: FileText, cap: 'documents.edit' },
      { key: 'integrations', label: 'Integrations', icon: Plug, cap: 'integrations.manage' },
      { key: 'audit', label: 'Audit logs', icon: ShieldCheck, cap: 'audit.view' },
      { key: 'settings', label: 'Settings', icon: Settings, cap: 'settings.manage' },
    ],
  },
];

export const NAV_FLAT = NAV.flatMap((s) => s.items.map((i) => ({ ...i, section: s.section })));

export const PAGE_TITLE: Record<string, string> = Object.fromEntries(NAV_FLAT.map((i) => [i.key, i.label]));
