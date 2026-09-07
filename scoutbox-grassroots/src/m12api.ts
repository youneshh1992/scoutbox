// M12 typed client (org side): evidence passport, assessments, video
// workspace, recruitment cases, tactical fit, opportunities, campaigns,
// development follow-up, trial days, outcomes, coach affiliations.
// Same live/demo split as api.ts: VITE_DEMO=1 selects the in-browser mirror.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM12 } from './m12demo';

export interface EvidenceRecord {
  id: string; playerId: string; claimType: string; label: string;
  value: number | string | null; units: string | null; season: string | null;
  source: { kind: string; id: string; name: string };
  observedAt: number | null; recordedAt: number;
  verification: { status: string; method: string | null; reviewerName: string | null; reviewedAt: number | null };
  freshness?: { ageDays: number; fresh: boolean };
  superseded?: boolean; supersededBy?: string | null; correctionOf?: string | null;
  openDisputes?: number; expired?: boolean; note?: string | null;
}
export interface Passport {
  records: EvidenceRecord[];
  legacy: { kind: string; label: string; tier: string; method: string; caveat?: string; conflictOfInterest?: string | null }[];
  summary: { activeRecords: number; byTier: Record<string, number>; corroborated: number; insufficient: boolean; note: string };
}
export interface AssessmentAttr { id: string; label: string; anchors: Record<string, string> }
export interface AssessmentRating { attrId: string; rating: number | null; notObserved: boolean; confidence: string; note?: string | null; evidenceRefs: { segmentId?: string }[] }
export interface Assessment {
  id: string; playerId: string; playerName: string; scoutUserId: string; scoutName: string;
  templateId: string; templateVersion: number; attributesSnapshot: AssessmentAttr[];
  context: { fixture?: string | null; date?: string | null; minutesWatched?: number | null; viewing?: string | null; opponentLevel?: string | null };
  ratings: AssessmentRating[]; state: 'draft' | 'submitted' | 'reviewed' | 'published';
  recommendation: { verdict: string; reasons: string } | null;
  secondOpinionOf: string | null; createdAt: number; submittedAt: number | null;
  publishedFeedback: { text: string; byName: string; at: number } | null;
}
export interface CompareResult {
  assessments: { id: string; scoutName: string; submittedAt: number; recommendation: Assessment['recommendation']; templateVersion: number }[];
  attributes: { attrId: string; label: string; observedCount: number; average: number | null; cells: { scoutName: string; rating: number | null; notObserved: boolean; confidence: string | null }[] }[];
  sameScale?: boolean; note: string;
}
export interface Segment { id: string; mediaId: string; playerId: string; startS: number; endS: number; labels: string[]; eventType: string | null; note: string | null; createdBy: { name: string }; createdAt: number; mediaUrl?: string }
export interface Playlist { id: string; name: string; segmentIds: string[] }
export interface CaseRec {
  id: string; playerId: string; playerName: string; vacancyId: string | null; ownerUserId: string; ownerName: string;
  stage: string; priority: string; deadline: string | null; restricted: boolean;
  assignments: { id: string; userId: string; name: string; task: string; dueAt: string | null; status: string }[];
  tasks: { id: string; title: string; dueAt: string | null; status: string; completedBy?: string }[];
  approvals: { id: string; decision: { outcome: string; reasons: string }; requestedBy: { name: string }; status: string }[];
  decision: { outcome: string; reasons: string; byName: string; approvedBy?: string; at: number } | null;
  links: { requestIds: string[]; trialIds: string[]; signingId: string | null };
  history: { at: number; byName: string; action: string; detail: string | null }[];
  createdAt: number;
}
export interface StaffRow { id: string; name: string; role: string; lead: boolean; removedAt: number | null }
export interface Criterion { key: string; value: unknown; verdict?: 'met' | 'not_met' | 'unknown'; source?: string }
export interface TacticalRole { id: string; name: string; positionGroup: string; description: string; category?: string; required: Criterion[]; preferred: Criterion[] }
export interface Tactical { formation: string; planningHorizon: string | null; windows: { name: string; opens: string | null; closes: string | null }[]; roles: TacticalRole[] }
export interface Vacancy { id: string; roleId: string; roleName: string; status: string; notes: string | null; createdAt: number }
export interface Candidate { playerId: string; name: string; position: string; age: number; required: Criterion[]; preferred: Criterion[]; requiredMet: number; requiredTotal: number; unknowns: number; onSquad: boolean; caseId: string | null }
export interface Opportunity {
  id: string; type: string; title: string; team: string | null; category: string; ageGroup: string | null; role: string | null;
  description: string | null; schedule: string | null; deadline: string; capacity: number | null;
  eligibility: { minAge: number | null; maxAge: number | null; positionGroup: string; radiusKm: number | null };
  requirements: string[]; status: string; open?: boolean; applications?: number; outstanding?: number;
}
export interface Application { id: string; playerId: string; playerName: string; status: string; note: string | null; outcome: { decision: string; note: string | null; byName: string } | null; submittedBy: { kind: string; name: string }; createdAt: number }
export interface Campaign {
  id: string; title: string; deadline: string; attemptsAllowed: number; status: string;
  drills: { name: string; instructions: string; recording: Record<string, string> }[];
  rubric: { criterion: string; guidance: string }[];
  submissions?: number; awaitingReview?: number;
}
export interface CampaignAttempt { id: string; mediaId: string | null; drillName: string; status: string; fileChecks: { passed: boolean; issues: string[]; kind: string }; review: { byName: string; reasons: string | null; rubricNotes: string | null; kind: string } | null; submittedAt: number; mediaUrl?: string | null }
export interface Objective { id: string; playerId: string; objectives: { id: string; text: string; baselineEvidenceIds: string[] }[]; progress: { at: number; note: string | null; evidenceId: string | null }[]; reassessments: { id: string; status: string; requestedAt: number; outcome: { note: string; byName: string } | null }[]; sharing: { orgIds: string[] }; status: string }
export interface FollowUp { id: string; playerId: string; playerName: string; milestone: string; dueAt: number; status: string; outcomeState: string; report: { registrationStatus: string; matchesPlayed: number | null; progression: string | null; status: string } | null }
export interface TrialDay {
  id: string; playerId: string; playerName: string; proposedDate: string | null; venue: string | null; reportDueAt: number | null;
  staff: { id: string; name: string; role: string; check: { kind: string | null; status: string; expiresAt: string | null } }[];
  arrival: { time: string | null; address: string | null; notes: string | null } | null;
  consents: { byKind: string; scope: string; at: number }[];
  checkins: { playerId: string; at: number; byName: string }[];
  statusEvents: { kind: string; at: number; reason: string; newDate: string | null }[];
  cancelled: boolean; emergency?: { name: string; phone: string } | null;
  collection?: { policy: string } | null;
}
export interface Affiliation { id: string; coachName: string; coachEmail: string | null; role: string; from: string; to: string | null; status: string; current: boolean; conflictOfInterest: string | null; confirmedBy: { name: string } }

