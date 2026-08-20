// Self-contained in-browser demo client (used when VITE_DEMO=1, e.g. static
// demo builds where no server is reachable). It SIMULATES the server's rules
// so the demo behaves honestly — but it is a demo aid only. The product's
// guarantees live in scoutbox-server, which refuses at the API, not the UI.

import type {
  ScoutboxApi, Org, Session, Player, PlayerDetail, OrgRequest, Trial,
  LedgerEntry, ProofPack, PlanInfo, Reputation, SearchFilters,
  Channel, FiledReport, Notification, TrialDetails,
  FeedItem, FilmRoomItem, FixtureGroup, SavedSearch, OrgNote, SigningRecord,
} from './api';
import { ApiError } from './api';
// Sample footage baked into the demo bundle so the Film Room plays offline.
import clipSprint from './assets/clip-sprint.webm?inline';
import clipPassing from './assets/clip-passing.webm?inline';
import clipWingplay from './assets/clip-wingplay.webm?inline';

const SCOUT_TAGS = [
  'first_touch', 'pace', 'positioning', 'work_rate', 'left_foot', 'right_foot',
  'aerial', 'composure', 'vision', 'pressing', 'finishing', 'distribution',
];

const ORGS: Org[] = [
  { id: 'org-eastport', name: 'Eastport FC', type: 'club', plan: 'Pro', trustedPartner: true, verified: true, safeguardingCertified: true },
  { id: 'org-harbour', name: 'Harbour City FC', type: 'club', plan: 'Academy', trustedPartner: false, verified: false, safeguardingCertified: false },
  { id: 'org-northstar', name: 'North Star Sports Agency', type: 'agency', plan: 'Agency', trustedPartner: false, verified: false, safeguardingCertified: false },
];

// Mirrors the server's visibility rule: agencies never see minors; only
// verified clubs do. (Demo simulation — the real gate is scoutbox-server.)
const canSee = (p: Player, org: Org) => !p.guardianManaged || (org.type === 'club' && org.verified);

// Mirrors the server's moderation screen.
const MOD_RES = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /(\+?\d[\d\s().-]{7,}\d)/,
  /(^|\s)@[a-z0-9_.]{3,}/i,
  /\b(whatsapp|snapchat|instagram|telegram|discord|tiktok|dm me|dms)\b/i,
  /\bhttps?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i,
];

const PLANS: Record<string, PlanInfo['plan']> = {
  Academy: { name: 'Academy', pricePerMonthGBP: 99, seats: 3, attributionWindowMonths: 18, antiCircumvention: 'Any signing of a ScoutBox-discovered player within the attribution window, however contact was concluded, owes the discovery fee. Off-platform approaches to circumvent the ledger are a terms breach and forfeit Trusted Partner eligibility.' },
  Pro: { name: 'Pro', pricePerMonthGBP: 349, seats: 15, attributionWindowMonths: 24, antiCircumvention: 'Any signing of a ScoutBox-discovered player within the attribution window, however contact was concluded, owes the discovery fee. Off-platform approaches to circumvent the ledger are a terms breach and forfeit Trusted Partner eligibility.' },
  Agency: { name: 'Agency', pricePerMonthGBP: 499, seats: 10, attributionWindowMonths: 24, antiCircumvention: 'Agencies additionally warrant that no representation approach is made to any player who has not accepted a contact request, and never to a minor under any circumstances.' },
};

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();

function mkPlayer(p: Partial<Player> & { id: string; name: string }): Player {
  return {
    createdAt: NOW - 30 * DAY,
    age: 21, dob: '2004-01-01', country: 'GB', city: '', position: 'CM', foot: 'right',
    heightCm: 180, weightKg: 75, stats: { appearances: 25, goals: 5, assists: 5 },
    academyPlus: false, badges: [], availability: 'available_now', contractStatus: 'free_agent',
    identityVerified: true, trustScore: 50, attendance: [], timeline: [], media: [],
    trialReports: [], medical: { shared: false, records: [], conditionStatus: 'not_shared', note: 'Medical data is player-controlled and has not been shared.' },
    ...p,
  } as Player;
}

