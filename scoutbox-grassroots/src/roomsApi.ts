// M17 typed client (org side): the Recruitment Room.
//
// What a Room IS: the CLUB's private decision layer over one player — what we
// think, what we have reviewed, what we are waiting on, and what we decided.
// What it is NOT: a second copy of the player's record. The Football Passport
// remains the player's truth layer; the Room composes the server's projections
// of it and never re-derives, re-scores or re-publishes them.
//
// A Room is private to the organisation that owns it. The player, their
// guardian and every other club can never see it, and nothing in this module
// has a player-facing surface. The free-text a scout writes here (comments,
// internal notes, task titles) never leaves the organisation — which is why the
// evidence-request bridge deliberately has NO free-text field: only the
// engine's rule-derived wording, with guardian routing, ever reaches a player.
//
// The Trust Score carried on these payloads is EVIDENCE CONFIDENCE, never
// football ability, and it opens no door: every standing gate (visibility,
// verification, blocks, suspension, the agency wall) has already run
// server-side on every read, and a score of 100 grants exactly what a score of
// 0 grants. Rooms are never sorted or ranked by it.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import type { RecruitmentPassport } from './m15api';
import { demoRooms } from './roomsDemo';

// ------------------------------------------------------------- vocabularies
// Mirrors of the server's fixed vocabularies. They are declarative labels for
// the UI only — the server remains the sole authority on what is allowed.
export const ROOM_STATUSES = [
  'watching', 'under_review', 'shortlisted', 'priority',
  'trial_requested', 'trial_scheduled', 'trial_completed',
  'offer_consideration', 'offer_made', 'signed',
  'withdrawn', 'archived', 'closed',
] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ROOM_RECOMMENDATIONS = [
  'no_decision', 'continue_watching', 'shortlist', 'priority', 'trial', 'offer', 'archive',
] as const;
export type RoomRecommendation = (typeof ROOM_RECOMMENDATIONS)[number];

export const ROOM_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const ROOM_TASK_STATES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export const ROOM_EVIDENCE_REVIEW_STATES = ['not_reviewed', 'reviewing', 'reviewed', 'needs_follow_up'] as const;
/** Statuses that end active pursuit and therefore demand a recorded reason. */
export const REASON_REQUIRED_STATUSES = ['withdrawn', 'archived', 'closed'];

// ------------------------------------------------------------------- shapes

/** The safe org Trust projection carried on a room. Evidence confidence only. */
export interface RoomTrust {
  score: number;
  band: string;
  bandLabel: string;
  /** Always present: "Evidence confidence — not football ability." */
  note: string;
  disclaimer?: string;
  policyVersion?: number;
  simulatedEvidenceIncluded?: boolean;
  explanations?: { component: string; level: string; levelLabel: string; weight: number }[];
  signals?: { code: string; text: string }[];
}

/** One row of the room list. A workflow view — never a back door into a Passport. */
export interface RoomListItem {
  roomId: string;
  playerId: string;
  playerName: string | null;
  playerAvailable: boolean;
  position: string | null;
  age: number | null;
  currentClub: string | null;
  status: string;
  statusLabel: string;
  stage: string | null;
  priority: string;
  tags: string[];
  ownerUserId: string | null;
  ownerName: string | null;
  leadScoutUserId: string | null;
  trust: RoomTrust | null;
  openTasks: number;
  health: string | null;
  healthLabel: string | null;
  lastActivityAt: number | null;
  updatedAt: number;
  createdAt: number;
}

export interface RoomFunnel {
  total: number; active: number; shortlisted: number; trials: number;
  offers: number; signed: number; archived: number;
  byStatus: Record<string, number>;
  note: string;
}

export interface RoomListParams {
  view?: string; status?: string; tag?: string; assignee?: string;
  q?: string; limit?: number; offset?: number;
}

export interface RoomListResult {
  items: RoomListItem[];
  total: number; limit: number; offset: number;
  funnel: RoomFunnel;
  statuses: { id: string; label: string }[];
  note: string;
}

export interface RoomAttentionItem {
  roomId: string; playerId: string; playerName: string | null;
  status: string; reasons: { code: string; text: string }[];
}

