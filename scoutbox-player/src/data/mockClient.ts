// Self-contained demo client — used when EXPO_PUBLIC_API_URL is not set.
// Simulates the server's behaviour (age gate, inbox flow, trust score) so the
// app demos without any backend. The real rules are enforced by
// scoutbox-server; this is a faithful imitation for demo mode only.

import type {
  PlayerClient, SignupInput, Me, AttendanceInput, DemoIdentity, ReportInput, ChildInput,
  Channel, AppNotification, Insights, FiledReport,
} from './types';
import { ClientError } from './types';
import type {
  Availability, ContractStatus, InboxRequest, ChildInboxItem, Guardian,
  GuardianInboxRequest, Drill, PlayerProfile,
} from '../domain/types';
import { adultAgeFor, ageOn, isAdult } from '../domain/safeguarding';
import { computeTrustScore, trustBreakdown } from '../domain/trustScore';

const players = new Map<string, PlayerProfile>();
const inboxes = new Map<string, InboxRequest[]>();
const guardians = new Map<string, Guardian>();
const guardianRequests: GuardianInboxRequest[] = [];
const channels: Channel[] = [];
const notificationsByAudience = new Map<string, AppNotification[]>(); // key: kind:id
const reportsByAudience = new Map<string, FiledReport[]>();
const scoutingEvents: { type: string; orgName: string; scoutName: string; playerId: string; ts: number }[] = [];
const commsLog: { id: string; ts: number; type: string; orgName: string; scoutName: string; playerId: string }[] = [];
const listeners = new Set<() => void>();
let idc = 100;
const nid = (p: string) => `${p}-${++idc}`;
const emit = () => listeners.forEach((l) => l());
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 100));

// Mirrors the server's moderation screen: no personal contact details,
// no off-platform contact.
const MOD_RES = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /(\+?\d[\d\s().-]{7,}\d)/,
  /(^|\s)@[a-z0-9_.]{3,}/i,
  /\b(whatsapp|snapchat|instagram|telegram|discord|tiktok|dm me|dms)\b/i,
  /\bhttps?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i,
];

function moderate(text: string) {
  if (MOD_RES.some((re) => re.test(text))) {
    throw new ClientError('MODERATION_BLOCKED', 'Blocked by moderation: personal contact details and off-platform contact are not allowed.');
  }
}

const DRILL_DEFS = [
  { id: 'drill-sprint-ladder', name: 'Sprint ladder — 6×30m' },
  { id: 'drill-passing-gates', name: 'Passing gates — both feet' },
  { id: 'drill-shooting-arc', name: 'Shooting arc — 20 finishes' },
  { id: 'drill-first-touch', name: 'First touch — wall rebounds' },
];

function isMinorProfile(p: PlayerProfile) {
  return !isAdult(p.dob, p.country);
}

function pushNotification(kind: 'player' | 'guardian', id: string, type: string, text: string) {
  const key = `${kind}:${id}`;
  const list = notificationsByAudience.get(key) ?? [];
  list.unshift({ id: nid('ntf'), ts: Date.now(), type, text, refId: null, read: false });
  notificationsByAudience.set(key, list);
  emit();
}

function notifications(kind: 'player' | 'guardian', id: string) {
  return notificationsByAudience.get(`${kind}:${id}`) ?? [];
}

function fileReport(kind: 'player' | 'guardian', id: string, input: ReportInput) {
  const key = `${kind}:${id}`;
  const list = reportsByAudience.get(key) ?? [];
  const filed: FiledReport = { ...input, id: nid('rep'), ts: Date.now(), status: 'pending_review', outcome: null, resolvedAt: null };
  list.unshift(filed);
  reportsByAudience.set(key, list);
  setTimeout(() => {
    filed.status = 'resolved';
    filed.resolvedAt = Date.now();
    filed.outcome = input.urgent
      ? 'Reviewed by the safety team. The suspension stands while we work with the organisation.'
      : 'Reviewed by the safety team. Logged against the record; we\'ll act on any pattern.';
    pushNotification(kind, id, 'report_resolved', 'Your report was reviewed — see the safety section for the outcome.');
  }, 20000);
  return filed;
}