export interface M12Api {
  getPassport(s: Session, playerId: string): Promise<Passport>;
  corroborateEvidence(s: Session, evidenceId: string): Promise<EvidenceRecord>;
  disputeEvidence(s: Session, evidenceId: string, reason: string): Promise<void>;
  submitClubEvidence(s: Session, playerId: string, input: { claimType: string; label: string; value?: number | string; units?: string; season?: string }): Promise<void>;

  listTemplates(s: Session): Promise<{ templates: { id: string; positionGroup: string; version: number; attributes: AssessmentAttr[] }[]; note: string }>;
  listAssessments(s: Session, playerId?: string): Promise<Assessment[]>;
  createAssessment(s: Session, playerId: string, positionGroup?: string, secondOpinionOf?: string, context?: Assessment['context']): Promise<Assessment>;
  updateAssessment(s: Session, id: string, patch: { ratings?: AssessmentRating[]; context?: Assessment['context']; recommendation?: { verdict: string; reasons: string } }): Promise<Assessment>;
  submitAssessment(s: Session, id: string): Promise<Assessment>;
  compareAssessments(s: Session, playerId: string): Promise<CompareResult>;
  publishFeedback(s: Session, id: string, text: string): Promise<void>;

  listSegments(s: Session, playerId?: string): Promise<Segment[]>;
  createSegment(s: Session, mediaId: string, input: { startS: number; endS: number; labels: string[]; eventType?: string; note?: string }): Promise<Segment>;
  listPlaylists(s: Session): Promise<Playlist[]>;
  createPlaylist(s: Session, name: string): Promise<Playlist>;
  addToPlaylist(s: Session, playlistId: string, segmentId: string): Promise<void>;