export interface RoomSummaryRow {
  playerId: string; roomId: string | null;
  status: string | null; statusLabel?: string | null;
}

export interface RoomTask {
  id: string; title: string; description: string | null;
  assigneeUserId: string | null; assigneeName: string | null;
  status: string; dueAt: string | number | null;
  linkedResourceType: string | null; linkedResourceId: string | null;
  createdBy: { userId: string; name: string } | null;
  createdAt: number; completedAt: number | null;
}

/** A deleted comment is tombstoned, never erased — the thread and the audit
 *  trail keep their shape and the author stays attributable. */
export interface RoomComment {
  id: string; roomId: string;
  author: { userId: string; name: string };
  body: string | null;
  deleted: boolean; deletedAt: number | null;
  edited: boolean; editedAt: number | null; editCount: number;
  replyToId: string | null;
  mentions: { userId: string; name: string }[];
  createdAt: number;
}

/** Decision-time evidence confidence. Never a record of the player's ability. */
export interface RoomSnapshot {
  id?: string;
  at: number;
  trigger?: string;
  trust: { score: number; band: string; policyVersion: number; componentLevels: Record<string, string>; hash?: string } | null;
  sourceRefs: {
    passportVersion: number | string | null;
    evidenceIds: string[]; assessmentIds: string[];
    combineResults: string[]; trialIds: string[];
  };
  note: string;
}

export interface RoomDecision {
  id: string;
  recommendation: string;
  reasonCodes: string[];
  note: string | null;
  by: { userId: string; name: string; role: string | null };
  createdAt: number;
  supersededById: string | null;
  snapshot: RoomSnapshot | null;
}

export interface RoomDecisionTaxonomy {
  categories: Record<string, string[]>;
  recommendations: string[];
}

export interface RoomDecisionsResult {
  current: RoomDecision | null;
  history: RoomDecision[];
  taxonomy: RoomDecisionTaxonomy;
  note: string;
}

export interface RoomActivityItem {
  id: string; at: number; type: string;
  actor: { kind: string; id: string; name: string } | null;
  detail: Record<string, unknown> | null;
}

export interface RoomActivityResult {
  items: RoomActivityItem[]; nextCursor: string | null; total: number;
}

export interface RoomCommentsResult {
  items: RoomComment[]; nextCursor: string | null; total: number; note: string;
}

/** Counts and words. Deliberately never a percentage and never a score. */
export interface RoomReadiness {
  items: { key: string; label: string; value: string; complete: boolean; outstanding: string | null }[];
  complete: number;
  total: number;
  blockers: { key: string; text: string }[];
  openEvidenceRequests: number;
  note: string;
}

/** Evidence the club may already see, plus the ROOM's own private review state. */
export interface RoomEvidenceItem {
  id: string;
  claimType?: string | null;
  label?: string | null;
  title?: string | null;
  recordedAt?: number | null;
  provenance?: string | null;
  provenanceCopy?: string | null;
  verification?: { status?: string | null; by?: string | null } | null;
  review: { state: string; note: string | null; by: string | null; at: number | null };
}

export interface RoomAssessment {
  id: string; scoutUserId: string; scoutName: string;
  templateId: string | null; templateVersion: number | null;
  state: string; recommendation: string | null; context: string | null;
  createdAt: number; submittedAt: number | null;
}

export interface RoomCombineResult {
  protocolId: string; protocolVersion: number; protocolTitle: string;
  metricUnit: string; measuredValue: number; display: string;
  combineVerified: boolean; capturedBy: string; completedAt: number;
}

export interface RoomCombineRequest {
  id: string; title: string | null; state: string;
  protocols: { protocolId: string; protocolTitle: string; completed: boolean }[];
  deadline: string | null; instructions: string | null;
  completedCount: number; requiredCount: number; createdAt: number;
  note?: string | null;
}

export interface RoomCombine {
  shared: boolean;
  results: RoomCombineResult[];
  hasCombineVerifiedResults?: boolean;
  requests: RoomCombineRequest[];
  note?: string | null;
}

