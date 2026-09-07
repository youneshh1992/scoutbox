// In-browser demo mirror of the M12 org API (VITE_DEMO=1 builds only).
// Populated with realistic synthetic examples of every feature so the demo
// artifact SHOWS the real screens working; state lives in this tab's memory.
import type { Session } from './api';
import type {
  M12Api, Passport, Assessment, AssessmentRating, CompareResult, Segment, Playlist,
  CaseRec, StaffRow, Tactical, Vacancy, Candidate, Opportunity, Application,
  Campaign, CampaignAttempt, Objective, FollowUp, TrialDay, Affiliation, EvidenceRecord, Criterion,
} from './m12api';

const NOW = Date.now();
const DAY = 86_400_000;
let n = 100;
const id = (p: string) => `${p}-d${++n}`;

const ATTRS = {
  ATT: [
    { id: 'finishing', label: 'Finishing', anchors: { 1: 'Snatches at chances', 3: 'Buries the clear ones', 5: 'Finishes half-chances both feet' } },
    { id: 'movement', label: 'Movement off the ball', anchors: { 1: 'Static', 3: 'Finds space in rotation', 5: 'Constantly unbalances the line' } },
    { id: 'first_touch', label: 'First touch', anchors: { 1: 'Escapes under pressure', 3: 'Controls with time', 5: 'Kills any ball instantly' } },
    { id: 'pressing', label: 'Pressing', anchors: { 1: 'No defensive effort', 3: 'Presses on triggers', 5: 'First defender, sets the press' } },
  ],
  MID: [
    { id: 'receiving', label: 'Receiving under pressure', anchors: { 1: 'Hides', 3: 'Keeps it simple', 5: 'Wants it in traffic' } },
    { id: 'progression', label: 'Ball progression', anchors: { 1: 'Sideways only', 3: 'Forward when on', 5: 'Breaks lines consistently' } },
    { id: 'defensive_work', label: 'Defensive contribution', anchors: { 1: 'Jogs back', 3: 'Screens adequately', 5: 'Wins it back high' } },
    { id: 'tempo', label: 'Tempo control', anchors: { 1: 'Rushes everything', 3: 'Plays at the game’s pace', 5: 'Dictates the pace' } },
  ],
} as Record<string, { id: string; label: string; anchors: Record<string, string> }[]>;

const TEMPLATES = [
  { id: 'tpl-att', positionGroup: 'ATT', version: 1, attributes: ATTRS.ATT },
  { id: 'tpl-mid', positionGroup: 'MID', version: 1, attributes: ATTRS.MID },
  { id: 'tpl-def', positionGroup: 'DEF', version: 1, attributes: ATTRS.MID },
  { id: 'tpl-gk', positionGroup: 'GK', version: 1, attributes: ATTRS.MID },
];

// ---- evidence passports (synthetic)
const EVIDENCE: Record<string, EvidenceRecord[]> = {
  'pl-adeyemi': [
    {
      id: 'evd-d1', playerId: 'pl-adeyemi', claimType: 'statistic', label: 'League goals 2025/26', value: 12, units: 'goals', season: '2025/26',
      source: { kind: 'player', id: 'pl-adeyemi', name: 'Kola Adeyemi' }, observedAt: NOW - 30 * DAY, recordedAt: NOW - 28 * DAY,
      verification: { status: 'club_assessed', method: 'corroborated by Eastport FC', reviewerName: 'Maria Keane', reviewedAt: NOW - 20 * DAY },
      freshness: { ageDays: 28, fresh: true }, superseded: false, correctionOf: 'evd-d0', openDisputes: 0,
    },
    {
      id: 'evd-d0', playerId: 'pl-adeyemi', claimType: 'statistic', label: 'League goals 2025/26', value: 14, units: 'goals', season: '2025/26',
      source: { kind: 'player', id: 'pl-adeyemi', name: 'Kola Adeyemi' }, observedAt: NOW - 40 * DAY, recordedAt: NOW - 40 * DAY,
      verification: { status: 'self_reported', method: 'self_entry', reviewerName: null, reviewedAt: null },
      freshness: { ageDays: 40, fresh: true }, superseded: true, supersededBy: 'evd-d1', openDisputes: 0,
    },
    {
      id: 'evd-d2', playerId: 'pl-adeyemi', claimType: 'attendance', label: 'Sunday league spring block', value: 9, units: 'matches', season: '2025/26',
      source: { kind: 'guardian', id: 'x', name: 'club roster' }, observedAt: NOW - 12 * DAY, recordedAt: NOW - 11 * DAY,
      verification: { status: 'coach_confirmed', method: 'confirmed by club-affiliated coach (Head Coach)', reviewerName: 'Dee Mensah', reviewedAt: NOW - 10 * DAY },
      freshness: { ageDays: 11, fresh: true }, superseded: false, openDisputes: 0,
    },
  ],
  'pl-svensson': [
    {
      id: 'evd-d3', playerId: 'pl-svensson', claimType: 'assessment_result', label: '30m sprint 4.21s', value: 4.21, units: 's', season: '2025/26',
      source: { kind: 'player', id: 'pl-svensson', name: 'Elias Svensson' }, observedAt: NOW - 8 * DAY, recordedAt: NOW - 8 * DAY,
      verification: { status: 'self_reported', method: 'video_attached', reviewerName: null, reviewedAt: null },
      freshness: { ageDays: 8, fresh: true }, superseded: false, openDisputes: 0,
    },
  ],
};