  listCases(s: Session): Promise<{ items: CaseRec[]; stages: string[] }>;
  createCase(s: Session, playerId: string, opts?: { vacancyId?: string; priority?: string; restricted?: boolean }): Promise<CaseRec>;
  setStage(s: Session, caseId: string, stage: string, reason?: string): Promise<CaseRec>;
  assignScout(s: Session, caseId: string, userId: string, task: string): Promise<void>;
  decideCase(s: Session, caseId: string, outcome: string, reasons: string): Promise<{ approval?: unknown; case?: CaseRec; pending: boolean }>;
  approveCase(s: Session, caseId: string, approvalId: string, approve: boolean): Promise<CaseRec>;
  listStaff(s: Session): Promise<StaffRow[]>;
  removeStaff(s: Session, userId: string): Promise<void>;

  getTactical(s: Session): Promise<{ tactical: Tactical | null; criteriaKeys: string[] }>;
  saveTactical(s: Session, tactical: { formation: string; planningHorizon?: string; roles: Omit<TacticalRole, 'id'>[] }): Promise<Tactical>;
  listVacancies(s: Session): Promise<Vacancy[]>;
  createVacancy(s: Session, roleId: string, notes?: string): Promise<Vacancy>;
  vacancyCandidates(s: Session, vacancyId: string): Promise<{ role: TacticalRole; candidates: Candidate[]; note: string }>;
  addShadow(s: Session, playerId: string, roleId?: string): Promise<void>;
  squadPlanner(s: Session): Promise<{ formation: string | null; roles: TacticalRole[]; current: { playerId: string; name: string; position: string | null; contractUntil: string | null; source: string }[]; shadow: { playerId: string; name: string; position: string | null; roleId: string | null }[]; vacancies: Vacancy[] }>;

  listOpportunities(s: Session): Promise<Opportunity[]>;
  createOpportunity(s: Session, input: Partial<Opportunity> & { title: string; type: string; deadline: string }): Promise<Opportunity>;
  listApplications(s: Session, opportunityId: string): Promise<Application[]>;
  resolveApplication(s: Session, applicationId: string, decision: 'accepted' | 'declined', note?: string): Promise<void>;
  closeOpportunity(s: Session, opportunityId: string): Promise<void>;

  listCampaigns(s: Session): Promise<Campaign[]>;
  createCampaign(s: Session, input: { title: string; deadline: string; attemptsAllowed?: number; drills: Campaign['drills']; rubric?: Campaign['rubric'] }): Promise<Campaign>;
  reviewQueue(s: Session, campaignId: string): Promise<{ campaign: { title: string; rubric: Campaign['rubric'] }; queue: { playerId: string; playerName: string; attempt: CampaignAttempt }[] }>;
  reviewAttempt(s: Session, attemptId: string, decision: 'accepted' | 'returned', reasons?: string, rubricNotes?: string): Promise<void>;

