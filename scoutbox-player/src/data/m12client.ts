// M12 player/guardian data surface: evidence passport, published feedback,
// development objectives, opportunity board, campaigns, trial safety packs,
// squad invites, post-signing follow-ups, resumable uploads, captions.
// Live implementation shares httpClient's bearer tokens; the demo mirror
// lives in m12mock.ts and is selected by the same EXPO_PUBLIC_DEMO flag.
import { m12Request as req } from './httpClient';
import { m12mock } from './m12mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export interface EvidenceRec {
  id: string; claimType: string; label: string; value: number | string | null; units: string | null; season: string | null;
  verification: { status: string; method: string | null; reviewerName: string | null };
  recordedAt: number; superseded?: boolean; correctionOf?: string | null; openDisputes?: number;
  freshness?: { ageDays: number; fresh: boolean };
}
export interface PassportView {
  records: EvidenceRec[];
  legacy: { kind: string; label: string; tier: string; method: string; caveat?: string }[];
  summary: { activeRecords: number; corroborated: number; insufficient: boolean; note: string };
}
export interface FeedbackItem { id: string; orgName: string; byName: string; text: string; at: number }
export interface ObjectiveRec {
  id: string; playerId: string; orgId: string;
  reviewer: { name: string; orgName?: string };
  objectives: { id: string; text: string }[];
  progress: { at: number; note: string | null }[];
  sharing: { orgIds: string[] };
  reassessments: { id: string; status: string; outcome: { note: string; byName?: string } | null }[];
  status: string;
}
export interface BoardItem {
  id: string; via?: string; type: string; title: string; orgName: string; deadline: string;
  schedule?: string | null; category?: string; requirements?: string[]; distance?: string | null;
  applied: { id?: string; status: string } | null; description?: string | null;
}
export interface ApplicationRec { id: string; status: string; outcome: { decision: string; note: string | null } | null; opportunity: { title?: string; orgName?: string } }
export interface CampaignView {
  id: string; title: string; orgName: string; deadline: string; attemptsAllowed: number;
  drills: { name: string; instructions: string; recording: Record<string, string> }[];
  mySubmission: { attempts: { id: string; drillName: string; status: string; fileChecks: { passed: boolean; issues: string[] }; review: { reasons: string | null; kind?: string } | null }[] } | null;
}
// M23 P4B — the family's view of the Trial workflow (the shared operational
// edge): state, the confirmed sessions with the address and instructions,
// whether a revision awaits their answer, and the completion state. Never a
// case id, a note, an observation or an assessment. A minor's own device
// receives the outcome line only.
export type TrialWorkflowState = 'legacy_accepted' | 'accepted' | 'scheduled' | 'completed' | 'cancelled';
export interface FamilyTrialSession {
  id: string; kind: string; startsAt: number; endsAt: number;
  venue: { name: string; town: string | null; address?: string | null } | null;
  instructions?: string | null;
  attendance: { state: string; source: string | null; recordedAt: number | null };
}
export interface FamilyTrialWorkflow {
  id: string; orgId: string; orgName: string | null; playerId: string;
  workflowState: TrialWorkflowState; workflowLabel: string; legacy: boolean;
  acceptedAt: number | null; proposedDate: string | null; venue: string | null;
  schedule: { legacy: boolean; timezone: string | null; revision: number; confirmedAt: number | null; awaitingConfirmation: boolean; declinedAt?: number | null; sessions: FamilyTrialSession[]; proposedDate?: string | null; venue?: string | null } | null;
  awaitingYourConfirmation: boolean;
  completion: { state: 'completed' | 'cancelled'; at: number; byKind: string | null; reason: string | null } | null;
  reportStatus: string; hasReport: boolean; rev: number;
}
export interface TrialOutcomeLine { id: string; orgName: string | null; workflowState: TrialWorkflowState; workflowLabel: string; guardianManaged: true }
export const isOutcomeLine = (w: FamilyTrialWorkflow | TrialOutcomeLine | null | undefined): w is TrialOutcomeLine => !!w && 'guardianManaged' in w && w.guardianManaged === true;
export interface FamilyTrial {
  id: string; playerId: string; playerName: string; orgName: string; proposedDate: string | null; venue: string | null;
  staff: { name: string; role: string; check: { kind: string | null; status: string } }[];
  arrival: { time: string | null; address: string | null; notes: string | null } | null;
  consents: { byKind: string; scope: string }[]; checkins: { at: number }[];
  cancelled: boolean; statusEvents: { kind: string; reason: string; newDate: string | null }[];
  workflow?: FamilyTrialWorkflow | TrialOutcomeLine | null;
}
export interface SafetyPack {
  trial: FamilyTrial;
  pack: { headline: string; checksExplained: string; arrival: FamilyTrial['arrival']; collection: { policy: string } | null; emergencySet: boolean; reportRoute: string; feedbackDue: string | null; staff: FamilyTrial['staff'] };
}
export interface SquadInvite { id: string; orgName: string; playerName: string; note: string | null; status: string }
export interface FollowUpView { id: string; playerId: string; orgName: string; milestone: string; dueAt: number; outcomeState: string; report: { registrationStatus: string; matchesPlayed: number | null; progression: string | null } | null }
export interface UploadSession { id: string; chunkSize: number; totalChunks: number; received: number[]; status: string; finalisedMediaId: string | null }

