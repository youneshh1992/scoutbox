// M14 in-browser demo mirror (VITE_DEMO=1). Same honesty rules as the live
// server: nothing here shows "verified" for anything that was only uploaded,
// and the demo personas cover the full range of states — verified club, root
// admin, verified scout, pending coach, former (historical) coach, and a
// submitted-but-NOT-verified licence. State lives in-page and resets on
// reload; nothing reaches a real person.
import type {
  M14Api, MyVerification, SubjectClaim, VerRequestRow, StaffRow, VerAdminRow,
  DomainRow, DomainRequest, RootTransfer, ReferenceRow, PlayerInviteRow, ConflictRow,
  PublicVerProfile,
} from './m14api';

const now = Date.now();
const day = 86_400_000;
const y = (yr: number) => new Date(`${yr}-07-01`).getTime();

const mk = (o: Partial<SubjectClaim>): SubjectClaim => ({
  id: `dclm-${Math.random().toString(36).slice(2, 8)}`, claimType: 'CLUB_ROLE', status: 'verified',
  effective: { status: 'verified', current: true, historical: false },
  organisation: { id: 'org-hackneymarsh', name: 'Hackney Marsh Rovers' }, role: null,
  validFrom: now - 300 * day, validUntil: null, current: true,
  verificationMethod: 'organisation_admin_confirmation', verifiedAt: now - 290 * day,
  provenance: 'Confirmed by an authorised Hackney Marsh Rovers administrator',
  reviewReasons: [], createdAt: now - 300 * day, updatedAt: now - 290 * day,
  revocationReason: null, disputedAt: null, evidence: [], humanReviewNote: null, ...o,
});

// You (the demo login) — identity verified, role verified, licence SUBMITTED.
const myClaims: SubjectClaim[] = [
  mk({ id: 'dclm-me-id', claimType: 'PERSON_IDENTITY', organisation: null, provenance: 'Reviewed and confirmed by ScoutBox Trust & Safety', verificationMethod: 'scoutbox_manual_review' }),
  mk({ id: 'dclm-me-aff', claimType: 'CLUB_AFFILIATION' }),
  mk({ id: 'dclm-me-role', role: 'Club Manager' }),
  mk({
    id: 'dclm-me-lic', claimType: 'LICENCE', organisation: null, status: 'requires_human_review',
    effective: { status: 'requires_human_review', current: false, historical: false },
    verificationMethod: 'document_submitted', verifiedAt: null, provenance: null,
    reviewReasons: ['NO_AUTHORITATIVE_SOURCE', 'DOCUMENT_AUTHENTICITY_UNCONFIRMED'],
    evidence: [{ id: 'devd-1', type: 'document', receivedAt: now - 6 * day, filename: 'uefa-a-licence.pdf', checks: { malwareScan: 'not_configured' }, note: null }],
    humanReviewNote: 'ScoutBox needs to review this request because an uploaded document is evidence, not proof — a reviewer checks it against authoritative sources.',
  }),
];

const requests: VerRequestRow[] = [{
  claimId: 'dclm-jo-role', claimType: 'CLUB_ROLE', pairId: 'dpair-jo',
  person: { id: 'usr-jo', name: 'Jo Denton', email: 'jo.denton@hackneymarshrovers.org.uk', accountCreatedAt: now - 20 * day, removed: false },
  claimedRole: 'Assistant Coach', requestedStart: null, identityStatus: 'verified',
  emailStatus: 'work_email_on_verified_domain', riskFlags: [], status: 'automated_checks_passed', requestedAt: now - 2 * day,
  priorClaims: [{ claimType: 'GRASSROOTS_AFFILIATION', organisationId: 'org-other', role: 'Coach', current: false }],
}, {
  claimId: 'dclm-jo-aff', claimType: 'CLUB_AFFILIATION', pairId: 'dpair-jo',
  person: { id: 'usr-jo', name: 'Jo Denton', email: 'jo.denton@hackneymarshrovers.org.uk', accountCreatedAt: now - 20 * day, removed: false },
  claimedRole: null, requestedStart: null, identityStatus: 'verified',
  emailStatus: 'work_email_on_verified_domain', riskFlags: [], status: 'automated_checks_passed', requestedAt: now - 2 * day,
  priorClaims: [],
}];

