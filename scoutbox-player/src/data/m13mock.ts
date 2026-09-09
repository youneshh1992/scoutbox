// Demo mirror of the M13 player/guardian surface (EXPO_PUBLIC_DEMO=1).
// Synthetic examples; state lives in this tab's memory and resets on reload.
import type {
  PlayerM13, Preferences, Verdict, TransitionCase, RepresentationView,
  ExposureView, AckNotification,
} from './m13client';

const NOW = Date.now();
const DAY = 86_400_000;
let n = 800;
const id = (p: string) => `${p}-m${++n}`;
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 100));

const PREFS: Record<string, Preferences> = {
  'pl-adeyemi': {
    commitments: [{ day: 'tue', start: '18:00', end: '21:00', tz: 'Europe/London', label: 'BTEC evening class' }],
    availableSlots: [{ day: 'mon', start: '17:00', end: '20:00', tz: 'Europe/London' }, { day: 'thu', start: '17:00', end: '20:00', tz: 'Europe/London' }, { day: 'sat', start: '09:00', end: '13:00', tz: 'Europe/London' }],
    travelLimitKm: 40, transport: 'public', relocation: 'discuss',
    ambitions: 'Professional contract within two seasons', environment: ['competitive'], accessibility: [],
    compensation: { maxFeeMinor: 0, currency: 'GBP', expensesNeeded: true }, updatedAt: NOW - 5 * DAY,
  },
  'pl-guni': {
    commitments: [{ day: 'mon', start: '08:30', end: '15:30', tz: 'Europe/London', label: 'school' }, { day: 'wed', start: '16:00', end: '18:00', tz: 'Europe/London', label: 'maths tutoring' }],
    availableSlots: [{ day: 'sat', start: '09:00', end: '12:00', tz: 'Europe/London' }],
    travelLimitKm: 15, transport: 'lift_needed', relocation: null,
    ambitions: null, environment: ['development_focus'], accessibility: [],
    compensation: { maxFeeMinor: 0, currency: 'GBP', expensesNeeded: false }, updatedAt: NOW - 2 * DAY,
  },
};

const VERDICTS: Verdict[] = [
  { dimension: 'schedule', verdict: 'conflict', reason: 'training tue 18:30–20:00 (Europe/London) overlaps your commitment “BTEC evening class” (Europe/London)', source: 'your commitments vs the club’s training times' },
  { dimension: 'travel', verdict: 'compatible', reason: '18 km from your area to Eastport — travel time unavailable (no routing provider configured)', source: 'distance vs your 40 km limit' },
  { dimension: 'relocation', verdict: 'compatible', reason: 'no relocation required', source: 'opportunity' },
  { dimension: 'compensation', verdict: 'conflict', reason: 'you need expenses covered and this opportunity does not cover them', source: 'fees' },
  { dimension: 'environment', verdict: 'compatible', reason: 'matches: competitive', source: 'your preferences vs club tags' },
  { dimension: 'accessibility', verdict: 'compatible', reason: 'no accessibility requirements recorded', source: 'your preferences' },
];

const TRANSITIONS: TransitionCase[] = [{
  id: 'trn-m1', playerId: 'pl-adeyemi', status: 'open', note: 'Looking for senior minutes after the academy.',
  periodEndsAt: NOW + 70 * DAY, placement: null,
  recipients: [
    { orgId: 'org-eastport', orgName: 'Eastport Academy', grantedAt: NOW - 3 * DAY, expiresAt: NOW + 27 * DAY, revokedAt: null, viewedAt: NOW - DAY },
    { orgId: 'org-riverline', orgName: 'Riverline FC', grantedAt: NOW - 10 * DAY, expiresAt: NOW + 20 * DAY, revokedAt: NOW - 2 * DAY, viewedAt: null },
  ],
  pack: { mediaIds: ['m1'], evidenceIds: ['ev1'], feedbackIds: [] },
  history: [{ at: NOW - 10 * DAY, byName: 'Kola Adeyemi', action: 'opened' }, { at: NOW - 3 * DAY, byName: 'Kola Adeyemi', action: 'recipient_added' }, { at: NOW - 2 * DAY, byName: 'Kola Adeyemi', action: 'recipient_revoked' }],
}];

const REPS: RepresentationView[] = [{
  id: 'rep-m1', agencyName: 'North Star Sports Agency', representativeName: 'Alex Agent', scope: 'contracts_only',
  status: 'proposed', endAt: NOW + 350 * DAY,
  credential: { note: 'FA intermediary licence PDF', reviewStatus: 'pending', honest: 'uploaded document, review pending — NOT an independently verified licence' },
  history: [{ at: NOW - DAY, byName: 'Alex Agent', action: 'proposed' }],
}];