/** Aggregate Box Cam activity, only behind the player's own recruitment share. */
export interface RoomDevelopment {
  shared?: boolean;
  days?: number;
  boxSessions?: number;
  verifiedActiveMs?: number;
  assigned?: number;
  assignedCompleted?: number;
  focus?: { category: string; activeMs: number }[];
  note: string;
}

export interface RoomMissingEvidence {
  id: string; ruleId: string; ruleVersion: number;
  explanation: string; action: string; status: string;
  requestedAt: number | null;
}

export interface RoomTrial {
  id: string; status: string; proposedDate: string | null;
  venue: string | null; reportDueAt: string | null;
  hasReport: boolean; linked: boolean;
}

/** The composed Room. Every player-side field is null/empty and
 *  `unavailableNote` is present when `playerAvailable` is false. */
export interface Room {
  roomId: string;
  orgId: string;
  playerId: string;
  /** Mutation revision — the optimistic-concurrency token (M18.1). */
  rev?: number;
  revAt?: number | null;
  revBy?: string | null;
  status: string;
  statusLabel: string;
  allowedTransitions: string[];
  stage: string | null;
  priority: string;
  priorityNote: string;
  tags: string[];
  restricted: boolean;
  sourceContext: string;
  owner: { userId: string | null; name: string | null };
  leadScout: { userId: string; name: string } | null;
  viewerRole: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  closedAt: number | null;
  links: { requestIds: string[]; trialIds: string[]; signingId: string | null };
  privacyNote: string;

  playerAvailable: boolean;
  playerName: string | null;
  player: Record<string, unknown> | null;
  unavailableNote?: string;

  trust: RoomTrust | null;
  passport: RecruitmentPassport | null;
  evidence: RoomEvidenceItem[];
  assessments: RoomAssessment[];
  assessmentsWithheldPendingOwnSubmission?: number;
  combine: RoomCombine | null;
  development: RoomDevelopment | null;
  missingEvidence: RoomMissingEvidence[];
  trials: RoomTrial[];
  tasks: RoomTask[];
  comments: RoomComment[];
  decision: { current: RoomDecision | null; history: RoomDecision[] };
  activity: RoomActivityResult;
  readiness: RoomReadiness | null;
  health: string | null;
  healthLabel: string | null;
}

export interface CreateRoomInput {
  playerId: string;
  sourceContext?: string;
  priority?: string;
  restricted?: boolean;
  vacancyId?: string;
}

/** One active room per organisation per player: the server answers 409 with the
 *  id of the room that already exists, so the client opens it instead of
 *  erroring at a scout who did the right thing. */
export type CreateRoomResult =
  | { ok: true; room: Room; adoptedExistingCase: boolean }
  | { ok: false; error: 'ROOM_EXISTS'; existingRoomId: string; status: string };

export interface PatchRoomInput {
  /** The room `rev` this edit was composed against (M18.1). */
  expectedRev?: number;
  priority?: string;
  tags?: string[];
  leadScoutUserId?: string | null;
  ownerUserId?: string;
  restricted?: boolean;
  deadline?: string | null;
}


// ------------------------------------------------------- M23 P3 — Contact
// A Contact is the club's INTERNAL record of one communication process. A
// draft never leaves the organisation; only a sent message or a recorded
// external contact is a contact, and only that moves the case to Contacted.
// Delivery truth (delivered / failed / responded / recorded) belongs to the
// Contact, never to the case. Nothing here is ever a player-facing shape: the
// recipient sees the request the send created, in their own Inbox.
export const CONTACT_EXTERNAL_CHANNELS = ['phone', 'in_person', 'email_external', 'agent', 'other'] as const;
export type ContactExternalChannel = (typeof CONTACT_EXTERNAL_CHANNELS)[number];

export interface ContactHistoryEntry {
  id: string; at: number; action: string;
  by: { name: string | null; kind: string | null } | null;
  detail: Record<string, unknown> | null;
}