const staff: StaffRow[] = [
  { claimId: 'dclm-tom', person: { id: 'usr-tom', name: 'Tom Field' }, claimType: 'CLUB_ROLE', role: 'Youth Coach', status: 'verified', effective: { status: 'verified', displayable: true, current: true, historical: false }, current: true, validFrom: now - 400 * day, validUntil: null, verificationMethod: 'organisation_admin_confirmation', verifiedAt: now - 390 * day },
  { claimId: 'dclm-priya', person: { id: 'usr-priya', name: 'Priya Nair' }, claimType: 'CLUB_ROLE', role: 'Assistant Coach', status: 'verified', effective: { status: 'verified', displayable: true, current: false, historical: true }, current: false, validFrom: y(2019), validUntil: y(2023), verificationMethod: 'organisation_admin_confirmation', verifiedAt: y(2019) },
  { claimId: 'dclm-sam-lic', person: { id: 'usr-sam', name: 'Sam Cole' }, claimType: 'LICENCE', role: null, status: 'requires_human_review', effective: { status: 'requires_human_review', displayable: false, current: false, historical: false }, current: true, validFrom: null, validUntil: null, verificationMethod: 'document_submitted', verifiedAt: null },
];

const domains: DomainRow[] = [{ domain: 'hackneymarshrovers.org.uk', status: 'verified', method: 'official_domain_email', verifiedAt: now - 200 * day, addedBy: 'usr-dee' }];
const domainRequests: DomainRequest[] = [];
const admins: VerAdminRow[] = [
  { id: 'dadm-1', userId: 'usr-dee', level: 'verification_root_admin', status: 'active', person: { id: 'usr-dee', name: 'Dee Coach' }, createdAt: now - 200 * day },
  { id: 'dadm-2', userId: 'usr-tom', level: 'verification_reviewer', status: 'active', person: { id: 'usr-tom', name: 'Tom Field' }, createdAt: now - 100 * day },
];
const transfers: RootTransfer[] = [];
const references: ReferenceRow[] = [{
  id: 'dref-1', version: 1, playerId: 'pl-guni', playerName: 'Marcus Guni', coachName: 'Tom Field', orgName: 'Hackney Marsh Rovers',
  roleAtTime: 'Youth Coach', relationship: 'Scouted and coached at development camp', capacity: '2 seasons',
  fromYear: 2024, toYear: 2026, structured: { strengths: 'Pressing triggers, first touch under pressure', development: 'Weak-foot delivery', summary: 'Reliable, coachable wide forward.' },
  status: 'active', createdAt: now - 30 * day,
}];
const invites: PlayerInviteRow[] = [{ id: 'dinv-1', name: 'Noor Haddad', squad: 'U18', status: 'accepted', byName: 'Tom Field', createdAt: now - 9 * day, expiresAt: now + 5 * day, guardianApproved: { guardianId: 'gd-1', at: now - 8 * day } }];
const conflicts: ConflictRow[] = [{ id: 'dcoi-1', userId: 'usr-tom', kind: 'family_relationship', subject: 'Nephew trials at U15', note: 'Declared before any assessment', createdAt: now - 40 * day, withdrawnAt: null }];

const publicProfiles: Record<string, PublicVerProfile> = {
  'usr-tom': {
    subjectType: 'user', subjectId: 'usr-tom', identityVerified: true,
    badges: [
      { kind: 'affiliation', claimType: 'CLUB_AFFILIATION', label: 'Verified at Hackney Marsh Rovers', organisation: { id: 'org-hackneymarsh', name: 'Hackney Marsh Rovers' }, role: null, current: true, historical: false, period: { from: 2025, to: null }, verifiedAt: now - 390 * day, provenance: 'Confirmed by an authorised Hackney Marsh Rovers administrator' },
      { kind: 'role', claimType: 'CLUB_ROLE', label: 'Role verified: Youth Coach', organisation: { id: 'org-hackneymarsh', name: 'Hackney Marsh Rovers' }, role: 'Youth Coach', current: true, historical: false, period: { from: 2025, to: null }, verifiedAt: now - 390 * day, provenance: 'Confirmed by an authorised Hackney Marsh Rovers administrator' },
    ],
  },
  'usr-priya': {
    subjectType: 'user', subjectId: 'usr-priya', identityVerified: true,
    badges: [{ kind: 'role', claimType: 'CLUB_ROLE', label: 'Former Hackney Marsh Rovers Assistant Coach · Verified history', organisation: { id: 'org-hackneymarsh', name: 'Hackney Marsh Rovers' }, role: 'Assistant Coach', current: false, historical: true, period: { from: 2019, to: 2023 }, verifiedAt: y(2019), provenance: 'Confirmed by an authorised Hackney Marsh Rovers administrator' }],
  },
};

