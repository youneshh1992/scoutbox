// M17 demo mirror (org side) — a SELF-CONTAINED Recruitment Room fixture.
//
// ⚠ Circular-import discipline (the exact bug that crashed the M16.1 bundle):
// roomsApi imports this module, so this module takes only TYPES from roomsApi
// (`import type`, erased at build time). It never reads a runtime binding from
// roomsApi, and it never calls an imported value at module-load time. Every
// constant used to build these fixtures — statuses, transitions, the reason
// taxonomy, the recommendation list, the notes — is declared right here.
//
// Same honesty rules as live. The Room is the CLUB's private decision layer:
// nothing here is visible to the player, their guardian or any other club. The
// Trust Score is evidence confidence and travels with its note; no measurement
// ever "moves" it; readiness is counts and words; health is a word, never a
// number; and rooms are ordered by recent activity, never ranked by score.
//
// Module-level arrays are deliberately MUTABLE so the demo behaves like the
// real thing: a comment posted here stays posted, a status move re-derives
// readiness and health, and a decision appends to the memory instead of
// overwriting it.
import type {
  CreateRoomInput, CreateRoomResult, PatchRoomInput, Room, RoomActivityItem,
  RoomActivityResult, RoomAssessment, RoomAttentionItem, RoomCombine,
  RoomComment, RoomCommentsResult, RoomDecision, RoomDecisionsResult,
  RoomDevelopment, RoomEvidenceItem, RoomFunnel, RoomListItem, RoomListResult,
  RoomMissingEvidence, RoomReadiness, RoomSnapshot, RoomSummaryRow, RoomTask,
  RoomTrial, RoomTrust, RoomsApi, ContactRecord, ContactList, ContactRouting, ContactCaseMove,
  TrialWorkflowState, TrialAttendanceState, TrialSessionView, TrialRevisionView, TrialAttendanceRecord, TrialHistoryEntry,
  TrialClubView, TrialInvitationView, TrialList, TrialEvidenceView, TrialEvidenceCandidate,
} from './roomsApi';
import type { RecruitmentPassport } from './m15api';
import { ApiError } from './api';

// ------------------------------------------------------------ local notes
const TRUST_NOTE = 'Evidence confidence — not football ability.';
const TRUST_DISCLAIMER = 'ScoutBox Trust Score reflects verification and evidence confidence — not football ability or recruitment suitability.';
const PRIVACY_NOTE = 'This room is private to your organisation. The player, their guardian and every other club can never see it.';
const UNAVAILABLE_NOTE = 'Player data is currently unavailable to your organisation under the standing rules. Your internal record remains.';
const PRIORITY_NOTE = 'Internal workflow urgency for your organisation. It is not a judgement of the player and is never shown to them.';
const READINESS_NOTE = 'Workflow completeness, not a recommendation. ScoutBox does not decide whether to sign a player.';
const DECISION_NOTE = 'Decisions are append-only. A revision supersedes its predecessor; nothing is rewritten.';
const SNAPSHOT_NOTE = 'Evidence confidence at the time of the decision. It is not a record of the player’s ability.';
const DEV_NOTE = 'Box Cam activity shows verified training evidence. It does not independently establish football ability.';
const COMBINE_NOTE = 'Combine Verified: measured from a standardized ScoutBox protocol during a live Box Cam session. Powered by Box Cam. Real numbers, not a talent score.';
const COMBINE_NOT_SHARED = 'This player has not shared Combine results with your organisation.';
const LIST_NOTE = 'Rooms are listed by most recent activity. ScoutBox never orders players by Trust Score.';
const ATTENTION_NOTE = 'Deterministic workflow signals only. ScoutBox does not rank or score these for you.';
const FUNNEL_NOTE = 'Your organisation’s own recruitment activity. ScoutBox publishes no cross-club league table.';
const REVIEW_NOTE = 'Internal review state only — the evidence record itself is unchanged.';
const EVIDENCE_ROUTED_NOTE = 'Routed through the standing evidence-request rules, including guardian routing for under-18s.';

const CLUB_COPY = 'Confirmed by an authorised administrator of the named organisation.';
const PLAYER_COPY = 'Provided by the player. ScoutBox has not independently confirmed this item.';
const COACH_COPY = 'Confirmed by a coach whose club affiliation was verified when they confirmed it.';

// ------------------------------------------------------ local vocabularies
const STATUS_LABELS: Record<string, string> = {
  watching: 'Watching', under_review: 'Under review', shortlisted: 'Shortlisted',
  priority: 'Priority', trial_requested: 'Trial requested', trial_scheduled: 'Trial scheduled',
  // M23 — the two contact states, mirrored from the server.
  contact_planned: 'Contact planned', contacted: 'Contacted',
  trial_completed: 'Trial completed', offer_consideration: 'Offer consideration',
  offer_made: 'Offer made', signed: 'Signed', withdrawn: 'Withdrawn',
  archived: 'Archived', closed: 'Closed',
};
const ALL_STATUSES = Object.keys(STATUS_LABELS);
const OPEN_STATUSES = ALL_STATUSES.filter((s) => !['signed', 'withdrawn', 'archived', 'closed'].includes(s));

const TRANSITIONS: Record<string, string[]> = {
  watching: ['under_review', 'shortlisted', 'contact_planned', 'withdrawn', 'archived'],
  under_review: ['watching', 'shortlisted', 'priority', 'contact_planned', 'trial_requested', 'withdrawn', 'archived'],
  // M23 — the two contact states. `contacted` is reached only by a real contact (see the Contact methods), never by the status picker.
  contact_planned: ['under_review', 'shortlisted', 'priority', 'withdrawn', 'archived'],
  contacted: ['shortlisted', 'priority', 'trial_requested', 'offer_consideration', 'under_review', 'withdrawn', 'archived'],
  shortlisted: ['under_review', 'priority', 'contact_planned', 'trial_requested', 'offer_consideration', 'withdrawn', 'archived'],
  priority: ['shortlisted', 'contact_planned', 'trial_requested', 'offer_consideration', 'withdrawn', 'archived'],
  trial_requested: ['trial_scheduled', 'shortlisted', 'priority', 'withdrawn', 'archived'],
  trial_scheduled: ['trial_completed', 'trial_requested', 'withdrawn', 'archived'],
  trial_completed: ['offer_consideration', 'shortlisted', 'priority', 'withdrawn', 'archived'],
  offer_consideration: ['offer_made', 'shortlisted', 'priority', 'withdrawn', 'archived'],
  offer_made: ['signed', 'offer_consideration', 'withdrawn', 'archived'],
  signed: ['closed'],
  withdrawn: ['under_review', 'archived', 'closed'],
  archived: ['under_review', 'closed'],
  closed: ['under_review'],
};
const REASON_REQUIRED = ['withdrawn', 'archived', 'closed'];
const STAGE_OF: Record<string, string> = {
  watching: 'identified', under_review: 'review', contact_planned: 'review', contacted: 'review', shortlisted: 'observation', priority: 'observation',
  trial_requested: 'trial', trial_scheduled: 'trial', trial_completed: 'trial',
  offer_consideration: 'decision', offer_made: 'decision',
  signed: 'closed', withdrawn: 'closed', archived: 'closed', closed: 'closed',
};

const REASON_CATEGORIES: Record<string, string[]> = {
  football: ['technical_fit', 'tactical_fit', 'physical_profile', 'position_need', 'development_upside'],
  evidence: ['insufficient_full_match', 'insufficient_recent_evidence', 'reference_missing', 'combine_missing'],
  process: ['budget', 'squad_space', 'timing', 'registration', 'travel_logistics', 'eligibility'],
  outcome: ['trial_needed', 'continue_monitoring', 'not_current_priority', 'trial_outcome', 'player_unavailable'],
};
const RECOMMENDATIONS = ['no_decision', 'continue_watching', 'shortlist', 'priority', 'trial', 'offer', 'archive'];

const HEALTH_LABELS: Record<string, string> = {
  decision_recorded: 'Decision recorded', trial_pending: 'Trial pending',
  assessment_outstanding: 'Assessment outstanding', waiting_on_evidence: 'Waiting on evidence',
  ready_for_review: 'Ready for review',
};

// --------------------------------------------------------------- fixtures
const NOW = Date.now();
const DAY = 86_400_000;
const ORG_ID = 'org-demo';
const ME = { userId: 'u-demo', name: 'A. Coach' };

interface DemoPlayer { name: string; position: string; age: number; currentClub: string | null }
const PLAYERS: Record<string, DemoPlayer> = {
  'pl-adeyemi': { name: 'Kola Adeyemi', position: 'ST', age: 22, currentClub: 'Eastport United FC' },
  'pl-svensson': { name: 'Elias Svensson', position: 'RW', age: 21, currentClub: null },
  'pl-carvalho': { name: 'Mateus Carvalho', position: 'CM', age: 23, currentClub: 'Porto B' },
  'pl-okafor': { name: 'Chinedu Okafor', position: 'CB', age: 22, currentClub: 'Lagos City FC' },
  'pl-martin': { name: 'Théo Martin', position: 'GK', age: 25, currentClub: 'Lyon B' },
  'pl-tanaka': { name: 'Riku Tanaka', position: 'CAM', age: 21, currentClub: 'Osaka United' },
  'pl-alvarez': { name: 'Santiago Álvarez', position: 'LB', age: 23, currentClub: null },
  'pl-nowak': { name: 'Filip Nowak', position: 'CDM', age: 25, currentClub: 'Kraków FC' },
  'pl-mensah': { name: 'Kwame Mensah', position: 'LW', age: 21, currentClub: null },
  'pl-kim': { name: 'Kim Min-jae', position: 'CF', age: 20, currentClub: 'Busan City' },
  'pl-reid': { name: 'Marcus Reid', position: 'CM', age: 24, currentClub: 'Hackney Marsh Rovers' },
};

// Evidence confidence per player. Elias and Mateus simply have LESS on record —
// which the UI presents as limited evidence, never as a lesser player.
const TRUST: Record<string, { score: number; band: string; bandLabel: string }> = {
  'pl-adeyemi': { score: 79, band: 'strong_evidence', bandLabel: 'Strong evidence' },
  'pl-svensson': { score: 46, band: 'developing_evidence', bandLabel: 'Developing evidence' },
  'pl-carvalho': { score: 31, band: 'limited_evidence', bandLabel: 'Limited evidence' },
  'pl-okafor': { score: 64, band: 'developing_evidence', bandLabel: 'Developing evidence' },
  'pl-martin': { score: 61, band: 'developing_evidence', bandLabel: 'Developing evidence' },
};
const FALLBACK_TRUST = { score: 38, band: 'limited_evidence', bandLabel: 'Limited evidence' };

const COMPONENT_ORDER = ['identity', 'footballHistory', 'relationships', 'evidence', 'combine', 'references'];
const COMPONENT_WEIGHTS: Record<string, number> = {
  identity: 15, footballHistory: 20, relationships: 20, evidence: 20, combine: 15, references: 10,
};
const LEVEL_FOR = (score: number): [string, string] =>
  score >= 70 ? ['strong', 'Strong'] : score >= 45 ? ['established', 'Established'] : ['limited', 'Limited'];

function trustFor(playerId: string): RoomTrust {
  const t = TRUST[playerId] ?? FALLBACK_TRUST;
  const [level, levelLabel] = LEVEL_FOR(t.score);
  return {
    score: t.score, band: t.band, bandLabel: t.bandLabel,
    note: TRUST_NOTE, disclaimer: TRUST_DISCLAIMER,
    policyVersion: 1, simulatedEvidenceIncluded: true,
    explanations: COMPONENT_ORDER.map((component) => ({ component, level, levelLabel, weight: COMPONENT_WEIGHTS[component] })),
    signals: [
      { code: 'IDENTITY_CONFIRMED', text: 'Identity confirmed by ScoutBox review.' },
      { code: 'CLUB_RELATIONSHIP_CONFIRMED', text: '1 verified club relationship.' },
    ],
  };
}