// M23 P6 — the recipient's view of the canonical Offer: the ISSUED revisions
// exactly as the club issued them, the recipient message, the expiry, the
// documents by their Offer id. Never the club's internal note, never a
// decision or transaction reference. Accepting is the recipient's own act and
// is NOT a signing.
export type OfferStatus = 'DRAFT' | 'ISSUED' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED' | 'SUPERSEDED';
export interface FamilyOfferTerms { offerType: string; role: string | null; squad: string | null; startDate: string | null; endDate: string | null; conditions: string | null }
export interface FamilyOfferRevision {
  id: string; revisionNumber: number; status: OfferStatus; storedStatus: OfferStatus; statusLabel: string | null; terms: FamilyOfferTerms;
  recipientMessage: string | null; documents: { id: string; label: string | null }[]; expiresAt: number | null; issuedAt: number | null; createdAt: number | null;
  supersedesRevisionId: string | null; supersededByRevisionId: string | null; withdrawnAt: number | null; respondedAt: number | null; rev: number;
}
export interface FamilyOfferResponse { id: string; revisionId: string; responseType: 'accepted' | 'declined'; actorType: 'player' | 'guardian'; occurredAt: number }
export interface FamilyOffer {
  id: string; playerId: string; playerName?: string | null; club: { id: string; name: string | null }; type: string; status: OfferStatus | null; statusLabel: string | null;
  currentRevisionId: string | null; currentRevision: FamilyOfferRevision | null; revisions: FamilyOfferRevision[]; awaitingYourResponse: boolean; answerable?: boolean; notAnswerableReason?: string | null;
  responses: FamilyOfferResponse[]; agentShared: boolean; policyVersion: number; honest: string;
}
export interface FamilyOfferHistory { id: string; at: number; action: string; by: { kind: string | null; name: string | null } | null; revisionId: string | null }
export interface OfferAnswerResult { offer: FamilyOffer; lifecycle: unknown; signing?: { created: false; note: string }; idempotent?: boolean }
export interface OfferDocumentFile { document: { id: string; label: string | null; mime: string | null; bytes: number | null; filename: string | null }; file: { mime: string; base64: string } | null }

export interface PlayerM12 {
  getPassport(playerId: string): Promise<PassportView>;
  addEvidence(playerId: string, input: { claimType: string; label: string; value?: number | string; units?: string; season?: string }): Promise<void>;
  correctEvidence(playerId: string, evidenceId: string, value: number | string, reason: string): Promise<void>;
  getFeedback(playerId: string): Promise<{ guardianManaged?: boolean; count?: number; items: FeedbackItem[] }>;
  getObjectives(playerId: string): Promise<ObjectiveRec[]>;
  createObjective(playerId: string, feedbackId: string, texts: string[]): Promise<void>;
  addObjectiveProgress(playerId: string, objectiveId: string, note: string): Promise<void>;
  shareObjective(playerId: string, objectiveId: string, orgId: string, enabled: boolean): Promise<void>;
  requestReassessment(playerId: string, objectiveId: string): Promise<void>;
  getBoard(playerId: string): Promise<{ items: BoardItem[]; minor?: boolean; note?: string | null }>;
  applyToOpportunity(playerId: string, opportunityId: string, note?: string): Promise<void>;
  withdrawApplication(playerId: string, applicationId: string): Promise<void>;
  myApplications(playerId: string): Promise<ApplicationRec[]>;
  getCampaigns(playerId: string): Promise<CampaignView[]>;
  submitCampaignAttempt(playerId: string, campaignId: string, mediaId: string | undefined, drillName: string, note?: string): Promise<{ status: string; issues: string[]; note: string }>;
  getTrials(playerId: string): Promise<FamilyTrial[]>;
  confirmTrialSchedule(playerId: string, trialId: string): Promise<FamilyTrialWorkflow>;
  declineTrialSchedule(playerId: string, trialId: string, reason?: string): Promise<FamilyTrialWorkflow>;
  cancelTrial(playerId: string, trialId: string, reason?: string): Promise<FamilyTrialWorkflow>;
  giveTrialConsent(playerId: string, trialId: string): Promise<void>;
  setEmergencyContact(playerId: string, trialId: string, name: string, phone: string): Promise<void>;
  getSafetyPack(playerId: string, trialId: string): Promise<SafetyPack>;
  getSquadInvites(playerId: string): Promise<SquadInvite[]>;
  respondSquadInvite(playerId: string, inviteId: string, accept: boolean): Promise<void>;
  getFollowUps(playerId: string): Promise<FollowUpView[]>;
  respondFollowUp(playerId: string, followUpId: string, agree: boolean, note?: string, experienceRating?: number): Promise<void>;
  setFootballCategory(playerId: string, category: string | null): Promise<void>;
  setCaptions(playerId: string, mediaId: string, vtt: string): Promise<void>;
  // Resumable uploads (F12A). No success is reported before finalisation.
  startUpload(playerId: string, input: { size: number; mime: string; title: string; sha256?: string }): Promise<UploadSession>;
  putChunk(playerId: string, uploadId: string, index: number, base64: string): Promise<{ received: number; totalChunks: number; complete: boolean }>;
  finaliseUpload(playerId: string, uploadId: string): Promise<{ mediaId: string }>;
  abortUpload(playerId: string, uploadId: string): Promise<void>;