  playerObjectives(s: Session, playerId: string): Promise<Objective[]>;
  reassessmentOutcome(s: Session, reassessmentId: string, note: string, evidenceIds?: string[]): Promise<void>;

  listFollowUps(s: Session): Promise<FollowUp[]>;
  reportFollowUp(s: Session, id: string, input: { registrationStatus: string; matchesPlayed?: number; progression?: string; endReason?: string; note?: string }): Promise<void>;

  getTrialDay(s: Session, trialId: string): Promise<TrialDay>;
  addTrialStaff(s: Session, trialId: string, input: { name: string; role: string; check?: { kind: string; ref?: string; expiresAt?: string } }): Promise<{ note: string }>;
  setArrival(s: Session, trialId: string, input: { time?: string; address?: string; notes?: string; collection?: string }): Promise<TrialDay>;
  checkinTrial(s: Session, trialId: string): Promise<TrialDay>;
  postponeTrial(s: Session, trialId: string, reason: string, newDate?: string): Promise<void>;
  cancelTrial(s: Session, trialId: string, reason: string): Promise<void>;

  listCoaches(s: Session): Promise<Affiliation[]>;
  addCoach(s: Session, input: { coachName: string; coachEmail?: string; role: string; conflictOfInterest?: string }): Promise<Affiliation>;
  endCoach(s: Session, id: string, revoke: boolean, reason?: string): Promise<void>;
  inviteToSquad(s: Session, playerId: string, note?: string): Promise<{ status: string }>;
}

// ------------------------------------------------------------- http client
const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return body as T;
}
const P = (s: Session, path: string, body?: unknown, method = 'POST') =>
  req<any>(path, { method, headers: H(s), body: JSON.stringify(body ?? {}) });
const G = (s: Session, path: string) => req<any>(path, { headers: H(s) });

