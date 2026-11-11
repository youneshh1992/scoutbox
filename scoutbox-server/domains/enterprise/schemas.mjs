/**
 * Enterprise's request input: staff invites, MFA, sessions, SSO with the local test identity provider, support
 * tickets and access grants, and backup checks. The routes keep the codes the apps already read for a missing field
 * (EMAIL_INVALID, NAME_REQUIRED, SUBJECT_REQUIRED).
 */
import * as v from 'valibot';
import { CURSOR_PAGE, flag, id, inputOrRefuse, oneOf, requiredText, text, wholeNumber } from '../platform/schemas.mjs';
import { ENTERPRISE_LIMITS as L, SUPPORT_REF_KINDS } from '../../repositories/enterprise.mjs';
import { STAFF_LIMITS } from '../../repositories/users.mjs';

// An emailed invite code, an SSO state and a session id are short hex; a signed test-IdP code is a little longer.
const CODE_MAX = 128;
const SIGNED_CODE_MAX = 4096;
const ISSUER_MAX = 200;
const BACKUP_DIR_MAX = 200;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const optText = (max) => v.nullish(text(max));

export const ENTERPRISE_INPUT = Object.freeze({
  invite: v.strictObject({
    email: v.pipe(v.string(), v.maxLength(L.email), v.regex(EMAIL)),
    name: optText(L.inviteName),
    role: v.nullish(requiredText(L.role)),
  }),
  acceptInvite: v.strictObject({ token: optText(CODE_MAX), scoutName: optText(STAFF_LIMITS.name) }),
  mfaCode: v.strictObject({ code: optText(CODE_MAX) }),
  security: v.strictObject({ mfaRequiredForLeads: flag }),
  revokeSession: v.strictObject({ sid: optText(CODE_MAX) }),
  sso: v.strictObject({ issuer: optText(ISSUER_MAX) }),
  ssoStart: v.strictObject({ orgId: optText(L.id) }),
  testIdpQuery: v.strictObject({
    client_id: v.optional(text(L.clientId)),
    state: v.optional(text(CODE_MAX)),
    nonce: v.optional(text(CODE_MAX)),
    email: v.optional(text(L.email)),
    groups: v.optional(text()),
  }),
  ssoCallback: v.strictObject({ code: optText(SIGNED_CODE_MAX), state: optText(CODE_MAX) }),
  ticket: v.strictObject({
    subject: optText(L.subject),
    body: optText(L.body),
    refs: v.nullish(v.pipe(v.array(v.strictObject({ kind: oneOf(SUPPORT_REF_KINDS), id })), v.maxLength(L.refs))),
  }),
  reply: v.strictObject({ text: optText(L.reply), close: v.nullish(flag) }),
  accessRequest: v.strictObject({ hours: v.nullish(wholeNumber({ min: L.hours[0], max: L.hours[1] })) }),
  backupDir: v.strictObject({ dir: text(BACKUP_DIR_MAX) }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({ invite: { email: 'EMAIL_INVALID' } });

/** The request input read with ENTERPRISE_INPUT[name], or `undefined` once the 400 has been sent. */
export const enterpriseInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, ENTERPRISE_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