export interface ContactRecord {
  id: string;
  caseId: string;
  playerId: string;
  status: 'draft' | 'delivered' | 'failed' | 'responded' | 'recorded' | 'cancelled' | string;
  statusLabel: string;
  channel: 'in_app' | ContactExternalChannel | string;
  channelLabel: string;
  external: boolean;
  recipient: { type: 'player' | 'guardian'; minor: boolean } | null;
  subject: string | null;
  body: string | null;
  summary: string | null;
  createdBy: { name: string } | null;
  createdAt: number;
  updatedAt: number;
  sentBy: { name: string } | null;
  sentAt: number | null;
  deliveredAt: number | null;
  failedAt: number | null;
  failureCode: string | null;
  attempts: number;
  occurredAt: number | null;
  recordedBy: { name: string } | null;
  recordedAt: number | null;
  respondedAt: number | null;
  response: { kind: 'accepted' | 'declined' | string; message: string | null; by: 'player' | 'guardian' | string; at: number } | null;
  /** Courtesy email copy to a guardian — never the transport of record, never "delivered". */
  emailCopy: { state: string; to: string; outboxId: string | null; at: number } | null;
  lifecycle: { applied: boolean; from?: string; to?: string; reason?: string; at: number } | null;
  cancelledAt: number | null;
  rev: number;
  revAt: number | null;
  revBy: string | null;
  history: ContactHistoryEntry[];
  transportNote: string;
  policyVersion: number;
}

export interface ContactRouting {
  available: boolean;
  type: 'player' | 'guardian' | null;
  minor: boolean | null;
  reason?: string;
}

export interface ContactList {
  items: ContactRecord[];
  omitted: number;
  routing: ContactRouting;
  case: { status: string; acceptsContact: boolean; planAction: string };
  canWrite: boolean;
  cooldown: { until: number } | null;
  channels: { inApp: string; external: { id: string; label: string }[] };
  limits: { subject: number; body: number; summary: number; replyMessage: number };
  policyVersion: number;
  note: string;
}

export type ContactCaseMove = { from: string; to: string } | { unchanged: true; status: string };