export const httpM12: M12Api = {
  getPassport: (s, id) => G(s, `/org/players/${id}/passport`),
  corroborateEvidence: async (s, id) => (await P(s, `/org/evidence/${id}/corroborate`)).evidence,
  disputeEvidence: (s, id, reason) => P(s, `/org/evidence/${id}/dispute`, { reason }),
  submitClubEvidence: (s, playerId, input) => P(s, `/org/players/${playerId}/evidence`, input),

  listTemplates: (s) => G(s, '/org/assessment-templates'),
  listAssessments: async (s, playerId) => (await G(s, `/org/assessments${playerId ? `?playerId=${playerId}` : ''}`)).items,
  createAssessment: async (s, playerId, positionGroup, secondOpinionOf, context) =>
    (await P(s, '/org/assessments', { playerId, positionGroup, secondOpinionOf, context })).assessment,
  updateAssessment: async (s, id, patch) => (await P(s, `/org/assessments/${id}`, patch, 'PUT')).assessment,
  submitAssessment: async (s, id) => (await P(s, `/org/assessments/${id}/submit`)).assessment,
  compareAssessments: (s, playerId) => G(s, `/org/players/${playerId}/assessment-compare`),
  publishFeedback: (s, id, text) => P(s, `/org/assessments/${id}/publish-feedback`, { text }),

  listSegments: async (s, playerId) => (await G(s, `/org/segments${playerId ? `?playerId=${playerId}` : ''}`)).items,
  createSegment: async (s, mediaId, input) => (await P(s, `/org/media/${mediaId}/segments`, input)).segment,
  listPlaylists: (s) => G(s, '/org/playlists'),
  createPlaylist: async (s, name) => (await P(s, '/org/playlists', { name })).playlist,
  addToPlaylist: (s, playlistId, segmentId) => P(s, `/org/playlists/${playlistId}/segments`, { segmentId }),

  listCases: (s) => G(s, '/org/cases'),
  createCase: async (s, playerId, opts) => (await P(s, '/org/cases', { playerId, ...opts })).case,
  setStage: async (s, caseId, stage, reason) => (await P(s, `/org/cases/${caseId}/stage`, { stage, reason })).case,
  assignScout: (s, caseId, userId, task) => P(s, `/org/cases/${caseId}/assign`, { userId, task }),
  decideCase: async (s, caseId, outcome, reasons) => {
    const r = await P(s, `/org/cases/${caseId}/decision`, { outcome, reasons });
    return { ...r, pending: !!r.approval };
  },
  approveCase: async (s, caseId, approvalId, approve) => (await P(s, `/org/cases/${caseId}/approvals/${approvalId}`, { approve })).case,
  listStaff: (s) => G(s, '/org/staff'),
  removeStaff: (s, userId) => P(s, `/org/staff/${userId}/remove`),

  getTactical: (s) => G(s, '/org/tactical'),
  saveTactical: async (s, tactical) => (await P(s, '/org/tactical', tactical)).tactical,
  listVacancies: (s) => G(s, '/org/vacancies'),
  createVacancy: async (s, roleId, notes) => (await P(s, '/org/vacancies', { roleId, notes })).vacancy,
  vacancyCandidates: (s, id) => G(s, `/org/vacancies/${id}/candidates`),
  addShadow: (s, playerId, roleId) => P(s, '/org/squad/shadow', { playerId, roleId }),
  squadPlanner: (s) => G(s, '/org/squad-planner'),

  listOpportunities: (s) => G(s, '/org/opportunities'),
  createOpportunity: async (s, input) => (await P(s, '/org/opportunities', input)).opportunity,
  listApplications: async (s, id) => (await G(s, `/org/opportunities/${id}/applications`)).items,
  resolveApplication: (s, id, decision, note) => P(s, `/org/applications/${id}/outcome`, { decision, note }),
  closeOpportunity: (s, id) => P(s, `/org/opportunities/${id}/close`),

  listCampaigns: (s) => G(s, '/org/campaigns'),
  createCampaign: async (s, input) => (await P(s, '/org/campaigns', input)).campaign,
  reviewQueue: (s, id) => G(s, `/org/campaigns/${id}/review-queue`),
  reviewAttempt: (s, id, decision, reasons, rubricNotes) => P(s, `/org/campaign-attempts/${id}/review`, { decision, reasons, rubricNotes }),

  playerObjectives: (s, playerId) => G(s, `/org/players/${playerId}/objectives`),
  reassessmentOutcome: (s, id, note, evidenceIds) => P(s, `/org/reassessments/${id}/outcome`, { note, evidenceIds }),

  listFollowUps: async (s) => (await G(s, '/org/followups')).items,
  reportFollowUp: (s, id, input) => P(s, `/org/followups/${id}/report`, input),

  getTrialDay: async (s, trialId) => (await G(s, `/org/trials/${trialId}/day`)).trial,
  addTrialStaff: (s, trialId, input) => P(s, `/org/trials/${trialId}/staff`, input),
  setArrival: async (s, trialId, input) => (await P(s, `/org/trials/${trialId}/arrival`, input)).trial,
  checkinTrial: async (s, trialId) => (await P(s, `/org/trials/${trialId}/checkin`)).trial,
  postponeTrial: (s, trialId, reason, newDate) => P(s, `/org/trials/${trialId}/postpone`, { reason, newDate }),
  cancelTrial: (s, trialId, reason) => P(s, `/org/trials/${trialId}/cancel`, { reason }),

  listCoaches: (s) => G(s, '/org/coaches'),
  addCoach: async (s, input) => (await P(s, '/org/coaches', input)).affiliation,
  endCoach: (s, id, revoke, reason) => P(s, `/org/coaches/${id}/${revoke ? 'revoke' : 'end'}`, { reason }),
  inviteToSquad: async (s, playerId, note) => (await P(s, '/org/squad/invite', { playerId, note })).invite,
};

export const m12: M12Api = DEMO_MODE ? demoM12 : httpM12;
