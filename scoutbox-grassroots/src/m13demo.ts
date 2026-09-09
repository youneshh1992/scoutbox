// In-browser demo mirror of the M13 org API (VITE_DEMO=1 builds only).
// Populated synthetic examples for every M13 area; state lives in this tab's
// memory and resets on reload. No real people, credentials or providers.
import type { Session } from './api';
import type {
  M13Api, ImportBatch, IdentityReview, ApiKeyRow, WebhookRow, WebhookDelivery, Connector,
  Fixture, CoveragePlan, CoverageAssignment, VisitSuggestion, CalibrationSession, CalibrationListRow,
  ExposureReport, ReviewQueue, EvidenceGap, GroupRow, GrantRow, SharedResource,
  TransitionListRow, TransitionPack, Scenario, ScenarioTotals, Representation,
  OnboardingState, InviteRow, SessionRow, SupportTicket, OrgNotification, SuitabilitySummary,
} from './m13api';

const NOW = Date.now();
const DAY = 86_400_000;
let n = 500;
const id = (p: string) => `${p}-d${++n}`;
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 120));

// ------------------------------------------------------------- F1 fixtures
const BATCHES: ImportBatch[] = [{
  id: 'imp-d1', status: 'committed', createdByName: 'Maria Keane', createdAt: NOW - 2 * DAY,
  summary: { total: 24, creatable: 21, errors: 1, duplicatesInFile: 1, alreadyImported: 0, linkedExisting: 0, ambiguous: 1 },
  rowCount: 24,
}];
const REVIEWS: IdentityReview[] = [{
  id: 'idr-d1', row: 14, status: 'open', candidatePlayerId: 'pl-adeyemi',
  record: { name: 'Kola Adeyemi', dob: '2004-03-14', provider: 'statsprovider', externalId: 'SP-1044', position: 'ST' },
}];
const KEYS: ApiKeyRow[] = [{ id: 'key-d1', scopes: ['export:shortlist'], label: 'Analytics pipeline', createdBy: 'Maria Keane', createdAt: NOW - 20 * DAY, revokedAt: null, lastUsedAt: NOW - DAY }];
const WEBHOOKS: WebhookRow[] = [{ id: 'whk-d1', url: 'https://hooks.eastport-example.club/scoutbox', events: ['import.committed', 'transition.granted'], active: true }];
const DELIVERIES: WebhookDelivery[] = [
  { id: 'dlv-d1', eventId: 'evt_9f2a', type: 'import.committed', status: 'delivered', attempts: [{ at: NOW - 2 * DAY, status: 200 }] },
  { id: 'dlv-d2', eventId: 'evt_1c77', type: 'transition.granted', status: 'retrying', attempts: [{ at: NOW - 3600e3, error: 'ECONNREFUSED' }] },
];
const CONNECTORS: Connector[] = [
  { id: 'stats-feed', name: 'Match statistics feed', kind: 'inbound', status: 'not_configured', note: 'No provider credentials — this connector performs no requests and imports nothing until an authorised integration is configured.' },
  { id: 'fed-registry', name: 'Federation registration lookup', kind: 'inbound', status: 'not_configured', note: 'No provider credentials — nothing is looked up.' },
  { id: 'video-host', name: 'Licensed video platform', kind: 'inbound', status: 'not_configured', note: 'No provider credentials — no scraping, ever.' },
];