// ------------------------------------------------------ M23 P4B — Trial
// The Trial is the club's OPERATIONAL record of one trial: invitation (a
// request row), acceptance, a confirmed schedule of sessions, per-session
// attendance, explicit completion, Box Cam evidence by reference and the
// existence of assessments. Every shape below is the club view; the family's
// view lives in the player app. Nothing here carries the family's emergency
// contact, an observation payload or an assessment body.
export type TrialWorkflowState = 'legacy_accepted' | 'accepted' | 'scheduled' | 'completed' | 'cancelled';
export type TrialAttendanceState = 'attended' | 'partial' | 'no_show' | 'club_cancelled' | 'player_withdrew';
export interface TrialSessionView {
  id: string; kind: string; startsAt: number; endsAt: number;
  venue: { name: string; town: string | null; address?: string | null } | null;
  instructions?: string | null;
  attendance: { state: TrialAttendanceState | 'not_recorded'; source: string | null; recordedAt: number | null };
  evidence?: { id: string; kind: string; sessionId: string; linkedAt: number }[];
}
export interface TrialScheduleView {
  legacy: boolean; timezone: string | null; revision: number; confirmedAt: number | null; confirmedBy: { kind: string } | null;
  proposedAt: number | null; awaitingConfirmation: boolean; declinedAt?: number | null; sessions: TrialSessionView[];
  proposedDate?: string | null; venue?: string | null;
}
export interface TrialRevisionView { revision: number; proposedAt: number; proposedBy: { kind: string; name: string | null } | null; confirmedAt: number | null; supersededAt: number | null; reason: string | null; material: boolean | null; sessionCount: number }
export interface TrialAttendanceRecord { sessionId: string; state: TrialAttendanceState; source: string; recordedAt: number; recordedBy: { name: string | null } | null; note: string | null }
export interface TrialHistoryEntry { id: string; at: number; action: string; by: { kind: string | null; name: string | null } | null; detail: Record<string, unknown> | null }
export interface TrialClubView {
  id: string; caseId: string | null; requestId: string | null; playerId: string; playerName: string | null; orgId: string;
  workflowState: TrialWorkflowState; workflowLabel: string; legacy: boolean;
  reportStatus: 'awaiting_report' | 'reported'; reportDueAt: number | null; hasReport: boolean;
  acceptedAt: number | null; acceptedBy: string | null; guardianApproved: boolean | null;
  proposedDate: string | null; venue: string | null;
  schedule: TrialScheduleView | null;
  revisions: TrialRevisionView[];
  attendanceHistory: TrialAttendanceRecord[];
  completion: { state: 'completed' | 'cancelled'; at: number; by: { kind: string; name: string | null } | null; reason: string | null; phase: string | null; cancelledBy: string | null } | null;
  recipient: { type: 'player' | 'guardian'; minor: boolean } | null;
  subjectRemovedAt: number | null;
  evidenceCount: number;
  history: TrialHistoryEntry[];
  rev: number; revAt: number | null; policyVersion: number;
}
export interface TrialInvitationView {
  id: string; status: 'pending' | 'accepted' | 'declined' | string; createdAt: number; respondedAt: number | null; respondedBy: string | null;
  routedTo: string | null; trialId: string | null;
  slots: { id: string; day: string; startsAt: number; endsAt: number; timezone: string; kind: string | null; venue: { name: string; town: string | null } | null }[];
  proposedDate: string | null; altSlots: string[];
}
export interface TrialList {
  items: TrialClubView[]; omitted: number;
  routing: ContactRouting;
  invitation: TrialInvitationView | null;
  case: { status: string; acceptsInvitation: boolean; planAction: string };
  canWrite: boolean; canAssess: boolean; blocked: boolean;
  limits: { sessions: number; slots: number; instructions: number; venueName: number; venueTown: number; venueAddress: number; reason: number; note: number; message: number; clientKey: number; evidencePerSession: number; minSessionMs: number; maxSessionMs: number; revisions: number };
  vocabulary: { workflowStates: TrialWorkflowState[]; sessionKinds: string[]; attendanceStates: TrialAttendanceState[] };
  policyVersion: number; note: string;
}
export interface TrialEvidenceView {
  id: string; kind: string; trialSessionId: string; linkedAt: number; linkedBy: { name: string | null }; removedAt: number | null;
  provenance: string; combineVerified: boolean; combineVerifiedBlockedBy: string;
  session: { id: string; drillId: string | null; protocolId: string | null; capturedAt: number | null; verificationState: string | null; simulated: boolean; invalidated: boolean } | null;
  observation: { state: string; copy: string; qualityState: string | null; experimental: { status: string } | null };
  providerVersion: string | null; engineVersion: string | null; cvPolicyVersion: string | null;
}
export interface TrialEvidenceCandidate { id: string; drillId: string | null; protocolId: string | null; capturedAt: number | null; verificationState: string | null; simulated: boolean; linked: boolean }
export interface TrialAssessmentLine { id: string; state: string; scoutName: string; scoutUserId: string; submittedAt: number | null; trialSessionId: string | null; published: boolean }
export interface TrialDetail { trial: TrialClubView; evidence: TrialEvidenceView[]; assessments: TrialAssessmentLine[]; canWrite: boolean; canAssess: boolean; blocked: boolean }
export interface TrialSessionInput { id?: string; kind?: string; startsAt: number; endsAt: number; venue: { name: string; town?: string | null; address?: string | null }; instructions?: string | null }
export type TrialCaseMove = { from: string; to: string } | { unchanged: true; status: string; reason?: string | null };