function insightsFor(playerId: string): Insights {
  const events = scoutingEvents.filter((e) => e.playerId === playerId);
  const week = Date.now() - 7 * 86400000;
  const month = Date.now() - 30 * 86400000;
  const count = (list: typeof events, type: string) => list.filter((l) => l.type.startsWith(type)).length;
  const weekly = events.filter((l) => l.ts >= week);
  const monthly = events.filter((l) => l.ts >= month);
  const byOrg: Record<string, Insights['byOrg'][number]> = {};
  for (const l of events) {
    byOrg[l.orgName] ??= { orgName: l.orgName, views: 0, saves: 0, shortlists: 0, requests: 0, lastSeen: 0 };
    if (l.type === 'view') byOrg[l.orgName].views++;
    if (l.type === 'save') byOrg[l.orgName].saves++;
    if (l.type === 'shortlist') byOrg[l.orgName].shortlists++;
    if (l.type.includes('request')) byOrg[l.orgName].requests++;
    byOrg[l.orgName].lastSeen = Math.max(byOrg[l.orgName].lastSeen, l.ts);
  }
  return {
    thisWeek: { views: count(weekly, 'view'), saves: count(weekly, 'save'), shortlists: count(weekly, 'shortlist') },
    thisMonth: { views: count(monthly, 'view'), saves: count(monthly, 'save'), shortlists: count(monthly, 'shortlist') },
    byOrg: Object.values(byOrg).sort((a, b) => b.lastSeen - a.lastSeen),
    recent: events.slice(-12).reverse().map((l) => ({ type: l.type, orgName: l.orgName, scoutName: l.scoutName, ts: l.ts })),
  };
}

const ORG_REPLIES = [
  'Thanks for the quick reply — our recruitment desk will follow up with the details here.',
  'Perfect. We\'ll confirm the schedule in this thread; everything stays on ScoutBox.',
  'Noted. And yes — a full performance report is mandatory and will land on the profile.',
];

function scheduleOrgReply(channel: Channel, audienceKind: 'player' | 'guardian', audienceId: string) {
  const reply = ORG_REPLIES[channel.messages.length % ORG_REPLIES.length];
  setTimeout(() => {
    channel.messages.push({
      id: nid('msg'), ts: Date.now(),
      sender: { kind: 'org_user', id: 'demo-scout', name: `${channel.scoutName} · ${channel.scoutRole} · ${channel.orgName}` },
      text: reply,
    });
    pushNotification(audienceKind, audienceId, 'message', `${channel.orgName} (${channel.scoutRole}) sent a message.`);
    emit();
  }, 3500);
}

