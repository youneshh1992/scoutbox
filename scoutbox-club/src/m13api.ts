// M13 typed client (org side): imports & integrations, coverage planning,
// calibration, exposure/review insight, evidence gaps, groups & transitions,
// deal budgets, representation (agency lane), organisation ops (onboarding,
// MFA, SSO, sessions, support) and the delivery centre.
// Same live/demo split as api.ts: VITE_DEMO=1 selects the in-browser mirror.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM13 } from './m13demo';

export interface ImportRow { row: number; record: Record<string, string>; errors: string[]; disposition: string; matchPlayerId: string | null }
export interface ImportBatch {
  id: string; status: string; createdByName: string; createdAt: number;
  summary: { total: number; creatable: number; errors: number; duplicatesInFile: number; alreadyImported: number; linkedExisting: number; ambiguous: number };
  rows?: ImportRow[]; createdProspectIds?: string[]; rowCount?: number;
}
export interface IdentityReview { id: string; record: Record<string, string>; candidatePlayerId: string; status: string; row: number }
export interface ApiKeyRow { id: string; scopes: string[]; label: string; createdBy: string; createdAt: number; revokedAt: number | null; lastUsedAt: number | null }
export interface WebhookRow { id: string; url: string; events: string[]; active: boolean; secret?: string }
export interface WebhookDelivery { id: string; eventId: string; type: string; status: string; attempts: { at: number; status?: number; error?: string }[] }
export interface Connector { id: string; name: string; kind: string; status: string; note: string | null }

export interface Fixture { id: string; source: string; competition: string | null; home: string; away: string; date: string; location: { city?: string } | null }
export interface CoveragePlan { id: string; label: string; competition: string | null; goalObservations: number; windowDays: number; progress?: { done: number; goal: number; complete: boolean } }
export interface CoverageAssignment {
  id: string; fixtureLabel: string; fixtureDate: string; scoutName: string; scoutUserId: string;
  targetPlayerIds: string[]; travelBudget: { amountMinor: number; currency: string } | null; travelNote: string;
  warnings: string[]; observedAt: number | null;
}
export interface VisitSuggestion { fixture: Fixture; alreadyCovered: boolean; nearbyTargets: { id: string; name: string; position: string }[]; rationale: string }

export interface CalibrationSession {
  id: string; title: string; status: string; templateVersion: number; mediaUrl?: string | null; footageNote?: string | null;
  attributesSnapshot: { id: string; label: string }[]; participants: string[]; blind?: boolean;
  submissions: { userId: string; userName: string; submittedAt: number; ratings?: { attrId: string; value?: number; notObserved?: boolean }[] }[];
  notes: { byName: string; text: string; at: number }[];
  comparison: { rows: { attrId: string; label: string; values: number[]; notObserved: number; range: number | null; mean: number | null; disagreement: string }[]; sampleSize: number; confidenceNote: string } | null;
}
export interface CalibrationListRow { id: string; title: string; status: string; participants: number; submitted: number }

export interface ExposureReport {
  funnel: { windowDays: number; definition: string; stages: { key: string; players: number; of?: number }[] };
  birthQuarter: { suppressed?: boolean; total?: number; quarters?: Record<string, number>; note?: string };
  absentEvidence: { note: string; notYetReviewed: number };
}
export interface ReviewQueue {
  queue: { player: { id: string; name: string; position?: string }; firstSeenDaysAgo: number }[];
  deferred: { player: { id: string; name: string }; deferredUntil: number }[];
  staleEvaluations: { playerId: string; playerName: string; lastAssessedAt: number; note: string }[];
}
export interface EvidenceGap { id: string; ruleId: string; ruleVersion: number; explanation: string; action: string; status: string; records: string[]; playerName: string }

export interface GroupRow { id: string; name: string; members: { id: string; name: string; level: string }[]; youAdmin: boolean; programmes: { id: string; name: string; region: string | null }[] }
export interface GrantRow { id: string; fromOrgName?: string; resourceKind: string; resourceId?: string; expiresAt: number; revokedAt?: number | null; live?: boolean; toOrgIds?: string[] }
export interface SharedResource { kind: string; players?: { id: string; name: string; position: string; level: string }[]; withheld?: number; withheldNote?: string | null; case?: unknown; assessment?: unknown; gone?: boolean }

