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
export interface FamilyTrial {
  id: string; playerId: string; playerName: string; orgName: string; proposedDate: string | null; venue: string | null;
  staff: { name: string; role: string; check: { kind: string | null; status: string } }[];
  arrival: { time: string | null; address: string | null; notes: string | null } | null;
  consents: { byKind: string; scope: string }[]; checkins: { at: number }[];
  cancelled: boolean; statusEvents: { kind: string; reason: string; newDate: string | null }[];
}
export interface SafetyPack {
  trial: FamilyTrial;
  pack: { headline: string; checksExplained: string; arrival: FamilyTrial['arrival']; collection: { policy: string } | null; emergencySet: boolean; reportRoute: string; feedbackDue: string | null; staff: FamilyTrial['staff'] };
}
export interface SquadInvite { id: string; orgName: string; playerName: string; note: string | null; status: string }
export interface FollowUpView { id: string; playerId: string; orgName: string; milestone: string; dueAt: number; outcomeState: string; report: { registrationStatus: string; matchesPlayed: number | null; progression: string | null } | null }
export interface UploadSession { id: string; chunkSize: number; totalChunks: number; received: number[]; status: string; finalisedMediaId: string | null }

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
  gGiveTrialConsent(guardianId: string, trialId: string): Promise<void>;
  gSetEmergencyContact(guardianId: string, trialId: string, name: string, phone: string): Promise<void>;
  gSafetyPack(guardianId: string, trialId: string): Promise<SafetyPack>;
  gSquadInvites(guardianId: string): Promise<SquadInvite[]>;
  gRespondSquadInvite(guardianId: string, inviteId: string, accept: boolean): Promise<void>;
  gFollowUps(guardianId: string): Promise<FollowUpView[]>;
  gRespondFollowUp(guardianId: string, followUpId: string, agree: boolean, note?: string): Promise<void>;
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
  gGiveTrialConsent: (gid, tid) => post(`/guardian/trials/${tid}/consent`, gid),
  gSetEmergencyContact: (gid, tid, name, phone) => post(`/guardian/trials/${tid}/emergency-contact`, gid, { name, phone }),
  gSafetyPack: (gid, tid) => req(`/guardian/trials/${tid}/safety-pack`, gid),
  gSquadInvites: (gid) => req('/guardian/squad-invites', gid),
  gRespondSquadInvite: (gid, iid, accept) => post(`/guardian/squad-invites/${iid}/respond`, gid, { accept }),
  gFollowUps: (gid) => req('/guardian/followups', gid),
  gRespondFollowUp: (gid, fid, agree, note) => post(`/guardian/followups/${fid}/respond`, gid, { agree, note }),
};

export const m12: PlayerM12 = DEMO ? m12mock : live;