function seedDemoPlayer(): PlayerProfile {
  return {
    id: 'demo-adeyemi',
    name: 'Kola Adeyemi',
    dob: '2004-03-14',
    country: 'GB',
    city: 'Manchester',
    position: 'ST',
    foot: 'right',
    heightCm: 184,
    weightKg: 79,
    squadNumber: 22,
    contractUntil: '2026-06-30',
    marketValueRange: '€250K – €450K',
    agentName: 'Team Elevate',
    drills: [],
    stats: { appearances: 31, goals: 22, assists: 6, paceKmh: 34.1, passCompletionPct: 78, duelSuccessPct: 61 },
    academyPlus: true,
    badges: ['Finisher', 'Pressing Forward', 'Fresh Start'],
    availability: 'available_now',
    contractStatus: 'expiring_summer',
    identityVerified: true,
    attendance: [
      { id: 'att-1', fixture: 'Sunday League Cup Final', venue: 'Hough End Playing Fields', date: '2026-07-02', gps: { lat: 53.43, lng: -2.26 }, verified: true },
      { id: 'att-2', fixture: 'County Trial Day', venue: 'Platt Lane Complex', date: '2026-05-23', gps: { lat: 53.45, lng: -2.23 }, verified: true },
    ],
    timeline: [
      { year: '2019', event: 'Joined local academy U15s' },
      { year: '2022', event: 'Released at 18 — continued in county football' },
      { year: '2025', event: 'Top scorer, county premier division' },
    ],
    media: [
      { id: 'm1', title: 'Match highlights vs Riverside', kind: 'video', uploadedAt: new Date(Date.now() - 25 * 86400000).toISOString() },
      { id: 'm2', title: 'Sprint & finishing session', kind: 'video', uploadedAt: new Date(Date.now() - 80 * 86400000).toISOString() },
    ],
    trialReports: [],
    medical: {
      shared: false,
      conditionStatus: 'fully_fit',
      records: [
        { id: 'md-1', type: 'injury', title: 'Hamstring strain (grade 1)', date: '2025-11-02', layoffWeeks: 3, cleared: true },
        { id: 'md-2', type: 'clearance', title: 'Pre-season cardiac screen — clear', date: '2026-01-15', layoffWeeks: null, cleared: true },
      ],
    },
  };
}

function seedDemoChild(): PlayerProfile {
  return {
    id: 'demo-guni',
    name: 'Guni Adebayo',
    dob: '2012-02-10',
    country: 'GB',
    city: 'London',
    guardianId: 'demo-guardian',
    position: 'RW',
    foot: 'left',
    heightCm: 165,
    weightKg: 54,
    stats: { appearances: 18, goals: 12, assists: 7, paceKmh: 30.2, passCompletionPct: 74, duelSuccessPct: 44 },
    academyPlus: false,
    badges: [],
    availability: 'not_seeking',
    contractStatus: 'unknown',
    identityVerified: true,
    drills: [],
    attendance: [{ id: 'att-g1', fixture: 'U15 Academy League, week 12', venue: 'Hackney Marshes', date: '2026-07-14', gps: { lat: 51.55, lng: -0.02 }, verified: true }],
    timeline: [
      { year: '2024', event: 'Joined grassroots academy U13s' },
      { year: '2026', event: 'U15 league top scorer at 14' },
    ],
    media: [{ id: 'mg1', title: 'U15 highlights — wing play', kind: 'video', uploadedAt: new Date(Date.now() - 14 * 86400000).toISOString() }],
    trialReports: [],
    medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
  };
}