// ------------------------------------------------------------- F7 fixtures
const FIXTURES: Fixture[] = [
  { id: 'fix-d1', source: 'own', competition: 'U21 Development League', home: 'Hackney U18s', away: 'Harbour Rovers U21', date: new Date(NOW + 6 * DAY).toISOString().slice(0, 10), location: { city: 'Manchester' } },
  { id: 'fix-d2', source: 'friendly_board', competition: 'Friendly', home: 'Hackney Marsh Rovers', away: 'open invitation', date: new Date(NOW + 9 * DAY).toISOString().slice(0, 10), location: { city: 'London' } },
  { id: 'fix-d3', source: 'open_trial', competition: 'Open trial', home: 'Camden Town Colts', away: '—', date: new Date(NOW + 12 * DAY).toISOString().slice(0, 10), location: { city: 'London' } },
];
const PLANS: CoveragePlan[] = [{ id: 'cvp-d1', label: 'Autumn U21 sweep', competition: 'U21 Development League', goalObservations: 6, windowDays: 60, progress: { done: 2, goal: 6, complete: false } }];
const ASSIGNMENTS: CoverageAssignment[] = [
  {
    id: 'cva-d1', fixtureLabel: 'Hackney U18s v Harbour Rovers U21', fixtureDate: FIXTURES[0].date, scoutName: 'Tom Field', scoutUserId: 'usr-d2',
    targetPlayerIds: ['pl-adeyemi', 'pl-svensson'], travelBudget: { amountMinor: 4500, currency: 'GBP' },
    travelNote: 'Travel time/route estimates unavailable — no routing provider is configured. The budget figure is user-entered, not a confirmed cost.',
    warnings: [], observedAt: null,
  },
  {
    id: 'cva-d2', fixtureLabel: 'Riverline v Northgate', fixtureDate: new Date(NOW - 4 * DAY).toISOString().slice(0, 10), scoutName: 'Maria Keane', scoutUserId: 'usr-d1',
    targetPlayerIds: ['pl-osei'], travelBudget: null,
    travelNote: 'Travel time/route estimates unavailable — no routing provider is configured.',
    warnings: [], observedAt: NOW - 4 * DAY,
  },
];
const SUGGESTIONS: VisitSuggestion[] = [{
  fixture: FIXTURES[2], alreadyCovered: false,
  nearbyTargets: [{ id: 'pl-osei', name: 'Danny Osei', position: 'CM' }, { id: 'pl-guni', name: 'Tomas Gunnarsson', position: 'RW' }],
  rationale: '2 players you track are within 30 km of this fixture\'s location',
}];

// ------------------------------------------------------------- F5 fixtures
const CAL_SESSIONS: CalibrationSession[] = [{
  id: 'cal-d1', title: 'Wing-play rubric alignment', status: 'open', templateVersion: 1,
  mediaUrl: null, footageNote: null,
  attributesSnapshot: [{ id: 'finishing', label: 'Finishing' }, { id: 'movement', label: 'Movement off the ball' }, { id: 'first_touch', label: 'First touch' }],
  participants: ['usr-d1', 'usr-d2', 'usr-d3'], blind: true,
  submissions: [
    { userId: 'usr-d2', userName: 'Tom Field', submittedAt: NOW - DAY },
    { userId: 'usr-d3', userName: 'Priya Nair', submittedAt: NOW - DAY / 2 },
  ],
  notes: [], comparison: null,
}];

// ------------------------------------------------------- F4 / F6 fixtures
const EXPOSURE: ExposureReport = {
  funnel: {
    windowDays: 90,
    definition: 'Unique players per stage within the window; events deduplicated per (player, kind, day). Denominator for each rate is the previous stage.',
    stages: [
      { key: 'eligible_impression', players: 38 },
      { key: 'profile_review', players: 17, of: 38 },
      { key: 'evidence_review', players: 9, of: 17 },
      { key: 'invitation', players: 4, of: 9 },
      { key: 'outcome', players: 1, of: 4 },
    ],
  },
  birthQuarter: { total: 11, quarters: { Q1: 5, Q2: 3, Q3: 2, Q4: 1 }, note: 'Distribution of assessed players by birth quarter (relative-age lens). An aggregate pattern is a prompt to look again — it does not prove discrimination, and nothing here infers ethnicity, socioeconomic status, disability or biological maturity.' },
  absentEvidence: { note: 'Players with NO evidence reviewed are counted as “not yet reviewed”, never as poor performers.', notYetReviewed: 6 },
};
const QUEUE: ReviewQueue = {
  queue: [
    { player: { id: 'pl-osei', name: 'Danny Osei', position: 'CM' }, firstSeenDaysAgo: 21 },
    { player: { id: 'pl-santos', name: 'Rafa Santos', position: 'LB' }, firstSeenDaysAgo: 13 },
  ],
  deferred: [{ player: { id: 'pl-kimura', name: 'Hana Kimura' }, deferredUntil: NOW + 3 * DAY }],
  staleEvaluations: [{ playerId: 'pl-svensson', playerName: 'Astrid Svensson', lastAssessedAt: NOW - 200 * DAY, note: 'last assessed over 180 days ago' }],
};
const GAPS: Record<string, EvidenceGap[]> = {
  'pl-osei': [
    { id: 'gap-d1', ruleId: 'single_match_sample', ruleVersion: 1, playerName: 'Danny Osei', status: 'suggested', records: ['media-1'], explanation: 'Only one clip available — a single viewing context.', action: 'Request footage from a second match before concluding anything.' },
    { id: 'gap-d2', ruleId: 'uncorroborated_claims', ruleVersion: 1, playerName: 'Danny Osei', status: 'requested', records: ['ev-1', 'ev-2'], explanation: 'All 2 evidence-passport records are self-reported — nothing is coach-confirmed or club-assessed yet.', action: 'Ask a coach or run a club assessment to corroborate the claim.' },
  ],
  'pl-adeyemi': [
    { id: 'gap-d3', ruleId: 'assessment_disagreement', ruleVersion: 1, playerName: 'Kola Adeyemi', status: 'suggested', records: ['ass-d1', 'ass-d2'], explanation: 'Your scouts disagree on “Finishing” (ratings span 2–5).', action: 'A third independent observation would resolve the split.' },
  ],
};