function passportFor(playerId: string): RecruitmentPassport {
  const p = PLAYERS[playerId] ?? { name: 'Demo player', position: null as unknown as string, age: 0, currentClub: null };
  return {
    viewer: 'pro_club',
    player: { id: playerId, name: p.name, age: p.age, position: p.position ?? null, location: null, level: null },
    identity: { confirmed: true, assurance: 'scoutbox_document_review', label: 'Identity confirmed by ScoutBox review' },
    status: {
      currentClub: p.currentClub ? { orgName: p.currentClub, role: null, since: '2026-05', provenance: 'verified_club_confirmed' } : null,
      availability: 'open_to_trials',
      representation: null,
    },
    note: 'A Football Passport describes evidence and provenance. It is not a rating of football ability and not a ScoutBox endorsement.',
    timeline: [
      { id: `pev:${playerId}:1`, type: 'reference_received', when: { display: '2026-03-14', precision: 'day' }, title: { coach: 'Tom Field' }, org: { id: 'org-eastport', name: 'Eastport United FC' }, provenance: 'verified_coach_confirmed', provenanceCopy: COACH_COPY },
      { id: `pev:${playerId}:2`, type: 'evidence_added', when: { display: '2026-01-11', precision: 'day' }, title: { label: 'Full match vs Harbour U23' }, org: null, provenance: 'player_submitted', provenanceCopy: PLAYER_COPY },
      { id: `pev:${playerId}:3`, type: 'club_joined', when: { display: '2018', precision: 'year' }, title: { org: 'Sunday Kings FC' }, org: { id: null, name: 'Sunday Kings FC' }, provenance: 'player_submitted', provenanceCopy: PLAYER_COPY },
    ],
    clubHistory: p.currentClub
      ? [{ orgName: p.currentClub, role: null, from: '2026-05-02', to: null, current: true, provenance: 'verified_club_confirmed', provenanceCopy: CLUB_COPY }]
      : [{ orgName: 'Sunday Kings FC', role: p.position ?? null, from: '2018', to: null, current: false, provenance: 'player_submitted', provenanceCopy: PLAYER_COPY }],
    evidence: { fullMatches: 1, clips: 2, assessments: 1, references: 1, lastEvidenceDays: 12, note: 'Counts describe evidence coverage, not football ability.' },
    references: [{
      id: `dref-${playerId}`, coachName: 'Tom Field', roleAtTime: 'Academy Scout', orgName: 'Eastport United FC',
      relationship: 'Scouted and coached at development camp', fromYear: 2024, toYear: 2026, at: '2026-03-14',
      provenance: 'verified_coach_confirmed', provenanceCopy: COACH_COPY,
      structured: { strengths: 'Pressing triggers', development: 'Weak-foot delivery', summary: 'Reliable, coachable.' },
    }],
    achievements: [{ id: `dach-${playerId}`, title: 'County Cup Winner 2024', orgName: 'Eastport United FC', when: '2024', provenance: 'verified_club_confirmed', confirmedBy: 'Eastport United FC', provenanceCopy: CLUB_COPY }],
    assessments: [{ id: `dass-${playerId}`, org: 'Eastport United FC', at: '2026-02-20', state: 'submitted' }],
    trials: [],
    availability: 'open_to_trials',
    representation: null,
  };
}

// ------------------------------------------------------- the mutable store
interface DemoRoom {
  roomId: string;
  playerId: string;
  /** False mirrors the live "no longer visible to this org" branch. */
  available: boolean;
  status: string;
  priority: string;
  tags: string[];
  restricted: boolean;
  sourceContext: string;
  owner: { userId: string; name: string };
  leadScoutUserId: string | null;
  leadScoutName: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  closedAt: number | null;
  tasks: RoomTask[];
  evidence: RoomEvidenceItem[];
  assessments: RoomAssessment[];
  assessmentsWithheld: number;
  combine: RoomCombine;
  development: RoomDevelopment;
  missingEvidence: RoomMissingEvidence[];
  trials: RoomTrial[];
  links: { requestIds: string[]; trialIds: string[]; signingId: string | null };
}

let seq = 1000;
const nid = (prefix: string) => `${prefix}-${++seq}`;

const STAFF: Record<string, string> = { 'u-demo': 'A. Coach', 'usr-maria': 'Maria Keane', 'usr-alex': 'Alex Ford', 'usr-jo': 'Jo Beckett' };
const staffName = (id: string | null | undefined) => (id ? STAFF[id] ?? 'Former colleague' : null);

const evidence = (id: string, claimType: string, label: string, ageDays: number, provenance: string, provenanceCopy: string, verification?: string): RoomEvidenceItem => ({
  id, claimType, label, recordedAt: NOW - ageDays * DAY,
  provenance, provenanceCopy,
  verification: verification ? { status: verification } : null,
  review: { state: 'not_reviewed', note: null, by: null, at: null },
});

const emptyCombine = (): RoomCombine => ({ shared: false, results: [], requests: [], note: COMBINE_NOT_SHARED });
const noDevelopment = (): RoomDevelopment => ({ shared: false, note: 'This player has not shared development activity for recruitment.' });

const roomStore: DemoRoom[] = [
  {
    roomId: 'room-d1', playerId: 'pl-adeyemi', available: true,
    status: 'shortlisted', priority: 'high', tags: ['left-side rotation', '2027 window'],
    restricted: false, sourceContext: 'search',
    owner: { userId: 'usr-maria', name: 'Maria Keane' },
    leadScoutUserId: 'usr-alex', leadScoutName: 'Alex Ford',
    createdAt: NOW - 26 * DAY, updatedAt: NOW - 2 * DAY, archivedAt: null, closedAt: null,
    tasks: [
      { id: 'tsk-d1', title: 'Second live viewing away from home', description: 'Prefer a match against a deep block.', assigneeUserId: 'usr-alex', assigneeName: 'Alex Ford', status: 'open', dueAt: null, linkedResourceType: null, linkedResourceId: null, createdBy: { userId: 'usr-maria', name: 'Maria Keane' }, createdAt: NOW - 9 * DAY, completedAt: null },
      { id: 'tsk-d2', title: 'Pull pressing segments for the compare', description: null, assigneeUserId: 'usr-jo', assigneeName: 'Jo Beckett', status: 'done', dueAt: null, linkedResourceType: 'evidence', linkedResourceId: 'ev-d1', createdBy: { userId: 'usr-maria', name: 'Maria Keane' }, createdAt: NOW - 18 * DAY, completedAt: NOW - 12 * DAY },
    ],
    evidence: [
      evidence('ev-d1', 'footage', 'Full match vs Harbour U23', 40, 'player_submitted', PLAYER_COPY),
      evidence('ev-d2', 'footage', 'Clip reel — pressing triggers', 12, 'player_submitted', PLAYER_COPY),
      evidence('ev-d3', 'reference', 'Coach reference — Tom Field', 180, 'verified_coach_confirmed', COACH_COPY, 'coach_confirmed'),
    ],
    assessments: [
      { id: 'ass-d1', scoutUserId: 'usr-alex', scoutName: 'Alex Ford', templateId: 'tpl-striker', templateVersion: 3, state: 'submitted', recommendation: 'monitor', context: 'Live — away', createdAt: NOW - 20 * DAY, submittedAt: NOW - 17 * DAY },
      { id: 'ass-d2', scoutUserId: 'u-demo', scoutName: 'A. Coach', templateId: 'tpl-striker', templateVersion: 3, state: 'draft', recommendation: null, context: 'Video', createdAt: NOW - 3 * DAY, submittedAt: null },
    ],
    assessmentsWithheld: 1,
    combine: {
      shared: true, hasCombineVerifiedResults: true, note: COMBINE_NOTE,
      results: [
        { protocolId: 'combine-box-touch-60', protocolVersion: 1, protocolTitle: 'Box Touch 60', metricUnit: 'touches', measuredValue: 184, display: '184', combineVerified: true, capturedBy: 'box_cam', completedAt: NOW - 3 * DAY },
        { protocolId: 'combine-box-control-60', protocolVersion: 1, protocolTitle: 'Box Control 60', metricUnit: 'seconds', measuredValue: 57.4, display: '57.4', combineVerified: true, capturedBy: 'box_cam', completedAt: NOW - 9 * DAY },
      ],
      requests: [
        { id: 'creq-d1', title: 'Autumn At-Home Combine', state: 'requested', protocols: [{ protocolId: 'combine-box-touch-60', protocolTitle: 'Box Touch 60', completed: true }, { protocolId: 'combine-box-control-60', protocolTitle: 'Box Control 60', completed: false }], deadline: null, instructions: null, completedCount: 1, requiredCount: 2, createdAt: NOW - 14 * DAY, note: null },
      ],
    },
    development: { shared: true, days: 30, boxSessions: 6, verifiedActiveMs: 4_260_000, assigned: 3, assignedCompleted: 2, focus: [{ category: 'ball_mastery', activeMs: 2_400_000 }, { category: 'close_control', activeMs: 1_260_000 }], note: DEV_NOTE },
    missingEvidence: [
      { id: 'sug-d1', ruleId: 'recent_full_match', ruleVersion: 1, explanation: 'No full match from the last 90 days is on record.', action: 'request_full_match', status: 'open', requestedAt: null },
    ],
    trials: [],
    links: { requestIds: [], trialIds: [], signingId: null },
  },
  {
    roomId: 'room-d2', playerId: 'pl-svensson', available: true,
    status: 'under_review', priority: 'normal', tags: ['winger pool'],
    restricted: false, sourceContext: 'shortlist',
    owner: { userId: 'u-demo', name: 'A. Coach' },
    leadScoutUserId: 'u-demo', leadScoutName: 'A. Coach',
    createdAt: NOW - 11 * DAY, updatedAt: NOW - 5 * DAY, archivedAt: null, closedAt: null,
    tasks: [
      { id: 'tsk-d3', title: 'Ask the club for a 2025/26 minutes breakdown', description: null, assigneeUserId: 'u-demo', assigneeName: 'A. Coach', status: 'open', dueAt: null, linkedResourceType: null, linkedResourceId: null, createdBy: { userId: 'u-demo', name: 'A. Coach' }, createdAt: NOW - 5 * DAY, completedAt: null },
    ],
    evidence: [evidence('ev-d4', 'footage', 'Clip reel — 1v1 outside', 60, 'player_submitted', PLAYER_COPY)],
    assessments: [],
    assessmentsWithheld: 0,
    combine: emptyCombine(),
    development: noDevelopment(),
    missingEvidence: [
      { id: 'sug-d2', ruleId: 'coach_reference', ruleVersion: 1, explanation: 'No verified coach reference is on record.', action: 'request_reference', status: 'open', requestedAt: null },
      { id: 'sug-d3', ruleId: 'recent_full_match', ruleVersion: 1, explanation: 'No full match from the last 90 days is on record.', action: 'request_full_match', status: 'requested', requestedAt: NOW - 4 * DAY },
    ],
    trials: [],
    links: { requestIds: [], trialIds: [], signingId: null },
  },
  {
    roomId: 'room-d3', playerId: 'pl-carvalho', available: true,
    status: 'trial_scheduled', priority: 'normal', tags: [],
    restricted: false, sourceContext: 'opportunity',
    owner: { userId: 'usr-maria', name: 'Maria Keane' },
    leadScoutUserId: 'usr-jo', leadScoutName: 'Jo Beckett',
    createdAt: NOW - 34 * DAY, updatedAt: NOW - 1 * DAY, archivedAt: null, closedAt: null,
    tasks: [],
    evidence: [evidence('ev-d5', 'footage', 'Half match vs Vale Rangers', 22, 'player_submitted', PLAYER_COPY)],
    assessments: [{ id: 'ass-d3', scoutUserId: 'usr-jo', scoutName: 'Jo Beckett', templateId: 'tpl-midfield', templateVersion: 2, state: 'submitted', recommendation: 'trial', context: 'Live', createdAt: NOW - 25 * DAY, submittedAt: NOW - 24 * DAY }],
    assessmentsWithheld: 0,
    combine: emptyCombine(),
    development: noDevelopment(),
    missingEvidence: [],
    trials: [{ id: 'trl-d1', status: 'scheduled', proposedDate: new Date(NOW + 6 * DAY).toISOString().slice(0, 10), venue: 'Eastport Training Centre', reportDueAt: null, hasReport: false, linked: true }],
    links: { requestIds: [], trialIds: ['trl-d1'], signingId: null },
  },
  {
    roomId: 'room-d4', playerId: 'pl-okafor', available: true,
    status: 'offer_consideration', priority: 'urgent', tags: ['centre-back need'],
    restricted: true, sourceContext: 'recommendation',
    owner: { userId: 'usr-maria', name: 'Maria Keane' },
    leadScoutUserId: 'usr-maria', leadScoutName: 'Maria Keane',
    createdAt: NOW - 52 * DAY, updatedAt: NOW - 6 * 3600_000, archivedAt: null, closedAt: null,
    tasks: [],
    evidence: [
      evidence('ev-d6', 'footage', 'Full match vs Riverside FC', 21, 'player_submitted', PLAYER_COPY),
      evidence('ev-d7', 'reference', 'Coach reference — A. Bello', 90, 'verified_coach_confirmed', COACH_COPY, 'coach_confirmed'),
    ],
    assessments: [{ id: 'ass-d4', scoutUserId: 'usr-maria', scoutName: 'Maria Keane', templateId: 'tpl-defender', templateVersion: 1, state: 'submitted', recommendation: 'sign', context: 'Live — home', createdAt: NOW - 30 * DAY, submittedAt: NOW - 28 * DAY }],
    assessmentsWithheld: 0,
    combine: emptyCombine(),
    development: noDevelopment(),
    missingEvidence: [],
    trials: [{ id: 'trl-d2', status: 'reported', proposedDate: new Date(NOW - 14 * DAY).toISOString().slice(0, 10), venue: 'Eastport Training Centre', reportDueAt: null, hasReport: true, linked: true }],
    links: { requestIds: [], trialIds: ['trl-d2'], signingId: null },
  },
  {
    roomId: 'room-d5', playerId: 'pl-martin', available: true,
    status: 'archived', priority: 'low', tags: ['goalkeeper pool'],
    restricted: false, sourceContext: 'campaign',
    owner: { userId: 'usr-maria', name: 'Maria Keane' },
    leadScoutUserId: 'usr-alex', leadScoutName: 'Alex Ford',
    createdAt: NOW - 120 * DAY, updatedAt: NOW - 40 * DAY, archivedAt: NOW - 40 * DAY, closedAt: null,
    tasks: [],
    evidence: [evidence('ev-d8', 'footage', 'Clip reel — distribution', 150, 'player_submitted', PLAYER_COPY)],
    assessments: [],
    assessmentsWithheld: 0,
    combine: emptyCombine(),
    development: noDevelopment(),
    missingEvidence: [{ id: 'sug-d4', ruleId: 'recent_full_match', ruleVersion: 1, explanation: 'No full match from the last 90 days is on record.', action: 'request_full_match', status: 'open', requestedAt: null }],
    trials: [],
    links: { requestIds: [], trialIds: [], signingId: null },
  },
  {
    // The standing rules stopped applying to this player mid-pursuit. The
    // internal record survives; every player projection is gone.
    roomId: 'room-d6', playerId: 'pl-withheld', available: false,
    status: 'watching', priority: 'normal', tags: [],
    restricted: false, sourceContext: 'direct',
    owner: { userId: 'u-demo', name: 'A. Coach' },
    leadScoutUserId: 'u-demo', leadScoutName: 'A. Coach',
    createdAt: NOW - 8 * DAY, updatedAt: NOW - 7 * DAY, archivedAt: null, closedAt: null,
    tasks: [],
    evidence: [], assessments: [], assessmentsWithheld: 0,
    combine: emptyCombine(), development: noDevelopment(),
    missingEvidence: [], trials: [],
    links: { requestIds: [], trialIds: [], signingId: null },
  },
];