export interface TransitionListRow { id: string; playerName: string; grantedAt: number; expiresAt: number; note: string | null }
export interface TransitionPack { transitionId: string; playerName: string; note: string | null; pack: { media: { id: string; title: string; url: string | null }[]; evidence: { id: string; kind?: string; tier: string; summary?: string }[]; publishedFeedback: { orgName: string; text: string; at: number }[] } }

export interface ScenarioLine { id?: string; kind: string; label: string; amountMinor: number; currency: string; schedule: string; confirmed: boolean; conditional: { assumption: string } | null }
export interface Scenario {
  id: string; version: number; label: string; currency: string; termMonths: number; lines: ScenarioLine[];
  fxAssumptions: { from: string; to: string; rate: string; source: string; date: string }[];
  approval: { by: string; at: number; version: number; superseded?: boolean } | null;
  actuals: { lineId: string; amountMinor: number; at: number }[];
  totals?: ScenarioTotals;
}
export interface ScenarioTotals {
  termMonths: number; perCurrency: Record<string, { confirmedMinor: number; estimatedMinor: number; conditionalCount: number }>;
  combined: { currency?: string; confirmedMinor?: number; estimatedMinor?: number; viaFx?: boolean; unavailable?: boolean; reason?: string } | null;
  conditionalLines: { label: string; amountMinor: number; currency: string; assumption: string }[];
  conditionalNote: string;
}

export interface Representation {
  id: string; playerId: string; playerName: string; agencyName: string; representativeName: string; scope: string;
  status: string; startAt: number; endAt: number | null; confirmedAt: number | null;
  credential: { source: string; note: string; reviewStatus: string; honest: string } | null;
  history: { at: number; byName: string; action: string }[];
}

export interface OnboardingState { tasks: { id: string; label: string; done: boolean; help: string }[]; complete: boolean; roleHelp: string }
export interface InviteRow { id: string; email: string; name: string; role: string; status: string; createdAt: number }
export interface SessionRow { sid: string; createdAt: number; current: boolean; via: string }
export interface SupportTicket { id: string; subject: string; body: string; status: string; refs: { kind: string; id: string }[]; replies: { at: number; by: string; text: string }[]; createdAt: number }
export interface OrgNotification { id: string; ts: number; type: string; text: string; read: boolean; actionRequired?: { deadline: number | null; ackedAt: number | null } | null }
export interface SuitabilitySummary { approvedAt: number; approvedBy: string; verdicts: { dimension: string; verdict: string }[] }