const EXPOSURE: ExposureView = {
  windowDays: 90, appearedInSearches: '6–20', profileViews: '1–5', clubs: '1–5',
  note: 'Coarse ranges over the last 90 days. Which club looked is not shown — interest becomes visible when a club actually contacts you through the proper channel.',
};

const ACKS: AckNotification[] = [{
  id: 'ntf-m1', ts: NOW - 3600e3, type: 'transition',
  text: 'Riverline FC’s access to your transition pack was withdrawn. They were asked to delete any local copies — already-downloaded files cannot be remotely erased.',
  actionRequired: { deadline: NOW + 6 * DAY, ackedAt: null },
}];

export const m13mock: PlayerM13 = {
  getPreferences: (pid) => delay({ preferences: PREFS[pid] ?? PREFS['pl-adeyemi'], note: 'Clubs never see this — only summaries you approve on an application.' }),
  savePreferences: (pid, patch) => {
    const p = PREFS[pid] ?? PREFS['pl-adeyemi'];
    Object.assign(p, patch, { updatedAt: Date.now() });
    return delay(p);
  },
  suitability: () => delay({ verdicts: VERDICTS, note: 'Suitability is guidance from YOUR private preferences. Eligibility rules (age, level, distance for grassroots) are separate and always apply.' }),
  shareSuitability: () => delay(undefined),
  listTransitions: (pid) => delay(TRANSITIONS.filter((t) => t.playerId === pid)),
  openTransition: (pid, input) => {
    const t: TransitionCase = {
      id: id('trn'), playerId: pid, status: 'open', note: input.note ?? null, periodEndsAt: Date.now() + 90 * DAY,
      placement: null, recipients: [], pack: { mediaIds: input.mediaIds, evidenceIds: [], feedbackIds: [] },
      history: [{ at: Date.now(), byName: 'you', action: 'opened' }],
    };
    TRANSITIONS.push(t);
    return delay(t);
  },
  addRecipient: (pid, tid, orgId) => {
    const t = TRANSITIONS.find((x) => x.id === tid);
    t?.recipients.push({ orgId, orgName: orgId === 'org-eastport' ? 'Eastport Academy' : orgId, grantedAt: Date.now(), expiresAt: Date.now() + 30 * DAY, revokedAt: null, viewedAt: null });
    return delay(undefined);
  },
  revokeRecipient: (pid, tid, orgId) => {
    const r = TRANSITIONS.find((x) => x.id === tid)?.recipients.find((x) => x.orgId === orgId && !x.revokedAt);
    if (r) r.revokedAt = Date.now();
    return delay({ honest: 'Future platform access is revoked. Already-downloaded copies cannot be remotely erased — the withdrawal notice asks the club to delete them.' });
  },
  placeTransition: (pid, tid, orgId) => {
    const t = TRANSITIONS.find((x) => x.id === tid);
    if (t) { t.status = 'placed'; t.placement = { orgName: orgId, at: Date.now() }; }
    return delay(undefined);
  },
  listRepresentation: (pid) => (pid === 'pl-guni' ? Promise.reject(new Error('Representation tools unlock at the age of majority — evaluated from your date of birth.')) : delay(REPS)),
  actRepresentation: (pid, rid, action) => {
    const r = REPS.find((x) => x.id === rid)!;
    r.status = action === 'confirm' ? 'active' : action === 'withdraw' ? 'withdrawn' : 'disputed';
    r.history.push({ at: Date.now(), byName: 'you', action });
    return delay(r);
  },
  exposure: () => delay(EXPOSURE),
  ackList: () => delay(ACKS.filter((a) => !a.actionRequired?.ackedAt)),
  ack: (pid, nid) => { const a = ACKS.find((x) => x.id === nid); if (a?.actionRequired) a.actionRequired.ackedAt = Date.now(); return delay(undefined); },
  gGetPreferences: (gid, cid) => delay({ preferences: PREFS[cid] ?? PREFS['pl-guni'] }),
  gSavePreferences: (gid, cid, patch) => {
    const p = PREFS[cid] ?? PREFS['pl-guni'];
    Object.assign(p, patch, { relocation: null, updatedAt: Date.now() }); // relocation never collected for minors
    return delay(p);
  },
  gSuitability: () => delay({ verdicts: VERDICTS.map((v) => (v.dimension === 'travel' ? { ...v, verdict: 'conflict' as const, reason: '18 km — beyond the 15 km limit set for your child; travel time unavailable (no routing provider configured)' } : v)) }),
  gShareSuitability: () => delay(undefined),
  gListTransitions: () => delay([]),
  gOpenTransition: (gid, cid, input) => m13mock.openTransition(cid, input),
  gAddRecipient: (gid, tid, orgId) => m13mock.addRecipient('pl-guni', tid, orgId),
  gRevokeRecipient: (gid, tid, orgId) => m13mock.revokeRecipient('pl-guni', tid, orgId),
  gAckList: () => delay([]),
  gAck: () => delay(undefined),
};