// ------------------------------------------------------- F8 / F2 fixtures
const GROUPS: GroupRow[] = [{
  id: 'grp-d1', name: 'North West Development Group', youAdmin: true,
  members: [{ id: 'org-hackneymarsh', name: 'Hackney Marsh Rovers', level: 'pro' }, { id: 'org-hackneymarsh', name: 'Hackney Marsh Rovers', level: 'grassroots' }],
  programmes: [{ id: 'pgm-d1', name: 'Regional U18 ID days', region: 'North West' }],
}];
const GRANTS_GIVEN: GrantRow[] = [{ id: 'gnt-d1', resourceKind: 'shortlist', resourceId: '*', toOrgIds: ['org-hackneymarsh'], expiresAt: NOW + 20 * DAY, revokedAt: null, live: true }];
const GRANTS_RECEIVED: GrantRow[] = [{ id: 'gnt-d2', fromOrgName: 'Hackney Marsh Rovers', resourceKind: 'assessment', expiresAt: NOW + 10 * DAY }];
const SHARED: Record<string, SharedResource> = {
  'gnt-d2': { kind: 'assessment', assessment: { playerName: 'Danny Osei', scoutName: 'Dee Coach', recommendation: { verdict: 'monitor' } } },
};
const TRANSITIONS: TransitionListRow[] = [{ id: 'trn-d1', playerName: 'Leo Marchetti', grantedAt: NOW - 3 * DAY, expiresAt: NOW + 27 * DAY, note: 'Leaving the academy at 19 — looking for senior minutes.' }];
const TRANSITION_PACKS: Record<string, TransitionPack> = {
  'trn-d1': {
    transitionId: 'trn-d1', playerName: 'Leo Marchetti', note: 'Leaving the academy at 19 — looking for senior minutes.',
    pack: {
      media: [{ id: 'media-t1', title: 'Full-back highlights 2025/26', url: null }],
      evidence: [{ id: 'ev-t1', tier: 'club_assessed', summary: '30m sprint 4.19s (club assessment)' }],
      publishedFeedback: [{ orgName: 'Former academy', text: 'Excellent left side, needs aerial work. Published to the player in June.', at: NOW - 90 * DAY }],
    },
  },
};

// ------------------------------------------------------------- F9 fixtures
const totalsOf = (scn: Scenario): ScenarioTotals => {
  const per: ScenarioTotals['perCurrency'] = {};
  const occ = (sch: string) => (sch === 'one_off' ? 1 : sch === 'monthly' ? scn.termMonths : sch === 'annual' ? Math.ceil(scn.termMonths / 12) : Math.round((scn.termMonths * 52) / 12));
  for (const l of scn.lines) {
    const b = (per[l.currency] ??= { confirmedMinor: 0, estimatedMinor: 0, conditionalCount: 0 });
    if (l.conditional) { b.conditionalCount++; continue; }
    const t = l.amountMinor * occ(l.schedule);
    if (l.confirmed) b.confirmedMinor += t; else b.estimatedMinor += t;
  }
  const curs = Object.keys(per);
  const combined = curs.length === 1
    ? { currency: curs[0], ...per[curs[0]], viaFx: false }
    : { unavailable: true, reason: 'Currencies mixed without a stated exchange-rate assumption for each — totals stay per-currency.' };
  return {
    termMonths: scn.termMonths, perCurrency: per, combined,
    conditionalLines: scn.lines.filter((l) => l.conditional).map((l) => ({ label: l.label, amountMinor: l.amountMinor, currency: l.currency, assumption: l.conditional!.assumption })),
    conditionalNote: 'Conditional amounts are listed with their assumptions and EXCLUDED from every total.',
  };
};
const SCENARIOS: Record<string, Scenario[]> = {
  'case-d1': [{
    id: 'scn-d1', version: 2, label: 'Base offer', currency: 'GBP', termMonths: 24,
    lines: [
      { id: 'ln-1', kind: 'wage', label: 'Weekly wage', amountMinor: 95000, currency: 'GBP', schedule: 'weekly', confirmed: true, conditional: null },
      { id: 'ln-2', kind: 'fee', label: 'Signing fee', amountMinor: 1_500_000, currency: 'GBP', schedule: 'one_off', confirmed: false, conditional: null },
      { id: 'ln-3', kind: 'bonus', label: 'Promotion bonus', amountMinor: 2_000_000, currency: 'GBP', schedule: 'one_off', confirmed: false, conditional: { assumption: 'first-team promotion within the term' } },
    ],
    fxAssumptions: [], approval: { by: 'Maria Keane', at: NOW - 5 * DAY, version: 2 }, actuals: [{ lineId: 'ln-1', amountMinor: 95000, at: NOW - DAY }],
  }],
};