function passportFor(playerId: string): Passport {
  const records = EVIDENCE[playerId] ?? [];
  const active = records.filter((r) => !r.superseded);
  const byTier: Record<string, number> = {};
  for (const r of active) byTier[r.verification.status] = (byTier[r.verification.status] ?? 0) + 1;
  const legacy = playerId === 'pl-adeyemi' ? [
    { kind: 'reference', label: 'Reference from Ade Balogun (Team Coach)', tier: 'coach_confirmed', method: 'email_code', caveat: 'Email-code reference: confirms mailbox control, not coach identity.', conflictOfInterest: 'No relation; former coach only.' },
    { kind: 'assessment_result', label: 'Combine drill sprint-30: 4.32', tier: 'self_reported', method: 'video_attached', caveat: 'An attached video is not a verified measurement — no validated video-analysis capability exists.' },
  ] : [];
  return {
    records, legacy,
    summary: {
      activeRecords: active.length, byTier,
      corroborated: active.filter((r) => r.verification.status !== 'self_reported').length,
      insufficient: active.length + legacy.length < 3,
      note: 'Provenance describes how each claim was checked — it is not a rating of football ability, and app usage frequency plays no part in it.',
    },
  };
}

// ---- assessments
const ASSESSMENTS: Assessment[] = [
  {
    id: 'ass-d1', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi', scoutUserId: 'usr-maria', scoutName: 'Maria Keane',
    templateId: 'tpl-att', templateVersion: 1, attributesSnapshot: ATTRS.ATT,
    context: { fixture: 'Hackney Marsh Rovers v Leyton Wanderers', date: '2026-08-30', minutesWatched: 90, viewing: 'live' },
    ratings: [
      { attrId: 'finishing', rating: 4, notObserved: false, confidence: 'high', note: 'both feet', evidenceRefs: [{ segmentId: 'seg-d1' }] },
      { attrId: 'movement', rating: 4, notObserved: false, confidence: 'medium', evidenceRefs: [] },
      { attrId: 'first_touch', rating: 3, notObserved: false, confidence: 'high', evidenceRefs: [] },
      { attrId: 'pressing', rating: null, notObserved: true, confidence: 'medium', evidenceRefs: [] },
    ],
    state: 'submitted', recommendation: { verdict: 'monitor', reasons: 'Real threat; want a second look against a deeper block.' },
    secondOpinionOf: null, createdAt: NOW - 6 * DAY, submittedAt: NOW - 6 * DAY,
    publishedFeedback: { text: 'Loved the movement and finishing. Focus next: pressing triggers — set the press, don’t chase it.', byName: 'Maria Keane', at: NOW - 5 * DAY },
  },
  {
    id: 'ass-d2', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi', scoutUserId: 'usr-alex', scoutName: 'Alex Ford',
    templateId: 'tpl-att', templateVersion: 1, attributesSnapshot: ATTRS.ATT,
    context: { fixture: 'Cup replay v Rovers', date: '2026-09-02', minutesWatched: 65, viewing: 'video' },
    ratings: [
      { attrId: 'finishing', rating: 3, notObserved: false, confidence: 'medium', evidenceRefs: [] },
      { attrId: 'movement', rating: null, notObserved: true, confidence: 'low', evidenceRefs: [] },
      { attrId: 'first_touch', rating: 4, notObserved: false, confidence: 'high', evidenceRefs: [] },
      { attrId: 'pressing', rating: 2, notObserved: false, confidence: 'low', evidenceRefs: [] },
    ],
    state: 'submitted', recommendation: { verdict: 'monitor', reasons: 'Different game state; finishing sample small.' },
    secondOpinionOf: 'ass-d1', createdAt: NOW - 4 * DAY, submittedAt: NOW - 4 * DAY, publishedFeedback: null,
  },
];

// ---- video
const SEGMENTS: Segment[] = [
  { id: 'seg-d1', mediaId: 'm1', playerId: 'pl-adeyemi', startS: 12, endS: 26, labels: ['pressing', 'counter'], eventType: 'defensive action', note: 'sets the trap on the CB', createdBy: { name: 'Maria Keane' }, createdAt: NOW - 6 * DAY },
  { id: 'seg-d2', mediaId: 'm1', playerId: 'pl-adeyemi', startS: 41, endS: 55, labels: ['finishing'], eventType: 'shot', note: 'first-time finish, weak side', createdBy: { name: 'Alex Ford' }, createdAt: NOW - 4 * DAY },
];
const PLAYLISTS: Playlist[] = [{ id: 'pls-d1', name: 'Pressing candidates', segmentIds: ['seg-d1'] }];