export interface RoomsApi {
  list(s: Session, params?: RoomListParams): Promise<RoomListResult>;
  needsAttention(s: Session): Promise<{ items: RoomAttentionItem[]; note: string }>;
  summaries(s: Session, playerIds: string[]): Promise<{ items: RoomSummaryRow[] }>;
  create(s: Session, input: CreateRoomInput): Promise<CreateRoomResult>;
  get(s: Session, roomId: string): Promise<Room>;
  patch(s: Session, roomId: string, input: PatchRoomInput): Promise<Room>;
  setStatus(s: Session, roomId: string, input: { status: string; reasonCodes?: string[]; note?: string | null; expectedRev?: number }): Promise<{ room: Room; snapshot: RoomSnapshot | null }>;
  activity(s: Session, roomId: string, params?: { limit?: number; cursor?: string | null }): Promise<RoomActivityResult>;
  comments(s: Session, roomId: string, params?: { limit?: number; cursor?: string | null }): Promise<RoomCommentsResult>;
  addComment(s: Session, roomId: string, input: { body: string; replyToId?: string | null; mentions?: string[] }): Promise<RoomComment>;
  editComment(s: Session, roomId: string, commentId: string, body: string): Promise<RoomComment>;
  deleteComment(s: Session, roomId: string, commentId: string): Promise<RoomComment>;
  createTask(s: Session, roomId: string, input: { title: string; description?: string | null; assigneeUserId?: string | null; dueAt?: string | null; linkedResourceType?: string | null; linkedResourceId?: string | null }): Promise<RoomTask>;
  updateTask(s: Session, roomId: string, taskId: string, input: { status?: string; assigneeUserId?: string | null }): Promise<RoomTask>;
  decisions(s: Session, roomId: string): Promise<RoomDecisionsResult>;
  recordDecision(s: Session, roomId: string, input: { recommendation: string; reasonCodes?: string[]; note?: string | null; clientKey?: string; expectedRev?: number }): Promise<{ decision: RoomDecision; snapshot: RoomSnapshot | null }>;
  snapshots(s: Session, roomId: string): Promise<{ items: RoomSnapshot[] }>;
  reviewEvidence(s: Session, roomId: string, evidenceId: string, input: { state: string; note?: string | null }): Promise<{ review: { evidenceId: string; state: string; note: string | null; by: string | null; at: number }; note: string }>;
  assignAssessment(s: Session, roomId: string, input: { userId: string; kind?: string; dueAt?: string | null }): Promise<{ assignment: { id: string; userId: string; name: string; task: string; dueAt: string | null; status: string; createdAt: number } }>;
  /** Bridges to the M13 engine. There is deliberately NO free-text field. */
  requestEvidence(s: Session, roomId: string, suggestionId: string): Promise<{ suggestion: RoomMissingEvidence; routedTo: string; note: string }>;
  requestCombine(s: Session, roomId: string, input: { protocolIds: string[]; title?: string | null; deadline?: string | null; instructions?: string | null }): Promise<{ request: RoomCombineRequest }>;
  link(s: Session, roomId: string, input: { trialId?: string; signingId?: string; requestId?: string }): Promise<{ links: Room['links'] }>;
  // M23 P3 — Contact. Page-local to the Room; there is no top-level surface.
  contacts(s: Session, roomId: string): Promise<ContactList>;
  createContact(s: Session, roomId: string, input: { subject?: string | null; body: string; clientKey?: string }): Promise<{ contact: ContactRecord; routing: ContactRouting }>;
  patchContact(s: Session, roomId: string, contactId: string, input: { subject?: string | null; body?: string; expectedRev: number }): Promise<{ contact: ContactRecord; routing: ContactRouting }>;
  sendContact(s: Session, roomId: string, contactId: string, input: { expectedRev: number; clientKey?: string }): Promise<{ contact: ContactRecord; delivered: boolean; case?: ContactCaseMove; idempotent?: boolean }>;
  cancelContact(s: Session, roomId: string, contactId: string, input: { expectedRev: number }): Promise<{ contact: ContactRecord }>;
  recordExternalContact(s: Session, roomId: string, input: { channel: string; occurredAt: number | string; summary?: string | null; recipientType: 'player' | 'guardian'; clientKey?: string }): Promise<{ contact: ContactRecord; case?: ContactCaseMove; idempotent?: boolean }>;
  // M23 P4B — Trial. Page-local to the Room, plus the existing Trials & Reports list.
  trials(s: Session, roomId: string): Promise<TrialList>;
  trial(s: Session, roomId: string, trialId: string): Promise<TrialDetail>;
  inviteTrial(s: Session, roomId: string, input: { timezone: string; venue: { name: string; town?: string | null; address?: string | null }; message: string; instructions?: string | null; slots: { startsAt: number; endsAt: number; kind?: string }[]; clientKey?: string }): Promise<{ invitation: TrialInvitationView; routing: ContactRouting; case: TrialCaseMove; idempotent?: boolean }>;
  scheduleTrial(s: Session, roomId: string, trialId: string, input: { timezone: string; sessions: TrialSessionInput[]; reason?: string | null; expectedRev: number; clientKey?: string }): Promise<{ trial: TrialClubView; requiresConfirmation?: boolean; material?: boolean; idempotent?: boolean }>;
  cancelTrial(s: Session, roomId: string, trialId: string, input: { reason: string; expectedRev: number; clientKey?: string }): Promise<{ trial: TrialClubView; idempotent?: boolean }>;
  recordTrialAttendance(s: Session, roomId: string, trialId: string, sessionId: string, input: { state: TrialAttendanceState; note?: string | null; expectedRev: number; clientKey?: string }): Promise<{ trial: TrialClubView; idempotent?: boolean }>;
  completeTrial(s: Session, roomId: string, trialId: string, input: { expectedRev: number; clientKey?: string }): Promise<{ trial: TrialClubView; case: TrialCaseMove; idempotent?: boolean }>;
  trialEvidenceCandidates(s: Session, roomId: string, trialId: string): Promise<{ items: TrialEvidenceCandidate[]; consent: boolean; reason: string | null }>;
  linkTrialEvidence(s: Session, roomId: string, trialId: string, sessionId: string, input: { boxSessionId: string; expectedRev: number; clientKey?: string }): Promise<{ trial: TrialClubView; evidence: TrialEvidenceView[]; idempotent?: boolean }>;
  unlinkTrialEvidence(s: Session, roomId: string, trialId: string, evidenceId: string, input: { expectedRev: number }): Promise<{ trial: TrialClubView; evidence: TrialEvidenceView[]; idempotent?: boolean }>;
  funnel(s: Session): Promise<RoomFunnel>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out.set(k, String(v));
  const s = out.toString();
  return s ? `?${s}` : '';
};