const PLAYERS: Player[] = [
  mkPlayer({
    id: 'pl-adeyemi', name: 'Kola Adeyemi', age: 22, dob: '2004-03-14', country: 'GB', city: 'Manchester',
    position: 'ST', foot: 'right', heightCm: 184, weightKg: 79,
    squadNumber: 22, contractUntil: '2026-06-30', marketValueRange: '€250K – €450K', agentName: 'Team Elevate',
    stats: { appearances: 31, goals: 22, assists: 6, paceKmh: 34.1, passCompletionPct: 78, duelSuccessPct: 61 },
    academyPlus: true, badges: ['Finisher', 'Pressing Forward'], availability: 'available_now', contractStatus: 'expiring_summer', trustScore: 59,
    attendance: [
      { id: 'att-1', fixture: 'Sunday League Cup Final', venue: 'Hough End Playing Fields', date: iso(NOW - 20 * DAY), gps: { lat: 53.43, lng: -2.26 }, verified: true },
      { id: 'att-2', fixture: 'County Trial Day', venue: 'Platt Lane Complex', date: iso(NOW - 60 * DAY), gps: { lat: 53.45, lng: -2.23 }, verified: true },
    ],
    timeline: [
      { year: '2019', event: 'Joined local academy U15s' },
      { year: '2022', event: 'Released at 18 — continued in county football' },
      { year: '2025', event: 'Top scorer, county premier division' },
    ],
    media: [
      { id: 'm1', title: 'Match highlights vs Riverside', kind: 'video', uploadedAt: iso(NOW - 25 * DAY), views: 3, tags: { finishing: 2, pace: 1 } },
      { id: 'm2', title: 'Sprint & finishing session', kind: 'video', uploadedAt: iso(NOW - 2 * DAY), url: clipSprint, views: 8, tags: { pace: 2 }, verifiedClip: 'att-1' },
    ],
    drillResults: [
      { id: 'cb1', drillId: 'drill-sprint-ladder', drillName: 'Sprint ladder — 6×30m', metric: 'best 30m time', unit: 's', value: 4.05, verified: true, ts: NOW - 6 * DAY },
      { id: 'cb2', drillId: 'drill-shooting-arc', drillName: 'Shooting arc — 20 finishes', metric: 'on-target finishes', unit: '/20', value: 15, verified: true, ts: NOW - 3 * DAY },
    ],
  }),
  mkPlayer({
    id: 'pl-carvalho', name: 'Mateus Carvalho', age: 23, dob: '2002-07-30', country: 'PT', city: 'Porto',
    position: 'CM', foot: 'left', heightCm: 176, weightKg: 71,
    stats: { appearances: 28, goals: 4, assists: 11, paceKmh: 31.2, passCompletionPct: 89, duelSuccessPct: 55 },
    academyPlus: true, badges: ['Deep Playmaker'], availability: 'end_of_season', contractStatus: 'under_contract', trustScore: 52,
    medical: { shared: true, conditionStatus: 'fully_fit', records: [{ id: 'md-3', type: 'clearance', title: 'Annual medical — clear', date: '2026-02-01', layoffWeeks: null, cleared: true }] },
    timeline: [{ year: '2020', event: 'Senior debut, district league' }, { year: '2024', event: 'Captain at 22' }],
    attendance: [{ id: 'att-3', fixture: 'District league round 18', venue: 'Campo do Bessa Anexo', date: iso(NOW - 12 * DAY), gps: { lat: 41.16, lng: -8.64 }, verified: true }],
    media: [{ id: 'm3', title: 'Passing range compilation', kind: 'video', uploadedAt: iso(NOW - 4 * DAY), url: clipPassing, views: 5, tags: { distribution: 1, vision: 1 }, verifiedClip: 'att-3' }],
  }),
  mkPlayer({
    id: 'pl-okafor', name: 'Chinedu Okafor', age: 22, dob: '2003-11-08', country: 'NG', city: 'Lagos',
    position: 'CB', foot: 'right', heightCm: 191, weightKg: 85,
    stats: { appearances: 24, goals: 2, assists: 1, paceKmh: 32.8, passCompletionPct: 82, duelSuccessPct: 72 },
    availability: 'overseas_open', contractStatus: 'free_agent', trustScore: 50,
    timeline: [{ year: '2021', event: 'Nationwide League One debut' }],
    attendance: [{ id: 'att-4', fixture: 'NLO fixture, matchday 9', venue: 'Agege Stadium', date: iso(NOW - 30 * DAY), gps: { lat: 6.62, lng: 3.32 }, verified: true }],
    media: [{ id: 'm4', title: 'Defensive duels reel', kind: 'video', uploadedAt: iso(NOW - 55 * DAY) }],
  }),
  mkPlayer({
    id: 'pl-svensson', name: 'Elias Svensson', age: 21, dob: '2005-01-22', country: 'SE', city: 'Göteborg',
    position: 'RW', foot: 'left', heightCm: 178, weightKg: 72,
    stats: { appearances: 26, goals: 9, assists: 12, paceKmh: 35.0, passCompletionPct: 81, duelSuccessPct: 49 },
    academyPlus: true, badges: ['Direct Winger', 'Fresh Start'], contractStatus: 'scholarship_ending', identityVerified: false, trustScore: 44,
    timeline: [{ year: '2023', event: 'Div 2 debut at 18' }, { year: '2025', event: 'Released from academy — Academy+ member' }],
    media: [{ id: 'm5', title: '1v1 and crossing clips', kind: 'video', uploadedAt: iso(NOW - 10 * DAY) }],
  }),
  mkPlayer({
    id: 'pl-martin', name: 'Théo Martin', age: 25, dob: '2001-05-03', country: 'FR', city: 'Lyon',
    position: 'GK', foot: 'right', heightCm: 193, weightKg: 88,
    stats: { appearances: 33, goals: 0, assists: 0, paceKmh: 29.5, passCompletionPct: 74, duelSuccessPct: 0, cleanSheets: 14 },
    availability: 'loan_open', contractStatus: 'under_contract', trustScore: 55,
    timeline: [{ year: '2019', event: 'Youth international (U18, 2 caps)' }, { year: '2023', event: 'N3 first choice' }],
    attendance: [{ id: 'att-5', fixture: 'National 3, round 21', venue: 'Stade de Balmont', date: iso(NOW - 8 * DAY), gps: { lat: 45.79, lng: 4.79 }, verified: true }],
  }),
  mkPlayer({
    id: 'pl-tanaka', name: 'Riku Tanaka', age: 21, dob: '2004-09-17', country: 'JP', city: 'Osaka',
    position: 'CAM', foot: 'right', heightCm: 172, weightKg: 66,
    stats: { appearances: 29, goals: 11, assists: 9, paceKmh: 32.4, passCompletionPct: 86, duelSuccessPct: 51 },
    availability: 'not_seeking', contractStatus: 'under_contract', trustScore: 55,
    timeline: [{ year: '2022', event: 'JFL debut' }],
    attendance: [{ id: 'att-6', fixture: 'JFL matchday 4', venue: 'Nagai Aid Stadium', date: iso(NOW - 45 * DAY), gps: { lat: 34.61, lng: 135.51 }, verified: true }],
    media: [{ id: 'm6', title: 'Set-piece deliveries', kind: 'video', uploadedAt: iso(NOW - 90 * DAY) }],
  }),
  mkPlayer({
    id: 'pl-alvarez', name: 'Santiago Álvarez', age: 23, dob: '2003-02-11', country: 'AR', city: 'Rosario',
    position: 'LB', foot: 'left', heightCm: 175, weightKg: 70,
    stats: { appearances: 27, goals: 1, assists: 7, paceKmh: 33.6, passCompletionPct: 84, duelSuccessPct: 63 },
    academyPlus: true, badges: ['Overlapping Full-back'], availability: 'overseas_open', contractStatus: 'expiring_summer', trustScore: 52,
    timeline: [{ year: '2021', event: 'Regional league debut' }, { year: '2024', event: 'Team of the season' }],
    attendance: [{ id: 'att-7', fixture: 'Torneo Regional, fecha 12', venue: 'Estadio Gabino Sosa', date: iso(NOW - 15 * DAY), gps: { lat: -32.96, lng: -60.66 }, verified: true }],
    media: [{ id: 'm7', title: 'Crossing under pressure', kind: 'video', uploadedAt: iso(NOW - 33 * DAY) }],
  }),
  mkPlayer({
    id: 'pl-nowak', name: 'Filip Nowak', age: 25, dob: '2000-12-05', country: 'PL', city: 'Kraków',
    position: 'CDM', foot: 'right', heightCm: 183, weightKg: 78,
    stats: { appearances: 30, goals: 3, assists: 4, paceKmh: 31.8, passCompletionPct: 88, duelSuccessPct: 68 },
    availability: 'end_of_season', contractStatus: 'release_approaching', trustScore: 57,
    medical: { shared: true, conditionStatus: 'fully_fit', records: [{ id: 'md-5', type: 'injury', title: 'Ankle syndesmosis sprain', date: '2025-04-10', layoffWeeks: 8, cleared: true }] },
    timeline: [{ year: '2019', event: 'Senior debut' }, { year: '2025', event: '100th appearance' }],
    attendance: [{ id: 'att-8', fixture: 'III liga, round 24', venue: 'Stadion Miejski Wieczysta', date: iso(NOW - 5 * DAY), gps: { lat: 50.08, lng: 19.98 }, verified: true }],
    media: [{ id: 'm8', title: 'Screening & interceptions', kind: 'video', uploadedAt: iso(NOW - 70 * DAY) }],
  }),
  mkPlayer({
    id: 'pl-mensah', name: 'Kwame Mensah', age: 21, dob: '2005-06-28', country: 'GH', city: 'Kumasi',
    position: 'LW', foot: 'right', heightCm: 174, weightKg: 68,
    stats: { appearances: 22, goals: 8, assists: 5, paceKmh: 34.7, passCompletionPct: 76, duelSuccessPct: 47 },
    academyPlus: true, badges: ['Fresh Start'], identityVerified: false, trustScore: 42,
    timeline: [{ year: '2023', event: 'Division One League debut' }],
    media: [{ id: 'm9', title: 'Dribbling sequences', kind: 'video', uploadedAt: iso(NOW - 18 * DAY) }],
  }),
  mkPlayer({
    id: 'pl-guni', name: 'Guni Adebayo', age: 14, dob: null, country: 'GB', city: '',
    createdAt: NOW - 3 * DAY,
    position: 'RW', foot: 'left', heightCm: 165, weightKg: 54,
    guardianManaged: true, contactPolicy: 'guardian_only',
    stats: { appearances: 18, goals: 12, assists: 7, paceKmh: 30.2, passCompletionPct: 74, duelSuccessPct: 44 },
    availability: 'not_seeking', contractStatus: 'unknown', trustScore: 52,
    timeline: [{ year: '2024', event: 'Joined grassroots academy U13s' }, { year: '2026', event: 'U15 league top scorer at 14' }],
    attendance: [{ id: 'att-g1', fixture: 'U15 Academy League, week 12', venue: 'Hackney Marshes', date: iso(NOW - 9 * DAY), gps: { lat: 51.55, lng: -0.02 }, verified: true }],
    media: [{ id: 'mg1', title: 'U15 highlights — wing play', kind: 'video', uploadedAt: iso(NOW - 2 * DAY), url: clipWingplay, views: 2, tags: {}, verifiedClip: 'att-g1' }],
  }),
  mkPlayer({
    id: 'pl-tomasz', name: 'Tomasz Kowalski', age: 16, dob: null, country: 'PL', city: '',
    position: 'CM', foot: 'right', heightCm: 175, weightKg: 64,
    guardianManaged: true, contactPolicy: 'guardian_only',
    stats: { appearances: 21, goals: 5, assists: 9, paceKmh: 31.0, passCompletionPct: 85, duelSuccessPct: 52 },
    availability: 'not_seeking', contractStatus: 'unknown', trustScore: 52,
    timeline: [{ year: '2023', event: 'Youth academy midfielder' }, { year: '2026', event: 'U17 central league debut at 16' }],
    attendance: [{ id: 'att-t1', fixture: 'CLJ U17, round 15', venue: 'Stadion Traugutta', date: iso(NOW - 6 * DAY), gps: { lat: 54.38, lng: 18.62 }, verified: true }],
    media: [{ id: 'mt1', title: 'U17 passing & pressing reel', kind: 'video', uploadedAt: iso(NOW - 20 * DAY) }],
  }),
  mkPlayer({
    id: 'pl-kim', name: 'Kim Min-jae', age: 20, dob: '2006-04-02', country: 'KR', city: 'Busan',
    position: 'CF', foot: 'right', heightCm: 186, weightKg: 80,
    stats: { appearances: 19, goals: 13, assists: 2, paceKmh: 33.9, passCompletionPct: 72, duelSuccessPct: 58 },
    trustScore: 55,
    timeline: [{ year: '2024', event: 'K4 debut at 18' }],
    attendance: [{ id: 'att-9', fixture: 'K4 League round 7', venue: 'Gudeok Stadium', date: iso(NOW - 22 * DAY), gps: { lat: 35.16, lng: 129.02 }, verified: true }],
    media: [{ id: 'm10', title: 'Hold-up play & finishing', kind: 'video', uploadedAt: iso(NOW - 12 * DAY) }],
  }),
];

