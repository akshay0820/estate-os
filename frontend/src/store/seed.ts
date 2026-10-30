import { DAY, HOUR, MIN, startOfDay } from '@/lib/format';
import { missingFields, scoreLead } from '@/lib/domain';
import { between, correlationId, intBetween, mulberry32, pick, pickWeighted, sample, type Rand } from '@/lib/util';
import type {
  Activity,
  Agent,
  Appointment,
  Approval,
  AuditLog,
  Call,
  Channel,
  Commission,
  Contact,
  Conversation,
  Deal,
  DealStage,
  DocumentRec,
  Expense,
  FollowUp,
  Integration,
  Lead,
  LeadStatus,
  LeadType,
  MarketingSource,
  Member,
  Message,
  Notification,
  Organization,
  Property,
  PropertyType,
  Run,
  RunStep,
  Task,
  UsageRecord,
  WebhookEvent,
  Workflow,
} from './types';

export interface OrgData {
  members: Member[];
  contacts: Contact[];
  leads: Lead[];
  properties: Property[];
  deals: Deal[];
  appointments: Appointment[];
  tasks: Task[];
  conversations: Conversation[];
  calls: Call[];
  agents: Agent[];
  workflows: Workflow[];
  runs: Run[];
  approvals: Approval[];
  followUps: FollowUp[];
  integrations: Integration[];
  webhookEvents: WebhookEvent[];
  usage: UsageRecord[];
  commissions: Commission[];
  expenses: Expense[];
  documents: DocumentRec[];
  audit: AuditLog[];
  activities: Activity[];
  notifications: Notification[];
  sources: MarketingSource[];
}

export const PROPERTY_IMAGES = [
  'photo-1600596542815-ffad4c1539a9',
  'photo-1600585154340-be6161a56a0c',
  'photo-1512917774080-9991f1c4c750',
  'photo-1502672260266-1c1ef2d93688',
  'photo-1522708323590-d24dbb6b0267',
  'photo-1560448204-e02f11c3d0e2',
  'photo-1493809842364-78817add7ffb',
  'photo-1545324418-cc1a3fa10c00',
  'photo-1515263487990-61b07816b324',
  'photo-1486406146926-c627a92ad1ab',
  'photo-1580587771525-78b9dba3b914',
  'photo-1613490493576-7fde63acd811',
  'photo-1600607687939-ce8a6c25118c',
  'photo-1484154218962-a197022b5858',
];

// Indexes into PROPERTY_IMAGES, grouped so a listing's photo matches its type.
const IMAGE_BY_TYPE: Record<PropertyType, number[]> = {
  apartment: [3, 4, 5, 6, 12, 13, 8],
  penthouse: [3, 5, 6, 12, 7],
  villa: [0, 1, 2, 10, 11],
  plot: [1, 10],
  office: [9, 7],
  retail: [9, 8],
};

export const AMENITIES = ['Parking', 'Gym', 'Pool', 'Sea view', 'Clubhouse', 'Security', 'Power backup', 'Pet friendly', 'Balcony', 'Lift'];

const FIRST = [
  'Aarav', 'Vihaan', 'Ishaan', 'Reyansh', 'Advait', 'Ananya', 'Diya', 'Saanvi', 'Aditi', 'Kiara',
  'Rahul', 'Nikhil', 'Siddharth', 'Karan', 'Varun', 'Pooja', 'Sneha', 'Riya', 'Tanvi', 'Nisha',
  'Farhan', 'Zoya', 'Imran', 'Ayesha', 'Daniel', 'Sarah', 'Cyrus', 'Zara', 'Manish', 'Deepa',
  'Harsh', 'Kavya', 'Yash', 'Shreya', 'Aman', 'Natasha', 'Rohit', 'Lakshmi', 'Gautam', 'Ira',
];
const LAST = [
  'Sharma', 'Verma', 'Patel', 'Gupta', 'Malhotra', 'Bhatia', 'Khanna', 'Reddy', 'Pillai', 'Menon',
  'Joshi', 'Kulkarni', 'Deshpande', 'Agarwal', 'Chopra', 'Sethi', 'Fernandes', 'D’Souza', 'Khan', 'Shaikh',
  'Iyer', 'Rao', 'Banerjee', 'Mukherjee', 'Sinha', 'Bajaj', 'Thakur', 'Wadia', 'Mistry', 'Kapadia',
];

interface OrgConfig {
  org: Organization;
  seed: number;
  scale: number;
  domain: string;
  localities: { name: string; psf: number; rentPsf: number }[];
  team: Omit<Member, 'orgId' | 'joinedAt' | 'id'>[];
  projects: string[];
}

export const ORG_CONFIGS: OrgConfig[] = [
  {
    seed: 7,
    scale: 1,
    domain: 'skylinerealty.in',
    org: {
      id: 'org_skyline',
      name: 'Skyline Realty',
      slug: 'skyline-realty',
      city: 'Mumbai',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      country: 'IN',
      businessHours: { start: 9, end: 20, days: [1, 2, 3, 4, 5, 6] },
      callingHours: { start: 9, end: 21 },
      outboundPaused: false,
      leadStages: ['new', 'attempting', 'contacted', 'qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won', 'lost', 'nurture'],
      assignment: 'by_locality',
      slaMinutes: 5,
      webhookSecretVersion: 3,
    },
    localities: [
      { name: 'Bandra West', psf: 52000, rentPsf: 110 },
      { name: 'Juhu', psf: 48000, rentPsf: 100 },
      { name: 'Worli', psf: 58000, rentPsf: 120 },
      { name: 'Lower Parel', psf: 44000, rentPsf: 95 },
      { name: 'Powai', psf: 27000, rentPsf: 62 },
      { name: 'Andheri West', psf: 29000, rentPsf: 70 },
      { name: 'Goregaon East', psf: 21000, rentPsf: 52 },
      { name: 'Chembur', psf: 24000, rentPsf: 55 },
      { name: 'Thane West', psf: 15000, rentPsf: 38 },
      { name: 'Vashi', psf: 16000, rentPsf: 40 },
    ],
    projects: ['Oberoi Sky City', 'Lodha Park', 'Hiranandani Gardens', 'Rustomjee Seasons', 'Kalpataru Radiance', 'Godrej Platinum', 'Runwal Greens', 'Raheja Vivarea', 'Sunteck City', 'Piramal Aranya', 'Ekta Tripolis', 'Shapoorji Vicinia'],
    team: [
      { name: 'Aanya Kapoor', email: 'aanya@skylinerealty.in', phone: '+919820011122', role: 'owner', title: 'Founder & Principal Broker', status: 'active', hue: 22, localities: [] },
      { name: 'Rohan Mehta', email: 'rohan@skylinerealty.in', phone: '+919820011123', role: 'admin', title: 'Head of Operations', status: 'active', hue: 200, localities: [] },
      { name: 'Priya Nair', email: 'priya@skylinerealty.in', phone: '+919820011124', role: 'manager', title: 'Sales Manager', status: 'active', hue: 40, localities: [] },
      { name: 'Kabir Shah', email: 'kabir@skylinerealty.in', phone: '+919820011125', role: 'agent', title: 'Senior Consultant', status: 'active', hue: 150, localities: ['Bandra West', 'Juhu', 'Andheri West'] },
      { name: 'Meera Iyer', email: 'meera@skylinerealty.in', phone: '+919820011126', role: 'agent', title: 'Property Consultant', status: 'active', hue: 330, localities: ['Powai', 'Goregaon East', 'Chembur'] },
      { name: 'Arjun Desai', email: 'arjun@skylinerealty.in', phone: '+919820011127', role: 'agent', title: 'Luxury Specialist', status: 'active', hue: 260, localities: ['Worli', 'Lower Parel'] },
      { name: 'Sana Qureshi', email: 'sana@skylinerealty.in', phone: '+919820011128', role: 'agent', title: 'Property Consultant', status: 'active', hue: 180, localities: ['Thane West', 'Vashi'] },
      { name: 'Vikram Rao', email: 'vikram@skylinerealty.in', phone: '+919820011129', role: 'finance', title: 'Finance Controller', status: 'active', hue: 90, localities: [] },
      { name: 'Neha Joshi', email: 'neha.joshi@gmail.com', phone: '', role: 'agent', title: 'Property Consultant', status: 'invited', hue: 300, localities: [] },
    ],
  },
  {
    seed: 19,
    scale: 0.3,
    domain: 'harborhomes.in',
    org: {
      id: 'org_harbor',
      name: 'Harbor Homes',
      slug: 'harbor-homes',
      city: 'Pune',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      country: 'IN',
      businessHours: { start: 10, end: 19, days: [1, 2, 3, 4, 5, 6] },
      callingHours: { start: 10, end: 20 },
      outboundPaused: false,
      leadStages: ['new', 'attempting', 'contacted', 'qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won', 'lost', 'nurture'],
      assignment: 'round_robin',
      slaMinutes: 10,
      webhookSecretVersion: 1,
    },
    localities: [
      { name: 'Koregaon Park', psf: 16000, rentPsf: 45 },
      { name: 'Baner', psf: 11000, rentPsf: 32 },
      { name: 'Kharadi', psf: 10000, rentPsf: 30 },
      { name: 'Hinjewadi', psf: 8000, rentPsf: 25 },
      { name: 'Aundh', psf: 12500, rentPsf: 34 },
    ],
    projects: ['Panchshil Towers', 'Kolte Patil Life Republic', 'Godrej Infinity', 'Amanora Park', 'VTP Blue Waters'],
    team: [
      { name: 'Aanya Kapoor', email: 'aanya@skylinerealty.in', phone: '+919820011122', role: 'admin', title: 'Partner (shared workspace)', status: 'active', hue: 22, localities: [] },
      { name: 'Omkar Patil', email: 'omkar@harborhomes.in', phone: '+919850022211', role: 'owner', title: 'Managing Director', status: 'active', hue: 210, localities: [] },
      { name: 'Ritika Sawant', email: 'ritika@harborhomes.in', phone: '+919850022212', role: 'agent', title: 'Consultant', status: 'active', hue: 340, localities: ['Koregaon Park', 'Aundh'] },
      { name: 'Tejas Gokhale', email: 'tejas@harborhomes.in', phone: '+919850022213', role: 'agent', title: 'Consultant', status: 'active', hue: 120, localities: ['Baner', 'Hinjewadi', 'Kharadi'] },
    ],
  },
];