function ensureSeed() {
  if (!guardians.has('demo-guardian')) {
    guardians.set('demo-guardian', {
      id: 'demo-guardian',
      name: 'Amara Adebayo',
      email: 'amara.adebayo@example.com',
      idVerified: true,
      disclaimerAccepted: true,
      childIds: ['demo-guni'],
    });
    players.set('demo-guni', seedDemoChild());
    inboxes.set('demo-guni', []);
    // A verified club has already asked the guardian about a trial.
    guardianRequests.push({
      id: nid('req'),
      playerId: 'demo-guni',
      playerName: 'Guni Adebayo',
      type: 'trial',
      orgName: 'Eastport FC',
      orgType: 'club',
      orgVerified: true,
      trustedPartner: true,
      scoutName: 'Maria Keane',
      scoutRole: 'Head of Recruitment',
      message: 'Eastport FC has requested to discuss a trial for Guni. U15 assessment day, full performance report guaranteed.',
      status: 'pending',
      createdAt: Date.now() - 2 * 3600_000,
      contactChannel: null,
      routedTo: 'guardian',
    });
    commsLog.push({ id: nid('log'), ts: Date.now() - 2 * 3600_000, type: 'trial_request_to_guardian', orgName: 'Eastport FC', scoutName: 'Maria Keane', playerId: 'demo-guni' });
    // Seeded scouting activity so "Who's watching you" has a story to tell.
    const D = 86400000;
    scoutingEvents.push(
      { type: 'view', orgName: 'Eastport FC', scoutName: 'Maria Keane', playerId: 'demo-adeyemi', ts: Date.now() - 2 * D },
      { type: 'view', orgName: 'Eastport FC', scoutName: 'Maria Keane', playerId: 'demo-adeyemi', ts: Date.now() - 1 * D },
      { type: 'shortlist', orgName: 'Eastport FC', scoutName: 'Maria Keane', playerId: 'demo-adeyemi', ts: Date.now() - 1 * D },
      { type: 'view', orgName: 'Harbour City FC', scoutName: 'Coach D. Ansah', playerId: 'demo-adeyemi', ts: Date.now() - 5 * D },
      { type: 'save', orgName: 'Harbour City FC', scoutName: 'Coach D. Ansah', playerId: 'demo-adeyemi', ts: Date.now() - 5 * D },
      { type: 'view', orgName: 'Eastport FC', scoutName: 'Maria Keane', playerId: 'demo-guni', ts: Date.now() - 3 * D },
      { type: 'trial_request_to_guardian', orgName: 'Eastport FC', scoutName: 'Maria Keane', playerId: 'demo-guni', ts: Date.now() - 2 * 3600_000 },
    );
  }
  if (!players.has('demo-adeyemi')) {
    players.set('demo-adeyemi', seedDemoPlayer());
    inboxes.set('demo-adeyemi', [
      {
        id: nid('req'),
        type: 'contact',
        orgName: 'Harbour City FC',
        orgType: 'club',
        trustedPartner: false,
        scoutName: 'Coach D. Ansah',
        message: 'Watched your cup final highlights — strong movement. Our first-team coach would like a conversation.',
        status: 'pending',
        createdAt: Date.now() - 3600_000,
        contactChannel: null,
      },
    ]);
    // Demo liveliness: a trial request lands shortly after login.
    setTimeout(() => {
      const inbox = inboxes.get('demo-adeyemi');
      if (inbox && !inbox.some((r) => r.type === 'trial')) {
        inbox.unshift({
          id: nid('req'),
          type: 'trial',
          orgName: 'Eastport FC',
          orgType: 'club',
          trustedPartner: true,
          scoutName: 'Maria Keane',
          message: 'We run assessment trials monthly. Full performance report guaranteed — it goes on your profile.',
          status: 'pending',
          createdAt: Date.now(),
          contactChannel: null,
        });
        emit();
      }
    }, 8000);
  }
}

function getPlayer(playerId: string): PlayerProfile {
  ensureSeed();
  const p = players.get(playerId);
  if (!p) throw new ClientError('PLAYER_NOT_FOUND', 'No such player');
  return p;
}

