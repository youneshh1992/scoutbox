/**
 * The agent core and integration routes' request input. A refusal is AGENT_INPUT_INVALID with field and problem,
 * except where a field has kept a code of its own (tiers, jurisdictions, scope, term, the player's sharing choices).
 */
import * as v from 'valibot';
import {
  CURSOR_PAGE,
  REV_FIELDS,
  REV_FIELD_CODES,
  declaredCodes,
  flag,
  oneOf,
  text,
  wholeNumber,
  wholeNumberText,
} from '../../platform/schemas.mjs';
import { AGENT_CORE_LIMITS as L } from '../../../repositories/agentCore.mjs';
import { DISCLOSURE_KEYS, JURISDICTIONS, MAX_TERM_MONTHS, SCOPES, TIERS } from './shared.mjs';

// normaliseClientKey judges the key itself under AGENT_CLIENT_KEY_INVALID.
const clientKey = v.nullish(v.string());
const optText = (max) => v.nullish(text(max));
const distinct = (xs) => new Set(xs).size === xs.length;
const distinctList = (values, { min = 0 } = {}) =>
  v.pipe(v.array(oneOf(values)), v.minLength(min), v.check(distinct, 'must not name a value twice'));
// A member association is written as a code; the route reads it in capitals and checks it is one this build knows.
const memberAssociation = v.nullish(text(3));
const PlayerAnswer = { clientKey, ...REV_FIELDS };

export const AGENT_INPUT = Object.freeze({
  profile: v.strictObject({
    displayName: optText(L.displayName),
    fifaLicenceNumber: optText(L.licenceNumber),
    jurisdictions: v.optional(distinctList(JURISDICTIONS)),
    ...REV_FIELDS,
  }),
  facetSubmission: v.strictObject({ reference: optText(L.reference), memberAssociation }),
  newMember: v.strictObject({
    name: optText(L.staffName),
    role: optText(L.staffRole),
    tiers: distinctList(TIERS, { min: 1 }),
    clientKey,
  }),
  memberTiers: v.strictObject({ tiers: distinctList(TIERS, { min: 1 }), ...REV_FIELDS }),
  memberEnd: v.strictObject({ reason: optText(L.reasonCode), ...REV_FIELDS }),
  settings: v.strictObject({
    jurisdictions: v.optional(distinctList(JURISDICTIONS)),
    description: optText(L.description),
  }),
  auditQuery: v.strictObject({
    limit: v.optional(wholeNumberText({ min: 1, max: 50 })),
    cursor: v.optional(text(L.id)),
  }),
  playerLookup: v.strictObject({ q: v.optional(text(L.name)) }),
  clientRequest: v.strictObject({
    // An absent player is refused after the agent's own verification, as an unknown one is.
    playerId: v.optional(text(L.id)),
    scope: v.optional(distinctList(SCOPES, { min: 1 })),
    termMonths: v.nullish(wholeNumber({ min: 1, max: MAX_TERM_MONTHS })),
    jurisdiction: memberAssociation,
    exclusive: v.optional(flag),
    clientKey,
  }),
  agentTermination: v.strictObject({ reasonCode: optText(L.reasonCode), clientKey, ...REV_FIELDS }),
  playerAnswer: v.strictObject(PlayerAnswer),
  playerDispute: v.strictObject({ ...PlayerAnswer, reason: optText(L.disputeReason) }),
  sharing: v.strictObject({
    shareWithAgencyStaff: v.optional(flag),
    disclosure: v.optional(v.strictObject(Object.fromEntries(DISCLOSURE_KEYS.map((k) => [k, v.optional(flag)])))),
    ...REV_FIELDS,
  }),
  page: v.strictObject({ ...CURSOR_PAGE }),
  // integration
  opportunityShare: v.strictObject({ note: optText(L.shareNote), clientKey }),
  handoffInvite: v.strictObject({ clientKey }),
  none: v.strictObject({}),
});

const FIELD_CODES = Object.freeze({
  tiers: 'AGENT_TIERS_INVALID',
  jurisdictions: 'AGENT_JURISDICTION_INVALID',
  jurisdiction: 'AGENT_JURISDICTION_INVALID',
  scope: 'AGENT_SCOPE_INVALID',
  termMonths: 'AGENT_TERM_INVALID',
  clientKey: 'AGENT_CLIENT_KEY_INVALID',
  ...REV_FIELD_CODES,
});

/** The player's own choices keep the code their refusals have always had. */
const CODE_OF = Object.freeze({ sharing: 'REPRESENTATION_INPUT_INVALID' });

export const agentParseOptions = (name, root = 'body') => {
  const code = CODE_OF[name] ?? 'AGENT_INPUT_INVALID';
  return { root, codes: { FIELD_INVALID: code }, fieldCodes: declaredCodes(AGENT_INPUT[name], FIELD_CODES) };
};