const commentStore: (RoomComment & { roomId: string })[] = [
  {
    id: 'rcmt-d1', roomId: 'room-d1', author: { userId: 'usr-maria', name: 'Maria Keane' },
    body: 'Second viewing confirmed the pressing profile. Holding at shortlisted until the full match lands.',
    deleted: false, deletedAt: null, edited: false, editedAt: null, editCount: 0,
    replyToId: null, mentions: [{ userId: 'usr-alex', name: 'Alex Ford' }], createdAt: NOW - 6 * DAY,
  },
  {
    id: 'rcmt-d2', roomId: 'room-d1', author: { userId: 'usr-alex', name: 'Alex Ford' },
    body: 'Agreed. I will take the away fixture on the 24th and file straight after.',
    deleted: false, deletedAt: null, edited: true, editedAt: NOW - 5 * DAY, editCount: 1,
    replyToId: 'rcmt-d1', mentions: [], createdAt: NOW - 5 * DAY - 3600_000,
  },
  {
    id: 'rcmt-d3', roomId: 'room-d1', author: { userId: 'usr-jo', name: 'Jo Beckett' },
    body: null, deleted: true, deletedAt: NOW - 4 * DAY, edited: false, editedAt: null, editCount: 0,
    replyToId: null, mentions: [], createdAt: NOW - 4 * DAY - 7200_000,
  },
];

const snapshot = (at: number, score: number, band: string, trigger: string): RoomSnapshot => ({
  id: nid('rsnap'), at, trigger,
  trust: { score, band, policyVersion: 1, componentLevels: Object.fromEntries(COMPONENT_ORDER.map((c) => [c, LEVEL_FOR(score)[0]])), hash: 'demo' },
  sourceRefs: { passportVersion: 1, evidenceIds: ['ev-d8'], assessmentIds: [], combineResults: [], trialIds: [] },
  note: SNAPSHOT_NOTE,
});

const decisionStore: (RoomDecision & { roomId: string })[] = [
  {
    id: 'rdec-d1', roomId: 'room-d5', recommendation: 'continue_watching',
    reasonCodes: ['continue_monitoring'], note: 'Keeping an eye on minutes after the winter break.',
    by: { userId: 'usr-alex', name: 'Alex Ford', role: 'Scout' },
    createdAt: NOW - 70 * DAY, supersededById: 'rdec-d2',
    snapshot: snapshot(NOW - 70 * DAY, 52, 'developing_evidence', 'decision'),
  },
  {
    id: 'rdec-d2', roomId: 'room-d5', recommendation: 'archive',
    reasonCodes: ['insufficient_recent_evidence', 'not_current_priority'],
    note: 'Archived for this window. Worth a second look if a recent full match arrives.',
    by: { userId: 'usr-maria', name: 'Maria Keane', role: 'Head of Recruitment' },
    createdAt: NOW - 40 * DAY, supersededById: null,
    snapshot: snapshot(NOW - 40 * DAY, 58, 'developing_evidence', 'status:archived'),
  },
];

const activityStore: (RoomActivityItem & { roomId: string })[] = [
  { id: 'evt-d1', roomId: 'room-d1', at: NOW - 26 * DAY, type: 'room_created', actor: { kind: 'org', id: 'usr-maria', name: 'Maria Keane' }, detail: { status: 'watching', sourceContext: 'search' } },
  { id: 'evt-d2', roomId: 'room-d1', at: NOW - 20 * DAY, type: 'room_status_changed', actor: { kind: 'org', id: 'usr-maria', name: 'Maria Keane' }, detail: { from: 'watching', to: 'under_review' } },
  { id: 'evt-d3', roomId: 'room-d1', at: NOW - 17 * DAY, type: 'room_status_changed', actor: { kind: 'org', id: 'usr-alex', name: 'Alex Ford' }, detail: { from: 'under_review', to: 'shortlisted' } },
  { id: 'evt-d4', roomId: 'room-d1', at: NOW - 9 * DAY, type: 'room_task_created', actor: { kind: 'org', id: 'usr-maria', name: 'Maria Keane' }, detail: { taskId: 'tsk-d1' } },
  { id: 'evt-d5', roomId: 'room-d1', at: NOW - 6 * DAY, type: 'room_comment_added', actor: { kind: 'org', id: 'usr-maria', name: 'Maria Keane' }, detail: { commentId: 'rcmt-d1' } },
  { id: 'evt-d6', roomId: 'room-d2', at: NOW - 11 * DAY, type: 'room_created', actor: { kind: 'org', id: 'u-demo', name: 'A. Coach' }, detail: { status: 'watching', sourceContext: 'shortlist' } },
  { id: 'evt-d7', roomId: 'room-d3', at: NOW - 1 * DAY, type: 'room_status_changed', actor: { kind: 'org', id: 'usr-jo', name: 'Jo Beckett' }, detail: { from: 'trial_requested', to: 'trial_scheduled' } },
  { id: 'evt-d8', roomId: 'room-d4', at: NOW - 6 * 3600_000, type: 'room_status_changed', actor: { kind: 'org', id: 'usr-maria', name: 'Maria Keane' }, detail: { from: 'trial_completed', to: 'offer_consideration' } },
  { id: 'evt-d9', roomId: 'room-d5', at: NOW - 40 * DAY, type: 'room_decision_recorded', actor: { kind: 'org', id: 'usr-maria', name: 'Maria Keane' }, detail: { recommendation: 'archive' } },
  { id: 'evt-d10', roomId: 'room-d6', at: NOW - 8 * DAY, type: 'room_created', actor: { kind: 'org', id: 'u-demo', name: 'A. Coach' }, detail: { status: 'watching', sourceContext: 'direct' } },
];

// -------------------------------------------------------------- derivation
const find = (roomId: string) => roomStore.find((r) => r.roomId === roomId) ?? null;

// ------------------------------------------------------ M23 P3 — Contact
// Same rules as the server: a draft is internal and moves nothing; a send is
// delivered into the recipient's Inbox and moves the case contact_planned →
// contacted through the same status log; a failed attempt keeps the draft; a
// recorded external contact is attested, never observed. Every demo player is
// an adult, so routing resolves to the player; the copy for a guardian route
// is exercised by the live client against the real server.
const CONTACT_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', delivered: 'Delivered', failed: 'Send failed', responded: 'Response received', recorded: 'Recorded (external)', cancelled: 'Cancelled',
};
const CONTACT_CHANNEL_LABELS: Record<string, string> = {
  in_app: 'ScoutBox message', phone: 'Telephone', in_person: 'In person', email_external: 'Email (outside ScoutBox)', agent: 'Via agent or guardian conversation', other: 'Other',
};
const CONTACT_COOLDOWN_MS = 72 * 3600_000;
const CONTACT_TRANSPORT_NOTE = 'Delivered means the message is in the recipient\'s ScoutBox Inbox. ScoutBox does not track whether it was read.';
const CONTACT_RECORDED_NOTE = 'Recorded by a named member of staff. ScoutBox did not observe this contact.';
const CONTACT_NOTE = 'A draft is internal to your organisation. Only a sent message or a recorded external contact is a contact.';
const plainShared = (s: string | null | undefined, max: number) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, max);