export interface M13Api {
  // F1
  importTemplateUrl(): string;
  createImport(s: Session, csv: string): Promise<{ batch: ImportBatch; dryRun: boolean; note: string }>;
  listImports(s: Session): Promise<ImportBatch[]>;
  commitImport(s: Session, id: string): Promise<{ created: number; reviewsQueued: number }>;
  reverseImport(s: Session, id: string): Promise<{ removed: number; kept: { id: string; reason: string }[] }>;
  listIdentityReviews(s: Session): Promise<IdentityReview[]>;
  resolveIdentity(s: Session, id: string, action: 'link' | 'separate'): Promise<void>;
  listApiKeys(s: Session): Promise<{ items: ApiKeyRow[]; contractVersion: string }>;
  createApiKey(s: Session, scopes: string[], label: string): Promise<{ key: ApiKeyRow; plaintext: string; note: string }>;
  revokeApiKey(s: Session, id: string): Promise<void>;
  listWebhooks(s: Session): Promise<{ items: WebhookRow[]; guidance: string }>;
  createWebhook(s: Session, url: string, events: string[]): Promise<{ endpoint: WebhookRow; note: string }>;
  webhookDeliveries(s: Session, id: string): Promise<WebhookDelivery[]>;
  rotateWebhook(s: Session, id: string): Promise<WebhookRow>;
  listConnectors(s: Session): Promise<Connector[]>;
  // F7
  listFixtures(s: Session): Promise<Fixture[]>;
  createFixture(s: Session, input: { competition?: string; home: string; away: string; date: string; city?: string; lat?: number; lng?: number }): Promise<Fixture>;
  listPlans(s: Session): Promise<CoveragePlan[]>;
  createPlan(s: Session, input: { label: string; competition?: string; goalObservations: number; windowDays: number }): Promise<CoveragePlan>;
  listAssignments(s: Session): Promise<CoverageAssignment[]>;
  createAssignment(s: Session, input: { fixtureId: string; scoutUserId: string; targetPlayerIds?: string[]; travelBudgetMinor?: number }): Promise<{ assignment: CoverageAssignment; warnings: string[] }>;
  completeAssignment(s: Session, id: string): Promise<void>;
  visitSuggestions(s: Session): Promise<{ items: VisitSuggestion[]; note: string }>;
  // F5
  listCalibrations(s: Session): Promise<CalibrationListRow[]>;
  createCalibration(s: Session, input: { templateId: string; title: string; mediaId?: string; participantUserIds: string[] }): Promise<CalibrationSession>;
  getCalibration(s: Session, id: string): Promise<CalibrationSession>;
  submitCalibration(s: Session, id: string, ratings: { attrId: string; value?: number; notObserved?: boolean }[], confidence: string): Promise<CalibrationSession>;
  closeCalibration(s: Session, id: string): Promise<CalibrationSession>;
  calibrationNote(s: Session, id: string, text: string): Promise<void>;
  decisionReview(s: Session): Promise<{ items: { assessmentId: string; playerName: string; scoutName: string; recommendation: { verdict: string }; since: { signedSomewhere: boolean; furtherAssessments: number } }[]; disclaimer: string }>;
  // F4 + F6
  reportImpressions(s: Session, playerIds: string[]): Promise<void>;
  exposureReport(s: Session): Promise<ExposureReport>;
  reviewQueue(s: Session): Promise<ReviewQueue>;
  deferReview(s: Session, playerId: string, days: number): Promise<void>;
  discoveryRotation(s: Session): Promise<{ week: number; items: { id: string; name: string; position?: string }[]; note: string }>;
  evidenceGaps(s: Session, playerId: string): Promise<{ items: EvidenceGap[]; engine: { version: number; note: string } }>;
  requestGap(s: Session, id: string): Promise<void>;
  dismissGap(s: Session, id: string): Promise<void>;
  // F8 + F2
  listGroups(s: Session): Promise<{ items: GroupRow[]; invites: { groupId: string; name: string }[] }>;
  acceptGroup(s: Session, id: string): Promise<void>;
  leaveGroup(s: Session, id: string): Promise<{ grantsEnded: number }>;
  inviteToGroup(s: Session, id: string, orgId: string): Promise<void>;
  previewGrant(s: Session, groupId: string, input: { resourceKind: string; resourceId: string; toOrgIds: string[] }): Promise<{ recipients: { orgName: string; wouldSee: SharedResource }[] }>;
  createGrant(s: Session, groupId: string, input: { resourceKind: string; resourceId: string; toOrgIds: string[]; expiresDays: number }): Promise<GrantRow>;
  listGrants(s: Session): Promise<{ given: GrantRow[]; received: GrantRow[] }>;
  revokeGrant(s: Session, id: string): Promise<void>;
  readShared(s: Session, grantId: string): Promise<{ from: string; resource: SharedResource }>;
  groupReport(s: Session, id: string): Promise<{ group: { name: string; members: number }; activity: { orgName: string; assessments: number | string; signings: number | string }[]; note: string }>;
  listTransitions(s: Session): Promise<{ items: TransitionListRow[]; note: string }>;
  transitionPack(s: Session, id: string): Promise<TransitionPack>;
  // F9
  caseBudget(s: Session, caseId: string): Promise<{ scenarios: Scenario[]; note: string }>;
  createScenario(s: Session, caseId: string, input: Partial<Scenario>): Promise<{ scenario: Scenario; totals: ScenarioTotals; honest: string }>;
  updateScenario(s: Session, caseId: string, sid: string, patch: Partial<Scenario>): Promise<{ scenario: Scenario; totals: ScenarioTotals }>;
  approveScenario(s: Session, caseId: string, sid: string): Promise<{ scenario: Scenario; note: string }>;
  // F10 (agency lane)
  listRepresentations(s: Session): Promise<{ items: Representation[]; note: string }>;
  proposeRepresentation(s: Session, input: { playerId: string; representativeName: string; scope: string; endMonths?: number; credentialNote?: string }): Promise<Representation>;
  // F12 + F11
  onboarding(s: Session): Promise<OnboardingState>;
  listInvites(s: Session): Promise<InviteRow[]>;
  createInvite(s: Session, email: string, name: string, role: string): Promise<InviteRow>;
  mfaSetup(s: Session): Promise<{ secret: string; otpauth: string; note: string }>;
  mfaVerify(s: Session, code: string): Promise<{ enabled: boolean; recoveryCodes: string[]; note: string }>;
  listSessions(s: Session): Promise<SessionRow[]>;
  revokeSession(s: Session, sid: string): Promise<void>;
  getSso(s: Session): Promise<{ config: { issuer: string; clientId: string } | null; available: string[]; note: string | null }>;
  setSso(s: Session, issuer: string): Promise<void>;
  listSupport(s: Session): Promise<SupportTicket[]>;
  createSupport(s: Session, subject: string, body: string, refs: { kind: string; id: string }[]): Promise<SupportTicket>;
  approveSupportAccess(s: Session, ticketId: string): Promise<void>;
  orgNotifications(s: Session): Promise<OrgNotification[]>;
  ackNotification(s: Session, id: string): Promise<void>;
  setDeliveryPrefs(s: Session, prefs: { quietStart?: string | null; quietEnd?: string | null; email?: boolean }): Promise<void>;
  auditExportUrl(): string;
  // F3 (org view)
  applicationSuitability(s: Session, applicationId: string): Promise<{ summary: SuitabilitySummary | null; note?: string }>;
  setStructuredRequirements(s: Session, oppId: string, input: { trainingSlots?: { day: string; start: string; end: string; tz: string }[]; relocationRequired?: boolean; feeMinor?: number; expensesCovered?: boolean; environment?: string[]; accommodations?: string[] }): Promise<void>;
}

