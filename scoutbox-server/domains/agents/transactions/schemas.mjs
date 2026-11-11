/**
 * The transaction routes' request input. A refusal keeps the route's code (TRANSACTION_, DOCUMENT_, NOTE_,
 * TERMS_INPUT_INVALID) through transactionParseOptions and says which field and what was wrong with it.
 *
 * A visibility is only checked to be text here: which lanes a caller may write into depends on their seat in the
 * transaction, so the route refuses the others as DOCUMENT_VISIBILITY_NOT_PERMITTED with the lanes it may use.
 */
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  REV_FIELDS,
  REV_FIELD_CODES,
  declaredCodes,
  dueDate,
  id,
  oneOf,
  text,
} from '../../platform/schemas.mjs';
import { AGENT_TRANSACTION_LIMITS as AL } from '../../../repositories/agentTransactions.mjs';
import {
  DOCUMENT_TYPES,
  PARTY_ROLES,
  TRANSACTION_LIMITS as L,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from './transaction.mjs';

// normaliseClientKey judges the key itself under TRANSACTION_CLIENT_KEY_INVALID.
const clientKey = v.nullish(v.string());
const optText = (max) => v.nullish(text(max));
const visibility = v.optional(text(60));
const memberAssociation = v.pipe(v.string(), v.regex(/^[A-Za-z]{3}$/, 'must be a three-letter code'));
const Party = { partyRole: oneOf(PARTY_ROLES), subjectKind: oneOf(['player', 'club']), subjectId: id };
const RevOnly = v.strictObject({ ...REV_FIELDS });

export const TRANSACTION_INPUT = Object.freeze({
  list: v.strictObject({ status: v.optional(oneOf(TRANSACTION_STATUSES)), ...CURSOR_PAGE }),
  clubList: v.strictObject({ ...CURSOR_PAGE }),
  create: v.strictObject({
    type: oneOf(TRANSACTION_TYPES),
    jurisdictions: v.pipe(v.array(memberAssociation), v.minLength(1), v.maxLength(AL.jurisdictions)),
    parties: v.nullish(v.pipe(v.array(v.strictObject(Party)), v.maxLength(L.parties))),
    // '' cites no case, as an absent one does.
    recruitmentCaseId: v.nullish(text(AL.id)),
    clientKey,
  }),
  party: v.strictObject({ ...Party, clientKey, ...REV_FIELDS }),
  representation: v.strictObject({
    partyRole: oneOf(PARTY_ROLES),
    agreementId: v.nullish(id),
    clientKey,
    ...REV_FIELDS,
  }),
  rev: RevOnly,
  evaluation: v.strictObject({}),
  status: v.strictObject({
    to: oneOf(TRANSACTION_STATUSES),
    reasonCode: optText(AL.code),
    reason: optText(L.reason),
    clientKey,
    ...REV_FIELDS,
  }),
  terms: v.strictObject({
    summary: optText(L.note),
    recordedFor: oneOf(PARTY_ROLES),
    visibility,
    ...REV_FIELDS,
  }),
  opportunityLink: v.strictObject({ opportunityId: id, ...REV_FIELDS }),
  trialLink: v.strictObject({ trialId: id, ...REV_FIELDS }),
  threadLink: v.strictObject({ channelId: id, ...REV_FIELDS }),
  document: v.strictObject({
    documentType: oneOf(DOCUMENT_TYPES),
    visibility,
    label: optText(L.label),
    evidenceRef: v.nullish(v.strictObject({ kind: oneOf(['verification_evidence']), id })),
    expiresAt: v.optional(dueDate),
    clientKey,
    ...REV_FIELDS,
  }),
  supersession: v.strictObject({ label: optText(L.label), ...REV_FIELDS }),
  note: v.strictObject({ text: optText(L.note), visibility, ...REV_FIELDS }),
});

const CODE_OF = Object.freeze({ terms: 'TERMS_INPUT_INVALID', note: 'NOTE_INPUT_INVALID' });
const DOCUMENT_SCHEMAS = new Set(['document', 'supersession']);

/**
 * A malformed rev is refused as guardRev refuses it, and a malformed client key as the idempotency check does. A
 * schema that takes neither refuses one sent to it as an unknown field, under the route's own code.
 */
export const transactionParseOptions = (name, root = 'body') => {
  const code = DOCUMENT_SCHEMAS.has(name) ? 'DOCUMENT_INPUT_INVALID' : (CODE_OF[name] ?? 'TRANSACTION_INPUT_INVALID');
  return {
    root,
    codes: { FIELD_INVALID: code, DATE_INVALID: code },
    fieldCodes: declaredCodes(TRANSACTION_INPUT[name], {
      ...REV_FIELD_CODES,
      clientKey: 'TRANSACTION_CLIENT_KEY_INVALID',
    }),
  };
};