function iso(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

// Mutable demo state
let idc = 5000;
const nid = (p: string) => `${p}-${++idc}`;
const requests: OrgRequest[] = [];
const trials: Trial[] = [];
const channels: Channel[] = [];
const notifications: Notification[] = [];
const myReports: FiledReport[] = [];
const savedSearches: SavedSearch[] = [];
const orgNotes: OrgNote[] = [];
const ledger: (LedgerEntry & { playerName?: string })[] = [];
const listeners = new Set<(e: string, payload?: Record<string, unknown>) => void>();
const emit = (e: string, payload?: Record<string, unknown>) => listeners.forEach((l) => l(e, payload));

// Cross-tab sync: when the player demo runs in another tab of the same
// browser, requests/responses/messages flow for real; the simulated
// counterparty only steps in when no player tab is present.
import { createDemoBus, type BusEvent } from './demoSync';

function ensureChannelFromMeta(meta: Record<string, unknown>): Channel {
  let channel = channels.find((c) => c.id === meta.channelId);
  if (!channel) {
    channel = {
      id: String(meta.channelId),
      requestId: String(meta.requestId ?? ''),
      playerId: String(meta.playerId ?? ''),
      playerName: String(meta.playerName ?? meta.playerId ?? ''),
      orgName: String(meta.orgName ?? 'Eastport FC'),
      scoutName: String(meta.scoutName ?? ''),
      scoutRole: String(meta.scoutRole ?? 'Scout'),
      counterparty: (meta.counterparty === 'guardian' ? 'guardian' : 'player'),
      createdAt: Date.now(),
      messages: [],
      readBy: { org: null, counterparty: null },
    };
    channels.push(channel);
  }
  return channel;
}

const bus = createDemoBus('club', (e: BusEvent) => {
  const p = e.payload;
  if (e.kind === 'respond') {
    const req = requests.find((r) => r.id === p.requestId);
    if (!req || req.status !== 'pending') return;
    req.status = p.accept ? 'accepted' : 'declined';
    if (p.accept) {
      const channel = ensureChannelFromMeta({ ...p, requestId: req.id, playerId: req.playerId, playerName: req.playerName, scoutName: req.scoutName, scoutRole: req.scoutRole, counterparty: req.routedTo });
      req.contactChannel = channel.id;
      if (req.type === 'trial') {
        const target = PLAYERS.find((x) => x.id === req.playerId);
        trials.push({
          id: `trial-${req.id}`, playerId: req.playerId, playerName: target?.name ?? req.playerName ?? req.playerId,
          scoutName: req.scoutName, acceptedAt: Date.now(),
          proposedDate: (p.chosenSlot as string) ?? null, venue: null, notes: '',
          reportDueAt: Date.now() + 7 * DAY, guardianApproved: req.routedTo === 'guardian',
          status: 'awaiting_report',
        });
      }
      pushNotification(`${req.routedTo === 'guardian' ? `The guardian of ${req.playerName}` : req.playerName} accepted your ${req.type} request — thread open.`, 'accepted');
    } else {
      pushNotification(`${req.routedTo === 'guardian' ? `The guardian of ${req.playerName}` : req.playerName} declined your ${req.type} request.`, 'declined');
    }
    emit('requests');
  }
  if (e.kind === 'message') {
    const channel = ensureChannelFromMeta(p);
    const msg = p.message as Channel['messages'][number];
    if (msg && !channel.messages.some((m) => m.id === msg.id)) {
      channel.messages.push(msg);
      pushNotification(`${msg.sender.name} replied in the ${channel.playerName} thread.`, 'message');
      emit('messages', { channelId: channel.id });
    }
  }
  if (e.kind === 'read') {
    const channel = channels.find((c) => c.id === p.channelId);
    if (channel && p.side !== 'org') {
      channel.readBy = { ...(channel.readBy ?? { org: null, counterparty: null }), counterparty: Number(p.ts) || Date.now() };
      emit('messages', { channelId: channel.id });
    }
  }
  if (e.kind === 'typing' && p.side !== 'org') {
    emit('typing', { channelId: p.channelId, side: 'counterparty' });
  }
});

function pushNotification(text: string, type = 'update') {
  notifications.unshift({ id: nid('ntf'), ts: Date.now(), type, text, refId: null, read: false });
  emit('notify');
}

// Simulated counterparty replies keep demo threads alive.
const CANNED_REPLIES: Record<'player' | 'guardian', string[]> = {
  player: [
    'Thanks — really pleased you got in touch. What does the next step look like?',
    'That works for me. Anything I should prepare?',
    'Sounds good. My current club knows I am talking to you.',
  ],
  guardian: [
    'Thank you for going through ScoutBox. Could you tell me who will be present at the session?',
    'That date works for us. Guni is excited — what should we bring?',
    'Before we confirm: will a full performance report be filed afterwards?',
  ],
};

function log(s: Session, type: string, playerId: string): LedgerEntry {
  const row: LedgerEntry = { id: nid('led'), ts: Date.now(), type, playerId, orgId: s.org.id, orgName: s.org.name, userId: s.userId, scoutName: s.scoutName };
  ledger.push(row);
  emit('ledger');
  return row;
}

const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 120));

