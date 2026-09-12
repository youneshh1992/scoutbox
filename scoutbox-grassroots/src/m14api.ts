// M14 typed client (org side): verification & trust — personal claims, the
// club Verification console (requests, staff, domains, administrators),
// licences, references, squad invitations and safe public badge profiles.
// Same live/demo split as api.ts: VITE_DEMO=1 selects the in-browser mirror.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM14 } from './m14demo';

export interface VerBadge {
  kind: 'identity' | 'organisation' | 'domain' | 'admin' | 'affiliation' | 'role' | 'licence' | 'claim';
  claimType: string; label: string; organisation: { id: string; name: string } | null;
  role: string | null; current: boolean; historical: boolean;
  period: { from: number | null; to: number | null } | null;
  verifiedAt: number | null; provenance: string;
}
export interface PublicVerProfile { subjectType: string; subjectId: string; identityVerified: boolean; badges: VerBadge[]; organisationStatus?: string }
export interface SubjectClaim {
  id: string; claimType: string; status: string;
  effective: { status: string; current: boolean; historical: boolean };
  organisation: { id: string; name: string } | null; role: string | null;
  validFrom: number | null; validUntil: number | null; current: boolean;
  verificationMethod: string | null; verifiedAt: number | null; provenance: string | null;
  reviewReasons: string[]; createdAt: number; updatedAt: number;
  revocationReason: string | null; disputedAt: number | null;
  evidence: { id: string; type: string; receivedAt: number; filename: string | null; checks: Record<string, string>; note: string | null }[];
  humanReviewNote: string | null;
}
export interface VerStep { id: string; label: string; done: boolean; state: string }
export interface MyVerification { claims: SubjectClaim[]; verificationLevel: string | null; organisationStatus: string; steps: VerStep[]; publicPreview: PublicVerProfile }
export interface VerRequestRow {
  claimId: string; claimType: string; pairId: string | null;
  person: { id: string; name: string; email: string | null; accountCreatedAt: number | null; removed: boolean };
  claimedRole: string | null; requestedStart: number | null; identityStatus: string;
  emailStatus: string; riskFlags: string[]; status: string; requestedAt: number;
  priorClaims: { claimType: string; organisationId: string | null; role: string | null; current: boolean }[];
}
export interface StaffRow {
  claimId: string; person: { id: string; name: string }; claimType: string; role: string | null;
  status: string; effective: { status: string; displayable: boolean; current: boolean; historical: boolean };
  current: boolean; validFrom: number | null; validUntil: number | null;
  verificationMethod: string | null; verifiedAt: number | null;
}
export interface VerDashboard { organisationStatus: string; counts: Record<string, number> }
export interface DomainRow { domain: string; status: string; method: string; verifiedAt: number; addedBy?: string }
export interface DomainRequest { id: string; domain: string; status: string; reviewReasons?: string[]; createdAt: number }
export interface VerAdminRow { id: string; userId: string; level: string; status: string; person: { id: string; name: string }; createdAt: number }
export interface RootTransfer { id: string; toUserId: string; proposedBy: string; status: string; createdAt: number }
export interface LicenceProvider { id: string; name: string; state: 'configured' | 'not_configured' | 'temporarily_unavailable' | 'unsupported' }
export interface ReferenceRow {
  id: string; version: number; playerId?: string; playerName?: string; coachName: string; orgName: string;
  roleAtTime: string | null; relationship: string; capacity: string; fromYear: number | null; toYear: number | null;
  structured: { strengths: string; development: string; summary: string }; status: string; createdAt: number;
}
export interface PlayerInviteRow { id: string; name: string; squad: string; status: string; byName: string; createdAt: number; expiresAt: number; guardianApproved: { guardianId: string; at: number } | null }
export interface ConflictRow { id: string; userId: string; kind: string; subject: string; note: string; createdAt: number; withdrawnAt: number | null }

export interface M14Api {
  me(s: Session): Promise<MyVerification>;
  startIdentity(s: Session): Promise<{ claim: SubjectClaim }>;
  requestAffiliation(s: Session, role: string): Promise<{ affiliation: SubjectClaim; role: SubjectClaim; next: string }>;
  addEvidence(s: Session, claimId: string, input: { dataUrl?: string; filename?: string; note?: string }): Promise<{ claim: SubjectClaim }>;
  submitClaim(s: Session, claimId: string): Promise<{ claim: SubjectClaim }>;
  sendWorkEmail(s: Session, email: string): Promise<{ sent: boolean; note: string }>;
  confirmWorkEmail(s: Session, code: string): Promise<{ domainControl: string; domainCoveredByOrg: boolean; note: string; claims: SubjectClaim[] }>;
  disputeClaim(s: Session, claimId: string, reason: string): Promise<{ note: string }>;

  dashboard(s: Session): Promise<VerDashboard>;
  listRequests(s: Session): Promise<{ items: VerRequestRow[]; note: string }>;
  decideRequest(s: Session, claimId: string, action: string, opts?: { role?: string; validFrom?: number; validUntil?: number; reason?: string }): Promise<{ decided: string; claims: SubjectClaim[] }>;
  listStaff(s: Session, filters?: Record<string, string>): Promise<{ items: StaffRow[] }>;
  markDeparted(s: Session, userId: string): Promise<{ closed: number; note: string }>;

  listDomains(s: Session): Promise<{ domains: DomainRow[]; requests: DomainRequest[] }>;
  addDomain(s: Session, domain: string, challengeEmail: string): Promise<{ request: DomainRequest; note: string }>;
  confirmDomain(s: Session, requestId: string, code: string): Promise<{ domain: string; status: string }>;