const me: MyVerification = {
  claims: myClaims, verificationLevel: 'verification_root_admin', organisationStatus: 'verified',
  steps: [
    { id: 'identity', label: 'Verify identity', done: true, state: 'verified' },
    { id: 'organisation', label: 'Select organisation', done: true, state: 'done' },
    { id: 'role', label: 'Add professional role', done: true, state: 'done' },
    { id: 'work_email', label: 'Verify work email', done: true, state: 'done' },
    { id: 'confirmation', label: 'Organisation confirmation', done: true, state: 'verified' },
  ],
  publicPreview: {
    subjectType: 'user', subjectId: 'usr-dee', identityVerified: true,
    badges: [{ kind: 'role', claimType: 'CLUB_ROLE', label: 'Role verified: Club Manager', organisation: { id: 'org-hackneymarsh', name: 'Hackney Marsh Rovers' }, role: 'Club Manager', current: true, historical: false, period: { from: 2025, to: null }, verifiedAt: now - 290 * day, provenance: 'Confirmed by an authorised Hackney Marsh Rovers administrator' }],
  },
};

const dl = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 120));

export const demoM14: M14Api = {
  me: () => dl(me),
  startIdentity: () => dl({ claim: myClaims[0] }),
  requestAffiliation: (_s, role) => dl({ affiliation: mk({ claimType: 'CLUB_AFFILIATION', status: 'collecting_evidence' }), role: mk({ role, status: 'collecting_evidence' }), next: 'Prove control of your work email; the organisation confirms the relationship.' }),
  addEvidence: () => dl({ claim: myClaims[3] }),
  submitClaim: () => dl({ claim: myClaims[3] }),
  sendWorkEmail: () => dl({ sent: true, note: 'Demo: a single-use code would arrive at that mailbox (local outbox in dev).' }),
  confirmWorkEmail: () => dl({ domainControl: 'passed', domainCoveredByOrg: true, note: 'Email control recorded as evidence. It does NOT by itself verify employment.', claims: myClaims.slice(1, 3) }),
  disputeClaim: () => dl({ note: 'The claim is flagged, its history is preserved, and Trust & Safety reviews the dispute.' }),

  dashboard: () => dl({ organisationStatus: 'verified', counts: { verifiedStaff: 2, pending: requests.length / 2, humanReview: 1, expiringSoon: 0, disputed: 0, revoked: 0, domains: domains.length, administrators: admins.filter((a) => a.status === 'active').length } }),
  listRequests: () => dl({ items: requests, note: 'Decisions are audited. You cannot decide your own request.' }),
  decideRequest: (_s, claimId, action, opts) => {
    const rows = requests.filter((r) => r.pairId === (requests.find((x) => x.claimId === claimId)?.pairId ?? ''));
    for (const r of rows) requests.splice(requests.indexOf(r), 1);
    if (action !== 'reject') {
      staff.unshift({ claimId, person: rows[0]?.person ?? { id: 'x', name: '?' }, claimType: 'CLUB_ROLE', role: opts?.role ?? rows.find((r) => r.claimedRole)?.claimedRole ?? 'Staff', status: 'verified', effective: { status: 'verified', displayable: true, current: action !== 'mark_former', historical: action === 'mark_former' }, current: action !== 'mark_former', validFrom: now, validUntil: action === 'mark_former' ? now : null, verificationMethod: 'organisation_admin_confirmation', verifiedAt: now });
    }
    return dl({ decided: action, claims: [] });
  },
  listStaff: () => dl({ items: staff }),
  markDeparted: (_s, userId) => {
    for (const row of staff) if (row.person.id === userId && row.current) { row.current = false; row.validUntil = now; row.effective = { status: 'verified', displayable: true, current: false, historical: true }; }
    return dl({ closed: 1, note: 'Current badges end now; the historical verified period remains. The person can dispute this.' });
  },
  listDomains: () => dl({ domains, requests: domainRequests }),
  addDomain: (_s, domain) => {
    const request: DomainRequest = { id: `ddom-${domainRequests.length + 1}`, domain, status: 'requires_human_review', reviewReasons: ['HIGH_RISK_ADMIN_CHANGE'], createdAt: now };
    domainRequests.push(request);
    return dl({ request, note: 'Root or contested domain changes are reviewed by Trust & Safety before they take effect.' });
  },
  confirmDomain: (_s, requestId) => dl({ domain: domainRequests.find((r) => r.id === requestId)?.domain ?? '', status: 'verified' }),
  listAdmins: () => dl({ items: admins, transfers }),
  grantAdmin: (_s, userId, level) => {
    if (level === 'verification_root_admin') {
      const transfer: RootTransfer = { id: `dtx-${transfers.length + 1}`, toUserId: userId, proposedBy: 'usr-dee', status: 'pending', createdAt: now };
      transfers.push(transfer);
      return dl({ transfer, note: 'Root authority changes need a second approval: another root administrator, or Trust & Safety.' });
    }
    const admin: VerAdminRow = { id: `dadm-${admins.length + 1}`, userId, level, status: 'active', person: { id: userId, name: userId }, createdAt: now };
    admins.push(admin);
    return dl({ admin });
  },
  revokeAdmin: (_s, adminId) => {
    const a = admins.find((x) => x.id === adminId)!;
    a.status = 'revoked';
    return dl({ admin: a, note: 'Authority ends immediately. Previously approved claims keep their provenance.' });
  },
  approveTransfer: (_s, transferId) => {
    const tr = transfers.find((x) => x.id === transferId)!;
    tr.status = 'approved';
    const admin: VerAdminRow = { id: `dadm-${admins.length + 1}`, userId: tr.toUserId, level: 'verification_root_admin', status: 'active', person: { id: tr.toUserId, name: tr.toUserId }, createdAt: now };
    admins.push(admin);
    return dl({ transfer: tr, admin });
  },
  licenceProviders: () => dl({
    providers: [
      { id: 'fa-england', name: 'The FA coaching qualifications register', state: 'not_configured' },
      { id: 'uefa', name: 'UEFA coaching licence register', state: 'not_configured' },
    ],
    note: 'No production governing-body register is connected. Providers listed not_configured are real integration points, not working integrations.',
  }),
  submitLicence: () => dl({ claim: { id: 'dclm-new-lic', status: 'collecting_evidence', display: 'Credential submitted — verification pending' }, note: 'An uploaded credential is a document, not a verified licence.' }),
  runLicenceCheck: () => dl({ claim: { id: 'dclm-new-lic', status: 'requires_human_review', display: 'Credential submitted — verification pending' }, provider: { id: 'fa-england', state: 'not_configured' }, note: 'No authoritative register is configured for this issuer — a reviewer can perform a document review, which is labelled as a document review.' }),
  publicUser: (_s, userId) => dl(publicProfiles[userId] ?? { subjectType: 'user', subjectId: userId, identityVerified: false, badges: [] }),
  publicOrg: (_s, orgId) => dl({ subjectType: 'org', subjectId: orgId, identityVerified: false, organisationStatus: orgId === 'org-hackneymarsh' ? 'verified' : 'unverified', badges: orgId === 'org-hackneymarsh' ? [{ kind: 'organisation', claimType: 'ORGANISATION_IDENTITY', label: 'Verified organisation', organisation: { id: orgId, name: 'Hackney Marsh Rovers' }, role: null, current: true, historical: false, period: null, verifiedAt: now - 200 * day, provenance: 'Reviewed and confirmed by ScoutBox Trust & Safety' }] : [] }),
  listReferences: () => dl({ items: references }),
  createReference: (_s, input) => {
    const reference: ReferenceRow = { id: `dref-${references.length + 1}`, version: 1, playerId: input.playerId, playerName: input.playerId, coachName: 'You', orgName: 'Hackney Marsh Rovers', roleAtTime: 'Club Manager', relationship: input.relationship, capacity: input.capacity ?? '', fromYear: input.fromYear ?? null, toYear: input.toYear ?? null, structured: { strengths: input.strengths ?? '', development: input.development ?? '', summary: input.summary }, status: 'active', createdAt: now };
    references.unshift(reference);
    return dl({ reference });
  },
  withdrawReference: (_s, id) => {
    const r = references.find((x) => x.id === id)!;
    r.status = 'withdrawn';
    return dl({ reference: r });
  },
  listPlayerInvites: () => dl({ items: invites }),
  createPlayerInvite: (_s, name, squad) => {
    const invite: PlayerInviteRow = { id: `dinv-${invites.length + 1}`, name, squad, status: 'pending', byName: 'You', createdAt: now, expiresAt: now + 14 * day, guardianApproved: null };
    invites.unshift(invite);
    return dl({ invite, code: 'demo-invite-code', note: 'Demo: hand the single-use code to the player (or their guardian).' });
  },
  listConflicts: () => dl({ items: conflicts }),
  declareConflict: (_s, kind, subject, note) => {
    const conflict: ConflictRow = { id: `dcoi-${conflicts.length + 1}`, userId: 'usr-dee', kind, subject, note, createdAt: now, withdrawnAt: null };
    conflicts.unshift(conflict);
    return dl({ conflict, note: 'Declarations are explicit — never inferred, never public.' });
  },
};