function similarity(a: Player, b: Player): number {
  let score = 0;
  if (a.position === b.position) score += 35;
  if (a.foot === b.foot) score += 10;
  score += Math.max(0, 15 - Math.abs(a.age - b.age) * 3);
  const out = (p: Player) => ((p.stats?.goals ?? 0) + (p.stats?.assists ?? 0)) / (p.stats?.appearances || 1);
  score += Math.max(0, 25 - Math.abs(out(a) - out(b)) * 25);
  score += Math.max(0, 15 - (Math.abs(a.heightCm - b.heightCm) / 2 + Math.abs(a.weightKg - b.weightKg) / 3));
  return Math.round(Math.min(score, 100));
}

export const demoApi: ScoutboxApi = {
  listOrgs: () => delay(ORGS),

  login: (orgId, scoutName, role) => {
    const org = ORGS.find((o) => o.id === orgId);
    if (!org) throw new ApiError(404, 'ORG_NOT_FOUND', 'Unknown org');
    if (!scoutName.trim()) throw new ApiError(400, 'SCOUT_NAME_REQUIRED', 'Every session is attributed to a named individual.');
    return delay({ org, userId: nid('usr'), scoutName: scoutName.trim(), role: role || 'Scout' });
  },

  report: (s, input) => {
    log(s, `report_${input.targetKind}`, input.targetPlayerId ?? 'n/a');
    const filed: FiledReport = { ...input, id: nid('rep'), ts: Date.now(), status: 'pending_review', outcome: null, resolvedAt: null };
    myReports.unshift(filed);
    setTimeout(() => {
      filed.status = 'resolved';
      filed.resolvedAt = Date.now();
      filed.outcome = 'Reviewed by the safety team. Logged against the record; we\'ll act on any pattern.';
      pushNotification('Your report was reviewed — see Report / Block for the outcome.', 'report_resolved');
    }, 20000);
    return delay(undefined);
  },

  searchPlayers: (s, f: SearchFilters) => {
    // Mirrors the server: agencies and unverified clubs never see minors.
    let list = PLAYERS.filter((p) => canSee(p, s.org));
    if (f.q) {
      const n = f.q.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(n) || p.city.toLowerCase().includes(n) || p.country.toLowerCase().includes(n));
    }
    if (f.position) list = list.filter((p) => p.position === f.position);
    if (f.availability) list = list.filter((p) => p.availability === f.availability);
    if (f.academyPlus) list = list.filter((p) => p.academyPlus);
    if (f.country) list = list.filter((p) => p.country === f.country);
    if (f.ageGroup === 'u16') list = list.filter((p) => p.age < 16);
    if (f.ageGroup === 'u18') list = list.filter((p) => p.age < 18);
    if (f.ageGroup === '18-21') list = list.filter((p) => p.age >= 18 && p.age <= 21);
    if (f.ageGroup === 'senior') list = list.filter((p) => p.age >= 22);
    if (f.newDays) {
      const cutoff = Date.now() - f.newDays * 24 * 3600 * 1000;
      list = list.filter((p) => p.createdAt && p.createdAt >= cutoff);
    }
    list.sort((a, b) => (b.academyPlus ? 1 : 0) - (a.academyPlus ? 1 : 0) || b.trustScore - a.trustScore);
    return delay(list);
  },

  getPlayer: (s, id) => {
    const p = PLAYERS.find((x) => x.id === id);
    if (!p) throw new ApiError(404, 'PLAYER_NOT_FOUND', 'No such player');
    if (!canSee(p, s.org)) {
      throw s.org.type === 'agency'
        ? new ApiError(403, 'UNDER_18_WALL', 'Agency accounts cannot view minors.')
        : new ApiError(403, 'VERIFIED_CLUBS_ONLY', 'Under-18 profiles are visible to verified clubs only.');
    }
    log(s, 'view', id);
    const notes = orgNotes.filter((n) => n.playerId === id);
    const similar = PLAYERS.filter((c) => c.id !== id && canSee(c, s.org))
      .map((c) => ({ playerId: c.id, name: c.name, position: c.position, score: similarity(p, c) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const detail: PlayerDetail = {
      ...p,
      orgNotes: notes,
      similarPlayers: {
        note: 'Statistical similarity — a lead, not a verdict.',
        players: similar,
        archetypes: [
          { archetypeId: 'arch', label: p.position === 'GK' ? 'Sweeper keeper' : p.position === 'CB' ? 'Ball-playing centre-back' : ['ST', 'CF'].includes(p.position) ? 'Pressing forward' : ['RW', 'LW'].includes(p.position) ? 'Direct winger' : 'Deep-lying playmaker', score: 70 + (p.trustScore % 20) },
        ],
      },
    };
    return delay(detail);
  },

  act: (s, playerId, action) => {
    log(s, action, playerId);
    return delay(undefined);
  },

  getShortlist: (s) => {
    const ids = new Set(ledger.filter((l) => l.orgId === s.org.id && l.type === 'shortlist').map((l) => l.playerId));
    return delay(PLAYERS.filter((p) => ids.has(p.id)));
  },

  sendRequest: (s, playerId, type, message, details?: TrialDetails) => {
    if (type === 'trial' && trials.some((t) => t.status === 'awaiting_report')) {
      throw new ApiError(409, 'REPORTS_OUTSTANDING', 'You have trials awaiting a mandatory performance report. File them before requesting new trials.');
    }
    if (MOD_RES.some((re) => re.test(message))) {
      throw new ApiError(400, 'MODERATION_BLOCKED', 'This text was blocked by moderation: personal contact details and off-platform contact are not allowed.');
    }
    const target = PLAYERS.find((x) => x.id === playerId);
    const req: OrgRequest = {
      id: nid('req'), playerId, playerName: target?.name, type, message, status: 'pending',
      scoutName: s.scoutName, scoutRole: s.role, createdAt: Date.now(),
      routedTo: target?.guardianManaged ? 'guardian' : 'player', contactChannel: null,
    };
    requests.push(req);
    log(s, `${type}_request${target?.guardianManaged ? '_to_guardian' : ''}`, playerId);
    bus.publish('request', {
      id: req.id, playerId, playerName: target?.name, type, message,
      trialDetails: details ?? null,
      orgName: s.org.name, orgVerified: s.org.verified, orgSafeguardingCertified: s.org.safeguardingCertified,
      trustedPartner: s.org.trustedPartner, scoutName: s.scoutName, scoutRole: s.role,
      routedTo: req.routedTo, createdAt: req.createdAt,
    });
    // A real player/guardian tab answers for itself; the simulated
    // counterparty only steps in when nobody is there.
    if (bus.peerActive()) return delay(undefined);
    setTimeout(() => {
      if (req.status !== 'pending') return;
      req.status = 'accepted';
      const counterparty = target?.guardianManaged ? 'guardian' as const : 'player' as const;
      const channel: Channel = {
        id: nid('chan'), requestId: req.id, playerId, playerName: target?.name ?? playerId,
        orgName: s.org.name, scoutName: s.scoutName, scoutRole: s.role,
        counterparty, createdAt: Date.now(), messages: [],
      };
      channels.push(channel);
      req.contactChannel = channel.id;
      log(s, `${type}_accepted`, playerId);
      pushNotification(
        counterparty === 'guardian'
          ? `The guardian of ${target?.name} accepted your ${type} request — thread open.`
          : `${target?.name} accepted your ${type} request — thread open.`,
        'accepted'
      );
      if (type === 'trial') {
        const p = PLAYERS.find((x) => x.id === playerId)!;
        trials.push({
          id: nid('trial'), playerId, playerName: p.name, scoutName: s.scoutName, acceptedAt: Date.now(),
          proposedDate: details?.proposedDate ?? null, venue: details?.venue ?? null, notes: details?.notes ?? '',
          reportDueAt: (details?.proposedDate ? new Date(details.proposedDate).getTime() : Date.now()) + 7 * 24 * 3600 * 1000,
          guardianApproved: counterparty === 'guardian',
          status: 'awaiting_report',
        });
      }
      emit('requests');
    }, 4000);
    return delay(undefined);
  },

  getChannels: (s) => delay(channels.slice()),

  sendMessage: (s, channelId, text, attachTrialReportId) => {
    if (MOD_RES.some((re) => re.test(text))) {
      throw new ApiError(400, 'MODERATION_BLOCKED', 'Blocked by moderation: personal contact details and off-platform contact are not allowed.');
    }
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) throw new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such thread');
    let attachment = null;
    if (attachTrialReportId) {
      const trial = trials.find((t) => t.report?.id === attachTrialReportId);
      const r = trial?.report;
      if (r) {
        attachment = {
          kind: 'trial_report' as const, reportId: r.id, orgName: s.org.name,
          summary: `accel ${r.acceleration}/10 · ${r.sprintSpeedKmh} km/h · ${r.distanceKm} km · pass ${r.passCompletionPct}% · duels ${r.duelSuccessPct}% · coach ${r.coachRating}/10`,
        };
      }
    }
    const outgoing = { id: nid('msg'), ts: Date.now(), sender: { kind: 'org_user' as const, id: s.userId, name: `${s.scoutName} · ${s.role} · ${s.org.name}` }, text, attachment };
    channel.messages.push(outgoing);
    log(s, 'message', channel.playerId);
    bus.publish('message', {
      channelId: channel.id, requestId: channel.requestId, playerId: channel.playerId,
      playerName: channel.playerName, orgName: channel.orgName, scoutName: channel.scoutName,
      scoutRole: channel.scoutRole, counterparty: channel.counterparty, message: outgoing,
    });
    if (bus.peerActive()) return delay(undefined);
    // Simulated counterparty: typing ping, then a reply, then a read receipt.
    setTimeout(() => emit('typing', { channelId: channel.id, side: 'counterparty' }), 1500);
    const replies = CANNED_REPLIES[channel.counterparty];
    const reply = replies[channel.messages.length % replies.length];
    setTimeout(() => {
      channel.messages.push({
        id: nid('msg'), ts: Date.now(),
        sender: {
          kind: channel.counterparty === 'guardian' ? 'guardian' : 'player',
          id: 'demo',
          name: channel.counterparty === 'guardian' ? `Guardian of ${channel.playerName}` : channel.playerName,
        },
        text: reply,
      });
      channel.readBy = { ...(channel.readBy ?? { org: null, counterparty: null }), counterparty: Date.now() };
      pushNotification(`${channel.counterparty === 'guardian' ? `The guardian of ${channel.playerName}` : channel.playerName} replied in your thread.`, 'message');
      emit('messages');
    }, 3500);
    return delay(undefined);
  },

  markChannelRead: (s, channelId) => {
    const channel = channels.find((c) => c.id === channelId);
    if (channel) {
      const ts = Date.now();
      channel.readBy = { ...(channel.readBy ?? { org: null, counterparty: null }), org: ts };
      bus.publish('read', { channelId, side: 'org', ts });
    }
    return delay(undefined);
  },

  sendTyping: (s, channelId) => {
    bus.publish('typing', { channelId, side: 'org' });
    return delay(undefined);
  },

  getFeed: (s) => {
    const FOURTEEN_DAYS = Date.now() - 14 * DAY;
    const shortlisted = new Set(ledger.filter((l) => l.orgId === s.org.id && (l.type === 'shortlist' || l.type === 'save')).map((l) => l.playerId));
    const items: FeedItem[] = [];
    for (const p of PLAYERS.filter((x) => canSee(x, s.org))) {
      if (p.createdAt && p.createdAt >= FOURTEEN_DAYS) {
        items.push({ type: 'new_player', ts: p.createdAt, playerId: p.id, playerName: p.name, position: p.position, age: p.age, guardianManaged: p.guardianManaged });
      }
      for (const m of p.media) {
        const ts = new Date(m.uploadedAt).getTime();
        if (ts >= FOURTEEN_DAYS) {
          items.push({
            type: shortlisted.has(p.id) ? 'shortlist_new_clip' : 'new_clip',
            ts, playerId: p.id, playerName: p.name, mediaId: m.id, title: m.title,
            hasVideo: !!m.url, verifiedClip: !!m.verifiedClip,
          });
        }
      }
    }
    for (const t of trials.filter((x) => x.status === 'awaiting_report')) {
      items.push({ type: 'report_due', ts: t.reportDueAt ?? Date.now(), playerId: t.playerId, playerName: t.playerName, trialId: t.id, dueAt: t.reportDueAt });
    }
    items.sort((a, b) => b.ts - a.ts);
    return delay(items);
  },

  getFilmRoom: (s) => {
    const deck: FilmRoomItem[] = [];
    for (const p of PLAYERS.filter((x) => canSee(x, s.org))) {
      for (const m of p.media) {
        if (!m.url) continue;
        deck.push({
          media: { id: m.id, title: m.title, url: m.url, views: m.views ?? 0, verifiedClip: m.verifiedClip ?? null, tags: m.tags ?? {} },
          player: { id: p.id, name: p.name, position: p.position, age: p.age, trustScore: p.trustScore, academyPlus: p.academyPlus, guardianManaged: !!p.guardianManaged },
        });
      }
    }
    deck.sort((a, b) => (b.media.verifiedClip ? 1 : 0) - (a.media.verifiedClip ? 1 : 0) || b.media.views - a.media.views);
    return delay(deck);
  },

  recordClipView: (s, playerId, mediaId) => {
    const m = PLAYERS.find((p) => p.id === playerId)?.media.find((x) => x.id === mediaId);
    if (m) m.views = (m.views ?? 0) + 1;
    return delay(undefined);
  },

  tagClip: (s, playerId, mediaId, tags) => {
    const m = PLAYERS.find((p) => p.id === playerId)?.media.find((x) => x.id === mediaId);
    if (!m) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'No such clip');
    m.tags ??= {};
    for (const t of tags) m.tags[t] = (m.tags[t] ?? 0) + 1;
    log(s, 'clip_tagged', playerId);
    return delay(undefined);
  },

  getScoutTags: () => delay(SCOUT_TAGS),

  getSavedSearches: (s) => delay(savedSearches.slice()),

  saveSearch: (s, name, filters) => {
    savedSearches.push({ id: nid('ss'), name, scoutName: s.scoutName, filters, createdAt: Date.now() });
    return delay(undefined);
  },

  deleteSavedSearch: (s, id) => {
    const i = savedSearches.findIndex((x) => x.id === id);
    if (i >= 0) savedSearches.splice(i, 1);
    return delay(undefined);
  },

  addNote: (s, playerId, text) => {
    orgNotes.push({ id: nid('note'), playerId, scoutName: s.scoutName, text, ts: Date.now() });
    return delay(undefined);
  },

  moreLikeThis: (s, playerId) => {
    const base = PLAYERS.find((p) => p.id === playerId);
    if (!base) throw new ApiError(404, 'PLAYER_NOT_FOUND', 'No such player');
    const players = PLAYERS.filter((c) => c.id !== playerId && canSee(c, s.org))
      .map((c) => ({ ...c, similarity: similarity(base, c) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10);
    return delay({ base: { name: base.name }, players });
  },

  recordSigning: (s, playerId) => {
    const p = PLAYERS.find((x) => x.id === playerId);
    if (!p) throw new ApiError(404, 'PLAYER_NOT_FOUND', 'No such player');
    p.contractStatus = 'under_contract';
    p.availability = 'not_seeking';
    p.timeline.push({ year: '2026', event: `Signed by ${s.org.name} — discovered on ScoutBox` });
    log(s, 'signing', playerId);
    const signing: SigningRecord = {
      id: nid('sign'), playerId, playerName: p.name, scoutName: s.scoutName,
      ts: Date.now(), attributionWindowMonths: 24, insideAttributionWindow: true,
    };
    pushNotification(`Signing of ${p.name} recorded — attribution evidence frozen.`, 'signing');
    return delay(signing);
  },

  trialIcsUrl: () => null, // downloads need the live server

  getFixtures: (s) => {
    const groups: Record<string, FixtureGroup> = {};
    for (const p of PLAYERS.filter((x) => canSee(x, s.org))) {
      for (const a of p.attendance) {
        const key = `${a.fixture}|${a.date}`;
        groups[key] ??= { fixture: a.fixture, venue: a.venue, date: a.date, players: [] };
        groups[key].players.push({ id: p.id, name: p.name, position: p.position, age: p.age, trustScore: p.trustScore });
      }
    }
    return delay(Object.values(groups).sort((a, b) => (a.date < b.date ? 1 : -1)));
  },

  getNotifications: (s) => delay(notifications.slice()),

  markNotificationsRead: (s) => {
    notifications.forEach((n) => { n.read = true; });
    return delay(undefined);
  },

  getMyReports: (s) => delay(myReports.slice()),

  mediaUrl: (path) => path ?? null,

  getRequests: (s) => delay(requests.slice()),
  getTrials: (s) => delay(trials.slice()),

  fileTrialReport: (s, trialId, report) => {
    const required = ['acceleration', 'sprintSpeedKmh', 'distanceKm', 'passCompletionPct', 'duelSuccessPct', 'coachRating'];
    const missing = required.filter((f) => report[f] === undefined || report[f] === null || report[f] === '' || Number.isNaN(report[f]));
    if (missing.length) {
      throw new ApiError(400, 'REPORT_INCOMPLETE', `Trial performance reports are mandatory and must be complete. Missing: ${missing.join(', ')}`);
    }
    const trial = trials.find((t) => t.id === trialId);
    if (!trial) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial');
    if (trial.status === 'reported') throw new ApiError(409, 'ALREADY_REPORTED', 'Report already filed');
    trial.status = 'reported';
    const p = PLAYERS.find((x) => x.id === trial.playerId)!;
    const filed = { id: nid('rep'), trialId, orgName: s.org.name, scoutName: s.scoutName, filedAt: Date.now(), ...(report as Record<string, number>) } as unknown as Player['trialReports'][number];
    trial.report = filed;
    p.trialReports.push(filed);
    p.trustScore = Math.min(99, p.trustScore + 8);
    log(s, 'trial_report', p.id);
    emit('players');
    return delay(undefined);
  },

  getLedger: (s) => delay(ledger.filter((l) => l.orgId === s.org.id).slice().reverse()),

  getProofPack: (s, playerId) => {
    const p = PLAYERS.find((x) => x.id === playerId)!;
    const events = ledger.filter((l) => l.playerId === playerId && l.orgId === s.org.id);
    const first = events[0] ?? null;
    const months = PLANS[s.org.plan].attributionWindowMonths;
    return delay({
      playerId, playerName: p.name,
      org: { id: s.org.id, name: s.org.name, plan: s.org.plan },
      firstQualifyingInteraction: first,
      attributionWindowMonths: months,
      attributionWindowEnds: first ? new Date(first.ts + months * 30.44 * 24 * 3600 * 1000).toISOString() : null,
      eventLog: events,
      generatedAt: new Date().toISOString(),
    });
  },

  getPlan: (s) =>
    delay({
      org: s.org,
      plan: PLANS[s.org.plan],
      compliance: {
        attributionWindowMonths: PLANS[s.org.plan].attributionWindowMonths,
        antiCircumvention: PLANS[s.org.plan].antiCircumvention,
        feeProtection: 'Discovery attribution is evidenced by the append-only ledger and Proof Packs. Fees attach to the first qualifying interaction inside the window.',
      },
    }),

  getReputation: (s) => {
    const live: Record<string, Reputation['live'][number]> = {};
    for (const l of ledger) {
      const k = `${l.scoutName}|${l.orgName}`;
      live[k] ??= { scoutName: l.scoutName, orgName: l.orgName, views: 0, contacts: 0, trials: 0, signings: 0 };
      if (l.type === 'view') live[k].views++;
      if (l.type === 'contact_request') live[k].contacts++;
      if (l.type.startsWith('trial')) live[k].trials++;
      if (l.type === 'signing') live[k].signings++;
    }
    return delay({
      seeded: [
        { scoutName: 'Maria Keane', orgName: 'Eastport FC', discoveries: 14, successRatePct: 64, avgResaleMultiple: 3.1, seeded: true },
        { scoutName: 'Coach D. Ansah', orgName: 'Harbour City FC', discoveries: 9, successRatePct: 55, avgResaleMultiple: 2.2, seeded: true },
        { scoutName: 'Tomás Rivera', orgName: 'North Star Sports Agency', discoveries: 21, successRatePct: 48, avgResaleMultiple: 2.8, seeded: true },
      ],
      live: Object.values(live),
    });
  },

  onChange: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