// ------------------------------------------------------------- http client
const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return body as T;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const P = (s: Session, path: string, body?: unknown, method = 'POST') =>
  req<any>(path, { method, headers: H(s), body: JSON.stringify(body ?? {}) });
const G = (s: Session, path: string) => req<any>(path, { headers: H(s) });

export const httpM13: M13Api = {
  importTemplateUrl: () => `${API_URL}/org/imports/template`,
  createImport: (s, csv) => P(s, '/org/imports', { csv }),
  listImports: async (s) => (await G(s, '/org/imports')).items,
  commitImport: (s, id) => P(s, `/org/imports/${id}/commit`, { confirm: true }),
  reverseImport: (s, id) => P(s, `/org/imports/${id}/reverse`),
  listIdentityReviews: async (s) => (await G(s, '/org/identity-reviews')).items,
  resolveIdentity: (s, id, action) => P(s, `/org/identity-reviews/${id}/resolve`, { action }),
  listApiKeys: (s) => G(s, '/org/api-keys'),
  createApiKey: (s, scopes, label) => P(s, '/org/api-keys', { scopes, label }),
  revokeApiKey: (s, id) => P(s, `/org/api-keys/${id}/revoke`),
  listWebhooks: (s) => G(s, '/org/webhooks'),
  createWebhook: (s, url, events) => P(s, '/org/webhooks', { url, events }),
  webhookDeliveries: async (s, id) => (await G(s, `/org/webhooks/${id}/deliveries`)).items,
  rotateWebhook: async (s, id) => (await P(s, `/org/webhooks/${id}/rotate`)).endpoint,
  listConnectors: async (s) => (await G(s, '/org/connectors')).items,

  listFixtures: async (s) => (await G(s, '/org/coverage/fixtures')).items,
  createFixture: async (s, input) => (await P(s, '/org/coverage/fixtures', input)).fixture,
  listPlans: async (s) => (await G(s, '/org/coverage-plans')).items,
  createPlan: async (s, input) => (await P(s, '/org/coverage-plans', input)).plan,
  listAssignments: async (s) => (await G(s, '/org/coverage/assignments')).items,
  createAssignment: (s, input) => P(s, '/org/coverage/assignments', input),
  completeAssignment: (s, id) => P(s, `/org/coverage/assignments/${id}/complete`),
  visitSuggestions: (s) => G(s, '/org/coverage/suggestions'),

  listCalibrations: async (s) => (await G(s, '/org/calibration')).items,
  createCalibration: async (s, input) => (await P(s, '/org/calibration', input)).session,
  getCalibration: async (s, id) => (await G(s, `/org/calibration/${id}`)).session,
  submitCalibration: async (s, id, ratings, confidence) => (await P(s, `/org/calibration/${id}/submit`, { ratings, confidence })).session,
  closeCalibration: async (s, id) => (await P(s, `/org/calibration/${id}/close`)).session,
  calibrationNote: (s, id, text) => P(s, `/org/calibration/${id}/notes`, { text }),
  decisionReview: (s) => G(s, '/org/decision-review'),

  reportImpressions: (s, playerIds) => P(s, '/org/exposure/impressions', { playerIds }),
  exposureReport: (s) => G(s, '/org/exposure/report'),
  reviewQueue: (s) => G(s, '/org/review-queue'),
  deferReview: (s, playerId, days) => P(s, `/org/review-queue/${playerId}/later`, { days }),
  discoveryRotation: (s) => G(s, '/org/discovery-rotation'),
  evidenceGaps: (s, playerId) => G(s, `/org/players/${playerId}/evidence-gaps`),
  requestGap: (s, id) => P(s, `/org/evidence-gaps/${id}/request`),
  dismissGap: (s, id) => P(s, `/org/evidence-gaps/${id}/dismiss`),

  listGroups: (s) => G(s, '/org/groups'),
  acceptGroup: (s, id) => P(s, `/org/groups/${id}/accept`),
  leaveGroup: (s, id) => P(s, `/org/groups/${id}/leave`),
  inviteToGroup: (s, id, orgId) => P(s, `/org/groups/${id}/invite`, { orgId }),
  previewGrant: (s, groupId, input) => P(s, `/org/groups/${groupId}/grants/preview`, input),
  createGrant: async (s, groupId, input) => (await P(s, `/org/groups/${groupId}/grants`, input)).grant,
  listGrants: (s) => G(s, '/org/grants'),
  revokeGrant: (s, id) => P(s, `/org/grants/${id}/revoke`),
  readShared: (s, grantId) => G(s, `/org/shared/${grantId}`),
  groupReport: (s, id) => G(s, `/org/groups/${id}/report`),
  listTransitions: (s) => G(s, '/org/transitions'),
  transitionPack: (s, id) => G(s, `/org/transitions/${id}/pack`),

  caseBudget: (s, caseId) => G(s, `/org/cases/${caseId}/budget`),
  createScenario: (s, caseId, input) => P(s, `/org/cases/${caseId}/budget/scenarios`, input),
  updateScenario: (s, caseId, sid, patch) => P(s, `/org/cases/${caseId}/budget/scenarios/${sid}`, patch, 'PUT'),
  approveScenario: (s, caseId, sid) => P(s, `/org/cases/${caseId}/budget/scenarios/${sid}/approve`),

  listRepresentations: (s) => G(s, '/org/representation'),
  proposeRepresentation: async (s, input) => (await P(s, '/org/representation/propose', input)).representation,

  onboarding: (s) => G(s, '/org/onboarding'),
  listInvites: async (s) => (await G(s, '/org/invites')).items,
  createInvite: async (s, email, name, role) => (await P(s, '/org/invites', { email, name, role })).invite,
  mfaSetup: (s) => P(s, '/org/mfa/setup'),
  mfaVerify: (s, code) => P(s, '/org/mfa/verify', { code }),
  listSessions: async (s) => (await G(s, '/org/sessions')).items,
  revokeSession: (s, sid) => P(s, '/org/sessions/revoke', { sid }),
  getSso: (s) => G(s, '/org/sso'),
  setSso: (s, issuer) => P(s, '/org/sso', { issuer }, 'PUT'),
  listSupport: async (s) => (await G(s, '/org/support')).items,
  createSupport: async (s, subject, body, refs) => (await P(s, '/org/support', { subject, body, refs })).ticket,
  approveSupportAccess: (s, ticketId) => P(s, `/org/support/${ticketId}/approve-access`),
  orgNotifications: (s) => G(s, '/org/notifications'),
  ackNotification: (s, id) => P(s, `/org/notifications/${id}/ack`),
  setDeliveryPrefs: (s, prefs) => P(s, '/org/delivery/prefs', prefs, 'PUT'),
  auditExportUrl: () => `${API_URL}/org/audit/export`,

  applicationSuitability: (s, applicationId) => G(s, `/org/applications/${applicationId}/suitability`),
  setStructuredRequirements: (s, oppId, input) => P(s, `/org/opportunities/${oppId}/structured-requirements`, input, 'PUT'),
};

export const m13: M13Api = DEMO_MODE ? demoM13 : httpM13;