  listAdmins(s: Session): Promise<{ items: VerAdminRow[]; transfers: RootTransfer[] }>;
  grantAdmin(s: Session, userId: string, level: string): Promise<{ admin?: VerAdminRow; transfer?: RootTransfer; note?: string }>;
  revokeAdmin(s: Session, adminId: string, reason: string): Promise<{ admin: VerAdminRow; note: string }>;
  approveTransfer(s: Session, transferId: string): Promise<{ transfer: RootTransfer; admin: VerAdminRow }>;

  licenceProviders(s: Session): Promise<{ providers: LicenceProvider[]; note: string }>;
  submitLicence(s: Session, input: { licenceType: string; issuer: string; identifier?: string; holderName?: string; expiry?: string; dataUrl?: string; filename?: string }): Promise<{ claim: { id: string; status: string; display: string }; note: string }>;
  runLicenceCheck(s: Session, claimId: string, providerId: string): Promise<{ claim: { id: string; status: string; display: string }; provider: { id: string; state?: string; result?: string }; note?: string }>;

  publicUser(s: Session, userId: string): Promise<PublicVerProfile>;
  publicOrg(s: Session, orgId: string): Promise<PublicVerProfile>;

  listReferences(s: Session): Promise<{ items: ReferenceRow[] }>;
  createReference(s: Session, input: { playerId: string; relationship: string; capacity?: string; fromYear?: number; toYear?: number; strengths?: string; development?: string; summary: string }): Promise<{ reference: ReferenceRow }>;
  withdrawReference(s: Session, id: string, reason: string): Promise<{ reference: ReferenceRow }>;

  listPlayerInvites(s: Session): Promise<{ items: PlayerInviteRow[] }>;
  createPlayerInvite(s: Session, name: string, squad: string, email?: string): Promise<{ invite: PlayerInviteRow; code?: string; note?: string }>;

  listConflicts(s: Session): Promise<{ items: ConflictRow[] }>;
  declareConflict(s: Session, kind: string, subject: string, note: string): Promise<{ conflict: ConflictRow; note: string }>;
}

// ------------------------------------------------------------- http client
const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const P = (s: Session, path: string, body?: unknown, method = 'POST') =>
  req<any>(path, { method, headers: H(s), body: body === undefined ? undefined : JSON.stringify(body) });
const G = (s: Session, path: string) => req<any>(path, { headers: H(s) });

export const httpM14: M14Api = {
  me: (s) => G(s, '/org/verification/me'),
  startIdentity: (s) => P(s, '/org/verification/identity'),
  requestAffiliation: (s, role) => P(s, '/org/verification/affiliation', { role }),
  addEvidence: (s, claimId, input) => P(s, `/org/verification/claims/${claimId}/evidence`, input),
  submitClaim: (s, claimId) => P(s, `/org/verification/claims/${claimId}/submit`),
  sendWorkEmail: (s, email) => P(s, '/org/verification/work-email', { email }),
  confirmWorkEmail: (s, code) => P(s, '/org/verification/work-email/confirm', { code }),
  disputeClaim: (s, claimId, reason) => P(s, `/org/verification/claims/${claimId}/dispute`, { reason }),

  dashboard: (s) => G(s, '/org/verification/dashboard'),
  listRequests: (s) => G(s, '/org/verification/requests'),
  decideRequest: (s, claimId, action, opts) => P(s, `/org/verification/requests/${claimId}/decide`, { action, ...opts }),
  listStaff: (s, filters) => G(s, `/org/verification/staff${filters ? `?${new URLSearchParams(filters)}` : ''}`),
  markDeparted: (s, userId) => P(s, `/org/verification/staff/${userId}/departed`, {}),

  listDomains: (s) => G(s, '/org/verification/domains'),
  addDomain: (s, domain, challengeEmail) => P(s, '/org/verification/domains', { domain, challengeEmail }),
  confirmDomain: (s, requestId, code) => P(s, `/org/verification/domains/${requestId}/confirm`, { code }),

  listAdmins: (s) => G(s, '/org/verification/admins'),
  grantAdmin: (s, userId, level) => P(s, '/org/verification/admins', { userId, level }),
  revokeAdmin: (s, adminId, reason) => P(s, `/org/verification/admins/${adminId}/revoke`, { reason }),
  approveTransfer: (s, transferId) => P(s, `/org/verification/root-transfers/${transferId}/approve`),

  licenceProviders: (s) => G(s, '/org/verification/licence-providers'),
  submitLicence: (s, input) => P(s, '/org/verification/licence', input),
  runLicenceCheck: (s, claimId, providerId) => P(s, `/org/verification/licence/${claimId}/submit`, { providerId }),

  publicUser: (s, userId) => G(s, `/org/verification/public/user/${userId}`),
  publicOrg: (s, orgId) => G(s, `/org/verification/public/org/${orgId}`),

  listReferences: (s) => G(s, '/org/verification/references'),
  createReference: (s, input) => P(s, '/org/verification/references', input),
  withdrawReference: (s, id, reason) => P(s, `/org/verification/references/${id}/withdraw`, { reason }),

  listPlayerInvites: (s) => G(s, '/org/verification/player-invites'),
  createPlayerInvite: (s, name, squad, email) => P(s, '/org/verification/player-invites', { name, squad, email }),

  listConflicts: (s) => G(s, '/org/verification/conflicts'),
  declareConflict: (s, kind, subject, note) => P(s, '/org/verification/conflicts', { kind, subject, note }),
};

export const m14: M14Api = DEMO_MODE ? demoM14 : httpM14;