  // Guardian surface — child ids are always explicit, ownership checked server-side.
  gPassport(guardianId: string, childId: string): Promise<PassportView>;
  gAddEvidence(guardianId: string, childId: string, input: { claimType: string; label: string; value?: number | string; units?: string }): Promise<void>;
  gFeedback(guardianId: string, childId: string): Promise<{ items: FeedbackItem[] }>;
  gObjectives(guardianId: string, childId: string): Promise<ObjectiveRec[]>;
  gCreateObjective(guardianId: string, childId: string, feedbackId: string, texts: string[]): Promise<void>;
  gShareObjective(guardianId: string, objectiveId: string, orgId: string, enabled: boolean): Promise<void>;
  gRequestReassessment(guardianId: string, objectiveId: string): Promise<void>;
  gBoard(guardianId: string, childId: string): Promise<{ items: BoardItem[] }>;
  gApply(guardianId: string, childId: string, opportunityId: string, note?: string): Promise<void>;
  gApplications(guardianId: string): Promise<ApplicationRec[]>;
  gCampaigns(guardianId: string, childId: string): Promise<CampaignView[]>;
  gSubmitCampaignAttempt(guardianId: string, childId: string, campaignId: string, mediaId: string | undefined, drillName: string): Promise<{ status: string; issues: string[] }>;
  gTrials(guardianId: string): Promise<FamilyTrial[]>;
  gConfirmTrialSchedule(guardianId: string, trialId: string): Promise<FamilyTrialWorkflow>;
  gDeclineTrialSchedule(guardianId: string, trialId: string, reason?: string): Promise<FamilyTrialWorkflow>;
  gCancelTrial(guardianId: string, trialId: string, reason?: string): Promise<FamilyTrialWorkflow>;
  gGiveTrialConsent(guardianId: string, trialId: string): Promise<void>;
  gSetEmergencyContact(guardianId: string, trialId: string, name: string, phone: string): Promise<void>;
  gSafetyPack(guardianId: string, trialId: string): Promise<SafetyPack>;
  gSquadInvites(guardianId: string): Promise<SquadInvite[]>;
  gRespondSquadInvite(guardianId: string, inviteId: string, accept: boolean): Promise<void>;
  gFollowUps(guardianId: string): Promise<FollowUpView[]>;
  gRespondFollowUp(guardianId: string, followUpId: string, agree: boolean, note?: string): Promise<void>;
  // M23 P6 — Offers, the recipient's side. A guardian route acts only where the server addressed the revision to that guardian.
  getOffers(playerId: string): Promise<FamilyOffer[]>;
  getOffer(playerId: string, offerId: string): Promise<{ offer: FamilyOffer; history: FamilyOfferHistory[] }>;
  acceptOffer(playerId: string, offerId: string, revisionId: string, clientKey: string): Promise<OfferAnswerResult>;
  declineOffer(playerId: string, offerId: string, revisionId: string, clientKey: string, reason?: string): Promise<OfferAnswerResult>;
  shareOfferWithAgent(playerId: string, offerId: string, share: boolean, agreementId?: string): Promise<{ offer: FamilyOffer }>;
  getOfferDocument(playerId: string, offerId: string, docId: string): Promise<OfferDocumentFile>;
  gOffers(guardianId: string): Promise<FamilyOffer[]>;
  gOffer(guardianId: string, offerId: string): Promise<{ offer: FamilyOffer; history: FamilyOfferHistory[] }>;
  gAcceptOffer(guardianId: string, offerId: string, revisionId: string, clientKey: string): Promise<OfferAnswerResult>;
  gDeclineOffer(guardianId: string, offerId: string, revisionId: string, clientKey: string, reason?: string): Promise<OfferAnswerResult>;
  gOfferDocument(guardianId: string, offerId: string, docId: string): Promise<OfferDocumentFile>;
}

