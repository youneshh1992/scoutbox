// The input schemas of the organisation verification routes.
import * as v from 'valibot';
import { ID_MAX, dueDate, flag, id, idsText, oneOf, text, wholeNumber } from '../../platform/schemas.mjs';
import { VER_LEVELS } from './shared.mjs';
import {
  VERIFICATION_LIMITS as L,
  CLAIM_STATES,
  CONFLICT_KINDS,
  METHODS,
  ROOT_ORG_TYPES,
} from '../../../repositories/verification.mjs';

export const optText = (max) => v.nullish(text(max));
// A one-time code from an e-mail or an invitation (a 32-character base64url secret); anything longer cannot match.
export const code = optText(64);
/** A file is optional when a note says what the evidence is. */
export const EvidenceUpload = v.strictObject({
  dataUrl: v.nullish(v.string()),
  filename: optText(L.filename),
  note: optText(L.note),
});
export const Affiliation = v.strictObject({ role: optText(L.role), validFrom: v.optional(dueDate) });
export const WorkEmail = v.strictObject({ email: text(L.email) });
export const WorkEmailConfirm = v.strictObject({ code, email: optText(L.email) });
export const EMAIL_CODES = { fieldCodes: { email: 'EMAIL_SYNTAX' } };
export const Reason = v.strictObject({ reason: optText(L.reason) });
export const PublicUsersQuery = v.strictObject({ ids: v.optional(idsText(100)) });
const DECISIONS = ['confirm', 'correct_role', 'mark_former', 'reject', 'request_info'];
export const Decision = v.strictObject({
  action: oneOf(DECISIONS),
  role: optText(L.role),
  validFrom: v.optional(dueDate),
  validUntil: v.optional(dueDate),
  reason: optText(L.reason),
});
export const DECISION_CODES = { fieldCodes: { action: 'ACTION_UNKNOWN' } };
export const StaffQuery = v.strictObject({
  state: v.optional(oneOf(CLAIM_STATES)),
  current: v.optional(oneOf(['true', 'false'])),
  method: v.optional(oneOf(METHODS)),
  role: v.optional(text(L.role)),
});
export const STAFF_QUERY_CODES = { root: 'query' };
export const Departure = v.strictObject({ validUntil: v.optional(dueDate) });
export const NewDomain = v.strictObject({ domain: optText(L.domain), challengeEmail: optText(L.email) });
export const DOMAIN_CODES = { fieldCodes: { domain: 'DOMAIN_INVALID' } };
export const Code = v.strictObject({ code });
export const AdminGrant = v.strictObject({ userId: id, level: oneOf(VER_LEVELS) });
export const ADMIN_GRANT_CODES = { fieldCodes: { level: 'LEVEL_UNKNOWN' } };
export const Conflict = v.strictObject({
  kind: oneOf(CONFLICT_KINDS),
  subject: optText(L.subject),
  note: optText(L.note),
});
export const CONFLICT_CODES = { fieldCodes: { kind: 'KIND_UNKNOWN' } };
export const PlayerInvite = v.strictObject({
  name: optText(L.inviteeName),
  squad: optText(L.squad),
  email: optText(L.email),
  // '' is the form's "no player".
  playerId: optText(ID_MAX),
});
export const InviteAnswer = v.strictObject({ code, email: optText(L.email) });
export const GuardianInviteAnswer = v.strictObject({ code, childId: id });
const year = v.nullish(wholeNumber({ min: 1900, max: 2100 }));
export const NewReference = v.strictObject({
  playerId: id,
  relationship: optText(L.relationship),
  capacity: optText(L.capacity),
  fromYear: year,
  toYear: year,
  strengths: optText(L.strengths),
  development: optText(L.development),
  summary: optText(L.summary),
});
export const ReferenceWithdrawal = v.strictObject({ reason: optText(L.withdrawReason) });
export const ReferenceCorrection = v.strictObject({
  strengths: optText(L.strengths),
  development: optText(L.development),
  summary: optText(L.summary),
});
export const APPLICATION_REQUIRED = [
  'orgName',
  'orgType',
  'country',
  'website',
  'applicantName',
  'applicantRole',
  'workEmail',
];
export const secret = optText(64);
export const Application = v.strictObject({
  orgName: optText(L.orgName),
  orgType: v.nullish(oneOf(ROOT_ORG_TYPES)),
  country: optText(L.country),
  website: optText(L.website),
  applicantName: optText(L.applicantName),
  applicantRole: optText(L.applicantRole),
  workEmail: optText(L.email),
  federation: optText(L.federation),
  domain: optText(L.domain),
  officialContact: optText(L.officialContact),
  declarations: v.nullish(v.strictObject({ authorised: flag })),
});
export const APPLICATION_CODES = { fieldCodes: { orgType: 'ORG_TYPE_UNKNOWN' } };
export const ApplicationEmailConfirm = v.strictObject({ applicantSecret: secret, code });
export const ApplicationEvidence = v.strictObject({ applicantSecret: secret, ...EvidenceUpload.entries });
export const ApplicationSubmit = v.strictObject({ applicantSecret: secret });
export const ApplicationStatusQuery = v.strictObject({ applicantSecret: v.optional(text(64)) });

export const AFFILIATION_TYPE = (org) =>
  org.type === 'agency'
    ? ['AGENCY_AFFILIATION', 'AGENCY_ROLE']
    : org.level === 'grassroots'
      ? ['GRASSROOTS_AFFILIATION', 'CLUB_ROLE']
      : ['CLUB_AFFILIATION', 'CLUB_ROLE'];