// ------------------------------------------------------------ F10 fixtures
const REPRESENTATIONS: Representation[] = [{
  id: 'rep-d1', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi', agencyName: 'North Star Sports Agency',
  representativeName: 'Alex Agent', scope: 'contracts_only', status: 'proposed', startAt: NOW - DAY, endAt: NOW + 360 * DAY, confirmedAt: null,
  credential: { source: 'uploaded_document', note: 'FA intermediary licence PDF', reviewStatus: 'pending', honest: 'uploaded document, review pending — NOT an independently verified licence' },
  history: [{ at: NOW - DAY, byName: 'Alex Agent', action: 'proposed' }],
}];

// ------------------------------------------------------------ F12 fixtures
const ONBOARDING: OnboardingState = {
  tasks: [
    { id: 'verify_org', label: 'Verify your organisation (company email domain)', done: true, help: 'Trust & Safety reviews verification — required before any under-18 visibility.' },
    { id: 'safeguarding', label: 'Sign the safeguarding contract', done: true, help: 'Required for under-18 access.' },
    { id: 'invite_staff', label: 'Invite your staff', done: true, help: 'Each person works under their own named account.' },
    { id: 'mfa_leads', label: 'Enable MFA for privileged accounts', done: false, help: 'Leads approve signings and manage staff — protect those accounts first.' },
    { id: 'first_import', label: 'Import or add your player records', done: true, help: 'CSV import with dry-run preview.' },
    { id: 'coverage_plan', label: 'Set up a coverage plan', done: true, help: 'Fixtures, assignments and observation tracking live under Coverage.' },
  ],
  complete: false, roleHelp: 'As a lead you approve signings, manage staff and see restricted cases.',
};
const INVITES: InviteRow[] = [{ id: 'inv-d1', email: 'nina@eastport-example.club', name: 'Nina Invitee', role: 'Scout', status: 'accepted', createdAt: NOW - 6 * DAY }];
const SESSIONS: SessionRow[] = [
  { sid: 'a1b2c3', createdAt: NOW - 3600e3, current: true, via: 'password' },
  { sid: 'd4e5f6', createdAt: NOW - 5 * DAY, current: false, via: 'sso' },
];
const TICKETS: SupportTicket[] = [{
  id: 'tkt-d1', subject: 'Import row stuck in review', body: 'Row 14 needs a second pair of eyes.', status: 'open',
  refs: [{ kind: 'import', id: 'imp-d1' }], replies: [{ at: NOW - DAY, by: 'Trust & Safety', text: 'We asked for time-limited access — a lead can approve it below.' }], createdAt: NOW - 2 * DAY,
}];
const ORG_NOTIFS: OrgNotification[] = [
  { id: 'ntf-d90', ts: NOW - 3600e3, type: 'transition', text: 'A transition evidence pack shared with Eastport Academy was withdrawn. Platform access has ended; anything your staff already downloaded is outside the platform and cannot be remotely erased — please delete local copies.', read: false, actionRequired: { deadline: NOW + 6 * DAY, ackedAt: null } },
  { id: 'ntf-d91', ts: NOW - 2 * 3600e3, type: 'group', text: '📂 Hackney Marsh Rovers shared an assessment with your club in “North West Development Group”.', read: true, actionRequired: null },
];
const SUITABILITY: Record<string, SuitabilitySummary | null> = {
  'apl-d1': { approvedAt: NOW - DAY, approvedBy: 'player', verdicts: [{ dimension: 'schedule', verdict: 'compatible' }, { dimension: 'travel', verdict: 'compatible' }, { dimension: 'relocation', verdict: 'compatible' }, { dimension: 'compensation', verdict: 'unknown' }, { dimension: 'environment', verdict: 'compatible' }, { dimension: 'accessibility', verdict: 'compatible' }] },
};