const post = (path: string, id: string, body?: unknown, method = 'POST') =>
  req<any>(path, id, { method, body: JSON.stringify(body ?? {}) });

const live: PlayerM12 = {
  getPassport: (pid) => req('/player/passport', pid),
  addEvidence: (pid, input) => post('/player/evidence', pid, input),
  correctEvidence: (pid, eid, value, reason) => post(`/player/evidence/${eid}/correct`, pid, { value, reason }),
  getFeedback: (pid) => req('/player/feedback', pid),
  getObjectives: (pid) => req('/player/objectives', pid),
  createObjective: (pid, feedbackId, texts) => post('/player/objectives', pid, { feedbackId, objectives: texts.map((t) => ({ text: t })) }),
  addObjectiveProgress: (pid, oid, note) => post(`/player/objectives/${oid}/progress`, pid, { note }),
  shareObjective: (pid, oid, orgId, enabled) => post(`/player/objectives/${oid}/share`, pid, { orgId, enabled }),
  requestReassessment: (pid, oid) => post(`/player/objectives/${oid}/reassessment`, pid),
  getBoard: (pid) => req('/player/opportunity-board', pid),
  applyToOpportunity: (pid, oid, note) => post(`/player/opportunities/${oid}/apply`, pid, { note }),
  withdrawApplication: (pid, aid) => post(`/player/applications/${aid}/withdraw`, pid),
  myApplications: (pid) => req('/player/applications', pid),
  getCampaigns: async (pid) => (await req<{ items: CampaignView[] }>('/player/campaigns', pid)).items,
  submitCampaignAttempt: async (pid, cid, mediaId, drillName, note) => {
    const r = await post(`/player/campaigns/${cid}/submit`, pid, { mediaId, drillName, note });
    return { status: r.attempt.status, issues: r.attempt.fileChecks.issues, note: r.note };
  },
  getTrials: (pid) => req('/player/trials', pid),
  confirmTrialSchedule: async (pid, tid) => (await post(`/player/trials/${tid}/confirm-schedule`, pid)).trial,
  declineTrialSchedule: async (pid, tid, reason) => (await post(`/player/trials/${tid}/decline-schedule`, pid, reason ? { reason } : {})).trial,
  cancelTrial: async (pid, tid, reason) => (await post(`/player/trials/${tid}/cancel`, pid, reason ? { reason } : {})).trial,
  giveTrialConsent: (pid, tid) => post(`/player/trials/${tid}/consent`, pid),
  setEmergencyContact: (pid, tid, name, phone) => post(`/player/trials/${tid}/emergency-contact`, pid, { name, phone }),
  getSafetyPack: (pid, tid) => req(`/player/trials/${tid}/safety-pack`, pid),
  getSquadInvites: (pid) => req('/player/squad-invites', pid),
  respondSquadInvite: (pid, iid, accept) => post(`/player/squad-invites/${iid}/respond`, pid, { accept }),
  getFollowUps: (pid) => req('/player/followups', pid),
  respondFollowUp: (pid, fid, agree, note, experienceRating) => post(`/player/followups/${fid}/respond`, pid, { agree, note, experienceRating }),
  setFootballCategory: (pid, category) => post('/player/football-category', pid, { category }),
  setCaptions: (pid, mid, vtt) => post(`/player/media/${mid}/captions`, pid, { vtt }),
  startUpload: async (pid, input) => (await post('/player/uploads', pid, input)).upload,
  putChunk: (pid, uid, index, base64) => post(`/player/uploads/${uid}/chunks/${index}`, pid, { data: base64 }, 'PUT'),
  finaliseUpload: async (pid, uid) => {
    const r = await post(`/player/uploads/${uid}/finalise`, pid);
    return { mediaId: r.media.id };
  },
  abortUpload: (pid, uid) => post(`/player/uploads/${uid}/abort`, pid),

  gPassport: (gid, cid) => req(`/guardian/children/${cid}/passport`, gid),
  gAddEvidence: (gid, cid, input) => post(`/guardian/children/${cid}/evidence`, gid, input),
  gFeedback: (gid, cid) => req(`/guardian/children/${cid}/feedback`, gid),
  gObjectives: (gid, cid) => req(`/guardian/children/${cid}/objectives`, gid),
  gCreateObjective: (gid, cid, feedbackId, texts) => post(`/guardian/children/${cid}/objectives`, gid, { feedbackId, objectives: texts.map((t) => ({ text: t })) }),
  gShareObjective: (gid, oid, orgId, enabled) => post(`/guardian/objectives/${oid}/share`, gid, { orgId, enabled }),
  gRequestReassessment: (gid, oid) => post(`/guardian/objectives/${oid}/reassessment`, gid),
  gBoard: (gid, cid) => req(`/guardian/children/${cid}/opportunity-board`, gid),
  gApply: (gid, cid, oid, note) => post(`/guardian/children/${cid}/opportunities/${oid}/apply`, gid, { note }),
  gApplications: (gid) => req('/guardian/applications', gid),
  gCampaigns: async (gid, cid) => (await req<{ items: CampaignView[] }>(`/guardian/children/${cid}/campaigns`, gid)).items,
  gSubmitCampaignAttempt: async (gid, cid, campId, mediaId, drillName) => {
    const r = await post(`/guardian/children/${cid}/campaigns/${campId}/submit`, gid, { mediaId, drillName });
    return { status: r.attempt.status, issues: r.attempt.fileChecks.issues };
  },
  gTrials: (gid) => req('/guardian/trials', gid),
  gConfirmTrialSchedule: async (gid, tid) => (await post(`/guardian/trials/${tid}/confirm-schedule`, gid)).trial,
  gDeclineTrialSchedule: async (gid, tid, reason) => (await post(`/guardian/trials/${tid}/decline-schedule`, gid, reason ? { reason } : {})).trial,
  gCancelTrial: async (gid, tid, reason) => (await post(`/guardian/trials/${tid}/cancel`, gid, reason ? { reason } : {})).trial,
  gGiveTrialConsent: (gid, tid) => post(`/guardian/trials/${tid}/consent`, gid),
  gSetEmergencyContact: (gid, tid, name, phone) => post(`/guardian/trials/${tid}/emergency-contact`, gid, { name, phone }),
  gSafetyPack: (gid, tid) => req(`/guardian/trials/${tid}/safety-pack`, gid),
  gSquadInvites: (gid) => req('/guardian/squad-invites', gid),
  gRespondSquadInvite: (gid, iid, accept) => post(`/guardian/squad-invites/${iid}/respond`, gid, { accept }),
  gFollowUps: (gid) => req('/guardian/followups', gid),
  gRespondFollowUp: (gid, fid, agree, note) => post(`/guardian/followups/${fid}/respond`, gid, { agree, note }),
  // ---- M23 P6
  getOffers: async (pid) => (await req<{ items: FamilyOffer[] }>('/player/offers', pid)).items,
  getOffer: (pid, oid) => req(`/player/offers/${oid}`, pid),
  acceptOffer: (pid, oid, revisionId, clientKey) => post(`/player/offers/${oid}/accept`, pid, { revisionId, clientKey }),
  declineOffer: (pid, oid, revisionId, clientKey, reason) => post(`/player/offers/${oid}/decline`, pid, { revisionId, clientKey, ...(reason ? { reason } : {}) }),
  shareOfferWithAgent: (pid, oid, share, agreementId) => post(`/player/offers/${oid}/share-agent`, pid, { share, ...(agreementId ? { agreementId } : {}) }),
  getOfferDocument: (pid, oid, docId) => req(`/player/offers/${oid}/documents/${docId}`, pid),
  gOffers: async (gid) => (await req<{ items: FamilyOffer[] }>('/guardian/offers', gid)).items,
  gOffer: (gid, oid) => req(`/guardian/offers/${oid}`, gid),
  gAcceptOffer: (gid, oid, revisionId, clientKey) => post(`/guardian/offers/${oid}/accept`, gid, { revisionId, clientKey }),
  gDeclineOffer: (gid, oid, revisionId, clientKey, reason) => post(`/guardian/offers/${oid}/decline`, gid, { revisionId, clientKey, ...(reason ? { reason } : {}) }),
  gOfferDocument: (gid, oid, docId) => req(`/guardian/offers/${oid}/documents/${docId}`, gid),
};

export const m12: PlayerM12 = DEMO ? m12mock : live;