type DemoContact = ContactRecord & { roomId: string };
const contactStore: DemoContact[] = [
  {
    id: 'rct-d1', roomId: 'room-d1', caseId: 'room-d1', playerId: 'pl-adeyemi',
    status: 'responded', statusLabel: 'Response received', channel: 'in_app', channelLabel: 'ScoutBox message', external: false,
    recipient: { type: 'player', minor: false }, subject: 'Interest from Eastport', body: 'Hi Kola, we would like to talk about your plans for next season. Would a call suit you?', summary: null,
    createdBy: { name: 'Maria Keane' }, createdAt: NOW - 12 * DAY, updatedAt: NOW - 10 * DAY,
    sentBy: { name: 'Maria Keane' }, sentAt: NOW - 11 * DAY, deliveredAt: NOW - 11 * DAY, failedAt: null, failureCode: null, attempts: 1,
    occurredAt: null, recordedBy: null, recordedAt: null,
    respondedAt: NOW - 10 * DAY, response: { kind: 'accepted', message: 'Yes, happy to talk next week.', by: 'player', at: NOW - 10 * DAY },
    emailCopy: null, lifecycle: { applied: true, from: 'contact_planned', to: 'contacted', at: NOW - 11 * DAY }, cancelledAt: null,
    rev: 3, revAt: NOW - 10 * DAY, revBy: null,
    history: [
      { id: 'aud-c1', at: NOW - 12 * DAY, action: 'contact_created', by: { name: 'Maria Keane', kind: 'org' }, detail: null },
      { id: 'aud-c2', at: NOW - 11 * DAY, action: 'contact_sent', by: { name: 'Maria Keane', kind: 'org' }, detail: { recipientType: 'player' } },
      { id: 'aud-c3', at: NOW - 10 * DAY, action: 'contact_responded', by: { name: 'Player', kind: 'player' }, detail: { kind: 'accepted' } },
    ],
    transportNote: CONTACT_TRANSPORT_NOTE, policyVersion: 1,
  },
];
const CONTACT_CASE_STATUSES = ['contact_planned', 'contacted'];
const contactRouting = (r: DemoRoom): ContactRouting => (r.available ? { available: true, type: 'player', minor: false } : { available: false, type: null, minor: null, reason: 'CONTACT_RECIPIENT_UNAVAILABLE' });
const contactsOf = (roomId: string) => contactStore.filter((c) => c.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
const contactCooldown = (r: DemoRoom, exceptId: string | null) => {
  const recent = contactsOf(r.roomId).filter((c) => c.id !== exceptId && c.channel === 'in_app' && c.status === 'delivered' && c.deliveredAt != null && Date.now() - c.deliveredAt < CONTACT_COOLDOWN_MS);
  return recent.length ? { until: Math.max(...recent.map((c) => c.deliveredAt as number)) + CONTACT_COOLDOWN_MS } : null;
};
const contactRev = (c: DemoContact, expectedRev: unknown) => {
  if (expectedRev === undefined || expectedRev === null) throw new Error('expectedRev is required: send the rev you were editing.');
  if (!Number.isInteger(expectedRev) || (expectedRev as number) < 0) throw new Error('expectedRev must be a whole number.');
  if (expectedRev !== c.rev) throw new Error('Someone else changed this while you were working on it. Reload to see their change, then apply yours.');
};
const contactGate = (r: DemoRoom) => { if (!CONTACT_CASE_STATUSES.includes(r.status)) throw new Error(`A case at "${STATUS_LABELS[r.status] ?? r.status}" cannot contact the player. Plan the contact first (planContact).`); };
const contactEvent = (c: DemoContact, action: string, by: { name: string; kind: string } | null, detail: Record<string, unknown> | null, at: number) => { c.history.push({ id: nid('aud'), at, action, by, detail }); };
const strip = (c: DemoContact): ContactRecord => { const { roomId: _r, ...rest } = c; return { ...rest, history: rest.history.map((h) => ({ ...h })) }; };
/** The lifecycle coupling: the same status log the Room's own moves write. */
function contactAdvance(r: DemoRoom, c: DemoContact, at: number): ContactCaseMove {
  if (r.status === 'contact_planned') {
    r.status = 'contacted'; r.updatedAt = at;
    log(r, 'room_status_changed', { from: 'contact_planned', to: 'contacted', reasonCodes: [], trigger: `contact:${c.id}` });
    c.lifecycle = { applied: true, from: 'contact_planned', to: 'contacted', at };
    return { from: 'contact_planned', to: 'contacted' };
  }
  c.lifecycle = { applied: false, reason: 'LIFECYCLE_NO_CHANGE', at };
  return { unchanged: true, status: r.status };
}

const roomComments = (roomId: string) => commentStore.filter((c) => c.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt);
const roomDecisions = (roomId: string) => decisionStore.filter((d) => d.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
const currentDecision = (roomId: string) => { const all = roomDecisions(roomId); return all.length ? all[all.length - 1] : null; };
const roomActivity = (roomId: string) => activityStore.filter((a) => a.roomId === roomId).sort((a, b) => b.at - a.at);
const openTasks = (r: DemoRoom) => r.tasks.filter((t) => t.status === 'open' || t.status === 'in_progress').length;

function log(r: DemoRoom, type: string, detail: Record<string, unknown>) {
  activityStore.unshift({ id: nid('evt'), roomId: r.roomId, at: Date.now(), type, actor: { kind: 'org', id: ME.userId, name: ME.name }, detail });
  r.updatedAt = Date.now();
}

/** Counts and plain facts a human could check. Never a score, never a verdict. */
function readinessFor(r: DemoRoom): RoomReadiness {
  const assigned = r.assessments.length;
  const submitted = r.assessments.filter((a) => a.state !== 'draft').length;
  const recentFullMatch = r.evidence.some((e) => e.claimType === 'footage' && !!e.recordedAt && e.recordedAt > Date.now() - 180 * DAY);
  const coachReference = r.evidence.some((e) => e.verification?.status === 'coach_confirmed');
  const combineVerified = r.combine.results.length;
  const combineRequested = r.combine.requests.filter((x) => x.state === 'requested').length;
  const trialState = r.trials.some((t) => t.status === 'reported') ? 'reported'
    : r.trials.some((t) => t.status === 'awaiting_report') ? 'awaiting_report'
      : r.trials.some((t) => t.status === 'scheduled') ? 'scheduled'
        : r.trials.some((t) => t.status === 'requested') ? 'requested' : 'none';
  const open = openTasks(r);
  const items = [
    { key: 'assessments', label: 'Assessments', value: `${submitted}/${assigned} submitted`, complete: assigned > 0 && submitted >= assigned, outstanding: assigned === 0 ? 'None assigned yet' : submitted < assigned ? 'Awaiting submissions' : null },
    { key: 'recent_full_match', label: 'Recent full match', value: recentFullMatch ? 'Available' : 'Not available', complete: recentFullMatch, outstanding: recentFullMatch ? null : 'No recent full-match evidence on record' },
    { key: 'coach_reference', label: 'Coach reference', value: coachReference ? 'Available' : 'Not available', complete: coachReference, outstanding: coachReference ? null : 'No verified coach reference on record' },
    { key: 'combine', label: 'Combine', value: combineVerified > 0 ? `${combineVerified} verified` : combineRequested > 0 ? 'Requested' : 'No verified result', complete: combineVerified > 0, outstanding: combineVerified > 0 ? null : combineRequested > 0 ? 'Requested, not yet completed' : 'No production-supported Combine Verified result is currently available' },
    { key: 'trial', label: 'Trial', value: ({ none: 'Not required yet', requested: 'Requested', scheduled: 'Scheduled', awaiting_report: 'Awaiting report', reported: 'Reported' } as Record<string, string>)[trialState] ?? 'Not required yet', complete: trialState === 'reported', outstanding: ['requested', 'scheduled', 'awaiting_report'].includes(trialState) ? 'Trial in progress' : null },
    { key: 'open_tasks', label: 'Open tasks', value: String(open), complete: open === 0, outstanding: open > 0 ? `${open} open` : null },
  ];
  return {
    items,
    complete: items.filter((i) => i.complete).length,
    total: items.length,
    blockers: items.filter((i) => i.outstanding).map((i) => ({ key: i.key, text: i.outstanding as string })),
    openEvidenceRequests: r.missingEvidence.filter((m) => m.status === 'requested').length,
    note: READINESS_NOTE,
  };
}

/** A word, never a number — a second numeric score is how a Trust Score
 *  becomes a player rating by accident. */
function healthFor(readiness: RoomReadiness | null, hasDecision: boolean, status: string): string {
  if (hasDecision && ['signed', 'archived', 'closed', 'withdrawn'].includes(status)) return 'decision_recorded';
  const blocked = new Set((readiness?.blockers ?? []).map((b) => b.key));
  if (blocked.has('trial')) return 'trial_pending';
  if (blocked.has('assessments')) return 'assessment_outstanding';
  if (blocked.has('recent_full_match') || blocked.has('coach_reference') || blocked.has('combine')) return 'waiting_on_evidence';
  return 'ready_for_review';
}

function project(r: DemoRoom): Room {
  const decisions = roomDecisions(r.roomId).map(({ roomId: _rid, ...d }) => d);
  const current = decisions.length ? decisions[decisions.length - 1] : null;
  const comments = roomComments(r.roomId).map((c) => ({ ...c }));
  const activityRows = roomActivity(r.roomId).map(({ roomId: _rid, ...a }) => a);
  const base = {
    roomId: r.roomId, orgId: ORG_ID, playerId: r.playerId,
    status: r.status, statusLabel: STATUS_LABELS[r.status] ?? r.status,
    allowedTransitions: TRANSITIONS[r.status] ?? [],
    stage: STAGE_OF[r.status] ?? null,
    priority: r.priority, priorityNote: PRIORITY_NOTE,
    tags: r.tags, restricted: r.restricted, sourceContext: r.sourceContext,
    owner: { userId: r.owner.userId, name: r.owner.name },
    leadScout: r.leadScoutUserId ? { userId: r.leadScoutUserId, name: r.leadScoutName ?? staffName(r.leadScoutUserId) ?? 'Former colleague' } : null,
    viewerRole: 'recruitment_admin',
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    archivedAt: r.archivedAt, closedAt: r.closedAt,
    links: r.links, privacyNote: PRIVACY_NOTE,
    tasks: r.tasks.map((t) => ({ ...t })),
    comments,
    decision: { current, history: decisions },
    activity: { items: activityRows.slice(0, 50), nextCursor: null, total: activityRows.length } as RoomActivityResult,
  };

  // Not visible right now: the internal record stays, every player projection
  // goes — no cached name, no stale Passport, no last-known Trust Score.
  if (!r.available) {
    return {
      ...base,
      playerAvailable: false, playerName: null, player: null, unavailableNote: UNAVAILABLE_NOTE,
      trust: null, passport: null, evidence: [], assessments: [], combine: null,
      development: null, missingEvidence: [], trials: [],
      readiness: null, health: null, healthLabel: null,
    };
  }

  const readiness = readinessFor(r);
  const health = healthFor(readiness, !!current, r.status);
  const p = PLAYERS[r.playerId];
  return {
    ...base,
    playerAvailable: true,
    playerName: p?.name ?? 'Demo player',
    player: { id: r.playerId, name: p?.name ?? 'Demo player', position: p?.position ?? null, age: p?.age ?? null, currentClub: p?.currentClub ?? null },
    trust: trustFor(r.playerId),
    passport: passportFor(r.playerId),
    evidence: r.evidence.map((e) => ({ ...e })),
    assessments: r.assessments.map((a) => ({ ...a })),
    assessmentsWithheldPendingOwnSubmission: r.assessmentsWithheld,
    combine: { ...r.combine, results: [...r.combine.results], requests: [...r.combine.requests] },
    development: { ...r.development },
    missingEvidence: r.missingEvidence.map((m) => ({ ...m })),
    trials: r.trials.map((t) => ({ ...t })),
    readiness,
    health,
    healthLabel: HEALTH_LABELS[health],
  };
}

function summarise(r: DemoRoom): RoomListItem {
  const p = r.available ? PLAYERS[r.playerId] : undefined;
  const readiness = r.available ? readinessFor(r) : null;
  const health = healthFor(readiness, !!currentDecision(r.roomId), r.status);
  const t = r.available ? trustFor(r.playerId) : null;
  return {
    roomId: r.roomId, playerId: r.playerId,
    playerName: r.available ? p?.name ?? 'Demo player' : null,
    playerAvailable: r.available,
    position: r.available ? p?.position ?? null : null,
    age: r.available ? p?.age ?? null : null,
    currentClub: r.available ? p?.currentClub ?? null : null,
    status: r.status, statusLabel: STATUS_LABELS[r.status] ?? r.status,
    stage: STAGE_OF[r.status] ?? null,
    priority: r.priority, tags: r.tags,
    ownerUserId: r.owner.userId, ownerName: r.owner.name,
    leadScoutUserId: r.leadScoutUserId,
    trust: t ? { score: t.score, band: t.band, bandLabel: t.bandLabel, note: TRUST_NOTE } : null,
    openTasks: openTasks(r),
    health, healthLabel: HEALTH_LABELS[health],
    lastActivityAt: roomActivity(r.roomId)[0]?.at ?? r.createdAt,
    updatedAt: r.updatedAt, createdAt: r.createdAt,
  };
}

function funnelOf(list: DemoRoom[]): RoomFunnel {
  const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const r of list) byStatus[r.status] += 1;
  return {
    total: list.length,
    active: OPEN_STATUSES.reduce((t, s) => t + byStatus[s], 0),
    shortlisted: byStatus.shortlisted + byStatus.priority,
    trials: byStatus.trial_requested + byStatus.trial_scheduled + byStatus.trial_completed,
    offers: byStatus.offer_consideration + byStatus.offer_made,
    signed: byStatus.signed,
    archived: byStatus.archived + byStatus.closed + byStatus.withdrawn,
    byStatus,
    note: FUNNEL_NOTE,
  };
}

const delay = <T,>(v: T): Promise<T> => new Promise((res) => setTimeout(() => res(v), 60));

// ------------------------------------------------------------------- api

// ------------------------------------------------------ M23 P4B — Trial
// The demo mirrors the server's truth model: an invitation is a request, a
// trial exists only once the (simulated) recipient accepts, attendance is
// recorded per session after it starts, completion is an explicit act behind
// the same gate. The simulated recipient accepts the first slot a moment
// after the invitation — the real player app is not in the loop here.
type DemoEvidenceLink = { id: string; kind: string; sessionId: string; linkedAt: number; removedAt: number | null };
type DemoTrialSession = Omit<TrialSessionView, 'evidence'> & { evidence: DemoEvidenceLink[] };
interface DemoTrial {
  roomId: string; id: string; playerId: string; playerName: string; workflowState: TrialWorkflowState;
  acceptedAt: number; timezone: string; revision: number; confirmedAt: number | null; sessions: DemoTrialSession[];
  revisions: TrialRevisionView[]; attendance: TrialAttendanceRecord[];
  completion: TrialClubView['completion']; history: TrialHistoryEntry[]; rev: number; revAt: number;
  reportStatus: 'awaiting_report' | 'reported';
  keys: Record<string, { key: string; fp: string }[]>;
}
interface DemoInvitation { roomId: string; view: TrialInvitationView; clientKey: string | null; fp: string }
const TRIAL_CASE_STATUSES = ['under_review', 'contacted', 'shortlisted', 'priority', 'trial_requested'];
const TRIAL_NOTE = 'An invitation is not a trial. A trial exists once the player or guardian accepts; it is scheduled once a concrete schedule is confirmed; it is completed only after recorded attendance and the last session has ended.';
const TRIAL_LIMITS = { sessions: 20, slots: 3, instructions: 500, venueName: 120, venueTown: 80, venueAddress: 200, reason: 300, note: 300, message: 2000, clientKey: 64, evidencePerSession: 20, minSessionMs: 15 * 60_000, maxSessionMs: 12 * 3_600_000, revisions: 30 };
const TRIAL_LABELS: Record<TrialWorkflowState, string> = { legacy_accepted: 'Accepted (before scheduling existed)', accepted: 'Accepted', scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled' };
const localDayOf = (ms: number, tz: string) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); } catch { return new Date(ms).toISOString().slice(0, 10); } };
const apiErr = (status: number, code: string, message: string, details?: Record<string, unknown>) => Object.assign(new ApiError(status, code, message), { details: details ?? null });
const trialStore: DemoTrial[] = [];
const invitationStore: DemoInvitation[] = [];
const trialEvent = (tr: DemoTrial, action: string, by: { kind: string; name: string | null }, detail: Record<string, unknown> | null, at: number) => { tr.history.push({ id: nid('aud'), at, action, by, detail }); };
const bumpTrial = (tr: DemoTrial, at: number) => { tr.rev += 1; tr.revAt = at; };
{
  // Seed: the room already at trial_scheduled carries a confirmed one-session trial six days out.
  const at = NOW - 2 * DAY; const start = NOW + 6 * DAY + 10 * 3_600_000;
  const session: DemoTrialSession = { id: 'tses-d1', kind: 'training', startsAt: start, endsAt: start + 2 * 3_600_000, venue: { name: 'Eastport Training Centre', town: 'Eastport', address: 'Gate B, Dome Road' }, instructions: 'Ask for Priya at reception.', attendance: { state: 'not_recorded', source: null, recordedAt: null }, evidence: [] };
  trialStore.push({
    roomId: 'room-d3', id: 'trl-d1', playerId: 'pl-carvalho', playerName: 'Mateus Carvalho', workflowState: 'scheduled', acceptedAt: at, timezone: 'Europe/London',
    revision: 1, confirmedAt: at, sessions: [session],
    revisions: [{ revision: 1, proposedAt: at - 3_600_000, proposedBy: { kind: 'org', name: 'Maria Keane' }, confirmedAt: at, supersededAt: null, reason: 'invitation', material: null, sessionCount: 1 }],
    attendance: [], completion: null, reportStatus: 'awaiting_report', rev: 1, revAt: at, keys: {},
    history: [{ id: 'aud-t1', at, action: 'trial_accepted', by: { kind: 'player', name: 'Mateus Carvalho' }, detail: { recipientType: 'player' } }, { id: 'aud-t2', at, action: 'trial_schedule_confirmed', by: { kind: 'player', name: 'Mateus Carvalho' }, detail: { revision: 1, sessionCount: 1 } }],
  });
  invitationStore.push({ roomId: 'room-d3', clientKey: null, fp: '', view: { id: 'req-t1', status: 'accepted', createdAt: at - 3_600_000, respondedAt: at, respondedBy: 'player', routedTo: 'player', trialId: 'trl-d1', slots: [{ id: 'tslot-d1', day: localDayOf(start, 'Europe/London'), startsAt: start, endsAt: start + 2 * 3_600_000, timezone: 'Europe/London', kind: 'training', venue: { name: 'Eastport Training Centre', town: 'Eastport' } }], proposedDate: localDayOf(start, 'Europe/London'), altSlots: [] } });
}
const trialsOfRoom = (roomId: string) => trialStore.filter((x) => x.roomId === roomId);
const currentAtt = (tr: DemoTrial) => { const m = new Map<string, TrialAttendanceRecord>(); for (const a of tr.attendance) m.set(a.sessionId, a); return m; };
const deriveTrialState = (tr: DemoTrial): TrialWorkflowState => tr.completion ? tr.completion.state : (tr.confirmedAt && tr.sessions.length ? 'scheduled' : 'accepted');
const trialView = (tr: DemoTrial): TrialClubView => {
  const att = currentAtt(tr); const state = deriveTrialState(tr);
  return {
    id: tr.id, caseId: tr.roomId, requestId: null, playerId: tr.playerId, playerName: tr.playerName, orgId: 'org-demo',
    workflowState: state, workflowLabel: TRIAL_LABELS[state], legacy: false, reportStatus: tr.reportStatus, reportDueAt: null, hasReport: false,
    acceptedAt: tr.acceptedAt, acceptedBy: 'player', guardianApproved: false, proposedDate: tr.sessions[0] ? localDayOf(tr.sessions[0].startsAt, tr.timezone) : null, venue: tr.sessions[0]?.venue?.name ?? null,
    schedule: { legacy: false, timezone: tr.timezone, revision: tr.revision, confirmedAt: tr.confirmedAt, confirmedBy: tr.confirmedAt ? { kind: 'player' } : null, proposedAt: tr.revisions[tr.revisions.length - 1]?.proposedAt ?? null, awaitingConfirmation: !tr.confirmedAt,
      sessions: tr.sessions.slice().sort((a, b) => a.startsAt - b.startsAt).map((s) => ({ ...s, attendance: att.get(s.id) ? { state: att.get(s.id)!.state, source: att.get(s.id)!.source, recordedAt: att.get(s.id)!.recordedAt } : { state: 'not_recorded', source: null, recordedAt: null }, evidence: s.evidence.filter((e) => !e.removedAt).map(({ id, kind, sessionId, linkedAt }) => ({ id, kind, sessionId, linkedAt })) })) },
    revisions: tr.revisions.slice(), attendanceHistory: tr.attendance.slice(), completion: tr.completion, recipient: { type: 'player', minor: false }, subjectRemovedAt: null,
    evidenceCount: tr.sessions.reduce((n, s) => n + s.evidence.filter((e) => !e.removedAt).length, 0),
    history: tr.history.slice(), rev: tr.rev, revAt: tr.revAt, policyVersion: 1,
  };
};
const trialRevGate = (tr: DemoTrial, expectedRev: unknown) => {
  if (!Number.isInteger(expectedRev) || (expectedRev as number) < 0) throw new ApiError(400, 'TRIAL_REV_REQUIRED', 'expectedRev must be an integer.');
  if (expectedRev !== tr.rev) throw apiErr(409, 'TRIAL_VERSION_CONFLICT', 'Someone else changed this while you were working on it. Reload to see their change, then apply yours.', { currentRev: tr.rev, updatedBy: ME.name, updatedAt: tr.revAt });
};
const trialKey = (tr: DemoTrial, action: string, key: string | undefined, fp: string) => {
  if (!key) return false;
  const list = tr.keys[action] ??= [];
  const prior = list.find((k) => k.key === key);
  if (prior && prior.fp === fp) return true;
  if (prior) throw new ApiError(409, 'TRIAL_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different request.');
  list.push({ key, fp });
  return false;
};
const openTrialOf = (roomId: string) => trialsOfRoom(roomId).find((x) => !x.completion) ?? null;
const evidenceView = (tr: DemoTrial): TrialEvidenceView[] => tr.sessions.flatMap((s) => s.evidence.map((e) => ({
  id: e.id, kind: e.kind, trialSessionId: s.id, linkedAt: e.linkedAt, linkedBy: { name: ME.name }, removedAt: e.removedAt, provenance: 'box_cam_observed', combineVerified: false, combineVerifiedBlockedBy: 'COMBINE_VERIFIED_DISABLED',
  session: { id: e.sessionId, drillId: e.sessionId === 'bx-d1' ? 'box-touches' : 'wall-passes', protocolId: null, capturedAt: NOW - 3 * DAY, verificationState: 'unverified', simulated: false, invalidated: false },
  observation: e.sessionId === 'bx-d1' ? { state: 'accepted', copy: 'This session was observed by Box Cam.', qualityState: 'usable', experimental: null } : { state: 'ball_not_detected', copy: 'No reliable observation available. We could not see the ball clearly in this session.', qualityState: null, experimental: null },
  providerVersion: 'demo', engineVersion: null, cvPolicyVersion: null,
})));
const EVIDENCE_CANDIDATES: TrialEvidenceCandidate[] = [
  { id: 'bx-d1', drillId: 'box-touches', protocolId: null, capturedAt: NOW - 3 * DAY, verificationState: 'unverified', simulated: false, linked: false },
  { id: 'bx-d2', drillId: 'wall-passes', protocolId: null, capturedAt: NOW - 9 * DAY, verificationState: 'unverified', simulated: false, linked: false },
];