export const httpRooms: RoomsApi = {
  list: (s, params = {}) => req(`/org/rooms${qs({ ...params })}`, { headers: H(s) }),
  needsAttention: (s) => req('/org/rooms/needs-attention', { headers: H(s) }),
  summaries: (s, playerIds) => req(`/org/rooms/summaries?playerIds=${encodeURIComponent(playerIds.slice(0, 100).join(','))}`, { headers: H(s) }),
  create: async (s, input) => {
    // 409 ROOM_EXISTS is a routing answer, not a failure: it carries the id of
    // the room the organisation already has, so the caller opens that one.
    const res = await fetch(`${API_URL}/org/rooms`, { method: 'POST', headers: H(s), body: JSON.stringify(input) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body?.error === 'ROOM_EXISTS') {
      return { ok: false, error: 'ROOM_EXISTS', existingRoomId: String(body.existingRoomId), status: String(body.status ?? '') };
    }
    if (!res.ok) throw ApiError.fromResponse(res, body);
    return { ok: true, room: body.room as Room, adoptedExistingCase: !!body.adoptedExistingCase };
  },
  get: async (s, roomId) => (await req<{ room: Room }>(`/org/rooms/${roomId}`, { headers: H(s) })).room,
  patch: async (s, roomId, input) => (await req<{ room: Room }>(`/org/rooms/${roomId}`, { method: 'PATCH', headers: H(s), body: JSON.stringify(input) })).room,
  setStatus: (s, roomId, input) => req(`/org/rooms/${roomId}/status`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  activity: (s, roomId, params = {}) => req(`/org/rooms/${roomId}/activity${qs({ limit: params.limit, cursor: params.cursor })}`, { headers: H(s) }),
  comments: (s, roomId, params = {}) => req(`/org/rooms/${roomId}/comments${qs({ limit: params.limit, cursor: params.cursor })}`, { headers: H(s) }),
  addComment: async (s, roomId, input) => (await req<{ comment: RoomComment }>(`/org/rooms/${roomId}/comments`, { method: 'POST', headers: H(s), body: JSON.stringify(input) })).comment,
  editComment: async (s, roomId, commentId, body) => (await req<{ comment: RoomComment }>(`/org/rooms/${roomId}/comments/${commentId}`, { method: 'PATCH', headers: H(s), body: JSON.stringify({ body }) })).comment,
  deleteComment: async (s, roomId, commentId) => (await req<{ comment: RoomComment }>(`/org/rooms/${roomId}/comments/${commentId}`, { method: 'DELETE', headers: H(s) })).comment,
  createTask: async (s, roomId, input) => (await req<{ task: RoomTask }>(`/org/rooms/${roomId}/tasks`, { method: 'POST', headers: H(s), body: JSON.stringify(input) })).task,
  updateTask: async (s, roomId, taskId, input) => (await req<{ task: RoomTask }>(`/org/rooms/${roomId}/tasks/${taskId}`, { method: 'PATCH', headers: H(s), body: JSON.stringify(input) })).task,
  decisions: (s, roomId) => req(`/org/rooms/${roomId}/decisions`, { headers: H(s) }),
  recordDecision: (s, roomId, input) => req(`/org/rooms/${roomId}/decisions`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  snapshots: (s, roomId) => req(`/org/rooms/${roomId}/snapshots`, { headers: H(s) }),
  reviewEvidence: (s, roomId, evidenceId, input) => req(`/org/rooms/${roomId}/evidence/${evidenceId}/review`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  assignAssessment: (s, roomId, input) => req(`/org/rooms/${roomId}/assessment-assignments`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  requestEvidence: (s, roomId, suggestionId) => req(`/org/rooms/${roomId}/evidence-requests`, { method: 'POST', headers: H(s), body: JSON.stringify({ suggestionId }) }),
  requestCombine: (s, roomId, input) => req(`/org/rooms/${roomId}/combine-requests`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  link: (s, roomId, input) => req(`/org/rooms/${roomId}/link`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  contacts: (s, roomId) => req(`/org/rooms/${roomId}/contacts`, { headers: H(s) }),
  createContact: (s, roomId, input) => req(`/org/rooms/${roomId}/contacts`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  patchContact: (s, roomId, contactId, input) => req(`/org/rooms/${roomId}/contacts/${contactId}`, { method: 'PATCH', headers: H(s), body: JSON.stringify(input) }),
  sendContact: (s, roomId, contactId, input) => req(`/org/rooms/${roomId}/contacts/${contactId}/send`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  cancelContact: (s, roomId, contactId, input) => req(`/org/rooms/${roomId}/contacts/${contactId}/cancel`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  recordExternalContact: (s, roomId, input) => req(`/org/rooms/${roomId}/contacts/external`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  trials: (s, roomId) => req(`/org/rooms/${roomId}/trials`, { headers: H(s) }),
  trial: (s, roomId, trialId) => req(`/org/rooms/${roomId}/trials/${trialId}`, { headers: H(s) }),
  inviteTrial: (s, roomId, input) => req(`/org/rooms/${roomId}/trials`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  scheduleTrial: (s, roomId, trialId, input) => req(`/org/rooms/${roomId}/trials/${trialId}/reschedule`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  cancelTrial: (s, roomId, trialId, input) => req(`/org/rooms/${roomId}/trials/${trialId}/cancel`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  recordTrialAttendance: (s, roomId, trialId, sessionId, input) => req(`/org/rooms/${roomId}/trials/${trialId}/sessions/${sessionId}/attendance`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  completeTrial: (s, roomId, trialId, input) => req(`/org/rooms/${roomId}/trials/${trialId}/complete`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  trialEvidenceCandidates: (s, roomId, trialId) => req(`/org/rooms/${roomId}/trials/${trialId}/evidence/candidates`, { headers: H(s) }),
  linkTrialEvidence: (s, roomId, trialId, sessionId, input) => req(`/org/rooms/${roomId}/trials/${trialId}/sessions/${sessionId}/evidence`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  unlinkTrialEvidence: (s, roomId, trialId, evidenceId, input) => req(`/org/rooms/${roomId}/trials/${trialId}/evidence/${evidenceId}/unlink`, { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  funnel: (s) => req('/org/rooms-funnel', { headers: H(s) }),
};

export const rooms: RoomsApi = DEMO_MODE ? demoRooms : httpRooms;