/* eslint-disable @typescript-eslint/no-unused-vars */
export const demoM13: M13Api = {
  importTemplateUrl: () => 'data:text/csv,name%2Cdob%2Cposition%2Cfoot%2CheightCm%2Cprovider%2CexternalId%2Cnotes%0AJordan%20Example%2C2004-03-12%2CST%2Cright%2C181%2Cstatsprovider%2CSP-1001%2Cleft-sided%20forward',
  createImport: (s: Session, csv: string) => {
    const rows = csv.trim().split('\n').slice(1);
    const batch: ImportBatch = {
      id: id('imp'), status: 'validated', createdByName: s.scoutName, createdAt: Date.now(),
      summary: { total: rows.length, creatable: rows.length, errors: 0, duplicatesInFile: 0, alreadyImported: 0, linkedExisting: 0, ambiguous: 0 },
      rows: rows.map((r, i) => ({ row: i + 2, record: { name: r.split(',')[0] ?? 'row' }, errors: [], disposition: 'create', matchPlayerId: null })),
    };
    BATCHES.unshift(batch);
    return delay({ batch, dryRun: true, note: 'Nothing imported yet — review the report, then commit.' });
  },
  listImports: () => delay(BATCHES),
  commitImport: (s, bid) => {
    const b = BATCHES.find((x) => x.id === bid);
    if (b) b.status = 'committed';
    return delay({ created: b?.summary.creatable ?? 0, reviewsQueued: b?.summary.ambiguous ?? 0 });
  },
  reverseImport: (s, bid) => {
    const b = BATCHES.find((x) => x.id === bid);
    if (b) b.status = 'reversed';
    return delay({ removed: b?.summary.creatable ?? 0, kept: [] });
  },
  listIdentityReviews: () => delay(REVIEWS.filter((r) => r.status === 'open')),
  resolveIdentity: (s, rid, action) => {
    const r = REVIEWS.find((x) => x.id === rid);
    if (r) r.status = 'resolved';
    return delay(undefined);
  },
  listApiKeys: () => delay({ items: KEYS, contractVersion: '2026-09-01.v1' }),
  createApiKey: (s, scopes, label) => {
    const k: ApiKeyRow = { id: id('key'), scopes, label, createdBy: s.scoutName, createdAt: Date.now(), revokedAt: null, lastUsedAt: null };
    KEYS.push(k);
    return delay({ key: k, plaintext: `sbk_demo_${Math.random().toString(36).slice(2)}`, note: 'Store this now — the key is shown once and only its hash is kept.' });
  },
  revokeApiKey: (s, kid) => { const k = KEYS.find((x) => x.id === kid); if (k) k.revokedAt = Date.now(); return delay(undefined); },
  listWebhooks: () => delay({ items: WEBHOOKS, guidance: 'Verify X-ScoutBox-Signature = HMAC-SHA256(secret, "<eventId>.<timestamp>.<rawBody>"). Reject old timestamps and replayed event ids.' }),
  createWebhook: (s, url, events) => {
    const w: WebhookRow = { id: id('whk'), url, events, active: true, secret: `whsec_demo_${Math.random().toString(36).slice(2)}` };
    WEBHOOKS.push(w);
    return delay({ endpoint: w, note: 'The signing secret is shown here and on rotation only.' });
  },
  webhookDeliveries: () => delay(DELIVERIES),
  rotateWebhook: (s, wid) => delay({ ...WEBHOOKS.find((x) => x.id === wid)!, secret: `whsec_demo_${Math.random().toString(36).slice(2)}` }),
  listConnectors: () => delay(CONNECTORS),

  listFixtures: () => delay(FIXTURES),
  createFixture: (s, input) => {
    const f: Fixture = { id: id('fix'), source: 'own', competition: input.competition ?? null, home: input.home, away: input.away, date: input.date, location: input.city ? { city: input.city } : null };
    FIXTURES.push(f);
    return delay(f);
  },
  listPlans: () => delay(PLANS),
  createPlan: (s, input) => {
    const p: CoveragePlan = { id: id('cvp'), label: input.label, competition: input.competition ?? null, goalObservations: input.goalObservations, windowDays: input.windowDays, progress: { done: 0, goal: input.goalObservations, complete: false } };
    PLANS.push(p);
    return delay(p);
  },
  listAssignments: () => delay(ASSIGNMENTS),
  createAssignment: (s, input) => {
    const fx = FIXTURES.find((f) => f.id === input.fixtureId)!;
    const dup = ASSIGNMENTS.some((a) => a.fixtureLabel === `${fx.home} v ${fx.away}` && !a.observedAt);
    const a: CoverageAssignment = {
      id: id('cva'), fixtureLabel: `${fx.home} v ${fx.away}`, fixtureDate: fx.date, scoutName: 'Tom Field', scoutUserId: input.scoutUserId,
      targetPlayerIds: input.targetPlayerIds ?? [], travelBudget: input.travelBudgetMinor ? { amountMinor: input.travelBudgetMinor, currency: 'GBP' } : null,
      travelNote: 'Travel time/route estimates unavailable — no routing provider is configured. The budget figure is user-entered, not a confirmed cost.',
      warnings: dup ? ['Duplicate visit: a scout is already assigned to this fixture.'] : [], observedAt: null,
    };
    ASSIGNMENTS.unshift(a);
    return delay({ assignment: a, warnings: a.warnings });
  },
  completeAssignment: (s, aid) => { const a = ASSIGNMENTS.find((x) => x.id === aid); if (a) a.observedAt = Date.now(); if (PLANS[0].progress) PLANS[0].progress.done++; return delay(undefined); },
  visitSuggestions: () => delay({ items: SUGGESTIONS, note: 'Location-proximity heuristic over your own tracked players and visible fixtures. It does not know who will actually play, and it never includes players outside your visibility rules.' }),

  listCalibrations: () => delay(CAL_SESSIONS.map((c): CalibrationListRow => ({ id: c.id, title: c.title, status: c.status, participants: c.participants.length, submitted: c.submissions.length }))),
  createCalibration: (s, input) => {
    const c: CalibrationSession = {
      id: id('cal'), title: input.title, status: 'open', templateVersion: 1, mediaUrl: null,
      attributesSnapshot: [{ id: 'finishing', label: 'Finishing' }, { id: 'movement', label: 'Movement off the ball' }],
      participants: input.participantUserIds, blind: true, submissions: [], notes: [], comparison: null,
    };
    CAL_SESSIONS.push(c);
    return delay(c);
  },
  getCalibration: (s, cid) => delay(CAL_SESSIONS.find((x) => x.id === cid)!),
  submitCalibration: (s, cid, ratings) => {
    const c = CAL_SESSIONS.find((x) => x.id === cid)!;
    c.submissions.push({ userId: 'usr-me', userName: s.scoutName, submittedAt: Date.now(), ratings });
    c.blind = false;
    c.comparison = {
      sampleSize: c.submissions.length + 1,
      confidenceNote: `Comparison of ${c.submissions.length + 1} blind submissions on one reference clip — a conversation starter about the rubric, not a measure of who is “right”.`,
      rows: c.attributesSnapshot.map((a, i) => {
        const mine = ratings.find((r) => r.attrId === a.id);
        const values = [i === 0 ? 5 : 3, i === 0 ? 2 : 3, ...(mine && !mine.notObserved && mine.value ? [mine.value] : [])];
        const range = Math.max(...values) - Math.min(...values);
        return { attrId: a.id, label: a.label, values, notObserved: mine?.notObserved ? 1 : 0, range, mean: Math.round((values.reduce((x, y) => x + y, 0) / values.length) * 10) / 10, disagreement: range >= 2 ? 'high' : range === 1 ? 'moderate' : 'aligned' };
      }),
    };
    return delay(c);
  },
  closeCalibration: (s, cid) => { const c = CAL_SESSIONS.find((x) => x.id === cid)!; c.status = 'closed'; c.blind = false; return delay(c); },
  calibrationNote: (s, cid, text) => { CAL_SESSIONS.find((x) => x.id === cid)!.notes.push({ byName: s.scoutName, text, at: Date.now() }); return delay(undefined); },
  decisionReview: () => delay({
    items: [
      { assessmentId: 'ass-d1', playerName: 'Kola Adeyemi', scoutName: 'Tom Field', recommendation: { verdict: 'sign' }, since: { signedSomewhere: true, furtherAssessments: 2 } },
      { assessmentId: 'ass-d2', playerName: 'Astrid Svensson', scoutName: 'Maria Keane', recommendation: { verdict: 'monitor' }, since: { signedSomewhere: false, furtherAssessments: 0 } },
    ],
    disclaimer: 'What happened after a recommendation reflects hundreds of factors. This view supports reflective review of evidence quality — it does not measure whether a scout “caused” an outcome, and it is never published or ranked.',
  }),

  reportImpressions: () => delay(undefined),
  exposureReport: () => delay(EXPOSURE),
  reviewQueue: () => delay(QUEUE),
  deferReview: (s, pid, days) => {
    const idx = QUEUE.queue.findIndex((q) => q.player.id === pid);
    if (idx >= 0) { QUEUE.deferred.push({ player: QUEUE.queue[idx].player, deferredUntil: Date.now() + days * DAY }); QUEUE.queue.splice(idx, 1); }
    return delay(undefined);
  },
  discoveryRotation: () => delay({
    week: Math.floor(Date.now() / (7 * DAY)),
    items: [{ id: 'pl-santos', name: 'Rafa Santos', position: 'LB' }, { id: 'pl-kimura', name: 'Hana Kimura', position: 'GK' }, { id: 'pl-osei', name: 'Danny Osei', position: 'CM' }],
    note: 'A rotating slice of eligible players you have not assessed — same pool as search, different order each week. Rotation never includes anyone outside your standing visibility rules, and nothing can pay its way in.',
  }),
  evidenceGaps: (s, pid) => delay({ items: GAPS[pid] ?? [], engine: { version: 1, note: 'Every suggestion cites its rule and the records behind it. No AI generation is involved.' } }),
  requestGap: (s, gid) => {
    for (const list of Object.values(GAPS)) { const g = list.find((x) => x.id === gid); if (g) g.status = 'requested'; }
    return delay(undefined);
  },
  dismissGap: (s, gid) => {
    for (const list of Object.values(GAPS)) { const g = list.find((x) => x.id === gid); if (g) g.status = 'dismissed'; }
    return delay(undefined);
  },

  listGroups: () => delay({ items: GROUPS, invites: [] }),
  acceptGroup: () => delay(undefined),
  leaveGroup: () => delay({ grantsEnded: 1 }),
  inviteToGroup: () => delay(undefined),
  previewGrant: (s, gid, input) => delay({
    recipients: input.toOrgIds.map((oid) => ({
      orgName: GROUPS[0].members.find((m) => m.id === oid)?.name ?? oid,
      wouldSee: { kind: input.resourceKind, players: [{ id: 'pl-osei', name: 'Danny Osei', position: 'CM', level: 'amateur' }], withheld: 2, withheldNote: '2 player(s) withheld — outside your organisation\'s own visibility rules (under-18 verification, agency wall, grassroots level/50 km). A group grant never overrides those.' } as SharedResource,
    })),
  }),
  createGrant: (s, gid, input) => {
    const g: GrantRow = { id: id('gnt'), resourceKind: input.resourceKind, resourceId: input.resourceId, toOrgIds: input.toOrgIds, expiresAt: Date.now() + input.expiresDays * DAY, revokedAt: null, live: true };
    GRANTS_GIVEN.push(g);
    return delay(g);
  },
  listGrants: () => delay({ given: GRANTS_GIVEN, received: GRANTS_RECEIVED }),
  revokeGrant: (s, gid) => { const g = GRANTS_GIVEN.find((x) => x.id === gid); if (g) { g.revokedAt = Date.now(); g.live = false; } return delay(undefined); },
  readShared: (s, gid) => {
    const g = GRANTS_RECEIVED.find((x) => x.id === gid);
    if (!g) return Promise.reject(new Error('GRANT_ENDED'));
    return delay({ from: g.fromOrgName ?? 'Partner club', resource: SHARED[gid] ?? { kind: g.resourceKind } });
  },
  groupReport: () => delay({
    group: { name: 'North West Development Group', members: 2 },
    activity: [{ orgName: 'Hackney Marsh Rovers', assessments: 11, signings: '<3' }, { orgName: 'Hackney Marsh Rovers', assessments: 4, signings: '<3' }],
    note: 'Counts under 3 are suppressed. This report contains NO player-level data — player records stay inside each member club\'s own permissions.',
  }),
  listTransitions: () => delay({ items: TRANSITIONS, note: 'Each pack was individually shared with your club by the player or their guardian, and can be withdrawn at any time.' }),
  transitionPack: (s, tid) => delay(TRANSITION_PACKS[tid]!),

  caseBudget: (s, cid) => delay({ scenarios: (SCENARIOS[cid] ?? []).map((x) => ({ ...x, totals: totalsOf(x) })), note: 'Amounts are integer minor units (pence/cents). Mixed currencies combine only under explicitly stated manual rates.' }),
  createScenario: (s, cid, input) => {
    const scn: Scenario = {
      id: id('scn'), version: 1, label: input.label ?? 'Scenario', currency: input.currency ?? 'GBP', termMonths: input.termMonths ?? 12,
      lines: (input.lines ?? []) as Scenario['lines'], fxAssumptions: [], approval: null, actuals: [],
    };
    (SCENARIOS[cid] ??= []).push(scn);
    return delay({ scenario: scn, totals: totalsOf(scn), honest: 'All figures are user-entered. ScoutBox never invents market values, resale projections or “expected returns”, and a scenario is planning support — not legal or financial approval.' });
  },
  updateScenario: (s, cid, sid, patch) => {
    const scn = (SCENARIOS[cid] ?? []).find((x) => x.id === sid)!;
    Object.assign(scn, patch, { version: scn.version + 1 });
    if (scn.approval) scn.approval = { ...scn.approval, superseded: true };
    return delay({ scenario: scn, totals: totalsOf(scn) });
  },
  approveScenario: (s, cid, sid) => {
    const scn = (SCENARIOS[cid] ?? []).find((x) => x.id === sid)!;
    scn.approval = { by: s.scoutName, at: Date.now(), version: scn.version };
    return delay({ scenario: scn, note: 'Internal planning approval by a named lead for THIS version. It is not legal, regulatory or financial-services approval.' });
  },

  listRepresentations: (s) => (s.org.type === 'agency'
    ? delay({ items: REPRESENTATIONS, note: 'Active representation requires the player’s confirmation and ends the moment they withdraw it. States are labelled exactly as they are.' })
    : Promise.reject(new Error('AGENCY_ONLY'))),
  proposeRepresentation: (s, input) => {
    const r: Representation = {
      id: id('rep'), playerId: input.playerId, playerName: input.playerId, agencyName: s.org.name,
      representativeName: input.representativeName, scope: input.scope, status: 'proposed', startAt: Date.now(),
      endAt: input.endMonths ? Date.now() + input.endMonths * 30 * DAY : null, confirmedAt: null,
      credential: input.credentialNote ? { source: 'uploaded_document', note: input.credentialNote, reviewStatus: 'pending', honest: 'uploaded document, review pending — NOT an independently verified licence' } : null,
      history: [{ at: Date.now(), byName: s.scoutName, action: 'proposed' }],
    };
    REPRESENTATIONS.push(r);
    return delay(r);
  },

  onboarding: () => delay(ONBOARDING),
  listInvites: () => delay(INVITES),
  createInvite: (s, email, name, role) => {
    const inv: InviteRow = { id: id('inv'), email, name, role, status: 'pending', createdAt: Date.now() };
    INVITES.push(inv);
    return delay(inv);
  },
  mfaSetup: () => delay({ secret: 'DEMO2SECRET2NOT2REAL2AAA', otpauth: 'otpauth://totp/ScoutBox:demo?secret=DEMO2SECRET2NOT2REAL2AAA&issuer=ScoutBox', note: 'Demo secret — in the live app this pairs with a real authenticator.' }),
  mfaVerify: (s, code) => (code.length === 6
    ? delay({ enabled: true, recoveryCodes: Array.from({ length: 10 }, (_, i) => `demo-rec-${i + 1}`), note: 'Store these recovery codes now — each works once and they are never shown again.' })
    : Promise.reject(new Error('MFA_CODE_WRONG'))),
  listSessions: () => delay(SESSIONS),
  revokeSession: (s, sid) => { const i = SESSIONS.findIndex((x) => x.sid === sid && !x.current); if (i >= 0) SESSIONS.splice(i, 1); return delay(undefined); },
  getSso: () => delay({ config: null, available: ['local-test-idp'], note: 'No identity provider configured. In this environment only the local test IdP is available — a corporate provider requires real OIDC credentials.' }),
  setSso: () => delay(undefined),
  listSupport: () => delay(TICKETS),
  createSupport: (s, subject, body, refs) => {
    const t: SupportTicket = { id: id('tkt'), subject, body, status: 'open', refs, replies: [], createdAt: Date.now() };
    TICKETS.unshift(t);
    return delay(t);
  },
  approveSupportAccess: () => delay(undefined),
  orgNotifications: () => delay(ORG_NOTIFS),
  ackNotification: (s, nid) => { const nf = ORG_NOTIFS.find((x) => x.id === nid); if (nf?.actionRequired) nf.actionRequired.ackedAt = Date.now(); return delay(undefined); },
  setDeliveryPrefs: () => delay(undefined),
  auditExportUrl: () => 'about:blank',

  applicationSuitability: (s, aid) => delay({ summary: SUITABILITY[aid] ?? null, note: SUITABILITY[aid] ? 'Verdict summary approved by the player/guardian. Underlying preferences are private.' : 'The player/guardian has not shared a suitability summary for this application.' }),
  setStructuredRequirements: () => delay(undefined),
};