export const demoRooms: RoomsApi = {
  list: async (_s, params = {}) => {
    let list = roomStore.slice();
    const view = params.view ?? 'all';
    if (view === 'mine') list = list.filter((r) => r.owner.userId === ME.userId || r.leadScoutUserId === ME.userId);
    if (view === 'assigned') list = list.filter((r) => r.tasks.some((t) => t.assigneeUserId === ME.userId && (t.status === 'open' || t.status === 'in_progress')));
    if (view === 'shortlisted') list = list.filter((r) => ['shortlisted', 'priority'].includes(r.status));
    if (view === 'trials') list = list.filter((r) => ['trial_requested', 'trial_scheduled', 'trial_completed'].includes(r.status));
    if (view === 'offers') list = list.filter((r) => ['offer_consideration', 'offer_made'].includes(r.status));
    if (view === 'archived') list = list.filter((r) => ['archived', 'closed', 'withdrawn'].includes(r.status));
    if (view === 'active') list = list.filter((r) => OPEN_STATUSES.includes(r.status));
    if (params.status) list = list.filter((r) => r.status === params.status);
    if (params.tag) list = list.filter((r) => r.tags.includes(params.tag as string));
    const q = (params.q ?? '').trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const name = r.available ? PLAYERS[r.playerId]?.name ?? '' : '';
        return name.toLowerCase().includes(q)
          || r.tags.some((t) => t.toLowerCase().includes(q))
          || (STATUS_LABELS[r.status] ?? '').toLowerCase().includes(q);
      });
    }
    // Most recent activity first — never ordered or ranked by Trust Score.
    const sorted = list.sort((a, b) => (b.updatedAt - a.updatedAt) || a.roomId.localeCompare(b.roomId));
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const result: RoomListResult = {
      items: sorted.slice(offset, offset + limit).map(summarise),
      total: sorted.length, limit, offset,
      funnel: funnelOf(roomStore),
      statuses: ALL_STATUSES.map((s) => ({ id: s, label: STATUS_LABELS[s] })),
      note: LIST_NOTE,
    };
    return delay(result);
  },

  needsAttention: async () => {
    const items: RoomAttentionItem[] = [];
    for (const r of roomStore) {
      if (!OPEN_STATUSES.includes(r.status)) continue;
      const reasons: { code: string; text: string }[] = [];
      const overdue = r.tasks.filter((t) => (t.status === 'open' || t.status === 'in_progress') && typeof t.dueAt === 'number' && (t.dueAt as number) < Date.now());
      if (overdue.length) reasons.push({ code: 'TASK_OVERDUE', text: `${overdue.length} task(s) past their due date.` });
      if (r.combine.requests.some((x) => x.state === 'completed')) reasons.push({ code: 'COMBINE_COMPLETED', text: 'A requested Combine has been completed.' });
      if (r.trials.some((t) => t.status === 'reported') && r.status === 'trial_scheduled') reasons.push({ code: 'TRIAL_REPORTED', text: 'A trial report is in.' });
      if (['offer_consideration', 'offer_made'].includes(r.status) && !currentDecision(r.roomId)) reasons.push({ code: 'DECISION_OUTSTANDING', text: 'No decision has been recorded yet.' });
      if (r.missingEvidence.some((m) => m.status === 'supplied')) reasons.push({ code: 'EVIDENCE_RETURNED', text: 'Requested evidence has arrived.' });
      if (reasons.length) items.push({ roomId: r.roomId, playerId: r.playerId, playerName: r.available ? PLAYERS[r.playerId]?.name ?? null : null, status: r.status, reasons });
    }
    return delay({ items, note: ATTENTION_NOTE });
  },

  summaries: async (_s, playerIds) => {
    const items: RoomSummaryRow[] = playerIds.map((playerId) => {
      const r = roomStore.find((x) => x.playerId === playerId && OPEN_STATUSES.includes(x.status));
      return r
        ? { playerId, roomId: r.roomId, status: r.status, statusLabel: STATUS_LABELS[r.status] }
        : { playerId, roomId: null, status: null };
    });
    return delay({ items });
  },

  create: async (_s, input: CreateRoomInput) => {
    const existing = roomStore.find((r) => r.playerId === input.playerId && OPEN_STATUSES.includes(r.status));
    // One active room per organisation per player — the caller opens that one.
    if (existing) {
      return delay<CreateRoomResult>({ ok: false, error: 'ROOM_EXISTS', existingRoomId: existing.roomId, status: existing.status });
    }
    const now = Date.now();
    const r: DemoRoom = {
      roomId: nid('room'), playerId: input.playerId, available: !!PLAYERS[input.playerId],
      status: 'watching', priority: input.priority ?? 'normal', tags: [],
      restricted: !!input.restricted, sourceContext: input.sourceContext ?? 'direct',
      owner: { userId: ME.userId, name: ME.name },
      leadScoutUserId: ME.userId, leadScoutName: ME.name,
      createdAt: now, updatedAt: now, archivedAt: null, closedAt: null,
      tasks: [], evidence: [], assessments: [], assessmentsWithheld: 0,
      combine: emptyCombine(), development: noDevelopment(),
      missingEvidence: [{ id: nid('sug'), ruleId: 'recent_full_match', ruleVersion: 1, explanation: 'No full match from the last 90 days is on record.', action: 'request_full_match', status: 'open', requestedAt: null }],
      trials: [], links: { requestIds: [], trialIds: [], signingId: null },
    };
    roomStore.unshift(r);
    log(r, 'room_created', { status: 'watching', sourceContext: r.sourceContext });
    return delay<CreateRoomResult>({ ok: true, room: project(r), adoptedExistingCase: false });
  },

  get: async (_s, roomId) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    return delay(project(r));
  },

  patch: async (_s, roomId, input: PatchRoomInput) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    if (input.priority !== undefined) { r.priority = input.priority; log(r, 'room_priority_changed', { priority: input.priority }); }
    if (input.tags !== undefined) { r.tags = [...new Set(input.tags.map((x) => x.trim()).filter(Boolean))]; log(r, 'room_tag_changed', { count: r.tags.length }); }
    if (input.leadScoutUserId !== undefined) {
      r.leadScoutUserId = input.leadScoutUserId;
      r.leadScoutName = staffName(input.leadScoutUserId);
      log(r, 'room_member_assigned', { leadScoutUserId: input.leadScoutUserId });
    }
    if (input.ownerUserId !== undefined) { r.owner = { userId: input.ownerUserId, name: staffName(input.ownerUserId) ?? 'Colleague' }; log(r, 'room_owner_changed', { ownerUserId: input.ownerUserId }); }
    if (input.restricted !== undefined) r.restricted = input.restricted;
    r.updatedAt = Date.now();
    return delay(project(r));
  },

  setStatus: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    const to = input.status;
    const codes = input.reasonCodes ?? [];
    if (!ALL_STATUSES.includes(to)) throw new Error('ROOM_STATUS_UNKNOWN');
    if (to === r.status) throw new Error(`This room is already ${STATUS_LABELS[to]}.`);
    if (!(TRANSITIONS[r.status] ?? []).includes(to)) throw new Error(`A room cannot move from ${STATUS_LABELS[r.status]} to ${STATUS_LABELS[to]}.`);
    if (REASON_REQUIRED.includes(to) && codes.length === 0) throw new Error(`Recording why keeps the decision useful later — ${STATUS_LABELS[to]} needs at least one reason.`);

    const from = r.status;
    r.status = to;
    r.archivedAt = to === 'archived' ? Date.now() : OPEN_STATUSES.includes(to) ? null : r.archivedAt;
    r.closedAt = to === 'closed' ? Date.now() : OPEN_STATUSES.includes(to) ? null : r.closedAt;
    log(r, 'room_status_changed', { from, to, reasonCodes: codes });

    let snap: RoomSnapshot | null = null;
    if (r.available && ['shortlisted', 'priority', 'trial_requested', 'offer_consideration', 'offer_made', 'signed', 'withdrawn', 'archived', 'closed'].includes(to)) {
      const t = trustFor(r.playerId);
      snap = snapshot(Date.now(), t.score, t.band, `status:${to}`);
    }
    // A status that ends pursuit records a decision, so the reason survives as
    // machine-readable decision memory instead of a bare status flag.
    if (['archived', 'closed', 'withdrawn'].includes(to)) {
      appendDecision(r, 'archive', codes, input.note ?? null, snap);
    }
    return delay({ room: project(r), snapshot: snap });
  },

  activity: async (_s, roomId, params = {}) => {
    const rows = roomActivity(roomId).map(({ roomId: _rid, ...a }) => a);
    const limit = params.limit ?? 50;
    const start = params.cursor ? rows.findIndex((x) => x.id === params.cursor) + 1 : 0;
    const page = rows.slice(start, start + limit);
    const result: RoomActivityResult = { items: page, nextCursor: start + limit < rows.length ? page[page.length - 1]?.id ?? null : null, total: rows.length };
    return delay(result);
  },

  comments: async (_s, roomId, params = {}) => {
    const rows = roomComments(roomId).map((c) => ({ ...c }));
    const limit = params.limit ?? 50;
    const start = params.cursor ? rows.findIndex((x) => x.id === params.cursor) + 1 : 0;
    const page = rows.slice(start, start + limit);
    const result: RoomCommentsResult = { items: page, nextCursor: start + limit < rows.length ? page[page.length - 1]?.id ?? null : null, total: rows.length, note: PRIVACY_NOTE };
    return delay(result);
  },

  addComment: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    // Stored inert: markup is stripped on write, exactly as the server does.
    const body = String(input.body ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, 4000);
    if (!body) throw new Error('A comment needs some text.');
    const c: RoomComment & { roomId: string } = {
      id: nid('rcmt'), roomId, author: { userId: ME.userId, name: ME.name },
      body, deleted: false, deletedAt: null, edited: false, editedAt: null, editCount: 0,
      replyToId: input.replyToId ?? null,
      mentions: (input.mentions ?? []).filter((id) => STAFF[id]).map((userId) => ({ userId, name: STAFF[userId] })),
      createdAt: Date.now(),
    };
    commentStore.push(c);
    log(r, 'room_comment_added', { commentId: c.id, replyToId: c.replyToId });
    return delay({ ...c });
  },

  editComment: async (_s, roomId, commentId, body) => {
    const r = find(roomId);
    const c = commentStore.find((x) => x.id === commentId && x.roomId === roomId);
    if (!r || !c) throw new Error('ROOM_COMMENT_NOT_FOUND');
    if (c.deleted) throw new Error('ROOM_COMMENT_DELETED');
    if (c.author.userId !== ME.userId) throw new Error('Only the author can edit a comment.');
    c.body = String(body ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, 4000);
    c.edited = true; c.editedAt = Date.now(); c.editCount += 1;
    log(r, 'room_comment_edited', { commentId });
    return delay({ ...c });
  },

  deleteComment: async (_s, roomId, commentId) => {
    const r = find(roomId);
    const c = commentStore.find((x) => x.id === commentId && x.roomId === roomId);
    if (!r || !c) throw new Error('ROOM_COMMENT_NOT_FOUND');
    // Tombstone, never erase: the thread keeps its shape, the author stays
    // attributable and the audit trail stays intact.
    c.deleted = true; c.deletedAt = Date.now(); c.body = null;
    log(r, 'room_comment_deleted', { commentId });
    return delay({ ...c });
  },

  createTask: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    const title = String(input.title ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 160);
    if (!title) throw new Error('A task needs a title.');
    const t: RoomTask = {
      id: nid('tsk'), title, description: input.description ?? null,
      assigneeUserId: input.assigneeUserId ?? null, assigneeName: staffName(input.assigneeUserId),
      status: 'open', dueAt: input.dueAt ?? null,
      linkedResourceType: input.linkedResourceType ?? null, linkedResourceId: input.linkedResourceId ?? null,
      createdBy: { userId: ME.userId, name: ME.name }, createdAt: Date.now(), completedAt: null,
    };
    r.tasks.push(t);
    log(r, 'room_task_created', { taskId: t.id });
    return delay({ ...t });
  },

  updateTask: async (_s, roomId, taskId, input) => {
    const r = find(roomId);
    const t = r?.tasks.find((x) => x.id === taskId);
    if (!r || !t) throw new Error('ROOM_TASK_NOT_FOUND');
    if (input.status !== undefined) { t.status = input.status; t.completedAt = input.status === 'done' ? Date.now() : null; }
    if (input.assigneeUserId !== undefined) { t.assigneeUserId = input.assigneeUserId; t.assigneeName = staffName(input.assigneeUserId); }
    log(r, 'room_task_updated', { taskId, status: t.status });
    return delay({ ...t });
  },

  decisions: async (_s, roomId) => {
    const history = roomDecisions(roomId).map(({ roomId: _rid, ...d }) => d);
    const result: RoomDecisionsResult = {
      current: history.length ? history[history.length - 1] : null,
      history,
      taxonomy: { categories: REASON_CATEGORIES, recommendations: RECOMMENDATIONS },
      note: DECISION_NOTE,
    };
    return delay(result);
  },

  recordDecision: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    if (!RECOMMENDATIONS.includes(input.recommendation)) throw new Error('That is not a ScoutBox recruitment recommendation.');
    const codes = input.reasonCodes ?? [];
    if (input.recommendation === 'archive' && codes.length === 0) throw new Error('Archiving needs at least one reason so the decision stays useful later.');
    const t = r.available ? trustFor(r.playerId) : null;
    const snap = t ? snapshot(Date.now(), t.score, t.band, 'decision') : null;
    const d = appendDecision(r, input.recommendation, codes, input.note ?? null, snap);
    const { roomId: _rid, ...view } = d;
    return delay({ decision: view, snapshot: snap });
  },

  snapshots: async (_s, roomId) => {
    const items = roomDecisions(roomId).map((d) => d.snapshot).filter((x): x is RoomSnapshot => !!x).sort((a, b) => b.at - a.at);
    return delay({ items });
  },

  reviewEvidence: async (_s, roomId, evidenceId, input) => {
    const r = find(roomId);
    const e = r?.evidence.find((x) => x.id === evidenceId);
    if (!r || !e) throw new Error('EVIDENCE_NOT_FOUND');
    // The review state and the note belong to the ROOM. The evidence record
    // itself is the player's and is never touched.
    e.review = { state: input.state, note: input.note ?? e.review.note, by: ME.name, at: Date.now() };
    log(r, 'room_evidence_reviewed', { evidenceId, state: input.state });
    return delay({ review: { evidenceId, state: e.review.state, note: e.review.note, by: e.review.by, at: e.review.at as number }, note: REVIEW_NOTE });
  },

  assignAssessment: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    const kind = (input.kind ?? 'Assessment').trim() || 'Assessment';
    const assignment = { id: nid('asg'), userId: input.userId, name: staffName(input.userId) ?? 'Colleague', task: `${kind} assessment`, dueAt: input.dueAt ?? null, status: 'open', createdAt: Date.now() };
    r.assessments.push({
      id: nid('ass'), scoutUserId: input.userId, scoutName: assignment.name,
      templateId: null, templateVersion: null, state: 'draft', recommendation: null,
      context: kind, createdAt: Date.now(), submittedAt: null,
    });
    log(r, 'room_assessment_assigned', { assignmentId: assignment.id, userId: input.userId, kind });
    return delay({ assignment });
  },

  requestEvidence: async (_s, roomId, suggestionId) => {
    const r = find(roomId);
    const s = r?.missingEvidence.find((x) => x.id === suggestionId);
    if (!r || !s) throw new Error('SUGGESTION_NOT_FOUND');
    s.status = 'requested';
    s.requestedAt = Date.now();
    log(r, 'room_evidence_requested', { suggestionId, ruleId: s.ruleId });
    // Whose inbox it lands in is the engine's decision, not the scout's.
    const routedTo = (PLAYERS[r.playerId]?.age ?? 99) < 18 ? 'guardian' : 'player';
    return delay({ suggestion: { ...s }, routedTo, note: EVIDENCE_ROUTED_NOTE });
  },

  requestCombine: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    if (!input.protocolIds.length) throw new Error('Select at least one standardized protocol.');
    const titles: Record<string, string> = {
      'combine-box-control-60': 'Box Control 60', 'combine-box-touch-60': 'Box Touch 60',
      'combine-box-juggle': 'Box Juggle', 'combine-box-footwork': 'Box Footwork',
      'combine-box-strength-60': 'Box Strength 60',
    };
    const request = {
      id: nid('creq'), title: input.title ?? null, state: 'requested',
      protocols: input.protocolIds.map((protocolId) => ({ protocolId, protocolTitle: titles[protocolId] ?? protocolId, completed: false })),
      deadline: input.deadline ?? null, instructions: input.instructions ?? null,
      completedCount: 0, requiredCount: input.protocolIds.length, createdAt: Date.now(),
      note: COMBINE_NOTE,
    };
    r.combine.requests = [request, ...r.combine.requests];
    log(r, 'room_combine_requested', { requestId: request.id, protocols: input.protocolIds });
    return delay({ request });
  },

  link: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    if (input.trialId && !r.links.trialIds.includes(input.trialId)) r.links.trialIds.push(input.trialId);
    if (input.requestId && !r.links.requestIds.includes(input.requestId)) r.links.requestIds.push(input.requestId);
    if (input.signingId) r.links.signingId = input.signingId;
    log(r, 'room_trial_linked', { ...input });
    return delay({ links: { ...r.links } });
  },

  // ---- M23 P3 — Contact
  contacts: async (_s, roomId) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    const result: ContactList = {
      items: contactsOf(roomId).map(strip), omitted: 0, routing: contactRouting(r),
      case: { status: r.status, acceptsContact: CONTACT_CASE_STATUSES.includes(r.status), planAction: 'planContact' },
      canWrite: true, cooldown: contactCooldown(r, null),
      channels: { inApp: 'in_app', external: ['phone', 'in_person', 'email_external', 'agent', 'other'].map((id) => ({ id, label: CONTACT_CHANNEL_LABELS[id] })) },
      limits: { subject: 120, body: 2000, summary: 500, replyMessage: 500 }, policyVersion: 1, note: CONTACT_NOTE,
    };
    return delay(result);
  },
  createContact: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    const prior = input.clientKey ? contactsOf(roomId).find((c) => (c as DemoContact & { clientKey?: string }).clientKey === input.clientKey) : null;
    if (prior) return delay({ contact: strip(prior), routing: contactRouting(r) });
    contactGate(r);
    const routing = contactRouting(r);
    if (!routing.available) throw new Error('This player is not available to your organisation under the standing rules.');
    const body = plainShared(input.body, 2000);
    if (!body) throw new Error('Write the message the player or guardian will read.');
    const at = Date.now();
    const c: DemoContact & { clientKey?: string } = {
      id: nid('rct'), roomId, caseId: roomId, playerId: r.playerId, status: 'draft', statusLabel: CONTACT_STATUS_LABELS.draft,
      channel: 'in_app', channelLabel: CONTACT_CHANNEL_LABELS.in_app, external: false, recipient: null,
      subject: plainShared(input.subject, 120) || null, body, summary: null,
      createdBy: { name: ME.name }, createdAt: at, updatedAt: at, sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null, attempts: 0,
      occurredAt: null, recordedBy: null, recordedAt: null, respondedAt: null, response: null, emailCopy: null, lifecycle: null, cancelledAt: null,
      rev: 1, revAt: at, revBy: ME.name, history: [], transportNote: CONTACT_TRANSPORT_NOTE, policyVersion: 1, clientKey: input.clientKey,
    };
    contactEvent(c, 'contact_created', { name: ME.name, kind: 'org' }, { channel: 'in_app' }, at);
    contactStore.push(c);
    // Nothing else: no room activity, no notification, no Inbox row.
    return delay({ contact: strip(c), routing });
  },
  patchContact: async (_s, roomId, contactId, input) => {
    const r = find(roomId);
    const c = contactStore.find((x) => x.id === contactId && x.roomId === roomId);
    if (!r || !c) throw new Error('CONTACT_NOT_FOUND');
    if (!['draft', 'failed'].includes(c.status)) throw new Error(`A contact that is ${CONTACT_STATUS_LABELS[c.status].toLowerCase()} cannot be edited.`);
    contactRev(c, input.expectedRev);
    const at = Date.now();
    const fields: string[] = [];
    if (input.subject !== undefined) { const s = plainShared(input.subject, 120) || null; if (s !== c.subject) { c.subject = s; fields.push('subject'); } }
    if (input.body !== undefined) { const b = plainShared(input.body, 2000); if (!b) throw new Error('Write the message the player or guardian will read.'); if (b !== c.body) { c.body = b; fields.push('body'); } }
    c.updatedAt = at; c.rev += 1; c.revAt = at; c.revBy = ME.name;
    contactEvent(c, 'contact_edited', { name: ME.name, kind: 'org' }, { fields }, at);
    return delay({ contact: strip(c), routing: contactRouting(r) });
  },
  sendContact: async (_s, roomId, contactId, input) => {
    const r = find(roomId);
    const c = contactStore.find((x) => x.id === contactId && x.roomId === roomId);
    if (!r || !c) throw new Error('CONTACT_NOT_FOUND');
    if (c.status === 'delivered') throw new Error('This contact has already been delivered.');
    if (!['draft', 'failed'].includes(c.status)) throw new Error(`A contact that is ${CONTACT_STATUS_LABELS[c.status].toLowerCase()} cannot be sent.`);
    contactGate(r);
    contactRev(c, input.expectedRev);
    const routing = contactRouting(r);
    if (!routing.available) throw new Error('This player is not available to your organisation under the standing rules.');
    const cd = contactCooldown(r, c.id);
    if (cd) throw new Error('A contact was delivered to this player recently and has not been answered yet. Wait before sending another.');
    const at = Date.now();
    c.status = 'delivered'; c.statusLabel = CONTACT_STATUS_LABELS.delivered;
    c.recipient = { type: 'player', minor: false }; c.sentBy = { name: ME.name }; c.sentAt = at; c.deliveredAt = at; c.failedAt = null; c.failureCode = null;
    c.attempts += 1; c.updatedAt = at; c.rev += 1; c.revAt = at; c.revBy = ME.name;
    contactEvent(c, 'contact_sent', { name: ME.name, kind: 'org' }, { channel: 'in_app', recipientType: 'player', attempt: c.attempts }, at);
    const moved = contactAdvance(r, c, at);
    return delay({ contact: strip(c), delivered: true, case: moved });
  },
  cancelContact: async (_s, roomId, contactId, input) => {
    const c = contactStore.find((x) => x.id === contactId && x.roomId === roomId);
    if (!c) throw new Error('CONTACT_NOT_FOUND');
    if (!['draft', 'failed'].includes(c.status)) throw new Error(`A contact that is ${CONTACT_STATUS_LABELS[c.status].toLowerCase()} cannot be cancelled.`);
    contactRev(c, input.expectedRev);
    const at = Date.now();
    c.status = 'cancelled'; c.statusLabel = CONTACT_STATUS_LABELS.cancelled; c.cancelledAt = at; c.updatedAt = at; c.rev += 1; c.revAt = at; c.revBy = ME.name;
    contactEvent(c, 'contact_cancelled', { name: ME.name, kind: 'org' }, null, at);
    return delay({ contact: strip(c) });
  },
  recordExternalContact: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    contactGate(r);
    const routing = contactRouting(r);
    if (!routing.available) throw new Error('This player is not available to your organisation under the standing rules.');
    if (!CONTACT_CHANNEL_LABELS[input.channel] || input.channel === 'in_app') throw new Error('Channel must be one of phone, in_person, email_external, agent, other.');
    const ts = typeof input.occurredAt === 'number' ? input.occurredAt : Date.parse(String(input.occurredAt));
    if (!Number.isFinite(ts)) throw new Error('occurredAt must be a date and time.');
    if (ts > Date.now() + 15 * 60_000) throw new Error('A contact cannot be recorded before it has happened.');
    if (ts < Date.now() - 180 * DAY) throw new Error('A contact this old cannot be recorded as recruitment evidence.');
    if (input.recipientType !== 'player') throw new Error('This player is an adult: the recorded contact is with the player.');
    const at = Date.now();
    const c: DemoContact = {
      id: nid('rct'), roomId, caseId: roomId, playerId: r.playerId, status: 'recorded', statusLabel: CONTACT_STATUS_LABELS.recorded,
      channel: input.channel, channelLabel: CONTACT_CHANNEL_LABELS[input.channel], external: true, recipient: { type: 'player', minor: false },
      subject: null, body: null, summary: plainShared(input.summary, 500) || null,
      createdBy: { name: ME.name }, createdAt: at, updatedAt: at, sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null, attempts: 0,
      occurredAt: ts, recordedBy: { name: ME.name }, recordedAt: at, respondedAt: null, response: null, emailCopy: null, lifecycle: null, cancelledAt: null,
      rev: 1, revAt: at, revBy: ME.name, history: [], transportNote: CONTACT_RECORDED_NOTE, policyVersion: 1,
    };
    contactEvent(c, 'contact_external_recorded', { name: ME.name, kind: 'org' }, { channel: input.channel, occurredAt: ts, recipientType: 'player' }, at);
    contactStore.push(c);
    const moved = contactAdvance(r, c, at);
    return delay({ contact: strip(c), case: moved });
  },

  trials: async (_s, roomId) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    const inv = invitationStore.filter((i) => i.roomId === roomId).sort((a, b) => b.view.createdAt - a.view.createdAt)[0] ?? null;
    const list: TrialList = {
      items: trialsOfRoom(roomId).map(trialView), omitted: 0, routing: contactRouting(r), invitation: inv ? inv.view : null,
      case: { status: r.status, acceptsInvitation: TRIAL_CASE_STATUSES.includes(r.status), planAction: 'planTrial' },
      canWrite: true, canAssess: true, blocked: false, limits: TRIAL_LIMITS,
      vocabulary: { workflowStates: ['legacy_accepted', 'accepted', 'scheduled', 'completed', 'cancelled'], sessionKinds: ['onboarding', 'training', 'drill', 'small_sided', 'match', 'other'], attendanceStates: ['attended', 'partial', 'no_show', 'club_cancelled', 'player_withdrew'] },
      policyVersion: 1, note: TRIAL_NOTE,
    };
    return delay(list);
  },
  trial: async (_s, roomId, trialId) => {
    const tr = trialsOfRoom(roomId).find((x) => x.id === trialId);
    if (!tr) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial.');
    return delay({ trial: trialView(tr), evidence: evidenceView(tr), assessments: [], canWrite: true, canAssess: true, blocked: false });
  },
  inviteTrial: async (_s, roomId, input) => {
    const r = find(roomId);
    if (!r) throw new Error('ROOM_NOT_FOUND');
    const fp = JSON.stringify({ slots: (input.slots ?? []).map((x) => [x.startsAt, x.endsAt]), venue: input.venue?.name, message: input.message });
    const prior = input.clientKey ? invitationStore.find((i) => i.roomId === roomId && i.clientKey === input.clientKey) : null;
    if (prior && prior.fp === fp) return delay({ invitation: prior.view, routing: contactRouting(r), case: { unchanged: true as const, status: r.status }, idempotent: true });
    if (prior) throw new ApiError(409, 'TRIAL_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different invitation.');
    if (!TRIAL_CASE_STATUSES.includes(r.status)) throw apiErr(409, 'TRIAL_CASE_STATE', `A case at "${STATUS_LABELS[r.status] ?? r.status}" cannot request a trial.`, { allowed: TRIAL_CASE_STATUSES });
    if (invitationStore.some((i) => i.roomId === roomId && i.view.status === 'pending')) throw new ApiError(409, 'TRIAL_ALREADY_INVITED', 'An invitation is already waiting for an answer.');
    if (openTrialOf(roomId)) throw new ApiError(409, 'TRIAL_INVALID_STATE', 'This case already has an open trial. Complete or cancel it before inviting again.');
    if (!input.timezone) throw new ApiError(400, 'TRIAL_TIMEZONE_INVALID', 'timezone must be an IANA time zone name, for example Europe/London.');
    if (!input.venue?.name?.trim()) throw new ApiError(400, 'TRIAL_VENUE_INVALID', 'A venue needs a name.');
    if (!input.message?.trim()) throw new ApiError(400, 'TRIAL_CONTENT_INVALID', 'Write the message the player or guardian will read.');
    if (!Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 3) throw new ApiError(400, 'TRIAL_SLOTS_INVALID', 'Offer one to three slots.');
    const now = Date.now();
    for (const sl of input.slots) { if (!(sl.endsAt > sl.startsAt) || sl.endsAt <= now) throw new ApiError(400, 'TRIAL_SCHEDULE_INVALID', 'A slot must end after it starts, in the future.'); }
    const days = new Set(input.slots.map((sl) => localDayOf(sl.startsAt, input.timezone)));
    if (days.size !== input.slots.length) throw new ApiError(400, 'TRIAL_SLOTS_INVALID', 'Each offered slot must fall on a different day.');
    const slots = input.slots.slice().sort((a, b) => a.startsAt - b.startsAt).map((sl) => ({ id: nid('tslot'), day: localDayOf(sl.startsAt, input.timezone), startsAt: sl.startsAt, endsAt: sl.endsAt, timezone: input.timezone, kind: sl.kind ?? 'training', venue: { name: input.venue.name, town: input.venue.town ?? null } }));
    const view: TrialInvitationView = { id: nid('req'), status: 'pending', createdAt: now, respondedAt: null, respondedBy: null, routedTo: 'player', trialId: null, slots, proposedDate: slots[0].day, altSlots: slots.slice(1).map((x) => x.day) };
    invitationStore.push({ roomId, clientKey: input.clientKey ?? null, fp, view });
    const moved = r.status !== 'trial_requested';
    const from = r.status;
    if (moved) { r.status = 'trial_requested'; r.updatedAt = now; }
    // The simulated recipient accepts the first slot shortly after — a demo stand-in for the player app.
    setTimeout(() => {
      if (view.status !== 'pending') return;
      const at = Date.now(); const first = slots[0];
      view.status = 'accepted'; view.respondedAt = at; view.respondedBy = 'player';
      const tr: DemoTrial = {
        roomId, id: nid('trl'), playerId: r.playerId, playerName: PLAYERS[r.playerId]?.name ?? 'Demo player', workflowState: 'scheduled', acceptedAt: at, timezone: input.timezone, revision: 1, confirmedAt: at,
        sessions: [{ id: nid('tses'), kind: first.kind ?? 'training', startsAt: first.startsAt, endsAt: first.endsAt, venue: { name: input.venue.name, town: input.venue.town ?? null, address: input.venue.address ?? null }, instructions: input.instructions ?? null, attendance: { state: 'not_recorded', source: null, recordedAt: null }, evidence: [] }],
        revisions: [{ revision: 1, proposedAt: now, proposedBy: { kind: 'org', name: ME.name }, confirmedAt: at, supersededAt: null, reason: 'invitation', material: null, sessionCount: 1 }],
        attendance: [], completion: null, reportStatus: 'awaiting_report', rev: 1, revAt: at, keys: {}, history: [],
      };
      trialEvent(tr, 'trial_accepted', { kind: 'player', name: tr.playerName }, { recipientType: 'player', day: first.day }, at);
      trialEvent(tr, 'trial_schedule_confirmed', { kind: 'player', name: tr.playerName }, { revision: 1, sessionCount: 1 }, at);
      view.trialId = tr.id; trialStore.push(tr);
      r.status = 'trial_scheduled'; r.updatedAt = at;
      log(r, 'trial_accepted', { trialId: tr.id });
    }, 1500);
    return delay({ invitation: view, routing: contactRouting(r), case: moved ? { from, to: 'trial_requested' } : { unchanged: true as const, status: r.status } });
  },
  scheduleTrial: async (_s, roomId, trialId, input) => {
    const tr = trialsOfRoom(roomId).find((x) => x.id === trialId);
    if (!tr) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial.');
    const fp = JSON.stringify({ tz: input.timezone, sessions: (input.sessions ?? []).map((x) => [x.id ?? null, x.startsAt, x.endsAt, x.venue?.name, x.kind ?? null, x.instructions ?? null]) });
    if (trialKey(tr, 'schedule', input.clientKey, fp)) return delay({ trial: trialView(tr), idempotent: true });
    if (tr.completion) throw new ApiError(409, 'TRIAL_INVALID_STATE', `A trial that is ${tr.completion.state} cannot take this action.`);
    trialRevGate(tr, input.expectedRev);
    if (!Array.isArray(input.sessions) || !input.sessions.length || input.sessions.length > 20) throw new ApiError(400, 'TRIAL_SCHEDULE_INVALID', 'A trial has between one and twenty sessions.');
    const now = Date.now();
    const att = currentAtt(tr);
    const next: DemoTrialSession[] = [];
    for (const s of input.sessions) {
      if (!(s.endsAt > s.startsAt) || s.endsAt - s.startsAt < TRIAL_LIMITS.minSessionMs || s.endsAt - s.startsAt > TRIAL_LIMITS.maxSessionMs) throw new ApiError(400, 'TRIAL_SCHEDULE_INVALID', 'A session is between 15 minutes and 12 hours long and ends after it starts.');
      const prev = s.id ? tr.sessions.find((x) => x.id === s.id) : null;
      if (s.id && !prev) throw new ApiError(404, 'TRIAL_SESSION_NOT_FOUND', 'A session id on a revision must name a session of this trial.');
      if (!prev && s.endsAt <= now) throw new ApiError(400, 'TRIAL_SCHEDULE_INVALID', 'A session cannot be scheduled entirely in the past.');
      if (!s.venue?.name?.trim()) throw new ApiError(400, 'TRIAL_VENUE_INVALID', 'A venue needs a name.');
      next.push({ id: prev?.id ?? nid('tses'), kind: s.kind ?? 'training', startsAt: s.startsAt, endsAt: s.endsAt, venue: { name: s.venue.name, town: s.venue.town ?? null, address: s.venue.address ?? null }, instructions: s.instructions ?? null, attendance: { state: 'not_recorded', source: null, recordedAt: null }, evidence: prev?.evidence ?? [] });
    }
    next.sort((a, b) => a.startsAt - b.startsAt);
    for (let i = 1; i < next.length; i += 1) if (next[i].startsAt < next[i - 1].endsAt) throw new ApiError(400, 'TRIAL_SCHEDULE_INVALID', 'Sessions cannot overlap.');
    for (const prev of tr.sessions) {
      if (prev.endsAt > now && !att.has(prev.id)) continue;
      const kept = next.find((x) => x.id === prev.id);
      if (!kept || kept.startsAt !== prev.startsAt || kept.endsAt !== prev.endsAt) throw apiErr(409, 'TRIAL_INVALID_STATE', 'A session that has ended or has attendance recorded cannot be removed or moved. Cancel the trial if it will not go ahead.', { current: { sessionId: prev.id } });
    }
    const key = (s: DemoTrialSession) => `${s.id}|${s.startsAt}|${s.endsAt}|${s.venue?.name ?? ''}|${s.venue?.town ?? ''}`;
    const material = tr.timezone !== input.timezone || tr.sessions.length !== next.length || tr.sessions.map(key).sort().some((k, i) => k !== next.map(key).sort()[i]);
    const keeps = !!tr.confirmedAt && !material;
    for (const rv of tr.revisions) if (!rv.supersededAt) rv.supersededAt = now;
    tr.revision += 1; tr.timezone = input.timezone; tr.sessions = next; tr.confirmedAt = keeps ? tr.confirmedAt : null;
    tr.revisions.push({ revision: tr.revision, proposedAt: now, proposedBy: { kind: 'org', name: ME.name }, confirmedAt: keeps ? tr.confirmedAt : null, supersededAt: null, reason: input.reason ?? null, material, sessionCount: next.length });
    trialEvent(tr, 'trial_rescheduled', { kind: 'org', name: ME.name }, { revision: tr.revision, sessionCount: next.length, material, requiresConfirmation: !keeps }, now);
    bumpTrial(tr, now);
    if (!keeps) {
      // The simulated recipient confirms a material change after a moment.
      setTimeout(() => { if (tr.confirmedAt || tr.completion) return; const at = Date.now(); tr.confirmedAt = at; const rv = tr.revisions.find((x) => x.revision === tr.revision); if (rv) rv.confirmedAt = at; trialEvent(tr, 'trial_schedule_confirmed', { kind: 'player', name: tr.playerName }, { revision: tr.revision, sessionCount: tr.sessions.length }, at); bumpTrial(tr, at); { const rr = find(roomId); if (rr) log(rr, 'trial_scheduled', { trialId: tr.id, revision: tr.revision }); } }, 2500);
    }
    return delay({ trial: trialView(tr), requiresConfirmation: !keeps, material });
  },
  cancelTrial: async (_s, roomId, trialId, input) => {
    const tr = trialsOfRoom(roomId).find((x) => x.id === trialId);
    if (!tr) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial.');
    if (!input.reason?.trim()) throw apiErr(400, 'TRIAL_CONTENT_INVALID', 'A cancellation needs a reason the family will read.', { field: 'reason' });
    if (trialKey(tr, 'cancel', input.clientKey, JSON.stringify({ reason: input.reason.trim() }))) return delay({ trial: trialView(tr), idempotent: true });
    if (tr.completion) throw new ApiError(409, 'TRIAL_INVALID_STATE', `A trial that is ${tr.completion.state} cannot take this action.`);
    trialRevGate(tr, input.expectedRev);
    const now = Date.now(); const phase = deriveTrialState(tr);
    tr.completion = { state: 'cancelled', at: now, by: { kind: 'org', name: ME.name }, reason: input.reason.trim(), phase, cancelledBy: 'club' };
    trialEvent(tr, 'trial_cancelled', { kind: 'org', name: ME.name }, { phase, cancelledBy: 'club' }, now);
    bumpTrial(tr, now);
    return delay({ trial: trialView(tr) });
  },
  recordTrialAttendance: async (_s, roomId, trialId, sessionId, input) => {
    const tr = trialsOfRoom(roomId).find((x) => x.id === trialId);
    if (!tr) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial.');
    const states: TrialAttendanceState[] = ['attended', 'partial', 'no_show', 'club_cancelled', 'player_withdrew'];
    if (!states.includes(input.state)) throw apiErr(400, 'TRIAL_ATTENDANCE_INVALID', 'Attendance records what happened, never how it went.', { allowed: states });
    if (trialKey(tr, 'attendance', input.clientKey, JSON.stringify({ sessionId, state: input.state, note: input.note ?? null }))) return delay({ trial: trialView(tr), idempotent: true });
    if (deriveTrialState(tr) !== 'scheduled') throw new ApiError(409, 'TRIAL_INVALID_STATE', `A trial that is ${deriveTrialState(tr)} cannot take this action.`);
    const s = tr.sessions.find((x) => x.id === sessionId);
    if (!s) throw new ApiError(404, 'TRIAL_SESSION_NOT_FOUND', 'No such session on this trial.');
    const now = Date.now();
    if (s.startsAt > now) throw apiErr(409, 'TRIAL_INVALID_STATE', 'Attendance is recorded once a session has started.', { current: { sessionId } });
    trialRevGate(tr, input.expectedRev);
    tr.attendance.push({ sessionId, state: input.state, source: 'manual', recordedAt: now, recordedBy: { name: ME.name }, note: input.note?.trim() || null });
    trialEvent(tr, 'trial_attendance_recorded', { kind: 'org', name: ME.name }, { sessionId, state: input.state, source: 'manual' }, now);
    bumpTrial(tr, now);
    return delay({ trial: trialView(tr) });
  },
  completeTrial: async (_s, roomId, trialId, input) => {
    const tr = trialsOfRoom(roomId).find((x) => x.id === trialId);
    if (!tr) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial.');
    if (trialKey(tr, 'complete', input.clientKey, JSON.stringify({ complete: trialId }))) return delay({ trial: trialView(tr), case: { unchanged: true as const, status: 'trial_completed' }, idempotent: true });
    const state = deriveTrialState(tr);
    if (state === 'completed') throw new ApiError(409, 'TRIAL_INVALID_STATE', 'This trial is already completed.');
    if (state === 'cancelled') throw new ApiError(409, 'TRIAL_INVALID_STATE', 'A trial that is cancelled cannot take this action.');
    const now = Date.now(); const att = currentAtt(tr);
    const reasons: string[] = [];
    if (state !== 'scheduled') reasons.push('schedule_not_confirmed');
    if (!tr.sessions.some((s) => ['attended', 'partial'].includes(att.get(s.id)?.state ?? ''))) reasons.push('no_attended_session');
    if (!tr.sessions.length || Math.max(...tr.sessions.map((s) => s.endsAt)) > now) reasons.push('last_session_not_ended');
    if (reasons.length) throw apiErr(409, 'TRIAL_COMPLETION_REQUIREMENTS_NOT_MET', 'A trial completes only after a confirmed schedule, recorded attendance at a session, and the last session has ended.', { reasons });
    trialRevGate(tr, input.expectedRev);
    tr.completion = { state: 'completed', at: now, by: { kind: 'org', name: ME.name }, reason: null, phase: 'scheduled', cancelledBy: null };
    trialEvent(tr, 'trial_completed', { kind: 'org', name: ME.name }, { sessionCount: tr.sessions.length }, now);
    bumpTrial(tr, now);
    const r = find(roomId); const from = r?.status ?? 'trial_scheduled';
    if (r) { r.status = 'trial_completed'; r.updatedAt = now; }
    return delay({ trial: trialView(tr), case: { from, to: 'trial_completed' } });
  },
  trialEvidenceCandidates: async (_s, roomId, trialId) => {
    const tr = trialsOfRoom(roomId).find((x) => x.id === trialId);
    if (!tr) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial.');
    const linked = new Set(tr.sessions.flatMap((s) => s.evidence.filter((e) => !e.removedAt).map((e) => e.sessionId)));
    return delay({ items: EVIDENCE_CANDIDATES.map((c) => ({ ...c, linked: linked.has(c.id) })), consent: true, reason: null });
  },
  linkTrialEvidence: async (_s, roomId, trialId, sessionId, input) => {
    const tr = trialsOfRoom(roomId).find((x) => x.id === trialId);
    if (!tr) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial.');
    if (trialKey(tr, 'link', input.clientKey, JSON.stringify({ sessionId, boxSessionId: input.boxSessionId }))) return delay({ trial: trialView(tr), evidence: evidenceView(tr), idempotent: true });
    const state = deriveTrialState(tr);
    if (state !== 'scheduled' && state !== 'completed') throw new ApiError(409, 'TRIAL_INVALID_STATE', `A trial that is ${state} cannot take this action.`);
    const s = tr.sessions.find((x) => x.id === sessionId);
    if (!s) throw new ApiError(404, 'TRIAL_SESSION_NOT_FOUND', 'No such session on this trial.');
    if (!EVIDENCE_CANDIDATES.some((c) => c.id === input.boxSessionId)) throw new ApiError(404, 'TRIAL_BOXCAM_INCOMPATIBLE', 'No Box Cam session of this player with that id is available to your organisation.');
    trialRevGate(tr, input.expectedRev);
    if (s.evidence.some((e) => e.sessionId === input.boxSessionId && !e.removedAt)) return delay({ trial: trialView(tr), evidence: evidenceView(tr), idempotent: true });
    const now = Date.now();
    s.evidence.push({ id: nid('tev'), kind: 'box_cam_session', sessionId: input.boxSessionId, linkedAt: now, removedAt: null });
    trialEvent(tr, 'trial_evidence_linked', { kind: 'org', name: ME.name }, { trialSessionId: s.id, kind: 'box_cam_session', sessionId: input.boxSessionId }, now);
    bumpTrial(tr, now);
    return delay({ trial: trialView(tr), evidence: evidenceView(tr) });
  },
  unlinkTrialEvidence: async (_s, roomId, trialId, evidenceId, input) => {
    const tr = trialsOfRoom(roomId).find((x) => x.id === trialId);
    if (!tr) throw new ApiError(404, 'TRIAL_NOT_FOUND', 'No such trial.');
    let hit: DemoEvidenceLink | null = null; let sess: DemoTrialSession | null = null;
    for (const s of tr.sessions) { const e = s.evidence.find((x) => x.id === evidenceId); if (e) { hit = e; sess = s; break; } }
    if (!hit || !sess) throw new ApiError(404, 'TRIAL_SESSION_NOT_FOUND', 'No such evidence link on this trial.');
    trialRevGate(tr, input.expectedRev);
    if (hit.removedAt) return delay({ trial: trialView(tr), evidence: evidenceView(tr), idempotent: true });
    const now = Date.now();
    hit.removedAt = now;
    trialEvent(tr, 'trial_evidence_unlinked', { kind: 'org', name: ME.name }, { trialSessionId: sess.id, sessionId: hit.sessionId }, now);
    bumpTrial(tr, now);
    return delay({ trial: trialView(tr), evidence: evidenceView(tr) });
  },
  funnel: async () => delay(funnelOf(roomStore)),
};

/** Append-only: a revision SUPERSEDES its predecessor, it never rewrites it. */
function appendDecision(r: DemoRoom, recommendation: string, reasonCodes: string[], note: string | null, snap: RoomSnapshot | null) {
  const prev = currentDecision(r.roomId);
  const d: RoomDecision & { roomId: string } = {
    id: nid('rdec'), roomId: r.roomId, recommendation, reasonCodes, note,
    by: { userId: ME.userId, name: ME.name, role: 'Head of Recruitment' },
    createdAt: Date.now(), supersededById: null, snapshot: snap,
  };
  if (prev) prev.supersededById = d.id;
  decisionStore.push(d);
  log(r, 'room_decision_recorded', { decisionId: d.id, recommendation, reasonCodes });
  return d;
}
