/**
 * Safety's request input: reports and blocks from players, guardians and staff, and the Trust & Safety console's
 * acts on reports, clubs, blocks and vouches. The routes keep the codes the apps already read (TARGET_KIND_REQUIRED,
 * REASON_REQUIRED, ORG_REQUIRED, ORG_AND_CHILD_REQUIRED, OUTCOME_REQUIRED, PASSWORD_TOO_SHORT).
 */
import * as v from 'valibot';
import { CURSOR_PAGE, flag, inputOrRefuse, oneOf, text } from '../platform/schemas.mjs';
import { AUDIT_LIMITS as L } from '../../repositories/safetyAudit.mjs';
import { ORG_LIMITS } from '../../repositories/orgs.mjs';

export const REPORT_TARGETS = ['club', 'scout', 'player'];
/** What the console sends with an outcome; only suspend_org changes anything beyond the report. */
export const RESOLVE_ACTIONS = ['none', 'warning', 'suspend_org', 'dismiss'];
const TARGET_MAX = 200;
const BLOCK_REASON_MAX = 500;
// Long enough for any pass phrase, short enough that hashing it costs nothing.
const PASSWORD_MAX = 256;

const optText = (max) => v.nullish(text(max));

export const SAFETY_INPUT = Object.freeze({
  report: v.strictObject({
    targetKind: v.nullish(oneOf(REPORT_TARGETS)),
    targetOrgId: optText(TARGET_MAX),
    targetScoutName: optText(TARGET_MAX),
    targetPlayerId: optText(TARGET_MAX),
    reason: optText(L.reason),
    urgent: v.nullish(flag),
  }),
  playerBlock: v.strictObject({ orgId: optText(TARGET_MAX), reason: optText(BLOCK_REASON_MAX) }),
  guardianBlock: v.strictObject({
    orgId: optText(TARGET_MAX),
    playerId: optText(TARGET_MAX),
    reason: optText(BLOCK_REASON_MAX),
  }),
  resolve: v.strictObject({ outcome: optText(L.outcome), action: v.nullish(oneOf(RESOLVE_ACTIONS)) }),
  credentials: v.strictObject({ password: optText(PASSWORD_MAX) }),
  clubStanding: v.strictObject({
    verified: v.optional(flag),
    safeguardingContractSigned: v.optional(flag),
    suspended: v.optional(flag),
    verifiedDomain: optText(ORG_LIMITS.domain),
  }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({ report: { targetKind: 'TARGET_KIND_REQUIRED' } });

/** The request input read with SAFETY_INPUT[name], or `undefined` once the 400 has been sent. */
export const safetyInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, SAFETY_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