const SOURCES: [string, number][] = [
  ['99acres', 22],
  ['MagicBricks', 16],
  ['Housing.com', 12],
  ['Meta Ads', 18],
  ['Google Ads', 12],
  ['Website form', 10],
  ['Referral', 7],
  ['Walk-in', 3],
];

const SOURCE_META: Record<string, { kind: MarketingSource['kind']; spend: number }> = {
  '99acres': { kind: 'portal', spend: 85000 },
  MagicBricks: { kind: 'portal', spend: 65000 },
  'Housing.com': { kind: 'portal', spend: 48000 },
  'Meta Ads': { kind: 'ads', spend: 120000 },
  'Google Ads': { kind: 'ads', spend: 90000 },
  'Website form': { kind: 'website', spend: 15000 },
  Referral: { kind: 'referral', spend: 0 },
  'Walk-in': { kind: 'offline', spend: 0 },
};

const CAMPAIGNS: Record<string, string[]> = {
  'Meta Ads': ['Diwali Homes ’26', 'Powai 2BHK Lookalike', 'Luxury Sea-view Retarget'],
  'Google Ads': ['Brand Search', '“flats in mumbai” Generic', 'Rental Intent'],
  '99acres': ['Featured Listing'],
  MagicBricks: ['Premium Slot'],
};

function personName(rand: Rand) {
  return `${pick(rand, FIRST)} ${pick(rand, LAST)}`;
}

function phoneFor(rand: Rand) {
  return `+91${pick(rand, ['98', '99', '97', '90', '88', '70', '77'])}${String(intBetween(rand, 10000000, 99999999))}`;
}