// ---- recruitment
const STAFF: StaffRow[] = [
  { id: 'usr-maria', name: 'Maria Keane', role: 'Head of Recruitment', lead: true, removedAt: null },
  { id: 'usr-alex', name: 'Alex Ford', role: 'Scout', lead: false, removedAt: null },
  { id: 'usr-jo', name: 'Jo Beckett', role: 'Analyst', lead: false, removedAt: null },
];
const CASES: CaseRec[] = [
  {
    id: 'case-d1', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi', vacancyId: 'vac-d1', ownerUserId: 'usr-maria', ownerName: 'Maria Keane',
    stage: 'observation', priority: 'high', deadline: null, restricted: false,
    assignments: [{ id: 'asg-d1', userId: 'usr-alex', name: 'Alex Ford', task: 'Second opinion v deeper block', dueAt: null, status: 'open' }],
    tasks: [{ id: 'tsk-d1', title: 'Pull pressing segments for compare', dueAt: null, status: 'done', completedBy: 'Jo Beckett' }],
    approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null },
    history: [
      { at: NOW - 7 * DAY, byName: 'Maria Keane', action: 'created', detail: 'identified' },
      { at: NOW - 6 * DAY, byName: 'Maria Keane', action: 'assigned', detail: 'Alex Ford: second opinion' },
      { at: NOW - 4 * DAY, byName: 'Alex Ford', action: 'stage', detail: 'review → observation' },
    ],
    createdAt: NOW - 7 * DAY,
  },
];

// ---- tactical
const TACTICAL: Tactical = {
  formation: '4-3-3', planningHorizon: '2 windows',
  windows: [{ name: 'Summer 2027', opens: '2027-06-01', closes: '2027-08-31' }],
  roles: [
    { id: 'role-d1', name: 'Pressing 9', positionGroup: 'ATT', description: 'Leads the press, attacks depth', category: 'mens',
      required: [{ key: 'positionGroup', value: 'ATT' }, { key: 'maxAge', value: 23 }],
      preferred: [{ key: 'foot', value: 'L' }, { key: 'minAppearances', value: 10 }] },
    { id: 'role-d2', name: 'Tempo 8', positionGroup: 'MID', description: 'Receives under pressure, dictates rhythm', category: 'mens',
      required: [{ key: 'positionGroup', value: 'MID' }], preferred: [{ key: 'availability', value: 'available_now' }] },
  ],
};
const VACANCIES: Vacancy[] = [{ id: 'vac-d1', roleId: 'role-d1', roleName: 'Pressing 9', status: 'open', notes: 'ST leaves summer 2027', createdAt: NOW - 9 * DAY }];
const CAND_POOL = [
  { playerId: 'pl-adeyemi', name: 'Kola Adeyemi', position: 'ST', age: 22, foot: 'R', apps: 28 },
  { playerId: 'pl-okafor', name: 'Chinedu Okafor', position: 'LW', age: 22, foot: 'L', apps: 24 },
  { playerId: 'pl-svensson', name: 'Elias Svensson', position: 'RW', age: 21, foot: 'L', apps: null },
];
function candidatesFor(role: Tactical['roles'][number]): Candidate[] {
  return CAND_POOL.map((p) => {
    const evalC = (c: Criterion): Criterion => {
      if (c.key === 'positionGroup') return { ...c, verdict: ['ST', 'CF', 'RW', 'LW'].includes(p.position) === (c.value === 'ATT') ? 'met' : 'not_met', source: 'profile field: position' };
      if (c.key === 'maxAge') return { ...c, verdict: p.age <= (c.value as number) ? 'met' : 'not_met', source: 'profile field: age' };
      if (c.key === 'foot') return { ...c, verdict: p.foot === c.value ? 'met' : 'not_met', source: 'profile field: foot' };
      if (c.key === 'minAppearances') return { ...c, verdict: p.apps == null ? 'unknown' : p.apps >= (c.value as number) ? 'met' : 'not_met', source: p.apps == null ? 'no appearances statistic recorded' : 'self-reported statistic' };
      return { ...c, verdict: 'unknown', source: 'not recorded' };
    };
    const required = role.required.map(evalC);
    const preferred = role.preferred.map(evalC);
    return {
      playerId: p.playerId, name: p.name, position: p.position, age: p.age,
      required, preferred,
      requiredMet: required.filter((c) => c.verdict === 'met').length, requiredTotal: required.length,
      unknowns: [...required, ...preferred].filter((c) => c.verdict === 'unknown').length,
      onSquad: false, caseId: p.playerId === 'pl-adeyemi' ? 'case-d1' : null,
    };
  }).filter((c) => !c.required.some((r) => r.verdict === 'not_met'))
    .sort((a, b) => b.requiredMet - a.requiredMet || a.unknowns - b.unknowns);
}
const SHADOW: { playerId: string; name: string; position: string | null; roleId: string | null }[] = [
  { playerId: 'pl-okafor', name: 'Chinedu Okafor', position: 'LW', roleId: 'role-d1' },
];