export const mockClient: PlayerClient = {
  mode: 'demo',

  listDemoIdentities: async (): Promise<DemoIdentity[]> => {
    ensureSeed();
    return [
      { id: 'demo-adeyemi', name: 'Kola Adeyemi', position: 'ST' },
      { id: 'demo-guni', name: 'Guni Adebayo (14, child account)', position: 'RW' },
    ];
  },

  signup: (input: SignupInput) => {
    // Mirrors the server's 403 GUARDIAN_REQUIRED for minors.
    const required = adultAgeFor(input.country);
    if (ageOn(input.dob) < required) {
      throw new ClientError('GUARDIAN_REQUIRED', `Under-${required} profiles are owned by a parent or guardian. A guardian must verify their ID, accept the safeguarding disclaimer, and create the profile from their own account.`);
    }
    const p: PlayerProfile = {
      id: nid('demo'),
      name: input.name,
      dob: input.dob,
      country: input.country,
      city: input.city ?? '',
      position: input.position ?? null,
      foot: input.foot ?? null,
      heightCm: input.heightCm ?? null,
      weightKg: input.weightKg ?? null,
      stats: null,
      academyPlus: false,
      badges: [],
      availability: 'not_seeking',
      contractStatus: 'unknown',
      identityVerified: false,
      attendance: [],
      timeline: [],
      media: [],
      trialReports: [],
      medical: { shared: false, records: [], conditionStatus: 'unknown' },
    };
    players.set(p.id, p);
    inboxes.set(p.id, []);
    return delay({ playerId: p.id });
  },

  getMe: (playerId) => {
    const p = getPlayer(playerId);
    return delay<Me>({ ...p, age: ageOn(p.dob), trustScore: computeTrustScore(p), trust: trustBreakdown(p) });
  },

  getInbox: (playerId) => {
    const p = getPlayer(playerId);
    if (isMinorProfile(p)) {
      // A child's inbox is guardian-managed status only: no messages, ever.
      const items: ChildInboxItem[] = guardianRequests
        .filter((r) => r.playerId === playerId)
        .map((r) => ({
          id: r.id,
          type: r.type,
          orgName: r.orgName,
          orgVerified: r.orgVerified,
          status: r.status,
          guardianManaged: true,
          note:
            r.status === 'pending'
              ? `${r.orgName} contacted your parent/guardian about a ${r.type === 'trial' ? 'trial' : 'conversation'}. They will decide together with you.`
              : r.status === 'accepted'
                ? `Your parent/guardian accepted the ${r.type} with ${r.orgName}.`
                : `Your parent/guardian declined the ${r.type} with ${r.orgName}.`,
        }));
      return delay(items);
    }
    return delay((inboxes.get(playerId) ?? []).slice());
  },

  respond: (playerId, requestId, accept) => {
    const p = getPlayer(playerId);
    if (isMinorProfile(p)) throw new ClientError('GUARDIAN_MANAGED', 'This is managed by your parent or guardian.');
    const req = (inboxes.get(playerId) ?? []).find((r) => r.id === requestId);
    if (!req) throw new ClientError('REQUEST_NOT_FOUND', 'No such request');
    if (req.status !== 'pending') throw new ClientError('ALREADY_RESPONDED', 'Already responded');
    req.status = accept ? 'accepted' : 'declined';
    if (accept) {
      const channel: Channel = {
        id: nid('chan'), requestId: req.id, playerId, playerName: p.name,
        orgName: req.orgName, orgVerified: req.orgVerified, scoutName: req.scoutName, scoutRole: req.scoutRole ?? 'Scout',
        counterparty: 'player', createdAt: Date.now(), messages: [],
      };
      channels.push(channel);
      req.contactChannel = channel.id;
    }
    emit();
    return delay(undefined);
  },

  setAcademyPlus: (playerId, enabled) => {
    const p = getPlayer(playerId);
    if (isMinorProfile(p)) throw new ClientError('GUARDIAN_MANAGED', 'This setting is managed by your parent or guardian.');
    p.academyPlus = enabled;
    if (enabled && !p.badges.includes('Fresh Start')) p.badges.push('Fresh Start');
    if (!enabled) p.badges = p.badges.filter((b) => b !== 'Fresh Start');
    emit();
    return delay(undefined);
  },

  addMedia: (playerId, title, dataUrl) => {
    const p = getPlayer(playerId);
    moderate(title);
    // Demo mode keeps the data URL itself as the playable source.
    p.media.push({ id: nid('m'), title, kind: 'video', uploadedAt: new Date().toISOString(), ...(dataUrl ? { url: dataUrl } : {}) });
    emit();
    return delay(undefined);
  },

  mediaUrl: (path) => path ?? null,

  getChannels: (playerId) => {
    const p = getPlayer(playerId);
    if (isMinorProfile(p)) return delay([]); // threads live with the guardian
    return delay(channels.filter((c) => c.playerId === playerId && c.counterparty === 'player'));
  },

  sendMessage: (playerId, channelId, text) => {
    const p = getPlayer(playerId);
    if (isMinorProfile(p)) throw new ClientError('GUARDIAN_MANAGED', 'This is managed by your parent or guardian.');
    moderate(text);
    const channel = channels.find((c) => c.id === channelId && c.playerId === playerId);
    if (!channel) throw new ClientError('CHANNEL_NOT_FOUND', 'No such thread');
    channel.messages.push({ id: nid('msg'), ts: Date.now(), sender: { kind: 'player', id: playerId, name: p.name }, text });
    scheduleOrgReply(channel, 'player', playerId);
    emit();
    return delay(undefined);
  },

  getNotifications: (playerId) => delay(notifications('player', playerId).slice()),

  markNotificationsRead: (playerId) => {
    notifications('player', playerId).forEach((n) => { n.read = true; });
    emit();
    return delay(undefined);
  },

  getInsights: (playerId) => {
    getPlayer(playerId);
    return delay(insightsFor(playerId));
  },

  getMyReports: (playerId) => delay((reportsByAudience.get(`player:${playerId}`) ?? []).slice()),

  setMedicalShared: (playerId, shared) => {
    const p = getPlayer(playerId);
    if (isMinorProfile(p)) throw new ClientError('GUARDIAN_MANAGED', 'Medical sharing for under-18s is controlled by the guardian.');
    p.medical.shared = shared;
    emit();
    return delay(undefined);
  },

  setAvailability: (playerId, availability?: Availability, contractStatus?: ContractStatus) => {
    const p = getPlayer(playerId);
    if (isMinorProfile(p)) throw new ClientError('GUARDIAN_MANAGED', 'This setting is managed by your parent or guardian.');
    if (availability) p.availability = availability;
    if (contractStatus) p.contractStatus = contractStatus;
    emit();
    return delay(undefined);
  },

  addAttendance: (playerId, input: AttendanceInput) => {
    // Mirrors the server's ATTENDANCE_UNVERIFIABLE guard.
    if (!input.fixture || !input.venue || !input.date || !input.gps || !input.deviceId) {
      throw new ClientError('ATTENDANCE_UNVERIFIABLE', 'Verified attendance needs fixture, venue, date, GPS and device data.');
    }
    const p = getPlayer(playerId);
    p.attendance.push({ id: nid('att'), fixture: input.fixture, venue: input.venue, date: input.date, gps: input.gps, verified: true });
    emit();
    return delay(undefined);
  },

  addTimeline: (playerId, year, event) => {
    moderate(event);
    getPlayer(playerId).timeline.push({ year, event });
    emit();
    return delay(undefined);
  },

  updateStats: (playerId, stats) => {
    const p = getPlayer(playerId);
    p.stats = { appearances: 0, goals: 0, assists: 0, ...p.stats, ...stats };
    emit();
    return delay(undefined);
  },

  getDrills: (playerId) => {
    const p = getPlayer(playerId);
    return delay(DRILL_DEFS.map((d) => ({ ...d, completed: (p.drills ?? []).includes(d.id) })) as Drill[]);
  },

  completeDrill: (playerId, drillId) => {
    const p = getPlayer(playerId);
    p.drills = p.drills ?? [];
    if (!p.drills.includes(drillId)) p.drills.push(drillId);
    emit();
    return delay(undefined);
  },

  report: (playerId, input: ReportInput) => {
    getPlayer(playerId);
    commsLog.push({ id: nid('log'), ts: Date.now(), type: `report_${input.targetKind}`, orgName: input.targetOrgId ?? '', scoutName: input.targetScoutName ?? '', playerId });
    fileReport('player', playerId, input);
    emit();
    return delay(undefined);
  },

  block: (playerId, orgId) => {
    getPlayer(playerId);
    commsLog.push({ id: nid('log'), ts: Date.now(), type: 'org_blocked', orgName: orgId, scoutName: '', playerId });
    emit();
    return delay(undefined);
  },

  // ---- guardian surface ----
  guardianSignup: (name, email) => {
    const g: Guardian = { id: nid('gd'), name, email, idVerified: false, disclaimerAccepted: false, childIds: [] };
    guardians.set(g.id, g);
    return delay({ guardianId: g.id });
  },

  guardianLogin: (idOrEmail) => {
    ensureSeed();
    const g = [...guardians.values()].find((x) => x.id === idOrEmail || x.email === idOrEmail);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    return delay({ guardianId: g.id, guardian: g });
  },

  guardianMe: (guardianId) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    return delay(g);
  },

  guardianVerifyId: (guardianId, documentType, documentRef) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    if (!documentType || !documentRef) throw new ClientError('DOCUMENT_REQUIRED', 'ID verification needs a document type and reference.');
    g.idVerified = true;
    emit();
    return delay(undefined);
  },

  guardianAcceptDisclaimer: (guardianId) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    g.disclaimerAccepted = true;
    emit();
    return delay(undefined);
  },

  guardianChildren: (guardianId) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    return delay(
      g.childIds
        .map((id) => players.get(id))
        .filter((p): p is PlayerProfile => !!p)
        .map((p) => ({ ...p, age: ageOn(p.dob), trustScore: computeTrustScore(p), trust: trustBreakdown(p) }))
    );
  },

  guardianAddChild: (guardianId, input: ChildInput) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    if (!g.idVerified) throw new ClientError('GUARDIAN_ID_UNVERIFIED', 'Verify your identity before onboarding a child.');
    if (!g.disclaimerAccepted) throw new ClientError('DISCLAIMER_REQUIRED', 'Accept the safeguarding disclaimer before onboarding a child.');
    if (ageOn(input.dob) >= adultAgeFor(input.country)) throw new ClientError('NOT_A_MINOR', 'Adults create their own account with player sign-up.');
    const p: PlayerProfile = {
      id: nid('child'),
      name: input.name,
      dob: input.dob,
      country: input.country,
      city: '',
      guardianId: g.id,
      position: input.position ?? null,
      foot: input.foot ?? null,
      heightCm: null,
      weightKg: null,
      stats: null,
      academyPlus: false,
      badges: [],
      availability: 'not_seeking',
      contractStatus: 'unknown',
      identityVerified: false,
      drills: [],
      attendance: [],
      timeline: [],
      media: [],
      trialReports: [],
      medical: { shared: false, records: [], conditionStatus: 'unknown' },
    };
    players.set(p.id, p);
    g.childIds.push(p.id);
    emit();
    return delay({ playerId: p.id });
  },

  guardianInbox: (guardianId) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    return delay(guardianRequests.filter((r) => g.childIds.includes(r.playerId)).slice().reverse());
  },

  guardianRespond: (guardianId, requestId, accept) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    const r = guardianRequests.find((x) => x.id === requestId && g.childIds.includes(x.playerId));
    if (!r) throw new ClientError('REQUEST_NOT_FOUND', 'No such request');
    if (r.status !== 'pending') throw new ClientError('ALREADY_RESPONDED', 'Already responded');
    r.status = accept ? 'accepted' : 'declined';
    if (accept) {
      const channel: Channel = {
        id: nid('chan'), requestId: r.id, playerId: r.playerId, playerName: r.playerName ?? r.playerId,
        orgName: r.orgName, orgVerified: r.orgVerified, scoutName: r.scoutName, scoutRole: r.scoutRole ?? 'Scout',
        counterparty: 'guardian', createdAt: Date.now(), messages: [],
      };
      channels.push(channel);
      r.contactChannel = channel.id;
      pushNotification('player', r.playerId, 'update', `Your parent/guardian accepted the ${r.type} with ${r.orgName}.`);
    } else {
      pushNotification('player', r.playerId, 'update', `Your parent/guardian declined the ${r.type} with ${r.orgName}.`);
    }
    commsLog.push({ id: nid('log'), ts: Date.now(), type: `${r.type}_${accept ? 'accepted' : 'declined'}_by_guardian`, orgName: r.orgName, scoutName: r.scoutName, playerId: r.playerId });
    emit();
    return delay(undefined);
  },

  guardianChannels: (guardianId) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    return delay(channels.filter((c) => c.counterparty === 'guardian' && g.childIds.includes(c.playerId)));
  },

  guardianSendMessage: (guardianId, channelId, text) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    moderate(text);
    const channel = channels.find((c) => c.id === channelId && g.childIds.includes(c.playerId));
    if (!channel) throw new ClientError('CHANNEL_NOT_FOUND', 'No such thread');
    channel.messages.push({ id: nid('msg'), ts: Date.now(), sender: { kind: 'guardian', id: guardianId, name: g.name }, text });
    scheduleOrgReply(channel, 'guardian', guardianId);
    emit();
    return delay(undefined);
  },

  guardianNotifications: (guardianId) => delay(notifications('guardian', guardianId).slice()),

  guardianMarkNotificationsRead: (guardianId) => {
    notifications('guardian', guardianId).forEach((n) => { n.read = true; });
    emit();
    return delay(undefined);
  },

  guardianChildInsights: (guardianId, childId) => {
    const g = guardians.get(guardianId);
    if (!g || !g.childIds.includes(childId)) throw new ClientError('CHILD_NOT_FOUND', 'No such child.');
    return delay(insightsFor(childId));
  },

  guardianSetChildAvailability: (guardianId, childId, availability) => {
    const g = guardians.get(guardianId);
    if (!g || !g.childIds.includes(childId)) throw new ClientError('CHILD_NOT_FOUND', 'No such child.');
    players.get(childId)!.availability = availability;
    emit();
    return delay(undefined);
  },

  guardianAddCoGuardian: (guardianId, name, email) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    const co: Guardian = { id: nid('gd'), name, email, idVerified: false, disclaimerAccepted: false, childIds: [...g.childIds] };
    guardians.set(co.id, co);
    (g as Guardian & { coGuardians?: { id: string; name: string; email: string }[] }).coGuardians = [
      ...((g as Guardian & { coGuardians?: { id: string; name: string; email: string }[] }).coGuardians ?? []),
      { id: co.id, name, email },
    ];
    emit();
    return delay(undefined);
  },

  guardianReports: (guardianId) => delay((reportsByAudience.get(`guardian:${guardianId}`) ?? []).slice()),

  guardianLog: (guardianId) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    return delay(commsLog.filter((l) => g.childIds.includes(l.playerId)).slice().reverse());
  },

  guardianSetMedicalShared: (guardianId, childId, shared) => {
    const g = guardians.get(guardianId);
    if (!g || !g.childIds.includes(childId)) throw new ClientError('CHILD_NOT_FOUND', 'No such child.');
    players.get(childId)!.medical.shared = shared;
    emit();
    return delay(undefined);
  },

  guardianReport: (guardianId, input: ReportInput) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    commsLog.push({ id: nid('log'), ts: Date.now(), type: `report_${input.targetKind}${input.urgent ? '_urgent' : ''}`, orgName: input.targetOrgId ?? '', scoutName: input.targetScoutName ?? '', playerId: g.childIds[0] ?? '' });
    fileReport('guardian', guardianId, input);
    if (input.urgent) {
      for (const r of guardianRequests) {
        if (g.childIds.includes(r.playerId) && r.status === 'pending') r.status = 'suspended';
      }
    }
    emit();
    return delay(undefined);
  },

  guardianBlock: (guardianId, orgId, childId) => {
    const g = guardians.get(guardianId);
    if (!g) throw new ClientError('GUARDIAN_NOT_FOUND', 'No guardian account found.');
    commsLog.push({ id: nid('log'), ts: Date.now(), type: 'org_blocked_by_guardian', orgName: orgId, scoutName: '', playerId: childId ?? g.childIds[0] ?? '' });
    emit();
    return delay(undefined);
  },

  onChange: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