function emailFor(name: string, rand: Rand) {
  const [f, l] = name.toLowerCase().replace(/[’']/g, '').split(' ');
  return `${f}${pick(rand, ['.', '', '_'])}${l}${rand() < 0.3 ? intBetween(rand, 1, 99) : ''}@${pick(rand, ['gmail.com', 'gmail.com', 'outlook.com', 'yahoo.co.in', 'icloud.com'])}`;
}

/** Age-aware status: older leads are more likely to have reached a terminal stage. */
function statusForAge(rand: Rand, ageDays: number): LeadStatus {
  if (ageDays < 1) return pickWeighted(rand, [['new', 6], ['attempting', 3], ['contacted', 2], ['qualified', 1]]);
  if (ageDays < 7)
    return pickWeighted(rand, [['attempting', 2], ['contacted', 4], ['qualified', 4], ['matching', 3], ['visit_scheduled', 3], ['lost', 1], ['nurture', 1]]);
  if (ageDays < 45)
    return pickWeighted(rand, [['contacted', 1], ['qualified', 3], ['matching', 2], ['visit_scheduled', 2], ['visit_completed', 3], ['negotiation', 2], ['won', 2], ['lost', 4], ['nurture', 3]]);
  if (ageDays < 120)
    return pickWeighted(rand, [['qualified', 1], ['visit_completed', 2], ['negotiation', 1], ['won', 3], ['lost', 6], ['nurture', 4]]);
  return pickWeighted(rand, [['qualified', 0.5], ['won', 3], ['lost', 8], ['nurture', 5]]);
}

const PROGRESSED: LeadStatus[] = ['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];

export function generateOrg(cfg: OrgConfig, now: number): OrgData {
  const rand = mulberry32(cfg.seed);
  const orgId = cfg.org.id;
  const today = startOfDay(now);
  let n = 0;
  const id = (p: string) => `${p}_${cfg.seed}_${(n++).toString(36)}`;

  /* Members */
  const members: Member[] = cfg.team.map((t, i) => ({
    ...t,
    id: i === 0 && orgId === 'org_skyline' ? 'mem_me' : t.email === 'aanya@skylinerealty.in' ? 'mem_me_h' : id('mem'),
    orgId,
    joinedAt: now - (900 - i * 70) * DAY,
  }));
  const agentsTeam = members.filter((m) => m.role === 'agent' && m.status === 'active');
  const assignFor = (locality: string | undefined) => {
    const match = agentsTeam.find((m) => locality && m.localities.includes(locality));
    return (match ?? pick(rand, agentsTeam)).id;
  };
  const memberName = (mid: string | null) => members.find((m) => m.id === mid)?.name ?? 'Unassigned';

  /* Properties */
  const properties: Property[] = [];
  const propCount = Math.round(48 * cfg.scale) + 6;
  for (let i = 0; i < propCount; i++) {
    const loc = pick(rand, cfg.localities);
    const listing: Property['listing'] = rand() < 0.72 ? 'sale' : 'rent';
    const type: PropertyType = pickWeighted(rand, [['apartment', 14], ['penthouse', 2], ['villa', 2], ['office', 2], ['retail', 1], ['plot', 1]]);
    const bedrooms = ['office', 'retail', 'plot'].includes(type) ? 0 : type === 'penthouse' ? intBetween(rand, 4, 5) : type === 'villa' ? intBetween(rand, 3, 5) : pickWeighted(rand, [[1, 3], [2, 6], [3, 4], [4, 1]]);
    const area = type === 'plot' ? intBetween(rand, 2000, 6000) : bedrooms ? Math.round((bedrooms * between(rand, 330, 520) + 150) / 10) * 10 : intBetween(rand, 600, 2400);
    const price = listing === 'sale' ? Math.round((area * loc.psf * between(rand, 0.9, 1.15)) / 1e5) * 1e5 : Math.round((area * loc.rentPsf * between(rand, 0.9, 1.15)) / 1000) * 1000;
    const project = pick(rand, cfg.projects);
    const createdAt = now - intBetween(rand, 5, 320) * DAY;
    const status: Property['status'] = pickWeighted(rand, [['active', 14], ['under_offer', 2], ['reserved', 1], [listing === 'sale' ? 'sold' : 'let', 2], ['draft', 1]]);
    const verifiedAgo = pickWeighted(rand, [[intBetween(rand, 1, 12), 6], [intBetween(rand, 13, 28), 3], [intBetween(rand, 35, 90), 2]]);
    const verified = rand() > 0.08;
    const title =
      type === 'office' ? `Grade A office, ${project}` :
      type === 'retail' ? `High-street retail, ${loc.name}` :
      type === 'plot' ? `Residential plot, ${loc.name}` :
      `${bedrooms} BHK ${type === 'apartment' ? '' : type + ' '}at ${project}`.replace('  ', ' ');
    properties.push({
      id: id('prop'),
      orgId,
      ref: `${cfg.org.slug.slice(0, 2).toUpperCase()}-${String(1040 + i)}`,
      title,
      description: `${title} in ${loc.name}. ${area.toLocaleString('en-IN')} sq ft carpet, ${pick(rand, ['east-facing', 'west-facing', 'corner unit', 'high floor', 'garden-facing'])}, ${pick(rand, ['newly renovated', 'ready to move', 'possession in 2027', 'well maintained'])}.`,
      listing,
      type,
      status,
      price,
      bedrooms,
      bathrooms: bedrooms ? Math.max(1, bedrooms - (rand() < 0.4 ? 1 : 0)) : 1,
      area,
      locality: loc.name,
      city: cfg.org.city,
      amenities: sample(rand, AMENITIES, intBetween(rand, 2, 6)),
      furnishing: pick(rand, ['unfurnished', 'semi', 'full'] as const),
      verified,
      verifiedAt: verified ? now - verifiedAgo * DAY : null,
      agentId: assignFor(loc.name),
      ownerContactId: null,
      image: pick(rand, IMAGE_BY_TYPE[type]),
      createdAt,
      updatedAt: createdAt + intBetween(rand, 0, 30) * DAY,
    });
  }

  /* Contacts + leads */
  const contacts: Contact[] = [];
  const leads: Lead[] = [];
  const activities: Activity[] = [];
  const leadCount = Math.round(520 * cfg.scale);
  const sys = { type: 'system' as const, name: 'System' };
  const qualAgentName = 'AI Voice Calling Agent';

  for (let i = 0; i < leadCount; i++) {
    // Density grows toward the present, so recent periods trend upward.
    // A handful arrive today; overall density grows gently toward the present.
    const ageDays = i < 2 ? rand() * 0.25 : Math.pow(rand(), 1.25) * 365;
    let createdAt = now - ageDays * DAY;
    const h = new Date(createdAt);
    h.setHours(pickWeighted(rand, [[8, 1], [9, 2], [10, 4], [11, 5], [12, 4], [13, 3], [14, 3], [15, 3], [16, 3], [17, 4], [18, 5], [19, 6], [20, 5], [21, 4], [22, 2], [23, 1]]), intBetween(rand, 0, 59));
    createdAt = Math.min(h.getTime(), now - intBetween(rand, 2, 40) * MIN);

    const name = personName(rand);
    const type: LeadType = pickWeighted(rand, [['buyer', 10], ['tenant', 5], ['investor', 2], ['seller', 2], ['landlord', 1]]);
    const intent = type === 'tenant' ? 'rent' : type === 'seller' ? 'sell' : type === 'landlord' ? 'let' : type === 'investor' ? 'invest' : 'buy';
    const source = pickWeighted(rand, SOURCES);
    const status = statusForAge(rand, ageDays);
    const loc = pick(rand, cfg.localities);
    const knows = PROGRESSED.includes(status) || rand() < 0.45;
    const bedrooms = knows ? pickWeighted(rand, [[1, 2], [2, 6], [3, 4], [4, 1]]) : null;
    const rentish = intent === 'rent' || intent === 'let';
    const baseBudget = bedrooms ? bedrooms * 420 * (rentish ? loc.rentPsf : loc.psf) : null;
    const budgetMax = knows && baseBudget ? Math.round((baseBudget * between(rand, 0.9, 1.35)) / (rentish ? 1000 : 1e5)) * (rentish ? 1000 : 1e5) : null;
    const contactId = id('con');
    const assignedTo = rand() < 0.95 ? assignFor(loc.name) : null;
    const consent = (): Contact['consents'][Channel] => pickWeighted(rand, [['granted', 8], ['unknown', 2], ['revoked', 0.3]]);
    const dnc = rand() < 0.02;
    contacts.push({
      id: contactId,
      orgId,
      name,
      email: emailFor(name, rand),
      phone: phoneFor(rand),
      roles: [type],
      preferredChannel: pickWeighted(rand, [['whatsapp', 5], ['phone', 4], ['email', 2]]),
      lifecycle: dnc ? 'do_not_contact' : status === 'won' ? 'client' : status === 'nurture' ? 'nurture' : status === 'lost' ? 'inactive' : 'active',
      source,
      assignedTo,
      consents: { phone: consent(), whatsapp: consent(), sms: consent(), email: consent() },
      tags: rand() < 0.2 ? [pick(rand, ['NRI', 'Hot', 'Repeat client', 'Pre-approved loan', 'Investor'])] : [],
      createdAt,
      lastContactedAt: status === 'new' ? null : createdAt + between(rand, 0.1, Math.max(0.2, ageDays * 0.7)) * DAY,
    });
    const propertyType: PropertyType | null = knows ? pickWeighted(rand, [['apartment', 12], ['villa', 1], ['penthouse', 1]]) : null;
    const timeline = knows ? pick(rand, ['Immediate', '1 month', '0-3 months', '3-6 months', '6-12 months']) : null;
    const locations = knows ? [loc.name, ...(rand() < 0.4 ? [pick(rand, cfg.localities).name] : [])].filter((v, idx, arr) => arr.indexOf(v) === idx) : rand() < 0.3 ? [loc.name] : [];
    const lead: Lead = {
      id: id('lead'),
      orgId,
      contactId,
      name,
      status,
      priority: pickWeighted(rand, [['low', 2], ['normal', 10], ['high', 3], ['urgent', 1]]),
      type,
      source,
      campaign: CAMPAIGNS[source] && rand() < 0.8 ? pick(rand, CAMPAIGNS[source]) : null,
      assignedTo,
      score: 0,
      scoreReasons: [],
      budgetMin: budgetMax ? Math.round((budgetMax * 0.75) / 1e4) * 1e4 : null,
      budgetMax,
      locations,
      propertyType,
      bedrooms,
      timeline,
      intent,
      amenities: knows ? sample(rand, AMENITIES, intBetween(rand, 0, 3)) : [],
      aiFields: knows && rand() < 0.7 ? sample(rand, ['budget', 'locations', 'bedrooms', 'timeline', 'propertyType'], intBetween(rand, 2, 4)) : [],
      missing: [],
      summary: null,
      nextFollowUpAt: ['won', 'lost'].includes(status) ? null : now + between(rand, -2, 6) * DAY,
      firstResponseAt: status === 'new' && rand() < 0.5 ? null : createdAt + pickWeighted(rand, [[between(rand, 0.3, 2), 6], [between(rand, 2, 8), 3], [between(rand, 8, 60), 1]]) * MIN,
      lastContactAt: null,
      lostReason: status === 'lost' ? pick(rand, ['Budget mismatch', 'Bought elsewhere', 'Not responsive', 'Location preference changed', 'Timeline postponed']) : null,
      archived: false,
      createdAt,
      updatedAt: createdAt + between(rand, 0, Math.max(0.1, ageDays)) * DAY,
    };
    const s = scoreLead(lead);
    lead.score = Math.round(s.score + between(rand, -4, 4));
    lead.scoreReasons = s.reasons;
    lead.missing = missingFields(lead);
    lead.lastContactAt = contacts[contacts.length - 1].lastContactedAt;
    if (knows) {
      lead.summary = `${type === 'tenant' ? 'Looking to rent' : type === 'investor' ? 'Investor looking for' : 'Looking to buy'} ${bedrooms ? `a ${bedrooms} BHK` : 'a home'} in ${locations.join(' or ') || cfg.org.city}${budgetMax ? `, budget up to ₹${rentish ? (budgetMax / 1000).toFixed(0) + 'k/mo' : (budgetMax / 1e7 >= 1 ? (budgetMax / 1e7).toFixed(2) + ' Cr' : (budgetMax / 1e5).toFixed(0) + ' L')}` : ''}. Timeline: ${timeline}.`;
    }
    leads.push(lead);

    // Timeline for recent and open leads.
    if (ageDays < 45 || !['won', 'lost', 'nurture'].includes(status)) {
      const base = { orgId, leadId: lead.id, contactId, dealId: null };
      activities.push({ ...base, id: id('act'), kind: 'created', title: `Lead received from ${source}`, body: lead.campaign ? `Campaign: ${lead.campaign}` : null, actor: { type: 'integration', name: source }, at: createdAt });
      if (assignedTo)
        activities.push({ ...base, id: id('act'), kind: 'assigned', title: `Assigned to ${memberName(assignedTo)}`, body: `Rule: ${cfg.org.assignment === 'by_locality' ? `locality match (${loc.name})` : 'round robin'}`, actor: sys, at: createdAt + 4000 });
      if (lead.firstResponseAt)
        activities.push({ ...base, id: id('act'), kind: 'call', title: 'AI qualification call completed', body: lead.summary, actor: { type: 'ai_agent', name: qualAgentName }, at: lead.firstResponseAt });
      if (lead.aiFields.length && lead.firstResponseAt)
        activities.push({ ...base, id: id('act'), kind: 'ai_update', title: `Updated ${lead.aiFields.join(', ')}`, body: 'Extracted from call transcript · schema v3', actor: { type: 'ai_agent', name: qualAgentName }, at: lead.firstResponseAt + 30_000 });
      if (status !== 'new' && status !== 'attempting' && status !== 'contacted')
        activities.push({ ...base, id: id('act'), kind: 'status', title: `Status → ${status.replace(/_/g, ' ')}`, body: null, actor: { type: 'user', name: memberName(assignedTo) }, at: Math.min(now - 60_000, createdAt + between(rand, 0.5, Math.max(0.6, ageDays * 0.6)) * DAY) });
    }
  }

  // A few repeat enquiries from the same person, so duplicate detection has something to find.
  for (let i = 0; i < Math.round(4 * cfg.scale) + 1; i++) {
    const orig = leads[intBetween(rand, 0, leads.length - 1)];
    const c = contacts.find((x) => x.id === orig.contactId)!;
    const createdAt = now - intBetween(rand, 1, 20) * DAY;
    leads.push({ ...orig, id: id('lead'), status: 'new', source: pickWeighted(rand, SOURCES), createdAt, updatedAt: createdAt, firstResponseAt: null, aiFields: [], summary: null, campaign: null });
    c.tags = [...new Set([...c.tags, 'Repeat enquiry'])];
  }

  // Property owners for some listings
  properties.forEach((p) => {
    if (rand() < 0.6) {
      const owner = pick(rand, contacts);
      p.ownerContactId = owner.id;
      if (!owner.roles.includes(p.listing === 'rent' ? 'landlord' : 'seller')) owner.roles.push(p.listing === 'rent' ? 'landlord' : 'seller');
    }
  });

  /* Deals */
  const deals: Deal[] = [];
  const dealCandidates = leads.filter((l) => ['visit_scheduled', 'visit_completed', 'negotiation', 'won', 'qualified'].includes(l.status) || (l.status === 'lost' && rand() < 0.1));
  for (const l of dealCandidates.slice(0, Math.round(58 * cfg.scale) + 4)) {
    const sale = l.intent !== 'rent';
    const prop = properties.find((p) => p.locality === l.locations[0] && (sale ? p.listing === 'sale' : p.listing === 'rent')) ?? pick(rand, properties);
    const stage: DealStage =
      l.status === 'won' ? 'won' : l.status === 'lost' ? 'lost' : l.status === 'negotiation' ? pick(rand, ['negotiation', 'offer', 'under_contract'] as const) : l.status === 'visit_completed' ? pick(rand, ['viewing', 'offer'] as const) : l.status === 'visit_scheduled' ? 'viewing' : 'qualification';
    const createdAt = l.createdAt + between(rand, 1, 6) * DAY;
    deals.push({
      id: id('deal'),
      orgId,
      title: `${l.name.split(' ')[1] ?? l.name} · ${prop.title.replace(/ at .*/, '')}${prop.locality ? `, ${prop.locality}` : ''}`,
      leadId: l.id,
      contactId: l.contactId,
      propertyId: prop.id,
      stage,
      value: prop.price,
      commissionPct: sale ? pick(rand, [1, 1.5, 2]) : 100, // rentals: one month's rent
      expectedClose: stage === 'won' || stage === 'lost' ? Math.min(now, createdAt + intBetween(rand, 15, 60) * DAY) : now + intBetween(rand, 4, 75) * DAY,
      ownerId: l.assignedTo,
      lostReason: stage === 'lost' ? pick(rand, ['Budget mismatch', 'Bought elsewhere', 'Financing fell through']) : null,
      createdAt: Math.min(createdAt, now - DAY),
      stageChangedAt: Math.min(now - HOUR, createdAt + intBetween(rand, 1, 20) * DAY),
    });
  }

  /* Appointments */
  const appointments: Appointment[] = [];
  const apptLeads = leads.filter((l) => ['visit_scheduled', 'visit_completed', 'negotiation', 'qualified', 'matching'].includes(l.status) && now - l.createdAt < 50 * DAY);
  const weekStart = today - ((new Date(today).getDay() + 6) % 7) * DAY;
  for (const l of apptLeads.slice(0, Math.round(70 * cfg.scale) + 4)) {
    const dayOffset = l.status === 'visit_scheduled' ? intBetween(rand, 0, 12) : intBetween(rand, -14, 9);
    const day = weekStart + Math.floor(rand() * 7) * DAY + (dayOffset > 6 ? 7 * DAY : dayOffset < 0 ? -7 * DAY * Math.ceil(-dayOffset / 7) : 0);
    const hourStart = pickWeighted(rand, [[10, 2], [11, 3], [12, 2], [14, 2], [15, 3], [16, 3], [17, 3], [18, 2]]);
    const start = day + hourStart * HOUR + (rand() < 0.5 ? 30 * MIN : 0);
    const dur = pick(rand, [30, 45, 60]) * MIN;
    const assignedTo = l.assignedTo ?? agentsTeam[0].id;
    const candidate = { assignedTo, start, end: start + dur };
    const clash = appointments.some((a) => a.assignedTo === assignedTo && a.start < candidate.end && candidate.start < a.end);
    if (clash) continue;
    const prop = properties.find((p) => p.locality === l.locations[0] && p.status === 'active') ?? pick(rand, properties);
    const past = start < now;
    const type: Appointment['type'] = pickWeighted(rand, [['viewing', 8], ['consultation', 2], ['valuation', 1]]);
    appointments.push({
      id: id('apt'),
      orgId,
      title: type === 'viewing' ? `Site visit — ${prop.title.replace(/ at .*/, '')}` : type === 'valuation' ? 'Property valuation' : 'Requirement consultation',
      type,
      status: past ? pickWeighted(rand, [['completed', 8], ['no_show', 1], ['cancelled', 1]]) : pickWeighted(rand, [['confirmed', 7], ['pending', 2], ['requested', 1]]),
      leadId: l.id,
      contactId: l.contactId,
      propertyId: type === 'viewing' ? prop.id : null,
      assignedTo,
      start,
      end: start + dur,
      location: type === 'viewing' ? `${prop.title.split(' at ')[1] ?? prop.locality}, ${prop.locality}` : type === 'consultation' ? 'Skyline office, BKC' : prop.locality,
      source: rand() < 0.55 ? 'ai' : 'user',
      cancelReason: null,
      feedback: past && rand() < 0.5 ? pick(rand, ['Liked the layout, concerned about parking.', 'Wants to bring family for a second visit.', 'Price feels high for the floor.', 'Very keen — asked about loan options.']) : null,
      createdAt: start - intBetween(rand, 1, 6) * DAY,
    });
  }

  // Historical viewings for leads that progressed, so older cohorts convert realistically.
  for (const l of leads.filter((x) => ['visit_completed', 'negotiation', 'won'].includes(x.status) && now - x.createdAt >= 50 * DAY)) {
    const start = startOfDay(l.createdAt) + intBetween(rand, 2, 10) * DAY + pick(rand, [11, 12, 15, 16, 17]) * HOUR;
    if (start > now - 2 * DAY) continue;
    const prop = properties.find((p) => p.locality === l.locations[0]) ?? pick(rand, properties);
    appointments.push({
      id: id('apt'), orgId, title: `Site visit — ${prop.title.replace(/ at .*/, '')}`, type: 'viewing', status: 'completed', leadId: l.id, contactId: l.contactId,
      propertyId: prop.id, assignedTo: l.assignedTo, start, end: start + 45 * MIN, location: prop.locality, source: rand() < 0.5 ? 'ai' : 'user', cancelReason: null,
      feedback: null, createdAt: start - intBetween(rand, 1, 4) * DAY,
    });
  }

  /* Tasks */
  const tasks: Task[] = [];
  const taskTitles = [
    'Call back about loan pre-approval',
    'Send floor plans and brochure',
    'Confirm site visit time with owner',
    'Collect KYC documents',
    'Follow up after site visit',
    'Re-verify availability with owner',
    'Prepare offer letter draft',
    'Schedule second viewing with family',
    'Share comparable sale prices',
    'Update lead requirements after call',
    'Negotiate maintenance charges',
    'Book token amount paperwork',
  ];
  const openLeads = leads.filter((l) => !['won', 'lost', 'nurture'].includes(l.status));
  for (let i = 0; i < Math.round(46 * cfg.scale) + 4; i++) {
    const l = pick(rand, openLeads);
    const due = today + pickWeighted(rand, [[-intBetween(rand, 1, 4) * DAY, 3], [intBetween(rand, 10, 19) * HOUR, 5], [intBetween(rand, 1, 7) * DAY + 11 * HOUR, 6]]);
    const status: Task['status'] = due < today && rand() < 0.4 ? 'completed' : pickWeighted(rand, [['open', 8], ['in_progress', 2]]);
    tasks.push({
      id: id('task'),
      orgId,
      title: pick(rand, taskTitles),
      status,
      priority: pickWeighted(rand, [['low', 2], ['normal', 6], ['high', 3], ['urgent', 1]]),
      dueAt: due,
      assignedTo: l.assignedTo,
      related: { type: 'lead', id: l.id },
      source: pickWeighted(rand, [['manual', 5], ['workflow', 4], ['ai', 2]]),
      createdAt: due - intBetween(rand, 1, 5) * DAY,
      completedAt: status === 'completed' ? due - HOUR : null,
    });
  }

  /* Agents */
  // The eight agents the product ships (same names, order and roles as the live AI agents page).
  const agents: Agent[] = [
    { id: id('agt'), orgId, name: 'AI Lead Intake Agent', type: 'lead_intake', purpose: 'Captures every enquiry from forms, portals and imports, checks it, spots repeat enquiries and assigns an owner.', status: 'active', autonomy: 'bounded_auto', tools: ['create_lead', 'find_duplicates', 'assign_owner', 'request_human_handoff'], channel: null, model: 'claude-opus-5-5', version: 3, dailyBudget: 300, maxSteps: 6, escalation: ['Possible duplicate with conflicting details'], createdAt: now - 160 * DAY },
    { id: id('agt'), orgId, name: 'AI Voice Calling Agent', type: 'voice_calling', purpose: 'Calls new enquiries (with AI-call consent, inside calling hours) to capture budget, area, configuration and timeline.', status: 'active', autonomy: 'bounded_auto', tools: ['get_lead', 'update_lead_fields', 'create_task', 'request_human_handoff'], channel: 'phone', model: 'claude-opus-5-5', version: 7, dailyBudget: 2500, maxSteps: 12, escalation: ['Caller asks for a human', 'Legal or pricing negotiation', 'Low extraction confidence'], createdAt: now - 150 * DAY },
    { id: id('agt'), orgId, name: 'AI Sales & Qualification Agent', type: 'qualification', purpose: 'Scores how ready each lead is to buy or rent, explains the score and lists the details still missing.', status: 'active', autonomy: 'approval_required', tools: ['get_lead', 'score_lead', 'create_task'], channel: null, model: 'claude-opus-5-5', version: 4, dailyBudget: 500, maxSteps: 6, escalation: ['Borderline score', 'Conflicting requirements'], createdAt: now - 140 * DAY },
    { id: id('agt'), orgId, name: 'AI Property Matching Agent', type: 'property_matching', purpose: 'Ranks active, verified listings against each lead’s hard requirements and explains every match.', status: 'active', autonomy: 'suggest_only', tools: ['get_lead', 'search_properties', 'get_verified_property_details'], channel: null, model: 'claude-opus-5-5', version: 3, dailyBudget: 400, maxSteps: 6, escalation: ['No listing meets the hard requirements'], createdAt: now - 120 * DAY },
    { id: id('agt'), orgId, name: 'AI Follow-Up Agent', type: 'follow_up', purpose: 'Drafts the next message from real matches and missing details; a person approves and sends it.', status: 'active', autonomy: 'approval_required', tools: ['get_lead', 'draft_customer_message', 'send_approved_message', 'create_task'], channel: 'whatsapp', model: 'claude-opus-5-5', version: 5, dailyBudget: 600, maxSteps: 6, escalation: ['Lead replied with an objection', 'No channel has consent'], createdAt: now - 110 * DAY },
    { id: id('agt'), orgId, name: 'AI Appointment Agent', type: 'appointment', purpose: 'Offers only verified free times and books site visits without double-booking; reschedules and cancels.', status: 'active', autonomy: 'approval_required', tools: ['check_appointment_availability', 'request_appointment_booking', 'create_task'], channel: null, model: 'claude-opus-5-5', version: 2, dailyBudget: 300, maxSteps: 5, escalation: ['No free slot in the requested window'], createdAt: now - 90 * DAY },
    { id: id('agt'), orgId, name: 'AI CRM & Data Intelligence Agent', type: 'data_quality', purpose: 'Finds duplicates and inconsistent records, proposes fixes and merges; a person approves every change.', status: 'active', autonomy: 'suggest_only', tools: ['scan_records', 'propose_merge', 'propose_fix'], channel: null, model: 'claude-opus-5-5', version: 2, dailyBudget: 300, maxSteps: 4, escalation: ['High-severity finding'], createdAt: now - 60 * DAY },
    { id: id('agt'), orgId, name: 'AI Sales Intelligence Agent', type: 'sales_intelligence', purpose: 'Computes the funnel, sources and team metrics with fixed definitions and suggests where to focus. Never commits to terms.', status: 'active', autonomy: 'suggest_only', tools: ['run_metrics', 'create_task'], channel: null, model: 'claude-opus-5-5', version: 1, dailyBudget: 300, maxSteps: 5, escalation: ['Any contractual question'], createdAt: now - 30 * DAY },
  ];
  const agentOf = (type: Agent['type']) => agents.find((a) => a.type === type)!;

  /* Workflows (PRD §8.11 initial templates) */
  const wf = (key: string, name: string, description: string, trigger: string, steps: [string, Workflow['steps'][number]['kind']][], exitRules: string[], status: Workflow['status'] = 'active', owner: Workflow['owner'] = 'app'): Workflow => ({
    id: id('wf'), orgId, key, name, description, trigger, status, version: intBetween(rand, 1, 6), owner, maxRetries: 3, exitRules,
    steps: steps.map(([label, kind], i) => ({ key: `s${i}`, label, kind })),
  });
  const workflows: Workflow[] = [
    wf('new_lead', 'New lead acknowledgement & qualification', 'Acknowledge within minutes, then run an AI qualification call during calling hours.', 'lead.created.v1', [['Lead created', 'trigger'], ['Check consent & calling hours', 'condition'], ['Send WhatsApp acknowledgement', 'action'], ['AI qualification call', 'ai'], ['Validate & save extracted fields', 'action'], ['Create follow-up task', 'action']], ['Lead opts out', 'Human takes over', 'Lead disqualified']),
    wf('no_answer', 'No-answer callback sequence', 'Retry unanswered calls with backoff — at most three attempts, then hand to a person.', 'call.completed.v1 (no_answer)', [['Call not answered', 'trigger'], ['Wait 2 hours', 'delay'], ['Retry call', 'ai'], ['Wait 1 day', 'delay'], ['Final attempt', 'ai'], ['Create callback task', 'action']], ['Lead replies', 'Max 3 attempts reached', 'Opt-out']),
    wf('recommend', 'Qualified lead property recommendations', 'Match verified inventory and send the top three with reasons.', 'lead.qualified.v1', [['Lead qualified', 'trigger'], ['Match properties', 'ai'], ['Exclude stale listings', 'condition'], ['Draft recommendation', 'ai'], ['Request approval', 'action'], ['Send via WhatsApp', 'action']], ['Lead books visit', 'Opt-out']),
    wf('reminder', 'Appointment confirmation & reminder', 'Confirm on booking, remind 24 hours and 2 hours before the visit.', 'appointment.booked.v1', [['Appointment booked', 'trigger'], ['Send confirmation', 'action'], ['Wait until T-24h', 'delay'], ['Send reminder', 'action'], ['Wait until T-2h', 'delay'], ['Send final reminder', 'action']], ['Appointment cancelled', 'Rescheduled']),
    wf('feedback', 'Post-site-visit feedback', 'Ask for feedback after a completed visit and update the lead.', 'appointment.completed.v1', [['Visit completed', 'trigger'], ['Wait 3 hours', 'delay'], ['Ask for feedback', 'action'], ['Summarize reply', 'ai'], ['Update lead', 'action']], ['No reply in 48h']),
    wf('reengage', 'Stale lead re-engagement', 'Re-engage nurture leads with new matching inventory, where permitted.', 'schedule (weekly)', [['Weekly schedule', 'trigger'], ['Select nurture leads with consent', 'condition'], ['Find new matches', 'ai'], ['Send update', 'action']], ['Opt-out', 'Lead responds'], 'paused'),
    wf('integration_alert', 'Failed integration alert', 'Notify admins when a provider fails repeatedly.', 'integration.health_changed.v1', [['Health degraded', 'trigger'], ['Check failure threshold', 'condition'], ['Notify admins', 'action']], [], 'active', 'n8n'),
    wf('sla', 'Lead response SLA escalation', 'Escalate to the manager when no first contact happens within the SLA.', 'schedule (every 5 min)', [['SLA timer', 'trigger'], ['Find leads past SLA', 'condition'], ['Notify manager', 'action'], ['Reassign if unclaimed', 'action']], ['First contact made']),
  ];

  /* Runs (execution log) */
  const runs: Run[] = [];
  const recentLeads = leads.filter((l) => now - l.createdAt < 14 * DAY);
  for (let i = 0; i < Math.round(240 * cfg.scale) + 10; i++) {
    const isAgent = rand() < 0.55;
    const startedAt = now - Math.pow(rand(), 1.3) * 14 * DAY;
    const status: Run['status'] = pickWeighted(rand, [['succeeded', 86], ['failed', 4], ['skipped', 4], ['waiting_approval', 2], ['dead_letter', 1], ['cancelled', 2]]);
    const l = recentLeads.length ? pick(rand, recentLeads) : pick(rand, leads);
    if (isAgent) {
      const a = pick(rand, agents.filter((x) => x.status === 'active'));
      const tokens = intBetween(rand, 1800, 14000);
      const steps: RunStep[] = [
        { label: 'Load lead context (minimal projection)', status: 'ok', ms: intBetween(rand, 30, 120) },
        { label: `Model call · ${a.model}`, status: 'ok', ms: intBetween(rand, 900, 4200) },
        { label: `Policy check · ${a.tools[1] ?? a.tools[0]}`, status: status === 'skipped' ? 'skip' : 'ok', ms: intBetween(rand, 8, 40), note: status === 'skipped' ? 'Consent unknown for channel' : undefined },
        { label: 'Validate output against schema v3', status: status === 'failed' ? 'fail' : status === 'skipped' ? 'pending' : 'ok', ms: intBetween(rand, 5, 30), note: status === 'failed' ? 'budget_max: expected number, got "around 2"' : undefined },
      ];
      if (status === 'waiting_approval') steps.push({ label: 'Approval requested', status: 'run', ms: 0 });
      runs.push({
        id: id('run'), orgId, kind: 'agent', refId: a.id, name: a.name, status, trigger: pick(rand, ['lead.created.v1', 'conversation.message_received.v1', 'call.completed.v1', 'manual']),
        startedAt, durationMs: steps.reduce((s, x) => s + x.ms, 0), cost: (tokens / 1000) * (a.model.includes('haiku') ? 0.12 : 0.6), tokens, steps, leadId: l.id, attempt: 1,
        error: status === 'failed' ? 'Output failed schema validation' : status === 'dead_letter' ? 'Provider timeout after 3 attempts' : null, correlationId: correlationId(),
      });
    } else {
      const w = pick(rand, workflows.filter((x) => x.status === 'active'));
      const failAt = status === 'failed' || status === 'dead_letter' ? intBetween(rand, 1, w.steps.length - 1) : -1;
      const steps: RunStep[] = w.steps.map((s, idx) => ({
        label: s.label,
        status: failAt === -1 ? (status === 'skipped' && idx > 1 ? 'pending' : status === 'skipped' && idx === 1 ? 'skip' : 'ok') : idx < failAt ? 'ok' : idx === failAt ? 'fail' : 'pending',
        ms: s.kind === 'ai' ? intBetween(rand, 2000, 90000) : intBetween(rand, 20, 600),
        note: idx === failAt ? pick(rand, ['WhatsApp provider returned 503', 'Voice provider timeout (30s)', 'Calendar sync rejected: token expired']) : status === 'skipped' && idx === 1 ? pick(rand, ['Outside calling hours — deferred', 'Contact opted out of WhatsApp']) : undefined,
      }));
      runs.push({
        id: id('run'), orgId, kind: 'workflow', refId: w.id, name: w.name, status, trigger: w.trigger, startedAt,
        durationMs: steps.reduce((s, x) => s + x.ms, 0), cost: rand() * 6, tokens: 0, steps, leadId: l.id, attempt: status === 'dead_letter' ? 3 : 1,
        error: failAt >= 0 ? steps[failAt].note ?? 'Step failed' : null, correlationId: correlationId(),
      });
    }
  }
  runs.sort((a, b) => b.startedAt - a.startedAt);

  /* Conversations */
  const conversations: Conversation[] = [];
  const convLeads = leads.filter((l) => now - l.createdAt < 20 * DAY).slice(0, Math.round(26 * cfg.scale) + 3);
  convLeads.forEach((l, idx) => {
    const c = contacts.find((x) => x.id === l.contactId)!;
    const first = c.name.split(' ')[0];
    const loc = l.locations[0] ?? cfg.localities[0].name;
    const bhk = l.bedrooms ?? 2;
    const agentM = members.find((m) => m.id === l.assignedTo);
    const script = idx % 6;
    const channel: Channel = script === 3 ? 'email' : script === 5 ? 'sms' : 'whatsapp';
    const t0 = Math.max(l.createdAt, now - 6 * DAY) + intBetween(rand, 0, 3) * HOUR;
    let t = t0;
    const msgs: Message[] = [];
    const push = (direction: Message['direction'], sender: Message['sender'], body: string, gap = intBetween(rand, 1, 25) * MIN, senderName?: string) => {
      t += gap;
      msgs.push({ id: id('msg'), direction, sender, senderName: senderName ?? (sender === 'contact' ? c.name : sender === 'ai' ? 'AI Follow-Up Agent' : sender === 'user' ? agentM?.name ?? 'Agent' : 'System'), body, at: Math.min(t, now - 2 * MIN), status: direction === 'in' ? 'received' : 'read' });
    };
    let owner: Conversation['owner'] = 'ai';
    if (script === 0) {
      push('in', 'contact', `Hi, saw the ${bhk}BHK in ${loc} on ${l.source}. Is it still available?`, 0);
      push('out', 'ai', `Hi ${first}, thanks for reaching out — this is the ${cfg.org.name} assistant. That ${bhk} BHK was last verified available ${intBetween(rand, 2, 9)} days ago. Could you share your budget and when you're hoping to move?`, 40_000);
      push('in', 'contact', `Budget around ${l.budgetMax ? (l.budgetMax >= 1e7 ? (l.budgetMax / 1e7).toFixed(1) + ' Cr' : Math.round(l.budgetMax / 1e5) + ' lakh') : '1.5 Cr'}, looking in the next 2-3 months`);
      push('out', 'ai', `Noted — I've saved that to your enquiry. ${agentM?.name.split(' ')[0] ?? 'Our consultant'} handles ${loc}. Would Saturday 11am or 4pm work for a site visit?`, 50_000);
      push('in', 'contact', 'Saturday 11 works');
      push('system', 'system', 'Visit request sent for approval — booking is confirmed only after availability check.', 20_000);
    } else if (script === 1) {
      push('in', 'contact', `Hello, I'm looking for a ${bhk} BHK on rent near ${loc}. Pet friendly please 🐕`, 0);
      push('out', 'ai', `Hi ${first}! I can help with that. I found ${intBetween(rand, 2, 4)} verified pet-friendly rentals in ${loc}. What monthly rent range should I search within?`, 35_000);
      push('in', 'contact', 'Up to 85k. Also need parking');
      push('out', 'ai', 'Got it — up to ₹85k/month with parking. Sharing the top matches now.', 45_000);
    } else if (script === 2) {
      owner = 'human';
      push('in', 'contact', `Is the price negotiable for the ${loc} flat? My father wants to speak to someone directly.`, 0);
      push('system', 'system', `Escalated to ${agentM?.name ?? 'a consultant'}: pricing negotiation is outside AI scope.`, 30_000);
      push('internal', 'user', `Owner open to ~3% on quick close. Don't commit in writing yet.`, 6 * MIN, members[2]?.name);
      push('out', 'user', `Hi ${first}, ${agentM?.name.split(' ')[0] ?? 'I'} here. Happy to talk — I'll call your father at 6pm today if that works?`, 8 * MIN);
      push('in', 'contact', 'Yes 6pm is fine, thank you');
    } else if (script === 3) {
      push('in', 'contact', `Dear team,\n\nI am an NRI based in Dubai, interested in investment options in ${loc} under ₹3 Cr. Could you share options with rental yield details?\n\nRegards,\n${c.name}`, 0);
      push('out', 'ai', `Dear ${first},\n\nThank you for your enquiry. I've shortlisted verified listings in ${loc} within your budget. Rental yield estimates depend on current lease data, so ${agentM?.name ?? 'our consultant'} will confirm figures personally.\n\nWould a video walkthrough this week be helpful?`, 3 * MIN);
    } else if (script === 4) {
      push('out', 'ai', `Hi ${first}, following up on your enquiry for ${loc}. Are you still looking?`, 0);
      push('in', 'contact', 'STOP');
      push('system', 'system', `Opt-out recorded for WhatsApp. Pending follow-ups cancelled.`, 10_000);
      c.consents.whatsapp = 'revoked';
      owner = 'unassigned';
    } else {
      push('out', 'system', `Reminder: your site visit is tomorrow at 11:00 am. Reply C to confirm or R to reschedule.`, 0, 'Appointment reminder');
      push('in', 'contact', 'C');
      push('out', 'system', 'Confirmed — see you tomorrow.', 30_000, 'Appointment reminder');
    }
    const last = msgs[msgs.length - 1];
    conversations.push({
      id: id('conv'), orgId, contactId: c.id, leadId: l.id, channel,
      status: script === 4 ? 'resolved' : script === 5 ? 'resolved' : 'open',
      owner, assignedTo: l.assignedTo, unread: last.direction === 'in' && rand() < 0.7 ? intBetween(rand, 1, 2) : 0, lastMessageAt: last.at, messages: msgs,
    });
  });
  conversations.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  /* Calls */
  const calls: Call[] = [];
  const qa = agentOf('voice_calling');
  for (let i = 0; i < Math.round(220 * cfg.scale) + 6; i++) {
    const l = pick(rand, leads.filter((x) => now - x.createdAt < 30 * DAY) .length ? leads.filter((x) => now - x.createdAt < 30 * DAY) : leads);
    const status: Call['status'] = pickWeighted(rand, [['completed', 62], ['no_answer', 18], ['busy', 5], ['failed', 3], ['needs_review', 3], ['blocked', 2]]);
    const byAi = rand() < 0.72;
    const dur = status === 'completed' || status === 'needs_review' ? intBetween(rand, 70, 420) : 0;
    const startedAt = now - Math.pow(rand(), 1.4) * 30 * DAY;
    calls.push({
      id: id('call'), orgId, leadId: l.id, contactId: l.contactId, direction: rand() < 0.85 ? 'outbound' : 'inbound', status,
      agentId: byAi ? qa.id : null, userId: byAi ? null : l.assignedTo, startedAt, duration: dur,
      cost: byAi ? Math.round((dur / 60) * 7.5 * 100) / 100 + (dur ? 0.8 : 0.2) : Math.round((dur / 60) * 1.2 * 100) / 100,
      outcome: status === 'completed' ? pick(rand, ['Qualified', 'Requirements captured', 'Visit requested', 'Callback requested', 'Not interested']) : status === 'needs_review' ? 'Low confidence extraction' : null,
      summary: status === 'completed' ? l.summary ?? `Spoke with ${l.name.split(' ')[0]}; requirements partially captured. Asked for a callback in the evening.` : null,
      extracted: status === 'completed' && l.budgetMax ? { budget: String(l.budgetMax), location: l.locations[0] ?? 'unknown', bedrooms: String(l.bedrooms ?? 'unknown'), timeline: l.timeline ?? 'unknown' } : null,
      recording: byAi && status === 'completed',
      policyNote: status === 'blocked' ? pick(rand, ['Outside calling hours', 'Phone consent unknown', 'Contact on suppression list']) : null,
    });
  }
  calls.sort((a, b) => b.startedAt - a.startedAt);

  /* Approvals */
  const approvals: Approval[] = [];
  const pendingConv = conversations.find((c) => c.owner === 'ai' && c.channel === 'whatsapp');
  const openDeal = deals.find((d) => d.stage === 'negotiation') ?? deals[0];
  const visitLead = leads.find((l) => l.status === 'qualified') ?? leads[0];
  if (pendingConv) {
    approvals.push({ id: id('apr'), orgId, action: 'send_approved_message', summary: `Send 3 property recommendations to ${contacts.find((c) => c.id === pendingConv.contactId)?.name}`, risk: 'medium', requestedBy: { type: 'ai_agent', name: 'AI Follow-Up Agent' }, status: 'pending', createdAt: now - 18 * MIN, expiresAt: now + 6 * HOUR, decidedBy: null, decidedAt: null, note: null, payload: { kind: 'send_message', conversationId: pendingConv.id, body: `Here are 3 verified homes that match what you shared:\n1. ${properties[0].title} — ${properties[0].locality}\n2. ${properties[1].title} — ${properties[1].locality}\n3. ${properties[2].title} — ${properties[2].locality}\nWould you like to visit any of these this week?` } });
  }
  if (openDeal)
    approvals.push({ id: id('apr'), orgId, action: 'deal_stage_change', summary: `Move “${openDeal.title}” to Under contract`, risk: 'high', requestedBy: { type: 'ai_agent', name: 'AI Sales Intelligence Agent' }, status: 'pending', createdAt: now - 2 * HOUR, expiresAt: now + 22 * HOUR, decidedBy: null, decidedAt: null, note: null, payload: { kind: 'deal_stage', dealId: openDeal.id, to: 'under_contract' } });
  approvals.push({ id: id('apr'), orgId, action: 'request_appointment_booking', summary: `Book site visit for ${visitLead.name} — Saturday 11:00`, risk: 'medium', requestedBy: { type: 'ai_agent', name: 'AI Follow-Up Agent' }, status: 'pending', createdAt: now - 42 * MIN, expiresAt: now + 3 * HOUR, decidedBy: null, decidedAt: null, note: null, payload: { kind: 'book_appointment', leadId: visitLead.id, propertyId: properties[0].id, start: nextSaturday(now, 11) } });
  approvals.push({ id: id('apr'), orgId, action: 'bulk_export', summary: 'Export 412 lead records to CSV', risk: 'high', requestedBy: { type: 'user', name: members[2]?.name ?? 'Manager' }, status: 'pending', createdAt: now - 5 * HOUR, expiresAt: now + 19 * HOUR, decidedBy: null, decidedAt: null, note: null, payload: { kind: 'bulk_export', entity: 'leads', rows: 412 } });
  for (let i = 0; i < 9; i++) {
    const st = pickWeighted(rand, [['approved', 6], ['rejected', 2], ['expired', 1]] as const);
    approvals.push({ id: id('apr'), orgId, action: pick(rand, ['send_approved_message', 'request_appointment_booking', 'deal_stage_change']), summary: pick(rand, ['Send visit confirmation to ' + personName(rand), 'Book viewing for ' + personName(rand), 'Send price-drop alert to ' + personName(rand)]), risk: pick(rand, ['low', 'medium'] as const), requestedBy: { type: 'ai_agent', name: pick(rand, ['AI Follow-Up Agent', 'AI Follow-Up Agent']) }, status: st, createdAt: now - intBetween(rand, 1, 9) * DAY, expiresAt: now - intBetween(rand, 0, 1) * DAY, decidedBy: st === 'expired' ? null : pick(rand, members.slice(0, 3)).name, decidedAt: st === 'expired' ? null : now - intBetween(rand, 1, 8) * DAY, note: st === 'rejected' ? 'Tone too pushy — rewrite.' : null, payload: { kind: 'bulk_export', entity: 'n/a', rows: 0 } });
  }

  /* Follow-ups */
  const followUps: FollowUp[] = openLeads.slice(0, Math.round(16 * cfg.scale) + 3).map((l, i) => {
    const created = Math.max(l.createdAt, now - 5 * DAY);
    const w = workflows[i % 3 === 0 ? 1 : i % 3 === 1 ? 2 : 4];
    const status: FollowUp['status'] = i % 7 === 3 ? 'stopped' : i % 9 === 4 ? 'paused' : i % 5 === 2 ? 'completed' : 'active';
    const steps = w.steps.filter((s) => s.kind !== 'trigger' && s.kind !== 'condition').slice(0, 4).map((s, idx) => {
      const at = created + (idx + 1) * intBetween(rand, 3, 26) * HOUR;
      return { label: s.label, channel: (s.kind === 'ai' ? 'phone' : s.label.toLowerCase().includes('task') ? 'task' : 'whatsapp') as FollowUp['steps'][number]['channel'], at, status: (status === 'completed' || at < now ? 'done' : status === 'stopped' ? 'cancelled' : 'scheduled') as FollowUp['steps'][number]['status'] };
    });
    return { id: id('fu'), orgId, leadId: l.id, workflowId: w.id, name: w.name, status, steps, stopReason: status === 'stopped' ? pick(rand, ['Lead replied', 'Human took over', 'Opt-out received']) : null, createdAt: created };
  });

  /* Integrations */
  const integ = (provider: string, category: Integration['category'], description: string, status: Integration['status'], scopes: string[], capabilities: string[], error: string | null = null): Integration => ({
    id: id('int'), orgId, provider, category, description, status, scopes, capabilities, error, lastSync: status === 'disconnected' ? null : now - intBetween(rand, 1, 50) * MIN,
  });
  const integrations: Integration[] = [
    integ('Website form', 'lead_source', 'Embeddable enquiry form with signed submissions.', 'connected', ['leads:write'], ['Lead intake', 'Spam scoring']),
    integ('Generic webhook', 'lead_source', 'HMAC-signed endpoint for any portal or ad platform.', 'connected', ['leads:write'], ['Lead intake', 'Idempotency']),
    integ('99acres', 'lead_source', 'Listing portal enquiries via partner API.', 'connected', ['enquiries:read'], ['Lead intake']),
    integ('MagicBricks', 'lead_source', 'Listing portal enquiries via email parsing.', 'error', ['mailbox:read'], ['Lead intake'], 'Parser rejected 3 emails: unexpected template change'),
    integ('Meta Lead Ads', 'lead_source', 'Instant-form leads from Facebook and Instagram.', 'connected', ['leads_retrieval', 'pages_show_list'], ['Lead intake', 'Campaign attribution']),
    integ('Exotel Voice', 'voice', 'Outbound and inbound AI calling with recording.', 'connected', ['calls:write', 'recordings:read'], ['Outbound calls', 'Inbound calls', 'Recording', 'Status webhooks']),
    integ('WhatsApp Business', 'messaging', 'Official Cloud API with approved templates.', 'connected', ['whatsapp_business_messaging'], ['Send', 'Receive', 'Templates', 'Delivery receipts']),
    integ('Google Calendar', 'calendar', 'Two-way sync of staff calendars.', 'needs_reauth', ['calendar.events'], ['Availability', 'Event sync'], 'Refresh token revoked for meera@'),
    integ('Postmark', 'email', 'Transactional email and inbound parsing.', 'connected', ['send', 'inbound'], ['Send', 'Receive']),
    integ('Anthropic', 'ai', 'Model provider for agents (no training on customer data).', 'connected', ['messages'], ['Extraction', 'Drafting', 'Summaries']),
    integ('n8n', 'automation', 'Connector-heavy workflows with run tracking.', 'connected', ['workflows:execute'], ['Integration alerts']),
    integ('Housing.com', 'lead_source', 'Portal enquiries.', 'disconnected', [], ['Lead intake']),
  ];

  /* Webhook events */
  const webhookEvents: WebhookEvent[] = [];
  for (let i = 0; i < Math.round(70 * cfg.scale) + 6; i++) {
    const provider = pick(rand, ['Meta Lead Ads', '99acres', 'Website form', 'Exotel Voice', 'WhatsApp Business', 'MagicBricks', 'Generic webhook']);
    const status: WebhookEvent['status'] = provider === 'MagicBricks' && rand() < 0.5 ? 'failed' : pickWeighted(rand, [['processed', 88], ['duplicate', 6], ['retrying', 2], ['dead_letter', 1], ['rejected', 2]]);
    webhookEvents.push({
      id: id('evt'), orgId, provider,
      type: provider.includes('Voice') ? pick(rand, ['call.status', 'call.completed']) : provider.includes('WhatsApp') ? pick(rand, ['message.received', 'message.status']) : 'lead.created',
      status, receivedAt: now - Math.pow(rand(), 1.3) * 3 * DAY, attempts: status === 'dead_letter' ? 5 : status === 'retrying' ? 2 : 1,
      error: status === 'failed' ? 'Payload validation: phone missing' : status === 'dead_letter' ? 'Exhausted retries: downstream timeout' : status === 'rejected' ? 'Invalid signature' : null,
      idempotencyKey: `${provider.slice(0, 3).toLowerCase()}_${Math.floor(rand() * 1e10).toString(36)}`, signature: status === 'rejected' ? 'invalid' : 'valid',
    });
  }
  webhookEvents.sort((a, b) => b.receivedAt - a.receivedAt);

  /* Usage */
  const usage: UsageRecord[] = [];
  for (let d = 89; d >= 0; d--) {
    const day = today - d * DAY;
    const growth = 0.55 + (1 - d / 90) * 0.6;
    const weekend = [0].includes(new Date(day).getDay()) ? 0.5 : 1;
    const f = growth * weekend * cfg.scale * between(rand, 0.85, 1.15);
    usage.push({ orgId, day, category: 'voice', provider: 'Exotel Voice', agentId: agentOf('voice_calling').id, units: Math.round(95 * f), cost: Math.round(95 * f * 7.6) });
    usage.push({ orgId, day, category: 'llm', provider: 'Anthropic', agentId: agentOf('qualification').id, units: Math.round(310 * f), cost: Math.round(310 * f * 0.55) });
    usage.push({ orgId, day, category: 'llm', provider: 'Anthropic', agentId: agentOf('follow_up').id, units: Math.round(180 * f), cost: Math.round(180 * f * 0.48) });
    usage.push({ orgId, day, category: 'llm', provider: 'Anthropic', agentId: agentOf('property_matching').id, units: Math.round(90 * f), cost: Math.round(90 * f * 0.12) });
    usage.push({ orgId, day, category: 'messaging', provider: 'WhatsApp Business', agentId: agentOf('follow_up').id, units: Math.round(260 * f), cost: Math.round(260 * f * 0.78) });
    usage.push({ orgId, day, category: 'messaging', provider: 'WhatsApp Business', agentId: agentOf('appointment').id, units: Math.round(120 * f), cost: Math.round(120 * f * 0.78) });
  }

  /* Finance */
  const commissions: Commission[] = deals
    .filter((d) => ['won', 'under_contract'].includes(d.stage))
    .map((d) => {
      const gross = Math.round((d.value * d.commissionPct) / 100);
      const status: Commission['status'] = d.stage === 'under_contract' ? 'estimated' : pickWeighted(rand, [['paid', 5], ['payable', 2], ['approved', 2]]);
      return { id: id('com'), orgId, dealId: d.id, beneficiaryId: d.ownerId ?? members[0].id, gross, status, createdAt: d.stageChangedAt, paidAt: status === 'paid' ? d.stageChangedAt + intBetween(rand, 7, 30) * DAY : null };
    });
  const expenses: Expense[] = [];
  for (let m = 0; m < 6; m++) {
    const date = new Date(today);
    date.setMonth(date.getMonth() - m, 3);
    for (const [cat, vendor, amt] of [
      ['marketing', 'Meta Platforms', 120000],
      ['marketing', 'Google Ads', 90000],
      ['marketing', '99acres', 85000],
      ['telephony', 'Exotel', 22000],
      ['ai_usage', 'Anthropic', 14000],
      ['software', 'Supabase · Vercel', 6500],
      ['operations', 'Office & travel', 48000],
    ] as const) {
      expenses.push({ id: id('exp'), orgId, category: cat, vendor, amount: Math.round(amt * cfg.scale * between(rand, 0.85, 1.15)), date: date.getTime(), status: m === 0 && rand() < 0.5 ? 'pending' : 'paid' });
    }
  }

  /* Documents */
  const documents: DocumentRec[] = [];
  const docKinds: [DocumentRec['kind'], string, DocumentRec['classification']][] = [
    ['agreement', 'Sale agreement draft', 'confidential'],
    ['id_proof', 'PAN card', 'restricted'],
    ['title_deed', 'Title deed', 'confidential'],
    ['floor_plan', 'Floor plan', 'general'],
    ['brochure', 'Project brochure', 'general'],
    ['invoice', 'Brokerage invoice', 'confidential'],
  ];
  for (let i = 0; i < Math.round(26 * cfg.scale) + 3; i++) {
    const [kind, label, classification] = pick(rand, docKinds);
    const target = kind === 'floor_plan' || kind === 'brochure' || kind === 'title_deed' ? { type: 'property' as const, id: pick(rand, properties).id } : kind === 'id_proof' ? { type: 'contact' as const, id: pick(rand, contacts).id } : deals.length ? { type: 'deal' as const, id: pick(rand, deals).id } : null;
    documents.push({ id: id('doc'), orgId, name: `${label} — ${kind === 'id_proof' ? personName(rand) : pick(rand, cfg.projects)}.pdf`, kind, size: intBetween(rand, 80_000, 6_000_000), classification, related: target, uploadedBy: pick(rand, members).name, uploadedAt: now - intBetween(rand, 0, 120) * DAY - intBetween(rand, 1, 600) * MIN, status: rand() < 0.05 ? 'processing' : 'ready', expiresAt: kind === 'agreement' ? now + intBetween(rand, -5, 60) * DAY : null });
  }
  documents.sort((a, b) => b.uploadedAt - a.uploadedAt);

  /* Audit */
  const audit: AuditLog[] = [];
  const auditActions: [string, string, Activity['actor']['type']][] = [
    ['lead.assigned', 'lead', 'system'], ['lead.status_changed', 'lead', 'user'], ['lead.fields_updated', 'lead', 'ai_agent'],
    ['member.role_changed', 'member', 'user'], ['integration.connected', 'integration', 'user'], ['agent.paused', 'agent', 'user'],
    ['approval.approved', 'approval', 'user'], ['export.requested', 'export', 'user'], ['webhook.signature_failed', 'webhook', 'integration'],
    ['consent.revoked', 'contact', 'system'], ['deal.stage_changed', 'deal', 'user'], ['recording.accessed', 'call', 'user'],
    ['settings.updated', 'organization', 'user'], ['workflow.paused', 'workflow', 'user'],
  ];
  for (let i = 0; i < Math.round(160 * cfg.scale) + 10; i++) {
    const [action, entity, at] = pick(rand, auditActions);
    audit.push({ id: id('aud'), orgId, actor: at === 'user' ? { type: 'user', name: pick(rand, members).name } : at === 'ai_agent' ? { type: 'ai_agent', name: pick(rand, agents).name } : at === 'integration' ? { type: 'integration', name: pick(rand, ['Meta Lead Ads', 'Exotel Voice', 'Generic webhook']) } : sys, action, entity, entityId: null, at: now - Math.pow(rand(), 1.2) * 30 * DAY, meta: action === 'member.role_changed' ? 'agent → manager' : action === 'webhook.signature_failed' ? 'ip_hash 9f1c…' : action === 'lead.fields_updated' ? 'budget_max, locations' : null });
  }
  audit.sort((a, b) => b.at - a.at);

  /* Notifications */
  const notifications: Notification[] = [
    { id: id('ntf'), orgId, kind: 'approval', title: `${approvals.filter((a) => a.status === 'pending').length} approvals waiting`, body: 'AI agents are waiting on your decision.', at: now - 15 * MIN, read: false, link: 'approvals' },
    { id: id('ntf'), orgId, kind: 'failure', title: 'MagicBricks parser failing', body: '3 enquiries could not be parsed. Review in Integrations.', at: now - 50 * MIN, read: false, link: 'integrations' },
    { id: id('ntf'), orgId, kind: 'lead', title: `New hot lead: ${leads.filter((l) => l.status === 'new').sort((a, b) => b.createdAt - a.createdAt)[0]?.name ?? 'New lead'}`, body: 'Scored 84 — budget and timeline confirmed.', at: now - 75 * MIN, read: false, link: 'leads' },
    { id: id('ntf'), orgId, kind: 'appointment', title: 'Visit rescheduled', body: 'Saturday 4:00 pm moved to Sunday 11:30 am.', at: now - 3 * HOUR, read: true, link: 'appointments' },
    { id: id('ntf'), orgId, kind: 'system', title: 'Google Calendar needs re-authorization', body: 'Sync paused for one user until access is restored.', at: now - 5 * HOUR, read: true, link: 'integrations' },
    { id: id('ntf'), orgId, kind: 'task', title: '4 tasks overdue', body: 'Callbacks and document collection are past due.', at: now - 8 * HOUR, read: true, link: 'tasks' },
  ];

  const sources: MarketingSource[] = SOURCES.map(([name]) => ({ id: id('src'), orgId, key: name.toLowerCase().replace(/\W+/g, '_'), name, kind: SOURCE_META[name].kind, monthlySpend: Math.round(SOURCE_META[name].spend * cfg.scale), active: name !== 'Walk-in' }));

  activities.sort((a, b) => b.at - a.at);

  return {
    members, contacts, leads, properties, deals, appointments, tasks, conversations, calls, agents, workflows, runs,
    approvals, followUps, integrations, webhookEvents, usage, commissions, expenses, documents, audit, activities, notifications, sources,
  };
}

function nextSaturday(now: number, hour: number) {
  const d = new Date(now);
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function generateAll(now = Date.now()) {
  const orgs = ORG_CONFIGS.map((c) => c.org);
  const data = ORG_CONFIGS.map((c) => generateOrg(c, now));
  const merged = {} as OrgData;
  for (const key of Object.keys(data[0]) as (keyof OrgData)[]) {
    (merged[key] as unknown[]) = data.flatMap((d) => d[key] as unknown[]);
  }
  return { orgs, ...merged };
}