// ---- opportunities
const OPPS: Opportunity[] = [{
  id: 'opp-d1', type: 'trial', title: 'Sunday open trial — all positions', team: 'U23', category: 'mens', ageGroup: 'U23', role: 'Forward',
  description: 'Two-session look at pressing forwards for the development squad.', schedule: 'Sat 09:30, Hackney Marsh, Pitch 4',
  deadline: new Date(NOW + 18 * DAY).toISOString().slice(0, 10), capacity: 20,
  eligibility: { minAge: 16, maxAge: 23, positionGroup: 'ATT', radiusKm: null },
  requirements: ['Bring boots', 'One highlight clip'], status: 'published', open: true, applications: 2, outstanding: 1,
}];
const APPLICATIONS: Application[] = [
  { id: 'apl-d1', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi', status: 'accepted', note: 'Would love a look.', outcome: { decision: 'accepted', note: 'See you Saturday.', byName: 'Maria Keane' }, submittedBy: { kind: 'player', name: 'Kola Adeyemi' }, createdAt: NOW - 3 * DAY },
  { id: 'apl-d2', playerId: 'pl-okafor', playerName: 'Chinedu Okafor', status: 'submitted', note: null, outcome: null, submittedBy: { kind: 'player', name: 'Chinedu Okafor' }, createdAt: NOW - 1 * DAY },
];

// ---- campaigns
const CAMPAIGNS: Campaign[] = [{
  id: 'cmp-d1', title: 'Remote sprint assessment', deadline: new Date(NOW + 12 * DAY).toISOString().slice(0, 10), attemptsAllowed: 2, status: 'published',
  drills: [{ name: '30m sprint', instructions: 'Two cones 30m apart, one run per clip.', recording: { equipment: 'Any phone ≥720p', distance: 'Full run in frame', surface: 'Flat grass', camera: 'Fixed, side-on' } }],
  rubric: [{ criterion: 'Full run visible', guidance: 'Start and finish cones both in frame' }],
  submissions: 2, awaitingReview: 1,
}];
const QUEUE: { playerId: string; playerName: string; attempt: CampaignAttempt }[] = [
  { playerId: 'pl-svensson', playerName: 'Elias Svensson', attempt: { id: 'att-d1', mediaId: 'm5', drillName: '30m sprint', status: 'submitted', fileChecks: { passed: true, issues: [], kind: 'automated_file_check' }, review: null, submittedAt: NOW - DAY, mediaUrl: null } },
];

// ---- objectives / followups / trial day / coaches
const OBJECTIVES: Objective[] = [{
  id: 'obj-d1', playerId: 'pl-adeyemi',
  objectives: [{ id: 'ox-1', text: 'Set the press on the trigger, not the chase', baselineEvidenceIds: ['evd-d1'] }],
  progress: [{ at: NOW - 2 * DAY, note: 'Two pressing sessions with Sunday league', evidenceId: 'evd-d2' }],
  reassessments: [{ id: 'ras-d1', status: 'requested', requestedAt: NOW - DAY, outcome: null }],
  sharing: { orgIds: ['org-hackneymarsh'] }, status: 'active',
}];
const FOLLOWUPS: FollowUp[] = [
  { id: 'fup-d1', playerId: 'pl-nowak', playerName: 'Filip Nowak', milestone: '3m', dueAt: NOW - 2 * DAY, status: 'due', outcomeState: 'unknown_pending', report: null },
  { id: 'fup-d2', playerId: 'pl-nowak', playerName: 'Filip Nowak', milestone: '6m', dueAt: NOW + 89 * DAY, status: 'scheduled', outcomeState: 'not_due', report: null },
  { id: 'fup-d0', playerId: 'pl-martin', playerName: 'Théo Martin', milestone: '3m', dueAt: NOW - 40 * DAY, status: 'complete', outcomeState: 'confirmed', report: { registrationStatus: 'registered', matchesPlayed: 6, progression: 'Rotation starter', status: 'confirmed' } },
];
const TRIAL_DAYS = new Map<string, TrialDay>();
function dayFor(trialId: string, playerName = 'Elias Svensson', playerId = 'pl-svensson'): TrialDay {
  if (!TRIAL_DAYS.has(trialId)) {
    TRIAL_DAYS.set(trialId, {
      id: trialId, playerId, playerName, proposedDate: new Date(NOW + 6 * DAY).toISOString().slice(0, 10), venue: 'Hackney Marsh, Pitch 4', reportDueAt: NOW + 13 * DAY,
      staff: [
        { id: 'stf-d1', name: 'Priya Shah', role: 'Safeguarding Lead', check: { kind: 'DBS (England & Wales)', status: 'reviewed', expiresAt: new Date(NOW + 290 * DAY).toISOString() } },
        { id: 'stf-d2', name: 'Marcus Cole', role: 'U23 Coach', check: { kind: 'DBS (England & Wales)', status: 'pending', expiresAt: null } },
      ],
      arrival: { time: '09:30', address: 'Gate B, Hackney Marsh, Pitch 4', notes: 'Ask for Priya at reception.' },
      consents: [{ byKind: 'player', scope: 'player_event_consent', at: NOW - 2 * DAY }],
      checkins: [], statusEvents: [], cancelled: false,
      emergency: { name: 'Lena Svensson', phone: '+46 70 ••• •• 22' }, collection: null,
    });
  }
  return TRIAL_DAYS.get(trialId)!;
}
const COACHES: Affiliation[] = [{
  id: 'aff-d1', coachName: 'Dee Mensah', coachEmail: 'dee@club.example', role: 'Head Coach', from: '2024-08-01', to: null,
  status: 'confirmed', current: true, conflictOfInterest: 'none declared', confirmedBy: { name: 'Maria Keane' },
}];

const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 120));

export const demoM12: M12Api = {
  getPassport: async (_s, playerId) => delay(passportFor(playerId)),
  corroborateEvidence: async (_s, evidenceId) => {
    const rec = Object.values(EVIDENCE).flat().find((e) => e.id === evidenceId);
    if (!rec) throw new Error('not found');
    rec.verification = { status: 'club_assessed', method: 'corroborated by your club (demo)', reviewerName: 'You', reviewedAt: Date.now() };
    return delay(rec);
  },
  disputeEvidence: async (_s, evidenceId) => {
    const rec = Object.values(EVIDENCE).flat().find((e) => e.id === evidenceId);
    if (rec) rec.openDisputes = (rec.openDisputes ?? 0) + 1;
    return delay(undefined);
  },
  submitClubEvidence: async (_s, playerId, input) => {
    (EVIDENCE[playerId] ??= []).unshift({
      id: id('evd'), playerId, claimType: input.claimType, label: input.label, value: input.value ?? null,
      units: input.units ?? null, season: input.season ?? null,
      source: { kind: 'org', id: 'org', name: 'Your club' }, observedAt: Date.now(), recordedAt: Date.now(),
      verification: { status: 'club_assessed', method: 'club_assessment', reviewerName: 'You', reviewedAt: Date.now() },
      freshness: { ageDays: 0, fresh: true }, superseded: false, openDisputes: 0,
    });
    return delay(undefined);
  },

  listTemplates: async () => delay({ templates: TEMPLATES, note: 'New versions never alter historical reports — every assessment snapshots its template.' }),
  listAssessments: async (s, playerId) => {
    // The blind rule, mirrored: others' reports hidden until you submit yours.
    let list = ASSESSMENTS.filter((a) => !playerId || a.playerId === playerId);
    const mineSubmitted = list.some((a) => a.scoutUserId === s.userId && a.state !== 'draft');
    const iAmLead = /head|director|lead|manager/i.test(s.role);
    if (!iAmLead) list = list.filter((a) => a.scoutUserId === s.userId || (mineSubmitted && a.state !== 'draft'));
    return delay(list.slice().sort((a, b) => b.createdAt - a.createdAt));
  },
  createAssessment: async (s, playerId, positionGroup = 'ATT', secondOpinionOf, context) => {
    const tmpl = TEMPLATES.find((t) => t.positionGroup === positionGroup) ?? TEMPLATES[0];
    const a: Assessment = {
      id: id('ass'), playerId, playerName: CAND_POOL.find((p) => p.playerId === playerId)?.name ?? 'Player',
      scoutUserId: s.userId, scoutName: s.scoutName, templateId: tmpl.id, templateVersion: tmpl.version,
      attributesSnapshot: tmpl.attributes, context: context ?? {}, ratings: [], state: 'draft',
      recommendation: null, secondOpinionOf: secondOpinionOf ?? null, createdAt: Date.now(), submittedAt: null, publishedFeedback: null,
    };
    ASSESSMENTS.push(a);
    return delay(a);
  },
  updateAssessment: async (_s, aid, patch) => {
    const a = ASSESSMENTS.find((x) => x.id === aid)!;
    if (patch.ratings) a.ratings = patch.ratings as AssessmentRating[];
    if (patch.context) a.context = { ...a.context, ...patch.context };
    if (patch.recommendation) a.recommendation = patch.recommendation;
    return delay(a);
  },
  submitAssessment: async (_s, aid) => {
    const a = ASSESSMENTS.find((x) => x.id === aid)!;
    a.state = 'submitted';
    a.submittedAt = Date.now();
    return delay(a);
  },
  compareAssessments: async (s, playerId) => {
    const list = ASSESSMENTS.filter((a) => a.playerId === playerId && a.state !== 'draft');
    const attributes = (ATTRS.ATT).map((attr) => {
      const cells = list.map((a) => {
        const r = a.ratings.find((x) => x.attrId === attr.id);
        return { scoutName: a.scoutName, rating: r?.notObserved ? null : r?.rating ?? null, notObserved: r?.notObserved ?? true, confidence: r?.confidence ?? null };
      });
      const observed = cells.filter((c) => c.rating != null);
      return { attrId: attr.id, label: attr.label, cells, observedCount: observed.length, average: observed.length ? Math.round(observed.reduce((x, c) => x + (c.rating as number), 0) / observed.length * 10) / 10 : null };
    });
    const cr: CompareResult = {
      assessments: list.map((a) => ({ id: a.id, scoutName: a.scoutName, submittedAt: a.submittedAt ?? 0, recommendation: a.recommendation, templateVersion: a.templateVersion })),
      attributes, sameScale: true,
      note: '"Not observed" is excluded from averages — observedCount says how many scouts actually saw each attribute.',
    };
    return delay(cr);
  },
  publishFeedback: async (_s, aid, text) => {
    const a = ASSESSMENTS.find((x) => x.id === aid)!;
    a.publishedFeedback = { text, byName: 'You', at: Date.now() };
    return delay(undefined);
  },

  listSegments: async (_s, playerId) => delay(SEGMENTS.filter((x) => !playerId || x.playerId === playerId)),
  createSegment: async (s, mediaId, input) => {
    const seg: Segment = { id: id('seg'), mediaId, playerId: 'pl-adeyemi', startS: input.startS, endS: input.endS, labels: input.labels, eventType: input.eventType ?? null, note: input.note ?? null, createdBy: { name: s.scoutName }, createdAt: Date.now() };
    SEGMENTS.push(seg);
    return delay(seg);
  },
  listPlaylists: async () => delay(PLAYLISTS),
  createPlaylist: async (_s, name) => {
    const pl = { id: id('pls'), name, segmentIds: [] as string[] };
    PLAYLISTS.push(pl);
    return delay(pl);
  },
  addToPlaylist: async (_s, playlistId, segmentId) => {
    const pl = PLAYLISTS.find((x) => x.id === playlistId);
    if (pl && !pl.segmentIds.includes(segmentId)) pl.segmentIds.push(segmentId);
    return delay(undefined);
  },

  listCases: async () => delay({ items: CASES.slice().sort((a, b) => b.createdAt - a.createdAt), stages: ['identified', 'review', 'observation', 'trial', 'decision', 'closed'] }),
  createCase: async (s, playerId, opts) => {
    const c: CaseRec = {
      id: id('case'), playerId, playerName: CAND_POOL.find((p) => p.playerId === playerId)?.name ?? 'Player',
      vacancyId: opts?.vacancyId ?? null, ownerUserId: s.userId, ownerName: s.scoutName,
      stage: 'identified', priority: opts?.priority ?? 'medium', deadline: null, restricted: !!opts?.restricted,
      assignments: [], tasks: [], approvals: [], decision: null, links: { requestIds: [], trialIds: [], signingId: null },
      history: [{ at: Date.now(), byName: s.scoutName, action: 'created', detail: 'identified' }], createdAt: Date.now(),
    };
    CASES.push(c);
    return delay(c);
  },
  setStage: async (s, caseId, stage, reason) => {
    const c = CASES.find((x) => x.id === caseId)!;
    c.history.push({ at: Date.now(), byName: s.scoutName, action: 'stage', detail: `${c.stage} → ${stage}${reason ? `: ${reason}` : ''}` });
    c.stage = stage;
    return delay(c);
  },
  assignScout: async (s, caseId, userId, task) => {
    const c = CASES.find((x) => x.id === caseId)!;
    const u = STAFF.find((x) => x.id === userId)!;
    c.assignments.push({ id: id('asg'), userId, name: u.name, task, dueAt: null, status: 'open' });
    c.history.push({ at: Date.now(), byName: s.scoutName, action: 'assigned', detail: `${u.name}: ${task}` });
    return delay(undefined);
  },
  decideCase: async (s, caseId, outcome, reasons) => {
    const c = CASES.find((x) => x.id === caseId)!;
    const iAmLead = /head|director|lead|manager/i.test(s.role);
    if (outcome === 'sign' && !iAmLead) {
      const appr = { id: id('apr'), decision: { outcome, reasons }, requestedBy: { name: s.scoutName }, status: 'pending' };
      c.approvals.push(appr);
      c.history.push({ at: Date.now(), byName: s.scoutName, action: 'approval_requested', detail: outcome });
      return delay({ approval: appr, pending: true });
    }
    c.decision = { outcome, reasons, byName: s.scoutName, at: Date.now() };
    c.stage = 'decision';
    c.history.push({ at: Date.now(), byName: s.scoutName, action: 'decision', detail: outcome });
    return delay({ case: c, pending: false });
  },
  approveCase: async (s, caseId, approvalId, approve) => {
    const c = CASES.find((x) => x.id === caseId)!;
    const appr = c.approvals.find((x) => x.id === approvalId)!;
    appr.status = approve ? 'approved' : 'rejected';
    if (approve) {
      c.decision = { ...appr.decision, byName: appr.requestedBy.name, approvedBy: s.scoutName, at: Date.now() };
      c.stage = 'decision';
    }
    c.history.push({ at: Date.now(), byName: s.scoutName, action: approve ? 'approved' : 'rejected', detail: appr.decision.outcome });
    return delay(c);
  },
  listStaff: async () => delay(STAFF),
  removeStaff: async (_s, userId) => {
    const u = STAFF.find((x) => x.id === userId);
    if (u) u.removedAt = Date.now();
    return delay(undefined);
  },

  getTactical: async () => delay({ tactical: TACTICAL, criteriaKeys: ['positionGroup', 'minAge', 'maxAge', 'foot', 'availability', 'maxLevel', 'minAppearances', 'category'] }),
  saveTactical: async (_s, t) => {
    TACTICAL.formation = t.formation;
    return delay(TACTICAL);
  },
  listVacancies: async () => delay(VACANCIES),
  createVacancy: async (_s, roleId, notes) => {
    const role = TACTICAL.roles.find((r) => r.id === roleId)!;
    const v: Vacancy = { id: id('vac'), roleId, roleName: role.name, status: 'open', notes: notes ?? null, createdAt: Date.now() };
    VACANCIES.push(v);
    return delay(v);
  },
  vacancyCandidates: async (_s, vacancyId) => {
    const v = VACANCIES.find((x) => x.id === vacancyId)!;
    const role = TACTICAL.roles.find((r) => r.id === v.roleId)!;
    return delay({ role, candidates: candidatesFor(role), note: 'Rule-based comparison: criteria met / not met / unknown with the data source for each. Unknown stays unknown — no invented suitability scores.' });
  },
  addShadow: async (_s, playerId, roleId) => {
    const p = CAND_POOL.find((x) => x.playerId === playerId);
    if (p && !SHADOW.some((x) => x.playerId === playerId)) SHADOW.push({ playerId, name: p.name, position: p.position, roleId: roleId ?? null });
    return delay(undefined);
  },
  squadPlanner: async () => delay({
    formation: TACTICAL.formation, roles: TACTICAL.roles,
    current: [
      { playerId: 'pl-martin', name: 'Théo Martin', position: 'CM', contractUntil: '2027-06-30', source: 'signing' },
      { playerId: 'pl-nowak', name: 'Filip Nowak', position: 'CB', contractUntil: '2026-12-31', source: 'signing' },
    ],
    shadow: SHADOW, vacancies: VACANCIES.filter((v) => v.status === 'open'),
  }),

  listOpportunities: async () => delay(OPPS),
  createOpportunity: async (_s, input) => {
    const o: Opportunity = {
      id: id('opp'), type: input.type, title: input.title, team: input.team ?? null, category: input.category ?? 'mixed',
      ageGroup: input.ageGroup ?? null, role: input.role ?? null, description: input.description ?? null,
      schedule: input.schedule ?? null, deadline: input.deadline, capacity: input.capacity ?? null,
      eligibility: (input.eligibility as Opportunity['eligibility']) ?? { minAge: null, maxAge: null, positionGroup: 'any', radiusKm: null },
      requirements: input.requirements ?? [], status: 'published', open: true, applications: 0, outstanding: 0,
    };
    OPPS.push(o);
    return delay(o);
  },
  listApplications: async (_s, opportunityId) => delay(opportunityId === 'opp-d1' ? APPLICATIONS : []),
  resolveApplication: async (s, applicationId, decision, note) => {
    const a = APPLICATIONS.find((x) => x.id === applicationId);
    if (a) {
      a.status = decision;
      a.outcome = { decision, note: note ?? null, byName: s.scoutName };
    }
    return delay(undefined);
  },
  closeOpportunity: async (_s, oid) => {
    const o = OPPS.find((x) => x.id === oid);
    if (o) {
      if (APPLICATIONS.some((a) => a.status === 'submitted') && o.id === 'opp-d1') throw new Error('Every applicant gets an answer before the door closes.');
      o.status = 'closed';
      o.open = false;
    }
    return delay(undefined);
  },

  listCampaigns: async () => delay(CAMPAIGNS),
  createCampaign: async (_s, input) => {
    const c: Campaign = { id: id('cmp'), title: input.title, deadline: input.deadline, attemptsAllowed: input.attemptsAllowed ?? 2, status: 'published', drills: input.drills, rubric: input.rubric ?? [], submissions: 0, awaitingReview: 0 };
    CAMPAIGNS.push(c);
    return delay(c);
  },
  reviewQueue: async (_s, campaignId) => delay({ campaign: { title: CAMPAIGNS.find((c) => c.id === campaignId)?.title ?? '', rubric: CAMPAIGNS[0].rubric }, queue: QUEUE.filter((q) => q.attempt.status === 'submitted') }),
  reviewAttempt: async (s, attemptId, decision, reasons, rubricNotes) => {
    const q = QUEUE.find((x) => x.attempt.id === attemptId);
    if (q) {
      q.attempt.status = decision;
      q.attempt.review = { byName: s.scoutName, reasons: reasons ?? null, rubricNotes: rubricNotes ?? null, kind: 'human_review' };
    }
    return delay(undefined);
  },

  playerObjectives: async (_s, playerId) => delay(OBJECTIVES.filter((o) => o.playerId === playerId && o.sharing.orgIds.includes('org-hackneymarsh'))),
  reassessmentOutcome: async (s, reassessmentId, note) => {
    const o = OBJECTIVES.find((x) => x.reassessments.some((r) => r.id === reassessmentId));
    const r = o?.reassessments.find((x) => x.id === reassessmentId);
    if (r) {
      r.status = 'completed';
      r.outcome = { note, byName: s.scoutName };
    }
    return delay(undefined);
  },

  listFollowUps: async () => delay(FOLLOWUPS),
  reportFollowUp: async (_s, fid, input) => {
    const f = FOLLOWUPS.find((x) => x.id === fid);
    if (f) {
      f.report = { registrationStatus: input.registrationStatus, matchesPlayed: input.matchesPlayed ?? null, progression: input.progression ?? null, status: 'reported' };
      f.status = 'complete';
      f.outcomeState = 'reported';
    }
    return delay(undefined);
  },

  getTrialDay: async (_s, trialId) => delay(dayFor(trialId)),
  addTrialStaff: async (_s, trialId, input) => {
    dayFor(trialId).staff.push({ id: id('stf'), name: input.name, role: input.role, check: input.check ? { kind: input.check.kind, status: 'pending', expiresAt: input.check.expiresAt ?? null } : { kind: null, status: 'missing', expiresAt: null } });
    return delay({ note: 'The check is PENDING until Trust & Safety reviews it — an uploaded reference is not a completed background check.' });
  },
  setArrival: async (_s, trialId, input) => {
    const d = dayFor(trialId);
    d.arrival = { time: input.time ?? null, address: input.address ?? null, notes: input.notes ?? null };
    return delay(d);
  },
  checkinTrial: async (_s, trialId) => {
    const d = dayFor(trialId);
    if (!d.staff.some((x) => x.check.status === 'reviewed')) throw new Error('At least one named staff member needs a REVIEWED, unexpired background check before anyone checks in.');
    if (!d.consents.length) throw new Error('Event consent has not been given for this trial day.');
    if (d.checkins.some((c) => c.playerId === d.playerId)) throw new Error('Already checked in.');
    d.checkins.push({ playerId: d.playerId, at: Date.now(), byName: 'You' });
    return delay(d);
  },
  postponeTrial: async (_s, trialId, reason, newDate) => {
    const d = dayFor(trialId);
    d.statusEvents.push({ kind: 'postponed', at: Date.now(), reason, newDate: newDate ?? null });
    if (newDate) d.proposedDate = newDate;
    return delay(undefined);
  },
  cancelTrial: async (_s, trialId, reason) => {
    const d = dayFor(trialId);
    d.statusEvents.push({ kind: 'cancelled', at: Date.now(), reason, newDate: null });
    d.cancelled = true;
    return delay(undefined);
  },

  listCoaches: async () => delay(COACHES),
  addCoach: async (s, input) => {
    const a: Affiliation = { id: id('aff'), coachName: input.coachName, coachEmail: input.coachEmail ?? null, role: input.role, from: new Date().toISOString().slice(0, 10), to: null, status: 'confirmed', current: true, conflictOfInterest: input.conflictOfInterest ?? null, confirmedBy: { name: s.scoutName } };
    COACHES.push(a);
    return delay(a);
  },
  endCoach: async (_s, aid, revoke) => {
    const a = COACHES.find((x) => x.id === aid);
    if (a) {
      a.status = revoke ? 'revoked' : 'ended';
      a.current = false;
      a.to = new Date().toISOString().slice(0, 10);
    }
    return delay(undefined);
  },
  inviteToSquad: async (_s, playerId) => delay({ status: playerId === 'pl-guni' ? 'pending_guardian' : 'pending_player' }),
};
