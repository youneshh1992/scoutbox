/**
 * S11a — the agent core as typed tables (migration `0026_agent_core`; docs/architecture/migration.md §4.5 S11;
 * sql/06_agent_compliance_transactions.sql).
 *
 * Records:
 *   - An agent profile: the licensed natural person's declared details and their verification facets. The declared
 *     jurisdictions are ordered rows; each facet is a row keyed by (facet, member association), the FIFA licence under
 *     'INT' (read back as `memberAssociation: null`). `policyVersion` is not stored (always the agent policy version).
 *   - An agency affiliation: a staff member's membership of an agency, with ordered role (tier) rows.
 *   - A representation agreement: the client-confirmed relationship, with ordered scope and policy-version rows, the
 *     client's disclosure choices as three columns and the agent's opportunity shares as rows. `isRegulatoryMinor` is
 *     not stored (always false: a minor is refused before a request exists); `policyVersion` likewise.
 *   - An agency's settings (the retired `orgs.agencySettings` facet): a description and ordered jurisdiction rows.
 *
 * History. Each record's history is ordered rows whose detail is typed columns, by action (no JSON): a facet change
 * names the facet, member association and states; an affiliation change its roles (rows); an agreement change its
 * statuses, side, reason code or review; a request's detail (scope, term, jurisdiction, policy versions) is read from
 * the agreement itself, which never changes them.
 *
 * Idempotency keys are columns of their owner (`keys.<slot>` = `{ key, fp }`): an affiliation's create; an
 * agreement's request, confirm, decline, terminate (the client's), dispute and agentTerminate; a share's share.
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` type the whole record and write it at once,
 * joined into the open unit of work, the caller's open transaction, or a transaction of their own; an unknown field and
 * an update from inside its own update are refused. History only grows; a profile's user and agency, an affiliation's
 * agency, user and start, and an agreement's parties, scope, jurisdiction, exclusivity, term and policy versions never
 * change; shares only gain rows.
 *
 * READS are SQL: no mirror. Queries decode fresh, deep-frozen records in insertion (rowid) order unless they say
 * otherwise. Modules receive them as `agentReads`.
 *
 * References. Staff ids → org_users and agencies → orgs are immediate RESTRICT keys; a client (player) id carries no key
 * (tolerant, as recruitment: an agreement outlives an account deletion as an id-only tombstone). Child rows cascade.
 * Policy versions are checked against the seeded policy ids in code until S11b makes the policies rows.
 */
import { isPlainObject, describe, ids } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { text, int, bool, oneOf, group, tableDdl, bad, typeSpec, encode, decode, upsertSql, quote } from './fieldSpecs.mjs';
import { VERIFICATION_STATES, FACETS, JURISDICTIONS, TIERS, AGREEMENT_STATUSES, SCOPES, MAX_TERM_MONTHS, DISCLOSURE_KEYS, MAX_OPPORTUNITY_SHARES } from '../domains/agents/core/shared.mjs';

export const AGENT_CORE_MIGRATION = '0026_agent_core';
export const AGENT_CORE_COLLECTIONS = Object.freeze(['agentProfiles', 'agencyAffiliations', 'representationAgreements']);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
/** Text limits: the routes refuse longer input naming the field. */
export const AGENT_CORE_LIMITS = Object.freeze({
  id: 80, name: 200, displayName: 80, licenceNumber: 40, reference: 60, note: 1000, reasonCode: 40, disputeReason: 300,
  description: 300, staffName: 80, staffRole: 60, key: 64, fp: 4000, shareNote: 300, shareTitle: 200, deadline: 40,
});
const L = AGENT_CORE_LIMITS;
/** Who an entry or a revision names. */
export const AGENT_ACTOR_KINDS = Object.freeze(['org', 'player', 'ts_reviewer', 'system']);
/** Where a stored facet's state came from. */
export const PROVENANCE_PROVIDERS = Object.freeze(['none', 'local-synthetic-test-provider', 'attributed_review']);
export const PROVENANCE_KINDS = Object.freeze(['none', 'synthetic', 'human_review']);
/** Statuses an agreement can be WRITTEN with (`expired` is derived from the end date, never stored). */
export const STORED_AGREEMENT_STATUSES = Object.freeze(AGREEMENT_STATUSES.filter((s) => s !== 'expired'));
export const TERMINATED_BY = Object.freeze(['agent', 'client', 'trust_safety']);
export const DISPUTE_OUTCOMES = Object.freeze(['reinstated', 'ended']);
export const SHARE_VIA = Object.freeze(['opportunity', 'open_trial']);
/** The facets kept per member association; the FIFA licence is one row under 'INT'. */
const MA_FACETS = Object.freeze(FACETS.filter((f) => f !== 'fifa_licence'));
const FIFA_MA = 'INT';
/** Agreement idempotency slots: the agent's request and terminate, the client's four answers. */
export const AGREEMENT_KEY_SLOTS = Object.freeze(['request', 'confirm', 'decline', 'terminate', 'dispute', 'agentTerminate']);
const SLOT_COLUMN = Object.freeze({ request: 'request', confirm: 'confirm', decline: 'decline', terminate: 'client_terminate', dispute: 'dispute', agentTerminate: 'agent_terminate' });

export const PROFILE_ACTIONS = Object.freeze(['agent_profile_created', 'agent_profile_updated', 'agent_verification_submitted', 'agent_verification_state_changed', 'agent_facet_rechecked']);
export const AFFILIATION_ACTIONS = Object.freeze(['agency_affiliation_created', 'agency_affiliation_updated', 'agency_affiliation_ended']);
export const AGREEMENT_ACTIONS = Object.freeze(['representation_requested', 'representation_confirmed', 'representation_rejected', 'representation_terminated', 'representation_disputed', 'representation_sharing_changed', 'opportunity_shared', 'opportunity_share_withdrawn']);
/** The profile fields an update names, in the order the route lists them. */
export const PROFILE_FIELDS = Object.freeze(['displayName', 'jurisdictions', 'fifaLicenceNumber']);
const FIELD_COLUMN = Object.freeze({ displayName: 'detail_display_name', jurisdictions: 'detail_jurisdictions', fifaLicenceNumber: 'detail_licence_number' });
const SHARING_KEYS = Object.freeze(['shareWithAgencyStaff', ...DISCLOSURE_KEYS]);
const SHARING_COLUMN = Object.freeze({ shareWithAgencyStaff: 'detail_share_with_agency_staff', clubPresence: 'detail_club_presence', contactRouting: 'detail_contact_routing', trialVisibility: 'detail_trial_visibility' });

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, o);
const req = { req: true, nonEmpty: true };
const REV_BY = group('revBy', [text('name', 'rev_by_name', L.name), idf('userId', 'rev_by_id')], { nullable: true });
const PROFILE_SPEC = [
  idf('id', 'id', req), idf('userId', 'user_id', req), idf('agencyOrgId', 'agency_org_id', req),
  text('displayName', 'display_name', L.displayName, req),
  int('createdAt', 'created_at', { req: true }), int('updatedAt', 'updated_at', { req: true }),
  int('rev', 'rev', { req: true }), int('revAt', 'rev_at'), REV_BY,
];
const FACET_SPEC = [
  oneOf('state', 'state', VERIFICATION_STATES, { req: true }), text('reference', 'reference', L.reference, { nonEmpty: true }),
  group('provenance', [
    oneOf('provider', 'provenance_provider', PROVENANCE_PROVIDERS, { req: true }), oneOf('kind', 'provenance_kind', PROVENANCE_KINDS, { req: true }),
    int('at', 'provenance_at', { req: true }), idf('reviewerId', 'provenance_reviewer_id', { nonEmpty: true }), idf('reviewId', 'provenance_review_id', { nonEmpty: true }),
  ], { nullable: true }),
  int('submittedAt', 'submitted_at'), int('verifiedAt', 'verified_at'), int('recheckAt', 'recheck_at'),
  text('note', 'note', L.note), int('staleNotifiedAt', 'stale_notified_at'),
];
const KEY_GROUP = (k, col) => group(k, [text('key', `${col}_key`, L.key, req), text('fp', `${col}_fp`, L.fp, { req: true })], { nullable: true });
const AFFILIATION_SPEC = [
  idf('id', 'id', req), idf('agencyOrgId', 'agency_org_id', req), idf('userId', 'user_id', req),
  int('startedAt', 'started_at', { req: true }), int('endedAt', 'ended_at'), text('endedReason', 'ended_reason', L.reasonCode),
  int('createdAt', 'created_at', { req: true }), int('rev', 'rev', { req: true }), int('revAt', 'rev_at'), REV_BY,
];
const AGREEMENT_SPEC = [
  idf('id', 'id', req), idf('agentUserId', 'agent_user_id', req), idf('agencyOrgId', 'agency_org_id', req),
  oneOf('clientKind', 'client_kind', ['player'], { req: true }), idf('clientId', 'client_id', req),
  oneOf('jurisdiction', 'jurisdiction', JURISDICTIONS, { req: true }), bool('exclusive', 'exclusive', { req: true }),
  int('termMonths', 'term_months', { req: true }), int('startAt', 'start_at'), int('endAt', 'end_at'),
  oneOf('status', 'status', STORED_AGREEMENT_STATUSES, { req: true }), int('proposedAt', 'proposed_at', { req: true }),
  int('confirmedAt', 'confirmed_at'), int('declinedAt', 'declined_at'), int('terminatedAt', 'terminated_at'),
  oneOf('terminatedBy', 'terminated_by', TERMINATED_BY), text('terminationReasonCode', 'termination_reason_code', L.reasonCode),
  int('disputedAt', 'disputed_at'), text('disputeReason', 'dispute_reason', L.disputeReason),
  int('disputeResolvedAt', 'dispute_resolved_at'),
  group('disputeResolution', [idf('reviewId', 'dispute_review_id', req), oneOf('outcome', 'dispute_outcome', DISPUTE_OUTCOMES, { req: true })], { nullable: true }),
  bool('shareWithAgencyStaff', 'share_with_agency_staff', { req: true }),
  group('disclosure', DISCLOSURE_KEYS.map((k) => bool(k, `disclosure_${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`, { req: true, def: false })), { sparse: true }),
  int('subjectRemovedAt', 'subject_removed_at'), int('expiryNotifiedAt', 'expiry_notified_at'),
  int('createdAt', 'created_at', { req: true }), int('rev', 'rev', { req: true }), int('revAt', 'rev_at'), REV_BY,
];
const AGREEMENT_KEYS_SPEC = AGREEMENT_KEY_SLOTS.map((s) => KEY_GROUP(s, SLOT_COLUMN[s]));
const SHARE_SPEC = [
  idf('id', 'id', req), idf('opportunityId', 'opportunity_id', req), oneOf('via', 'via', SHARE_VIA),
  text('title', 'title', L.shareTitle), text('orgName', 'org_name', L.name), text('deadline', 'deadline', L.deadline),
  text('note', 'note', L.shareNote, { nonEmpty: true }), int('sharedAt', 'shared_at', { req: true }),
  group('sharedBy', [oneOf('kind', 'shared_by_kind', ['org'], { req: true }), idf('userId', 'shared_by_user_id', req), text('name', 'shared_by_name', L.name)]),
  int('withdrawnAt', 'withdrawn_at'), int('rev', 'rev', { req: true }), int('revAt', 'rev_at', { req: true }),
];

// ------------------------------------------------------------------ DDL
const fk = (col, table, on = 'RESTRICT') => `FOREIGN KEY (${col}) REFERENCES ${table}(id) ON DELETE ${on}`;
const inList = (c, vals) => `${c} IN (${vals.map(quote).join(',')})`;
const stateCol = (c) => `${c} TEXT CHECK (${c} IS NULL OR ${inList(c, VERIFICATION_STATES)})`;
const statusCol = (c) => `${c} TEXT CHECK (${c} IS NULL OR ${inList(c, AGREEMENT_STATUSES)})`;
export const AGENT_CORE_DDL = [
  tableDdl('agent_profiles', [...PROFILE_SPEC, text('fifaLicenceNumber', 'declared_fifa_licence_number', L.licenceNumber, { nonEmpty: true })], [
    fk('user_id', 'org_users'), fk('agency_org_id', 'orgs'), 'UNIQUE (user_id)', 'CHECK (rev >= 1)',
  ]),
  'CREATE INDEX agent_profiles_agency ON agent_profiles (agency_org_id);',
  `CREATE TABLE agent_profile_jurisdictions (
  profile_id    TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL CHECK (ord >= 0),
  jurisdiction  TEXT NOT NULL CHECK (${inList('jurisdiction', JURISDICTIONS)}),
  PRIMARY KEY (profile_id, jurisdiction),
  UNIQUE (profile_id, ord)
) STRICT;`,
  tableDdl('agent_profile_facets', [
    idf('profileId', 'profile_id', req), oneOf('facet', 'facet', FACETS, { req: true }), oneOf('memberAssociation', 'member_association', JURISDICTIONS, { req: true }), ...FACET_SPEC,
  ], [
    'FOREIGN KEY (profile_id) REFERENCES agent_profiles(id) ON DELETE CASCADE',
    'PRIMARY KEY (profile_id, facet, member_association)',
    `CHECK ((facet = 'fifa_licence') = (member_association = '${FIFA_MA}'))`,
    "CHECK (provenance_reviewer_id IS NULL OR provenance_provider = 'attributed_review')",
  ]),
  "CREATE INDEX agent_profile_facets_stale ON agent_profile_facets (recheck_at) WHERE state = 'VERIFIED' AND stale_notified_at IS NULL AND recheck_at IS NOT NULL;",
  `CREATE TABLE agent_profile_history (
  id                    TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  profile_id            TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  ord                   INTEGER NOT NULL CHECK (ord >= 0),
  at                    INTEGER NOT NULL,
  by_kind               TEXT NOT NULL CHECK (${inList('by_kind', AGENT_ACTOR_KINDS)}),
  by_id                 TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= ${L.id})),
  by_name               TEXT CHECK (by_name IS NULL OR length(by_name) <= ${L.name}),
  by_role               TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  action                TEXT NOT NULL CHECK (${inList('action', PROFILE_ACTIONS)}),
  detail_display_name   INTEGER CHECK (detail_display_name IN (0,1)),
  detail_jurisdictions  INTEGER CHECK (detail_jurisdictions IN (0,1)),
  detail_licence_number INTEGER CHECK (detail_licence_number IN (0,1)),
  detail_facet          TEXT CHECK (detail_facet IS NULL OR ${inList('detail_facet', FACETS)}),
  detail_ma             TEXT CHECK (detail_ma IS NULL OR ${inList('detail_ma', JURISDICTIONS)}),
  ${stateCol('detail_from')},
  ${stateCol('detail_to')},
  ${stateCol('detail_state')},
  detail_review_id      TEXT CHECK (detail_review_id IS NULL OR (length(detail_review_id) > 0 AND length(detail_review_id) <= ${L.id})),
  UNIQUE (profile_id, ord),
  CHECK ((action = 'agent_profile_updated') = (detail_display_name IS NOT NULL)),
  CHECK ((detail_display_name IS NULL) = (detail_jurisdictions IS NULL) AND (detail_display_name IS NULL) = (detail_licence_number IS NULL)),
  CHECK ((action IN ('agent_verification_submitted','agent_verification_state_changed','agent_facet_rechecked')) = (detail_facet IS NOT NULL)),
  CHECK ((action IN ('agent_verification_state_changed','agent_facet_rechecked')) = (detail_to IS NOT NULL)),
  CHECK ((detail_from IS NULL) = (detail_to IS NULL)),
  CHECK ((action = 'agent_verification_state_changed') = (detail_state IS NOT NULL)),
  CHECK (detail_review_id IS NULL OR action = 'agent_verification_state_changed')
) STRICT;`,
  tableDdl('agency_affiliations', [...AFFILIATION_SPEC, KEY_GROUP('keys', 'create')], [
    fk('agency_org_id', 'orgs'), fk('user_id', 'org_users'), 'CHECK (rev >= 1)', 'CHECK (ended_at IS NULL OR ended_reason IS NOT NULL)',
    'CHECK ((create_key IS NULL) = (create_fp IS NULL))',
  ]),
  'CREATE INDEX agency_affiliations_member ON agency_affiliations (user_id, agency_org_id);',
  'CREATE INDEX agency_affiliations_agency ON agency_affiliations (agency_org_id, ended_at);',
  'CREATE UNIQUE INDEX agency_affiliations_create_key ON agency_affiliations (agency_org_id, create_key) WHERE create_key IS NOT NULL;',
  `CREATE TABLE agency_affiliation_tiers (
  affiliation_id  TEXT NOT NULL REFERENCES agency_affiliations(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL CHECK (ord >= 0),
  tier            TEXT NOT NULL CHECK (${inList('tier', TIERS)}),
  PRIMARY KEY (affiliation_id, tier),
  UNIQUE (affiliation_id, ord)
) STRICT;`,
  `CREATE TABLE agency_affiliation_history (
  id                    TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  affiliation_id        TEXT NOT NULL REFERENCES agency_affiliations(id) ON DELETE CASCADE,
  ord                   INTEGER NOT NULL CHECK (ord >= 0),
  at                    INTEGER NOT NULL,
  by_kind               TEXT NOT NULL CHECK (${inList('by_kind', AGENT_ACTOR_KINDS)}),
  by_id                 TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= ${L.id})),
  by_name               TEXT CHECK (by_name IS NULL OR length(by_name) <= ${L.name}),
  by_role               TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  action                TEXT NOT NULL CHECK (${inList('action', AFFILIATION_ACTIONS)}),
  detail_bootstrap      INTEGER CHECK (detail_bootstrap IN (1)),
  detail_reason_code    TEXT CHECK (detail_reason_code IS NULL OR length(detail_reason_code) <= ${L.reasonCode}),
  UNIQUE (affiliation_id, ord),
  CHECK (detail_bootstrap IS NULL OR action = 'agency_affiliation_created'),
  CHECK ((action = 'agency_affiliation_ended') = (detail_reason_code IS NOT NULL))
) STRICT;`,
  `CREATE TABLE agency_affiliation_history_tiers (
  history_id  TEXT NOT NULL REFERENCES agency_affiliation_history(id) ON DELETE CASCADE,
  list        TEXT NOT NULL CHECK (list IN ('from','to')),
  ord         INTEGER NOT NULL CHECK (ord >= 0),
  tier        TEXT NOT NULL CHECK (${inList('tier', TIERS)}),
  PRIMARY KEY (history_id, list, ord)
) STRICT;`,
  tableDdl('representation_agreements', [...AGREEMENT_SPEC, idf('confirmedByPlayerId', 'confirmed_by_player_id', { nonEmpty: true }), ...AGREEMENT_KEYS_SPEC], [
    fk('agent_user_id', 'org_users'), fk('agency_org_id', 'orgs'),
    `CHECK (term_months BETWEEN 1 AND ${MAX_TERM_MONTHS})`, 'CHECK (rev >= 1)',
    'CHECK ((confirmed_at IS NULL) = (confirmed_by_player_id IS NULL))',
    "CHECK ((status = 'declined') = (declined_at IS NOT NULL))",
    "CHECK ((terminated_at IS NULL) = (terminated_by IS NULL))",
    "CHECK (status NOT IN ('terminated_by_client','terminated_by_agent') OR terminated_at IS NOT NULL)",
    "CHECK (status <> 'disputed' OR disputed_at IS NOT NULL)",
    'CHECK ((dispute_resolved_at IS NULL) = (dispute_review_id IS NULL))',
    ...AGREEMENT_KEY_SLOTS.map((s) => `CHECK ((${SLOT_COLUMN[s]}_key IS NULL) = (${SLOT_COLUMN[s]}_fp IS NULL))`),
  ]),
  'CREATE INDEX representation_agreements_agency_agent ON representation_agreements (agency_org_id, agent_user_id);',
  'CREATE INDEX representation_agreements_client ON representation_agreements (client_id);',
  "CREATE INDEX representation_agreements_expiry ON representation_agreements (end_at) WHERE status = 'active' AND expiry_notified_at IS NULL AND end_at IS NOT NULL;",
  'CREATE UNIQUE INDEX representation_agreements_request_key ON representation_agreements (agency_org_id, agent_user_id, request_key) WHERE request_key IS NOT NULL;',
  `CREATE TABLE agreement_scopes (
  agreement_id  TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL CHECK (ord >= 0),
  scope         TEXT NOT NULL CHECK (${inList('scope', SCOPES)}),
  PRIMARY KEY (agreement_id, scope),
  UNIQUE (agreement_id, ord)
) STRICT;`,
  `CREATE TABLE agreement_policy_versions (
  agreement_id       TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  ord                INTEGER NOT NULL CHECK (ord >= 0),
  policy_version_id  TEXT NOT NULL CHECK (length(policy_version_id) > 0 AND length(policy_version_id) <= ${L.id}),
  PRIMARY KEY (agreement_id, policy_version_id),
  UNIQUE (agreement_id, ord)
) STRICT;`,
  tableDdl('agreement_opportunity_shares', [idf('agreementId', 'agreement_id', req), int('ord', 'ord', { req: true }), ...SHARE_SPEC, KEY_GROUP('keys', 'share')], [
    'FOREIGN KEY (agreement_id) REFERENCES representation_agreements(id) ON DELETE CASCADE',
    fk('shared_by_user_id', 'org_users'), 'UNIQUE (agreement_id, ord)', `CHECK (ord >= 0 AND ord < ${MAX_OPPORTUNITY_SHARES})`,
    'CHECK (rev >= 1)', 'CHECK ((share_key IS NULL) = (share_fp IS NULL))',
  ]),
  'CREATE UNIQUE INDEX agreement_opportunity_shares_live ON agreement_opportunity_shares (agreement_id, opportunity_id) WHERE withdrawn_at IS NULL;',
  'CREATE UNIQUE INDEX agreement_opportunity_shares_key ON agreement_opportunity_shares (agreement_id, share_key) WHERE share_key IS NOT NULL;',
  `CREATE TABLE agreement_history (
  id                              TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  agreement_id                    TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  ord                             INTEGER NOT NULL CHECK (ord >= 0),
  at                              INTEGER NOT NULL,
  by_kind                         TEXT NOT NULL CHECK (${inList('by_kind', AGENT_ACTOR_KINDS)}),
  by_id                           TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= ${L.id})),
  by_name                         TEXT CHECK (by_name IS NULL OR length(by_name) <= ${L.name}),
  by_role                         TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  action                          TEXT NOT NULL CHECK (${inList('action', AGREEMENT_ACTIONS)}),
  detail_by                       TEXT CHECK (detail_by IS NULL OR ${inList('detail_by', TERMINATED_BY)}),
  ${statusCol('detail_from')},
  ${statusCol('detail_to')},
  detail_had_reason               INTEGER CHECK (detail_had_reason IN (0,1)),
  ${statusCol('detail_phase')},
  detail_reason_code              TEXT CHECK (detail_reason_code IS NULL OR length(detail_reason_code) <= ${L.reasonCode}),
  detail_review_id                TEXT CHECK (detail_review_id IS NULL OR (length(detail_review_id) > 0 AND length(detail_review_id) <= ${L.id})),
  detail_share_with_agency_staff  INTEGER CHECK (detail_share_with_agency_staff IN (0,1)),
  detail_club_presence            INTEGER CHECK (detail_club_presence IN (0,1)),
  detail_contact_routing          INTEGER CHECK (detail_contact_routing IN (0,1)),
  detail_trial_visibility         INTEGER CHECK (detail_trial_visibility IN (0,1)),
  detail_share_id                 TEXT CHECK (detail_share_id IS NULL OR (length(detail_share_id) > 0 AND length(detail_share_id) <= ${L.id})),
  detail_via                      TEXT CHECK (detail_via IS NULL OR ${inList('detail_via', SHARE_VIA)}),
  UNIQUE (agreement_id, ord),
  CHECK ((action IN ('representation_confirmed','representation_rejected','representation_terminated','representation_disputed')) = (detail_by IS NOT NULL)),
  CHECK ((detail_by = 'client') = (detail_from IS NOT NULL AND detail_to IS NOT NULL AND detail_had_reason IS NOT NULL)),
  CHECK (detail_by IS NULL OR detail_by = 'client' OR (detail_phase IS NOT NULL AND detail_reason_code IS NOT NULL)),
  CHECK ((detail_by = 'trust_safety') = (detail_review_id IS NOT NULL)),
  CHECK ((action IN ('opportunity_shared','opportunity_share_withdrawn')) = (detail_share_id IS NOT NULL)),
  CHECK (detail_via IS NULL OR action = 'opportunity_shared'),
  CHECK ((action = 'representation_sharing_changed') = (coalesce(detail_share_with_agency_staff, detail_club_presence, detail_contact_routing, detail_trial_visibility) IS NOT NULL))
) STRICT;`,
  `CREATE TABLE org_agency_settings (
  org_id       TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE RESTRICT,
  description  TEXT NOT NULL CHECK (length(description) <= ${L.description}),
  updated_at   INTEGER NOT NULL
) STRICT;`,
  `CREATE TABLE org_agency_jurisdictions (
  org_id        TEXT NOT NULL REFERENCES org_agency_settings(org_id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL CHECK (ord >= 0),
  jurisdiction  TEXT NOT NULL CHECK (${inList('jurisdiction', JURISDICTIONS)}),
  PRIMARY KEY (org_id, jurisdiction),
  UNIQUE (org_id, ord)
) STRICT;`,
].join('\n');
export const AGENT_CORE_TABLES = Object.freeze([
  'agent_profiles', 'agent_profile_jurisdictions', 'agent_profile_facets', 'agent_profile_history',
  'agency_affiliations', 'agency_affiliation_tiers', 'agency_affiliation_history', 'agency_affiliation_history_tiers',
  'representation_agreements', 'agreement_scopes', 'agreement_policy_versions', 'agreement_opportunity_shares', 'agreement_history',
  'org_agency_settings', 'org_agency_jurisdictions',
]);

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= L.id;
/** An ordered list of distinct values from `vocab`: `{ ok, list }` or a refusal naming the field. */
function typeList(v, vocab, label, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(v)) return bad(label, field, `must be a list (got ${describe(v)})`);
  const i = v.findIndex((x) => !vocab.includes(x));
  if (i >= 0) return bad(label, `${field}[${i}]`, `must be one of ${vocab.join('|')} (got ${describe(v[i])})`);
  if (new Set(v).size !== v.length) return bad(label, field, 'names an entry twice');
  if (nonEmpty && !v.length) return bad(label, field, 'must not be empty');
  return { ok: true, list: [...v] };
}
const typeKeys = (raw, slots, label) => {
  const keys = raw ?? {};
  if (!isPlainObject(keys)) return bad(label, 'keys', `must be an object (got ${describe(keys)})`);
  const t = typeSpec(slots.map((s) => KEY_GROUP(s, s)), keys, `${label}.keys`); if (!t.ok) return t;
  return { ok: true, record: Object.fromEntries(Object.entries(t.record).filter(([, v]) => v !== null)) };
};
/** The actor of an entry: `{ kind, userId, name, role? }`. */
function typeBy(by, label) {
  if (!isPlainObject(by)) return bad(label, 'by', `must be an object (got ${describe(by)})`);
  const extra = Object.keys(by).filter((k) => !['kind', 'userId', 'name', 'role'].includes(k));
  if (extra.length) return bad(label, 'by', `carries field(s) this build does not store: ${extra.join(', ')}`);
  if (!AGENT_ACTOR_KINDS.includes(by.kind)) return bad(label, 'by.kind', `must be one of ${AGENT_ACTOR_KINDS.join('|')} (got ${describe(by.kind)})`);
  if (by.userId !== null && by.userId !== undefined && !isId(by.userId)) return bad(label, 'by.userId', `must be an id (got ${describe(by.userId)})`);
  if (by.name !== null && by.name !== undefined && !(typeof by.name === 'string' && by.name.length <= L.name)) return bad(label, 'by.name', `must be text of at most ${L.name} characters`);
  if (by.role !== undefined && by.kind !== 'ts_reviewer') return bad(label, 'by.role', 'is a reviewer\'s only');
  if (by.kind === 'ts_reviewer' && !(typeof by.role === 'string' && by.role.length > 0 && by.role.length <= 60)) return bad(label, 'by.role', 'names the reviewer\'s role');
  return { ok: true, by: { kind: by.kind, userId: by.userId ?? null, name: by.name ?? null, ...(by.kind === 'ts_reviewer' ? { role: by.role } : {}) } };
}
const byColumns = (by) => ({ by_kind: by.kind, by_id: by.userId, by_name: by.name, by_role: by.role ?? null });
const byOf = (h) => ({ kind: h.by_kind, userId: h.by_id, name: h.by_name, ...(h.by_kind === 'ts_reviewer' ? { role: h.by_role } : {}) });
/** A history entry `{ id, at, action, by, detail }`; `detail` is judged by `typeDetail(action, detail)`. */
function typeEntry(raw, label, actions, typeDetail) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !['id', 'at', 'action', 'by', 'detail'].includes(k));
  if (unknown.length) return bad(label, 'entry', `carries field(s) this build does not store: ${unknown.join(', ')}`);
  if (!isId(raw.id)) return bad(label, 'id', `must be an id (got ${describe(raw.id)})`);
  if (!Number.isSafeInteger(raw.at)) return bad(label, 'at', `must be an integer instant (got ${describe(raw.at)})`);
  if (!actions.includes(raw.action)) return bad(label, 'action', `must be one of ${actions.join('|')} (got ${describe(raw.action)})`);
  const b = typeBy(raw.by, label); if (!b.ok) return b;
  const d = typeDetail(raw.action, raw.detail ?? null, label); if (!d.ok) return d;
  return { ok: true, record: { id: raw.id, at: raw.at, action: raw.action, by: b.by, detail: d.detail } };
}
const exactKeys = (detail, required, optional, label) => {
  if (!isPlainObject(detail)) return bad(label, 'detail', `must be an object (got ${describe(detail)})`);
  const extra = Object.keys(detail).filter((k) => !required.includes(k) && !optional.includes(k));
  if (extra.length) return bad(label, 'detail', `carries field(s) this build does not store: ${extra.join(', ')}`);
  const missing = required.filter((k) => !Object.hasOwn(detail, k));
  if (missing.length) return bad(label, 'detail', `lacks ${missing.join(', ')}`);
  return null;
};
const inVocab = (v, vocab, label, field) => (vocab.includes(v) ? null : bad(label, `detail.${field}`, `must be one of ${vocab.join('|')} (got ${describe(v)})`));

/** Profile history detail: none, the changed fields, or a facet's change. */
function typeProfileDetail(action, d, label) {
  if (action === 'agent_profile_created') return d === null ? { ok: true, detail: null } : bad(label, 'detail', 'must be null for agent_profile_created');
  if (action === 'agent_profile_updated') {
    const e = exactKeys(d, ['fields'], [], label); if (e) return e;
    const l = typeList(d.fields, PROFILE_FIELDS, label, 'detail.fields'); if (!l.ok) return l;
    return { ok: true, detail: { fields: PROFILE_FIELDS.filter((f) => l.list.includes(f)) } };
  }
  const changes = action !== 'agent_verification_submitted';
  const e = exactKeys(d, ['facet', 'memberAssociation', ...(changes ? ['from', 'to'] : []), ...(action === 'agent_verification_state_changed' ? ['state'] : [])], action === 'agent_verification_state_changed' ? ['reviewId'] : [], label); if (e) return e;
  const f = inVocab(d.facet, FACETS, label, 'facet'); if (f) return f;
  if (d.facet === 'fifa_licence' ? d.memberAssociation !== null : !JURISDICTIONS.includes(d.memberAssociation)) return bad(label, 'detail.memberAssociation', 'is null for the FIFA licence and a member association otherwise');
  for (const k of ['from', 'to', 'state']) if (Object.hasOwn(d, k)) { const s = inVocab(d[k], VERIFICATION_STATES, label, k); if (s) return s; }
  if (d.reviewId !== undefined && d.reviewId !== null && !isId(d.reviewId)) return bad(label, 'detail.reviewId', 'must be an id');
  const out = { facet: d.facet, memberAssociation: d.memberAssociation };
  if (changes) { out.from = d.from; out.to = d.to; }
  if (action === 'agent_verification_state_changed') { out.state = d.state; if (d.reviewId) out.reviewId = d.reviewId; }
  return { ok: true, detail: out };
}
/** Affiliation history detail: the roles granted (and whether by bootstrap), the change of roles, or the end's reason. */
function typeAffiliationDetail(action, d, label) {
  if (action === 'agency_affiliation_ended') {
    const e = exactKeys(d, ['reasonCode'], [], label); if (e) return e;
    if (!(typeof d.reasonCode === 'string' && d.reasonCode.length <= L.reasonCode)) return bad(label, 'detail.reasonCode', `must be text of at most ${L.reasonCode} characters`);
    return { ok: true, detail: { reasonCode: d.reasonCode } };
  }
  if (action === 'agency_affiliation_created') {
    const e = exactKeys(d, ['tiers'], ['bootstrap'], label); if (e) return e;
    if (d.bootstrap !== undefined && d.bootstrap !== true) return bad(label, 'detail.bootstrap', 'is true or absent');
    const l = typeList(d.tiers, TIERS, label, 'detail.tiers', { nonEmpty: true }); if (!l.ok) return l;
    return { ok: true, detail: { tiers: l.list, ...(d.bootstrap ? { bootstrap: true } : {}) } };
  }
  const e = exactKeys(d, ['from', 'to', 'tiers'], [], label); if (e) return e;
  const from = typeList(d.from, TIERS, label, 'detail.from'); if (!from.ok) return from;
  const to = typeList(d.to, TIERS, label, 'detail.to', { nonEmpty: true }); if (!to.ok) return to;
  if (JSON.stringify(d.tiers) !== JSON.stringify(to.list)) return bad(label, 'detail.tiers', 'repeats `to`');
  return { ok: true, detail: { from: from.list, to: to.list, tiers: [...to.list] } };
}
/** Agreement history detail, by action and side; a request's detail is the agreement's own (checked by the caller). */
function typeAgreementDetail(action, d, label) {
  if (action === 'representation_requested') {
    const e = exactKeys(d, ['scope', 'termMonths', 'jurisdiction', 'policyVersions'], [], label); if (e) return e;
    return { ok: true, detail: { scope: d.scope, termMonths: d.termMonths, jurisdiction: d.jurisdiction, policyVersions: d.policyVersions } };
  }
  if (action === 'representation_sharing_changed') {
    const e = exactKeys(d, [], SHARING_KEYS, label); if (e) return e;
    if (!Object.keys(d).length) return bad(label, 'detail', 'names at least one choice');
    for (const [k, v] of Object.entries(d)) if (typeof v !== 'boolean') return bad(label, `detail.${k}`, 'must be true or false');
    return { ok: true, detail: Object.fromEntries(SHARING_KEYS.filter((k) => Object.hasOwn(d, k)).map((k) => [k, d[k]])) };
  }
  if (action === 'opportunity_shared' || action === 'opportunity_share_withdrawn') {
    const e = exactKeys(d, action === 'opportunity_shared' ? ['shareId', 'via'] : ['shareId'], [], label); if (e) return e;
    if (!isId(d.shareId)) return bad(label, 'detail.shareId', 'must be an id');
    if (action === 'opportunity_shared' && d.via !== null && !SHARE_VIA.includes(d.via)) return bad(label, 'detail.via', `must be one of ${SHARE_VIA.join('|')} or null`);
    return { ok: true, detail: action === 'opportunity_shared' ? { shareId: d.shareId, via: d.via } : { shareId: d.shareId } };
  }
  if (!isPlainObject(d)) return bad(label, 'detail', `must be an object (got ${describe(d)})`);
  const side = inVocab(d.by, TERMINATED_BY, label, 'by'); if (side) return side;
  if (d.by === 'client') {
    const e = exactKeys(d, ['from', 'to', 'by', 'hadReason'], [], label); if (e) return e;
    for (const k of ['from', 'to']) { const s = inVocab(d[k], AGREEMENT_STATUSES, label, k); if (s) return s; }
    if (typeof d.hadReason !== 'boolean') return bad(label, 'detail.hadReason', 'must be true or false');
    return { ok: true, detail: { from: d.from, to: d.to, by: 'client', hadReason: d.hadReason } };
  }
  const e = exactKeys(d, ['by', 'phase', 'reasonCode', ...(d.by === 'trust_safety' ? ['reviewId'] : [])], [], label); if (e) return e;
  const s = inVocab(d.phase, AGREEMENT_STATUSES, label, 'phase'); if (s) return s;
  if (!(typeof d.reasonCode === 'string' && d.reasonCode.length <= L.reasonCode)) return bad(label, 'detail.reasonCode', `must be text of at most ${L.reasonCode} characters`);
  if (d.by === 'trust_safety' && !isId(d.reviewId)) return bad(label, 'detail.reviewId', 'must be an id');
  return { ok: true, detail: d.by === 'trust_safety' ? { by: d.by, phase: d.phase, reviewId: d.reviewId, reasonCode: d.reasonCode } : { by: d.by, phase: d.phase, reasonCode: d.reasonCode } };
}
function typeHistory(list, label, actions, typeDetail) {
  if (!Array.isArray(list)) return bad(label, 'history', `must be a list (got ${describe(list)})`);
  const out = [];
  for (const [i, h] of list.entries()) { const t = typeEntry(h, `${label}.history[${i}]`, actions, typeDetail); if (!t.ok) return t; out.push(t.record); }
  if (new Set(out.map((h) => h.id)).size !== out.length) return bad(label, 'history', 'names an id twice');
  return { ok: true, list: out };
}
function typeFacet(raw, at, facet, ma) {
  const t = typeSpec(FACET_SPEC, raw, at, ['memberAssociation']); if (!t.ok) return t;
  const want = facet === 'fifa_licence' ? null : ma;
  if ((raw.memberAssociation ?? null) !== want) return bad(at, 'memberAssociation', `must be ${want === null ? 'null for the FIFA licence' : want}`);
  const r = t.record;
  if (r.provenance && (r.provenance.reviewerId !== null || r.provenance.reviewId !== null) && r.provenance.provider !== 'attributed_review') return bad(at, 'provenance', 'names a reviewer only for an attributed review');
  return { ok: true, record: { state: r.state, reference: r.reference, memberAssociation: want, provenance: r.provenance, submittedAt: r.submittedAt, verifiedAt: r.verifiedAt, recheckAt: r.recheckAt, note: r.note, staleNotifiedAt: r.staleNotifiedAt } };
}
/** An agent profile: the flat columns, the declared details, the facets and the history. */
export function typeAgentProfile(raw, at = 'agentProfiles') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { declared, facets, history = [], ...flatPart } = raw;
  const t = typeSpec(PROFILE_SPEC, flatPart, label); if (!t.ok) return t;
  if (!isPlainObject(declared)) return bad(label, 'declared', `must be an object (got ${describe(declared)})`);
  const dt = typeSpec([text('fifaLicenceNumber', 'x', L.licenceNumber, { nonEmpty: true })], { fifaLicenceNumber: declared.fifaLicenceNumber ?? null }, `${label}.declared`); if (!dt.ok) return dt;
  const extraDeclared = Object.keys(declared).filter((k) => !['fifaLicenceNumber', 'jurisdictions'].includes(k));
  if (extraDeclared.length) return bad(label, 'declared', `carries field(s) this build does not store: ${extraDeclared.join(', ')}`);
  const jur = typeList(declared.jurisdictions ?? [], JURISDICTIONS, label, 'declared.jurisdictions'); if (!jur.ok) return jur;
  if (!isPlainObject(facets)) return bad(label, 'facets', `must be an object (got ${describe(facets)})`);
  const unknownFacets = Object.keys(facets).filter((k) => !FACETS.includes(k));
  if (unknownFacets.length) return bad(label, 'facets', `carries field(s) this build does not store: ${unknownFacets.join(', ')}`);
  const fifa = typeFacet(facets.fifa_licence, `${label}.facets.fifa_licence`, 'fifa_licence', null); if (!fifa.ok) return fifa;
  const typedFacets = { fifa_licence: fifa.record };
  for (const f of MA_FACETS) {
    const byMa = facets[f] ?? {};
    if (!isPlainObject(byMa)) return bad(label, `facets.${f}`, `must be an object keyed by member association (got ${describe(byMa)})`);
    typedFacets[f] = {};
    for (const [ma, rec] of Object.entries(byMa)) {
      if (!JURISDICTIONS.includes(ma) || ma === FIFA_MA) return bad(label, `facets.${f}`, `names ${describe(ma)}, which is not a member association`);
      const ft = typeFacet(rec, `${label}.facets.${f}.${ma}`, f, ma); if (!ft.ok) return ft;
      typedFacets[f][ma] = ft.record;
    }
  }
  const h = typeHistory(history, label, PROFILE_ACTIONS, typeProfileDetail); if (!h.ok) return h;
  if (t.record.rev < 1) return bad(label, 'rev', 'starts at 1');
  return { ok: true, record: { ...t.record, declared: { fifaLicenceNumber: dt.record.fifaLicenceNumber, jurisdictions: jur.list }, facets: typedFacets, history: h.list } };
}
/** An agency affiliation: the flat columns, its roles, its create key and its history. */
export function typeAgencyAffiliation(raw, at = 'agencyAffiliations') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { tiers, keys, history = [], ...flatPart } = raw;
  const t = typeSpec(AFFILIATION_SPEC, flatPart, label); if (!t.ok) return t;
  const l = typeList(tiers, TIERS, label, 'tiers', { nonEmpty: true }); if (!l.ok) return l;
  const k = typeKeys(keys, ['create'], label); if (!k.ok) return k;
  const h = typeHistory(history, label, AFFILIATION_ACTIONS, typeAffiliationDetail); if (!h.ok) return h;
  const r = t.record;
  if (r.rev < 1) return bad(label, 'rev', 'starts at 1');
  if (r.endedAt !== null && r.endedReason === null) return bad(label, 'endedReason', 'is given when the membership ends');
  return { ok: true, record: { ...r, tiers: l.list, keys: k.record, history: h.list } };
}
function typeShare(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { keys, ...flatPart } = raw;
  const t = typeSpec(SHARE_SPEC, flatPart, at); if (!t.ok) return t;
  const k = typeKeys(keys, ['share'], at); if (!k.ok) return k;
  return { ok: true, record: { ...t.record, keys: k.record } };
}
/** A representation agreement: the flat columns, scope, policy versions, keys, shares and history. */
export function typeRepresentationAgreement(raw, at = 'representationAgreements') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { scope, policyVersions = [], keys, opportunityShares = [], history = [], confirmedBy = null, isRegulatoryMinor, ...flatPart } = raw;
  const t = typeSpec(AGREEMENT_SPEC, flatPart, label); if (!t.ok) return t;
  if (isRegulatoryMinor !== undefined && isRegulatoryMinor !== false) return bad(label, 'isRegulatoryMinor', 'is always false (a minor is refused before a request exists)');
  const r = t.record;
  if (confirmedBy !== null && !(isPlainObject(confirmedBy) && confirmedBy.kind === 'player' && confirmedBy.id === r.clientId && Object.keys(confirmedBy).length === 2)) return bad(label, 'confirmedBy', 'is { kind: \'player\', id: <the client> } or null');
  if ((confirmedBy === null) !== (r.confirmedAt === null)) return bad(label, 'confirmedBy', 'is set exactly when confirmedAt is');
  const sc = typeList(scope, SCOPES, label, 'scope', { nonEmpty: true }); if (!sc.ok) return sc;
  if (!Array.isArray(policyVersions) || policyVersions.some((p) => !isId(p)) || new Set(policyVersions).size !== policyVersions.length) return bad(label, 'policyVersions', 'must be a list of distinct policy version ids');
  const k = typeKeys(keys, AGREEMENT_KEY_SLOTS, label); if (!k.ok) return k;
  if (!Array.isArray(opportunityShares)) return bad(label, 'opportunityShares', `must be a list (got ${describe(opportunityShares)})`);
  if (opportunityShares.length > MAX_OPPORTUNITY_SHARES) return bad(label, 'opportunityShares', `holds more than ${MAX_OPPORTUNITY_SHARES} shares`);
  const shares = [];
  for (const [i, s] of opportunityShares.entries()) { const st = typeShare(s, `${label}.opportunityShares[${i}]`); if (!st.ok) return st; shares.push(st.record); }
  if (new Set(shares.map((s) => s.id)).size !== shares.length) return bad(label, 'opportunityShares', 'names an id twice');
  const live = shares.filter((s) => s.withdrawnAt === null).map((s) => s.opportunityId);
  if (new Set(live).size !== live.length) return bad(label, 'opportunityShares', 'shares one opportunity twice');
  const h = typeHistory(history, label, AGREEMENT_ACTIONS, typeAgreementDetail); if (!h.ok) return h;
  const requested = h.list.filter((e) => e.action === 'representation_requested');
  const own = { scope: sc.list, termMonths: r.termMonths, jurisdiction: r.jurisdiction, policyVersions: [...policyVersions] };
  if (requested.some((e) => JSON.stringify(e.detail) !== JSON.stringify(own))) return bad(label, 'history', 'a request entry repeats the agreement\'s own scope, term, jurisdiction and policy versions');
  if (r.termMonths < 1 || r.termMonths > MAX_TERM_MONTHS) return bad(label, 'termMonths', `must be 1 to ${MAX_TERM_MONTHS}`);
  if (r.rev < 1) return bad(label, 'rev', 'starts at 1');
  return { ok: true, record: { ...r, isRegulatoryMinor: false, confirmedBy: confirmedBy && { kind: 'player', id: confirmedBy.id }, scope: sc.list, policyVersions: [...policyVersions], keys: k.record, opportunityShares: shares, history: h.list } };
}
/** An agency's settings: `{ jurisdictions, description }`. */
export function typeAgencySettings(raw, at = 'agencySettings') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const extra = Object.keys(raw).filter((k) => !['jurisdictions', 'description'].includes(k));
  if (extra.length) return bad(at, 'settings', `carries field(s) this build does not store: ${extra.join(', ')}`);
  const j = typeList(raw.jurisdictions ?? [], JURISDICTIONS, at, 'jurisdictions'); if (!j.ok) return j;
  const d = raw.description ?? '';
  if (!(typeof d === 'string' && d.length <= L.description)) return bad(at, 'description', `must be text of at most ${L.description} characters`);
  return { ok: true, record: { jurisdictions: j.list, description: d } };
}

// ------------------------------------------------------------------ rows
const facetRow = (profileId, facet, ma, f) => ({ ...f, profileId, facet, memberAssociation: ma });
const FACET_ROW_SPEC = [idf('profileId', 'profile_id', req), oneOf('facet', 'facet', FACETS, { req: true }), oneOf('memberAssociation', 'member_association', JURISDICTIONS, { req: true }), ...FACET_SPEC];
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    profile: p(upsertSql('agent_profiles', [...PROFILE_SPEC, text('fifaLicenceNumber', 'declared_fifa_licence_number', L.licenceNumber)])),
    profileJurDel: p('DELETE FROM agent_profile_jurisdictions WHERE profile_id = ?'),
    profileJurIns: p('INSERT INTO agent_profile_jurisdictions (profile_id, ord, jurisdiction) VALUES (?, ?, ?)'),
    facetDel: p('DELETE FROM agent_profile_facets WHERE profile_id = ?'),
    facetIns: p(upsertSql('agent_profile_facets', FACET_ROW_SPEC, ['profile_id', 'facet', 'member_association'])),
    profileHist: p(`INSERT INTO agent_profile_history (id, profile_id, ord, at, by_kind, by_id, by_name, by_role, action, detail_display_name, detail_jurisdictions, detail_licence_number, detail_facet, detail_ma, detail_from, detail_to, detail_state, detail_review_id)
      VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @action, @detail_display_name, @detail_jurisdictions, @detail_licence_number, @detail_facet, @detail_ma, @detail_from, @detail_to, @detail_state, @detail_review_id)`),
    affiliation: p(upsertSql('agency_affiliations', [...AFFILIATION_SPEC, KEY_GROUP('keys', 'create')])),
    tierDel: p('DELETE FROM agency_affiliation_tiers WHERE affiliation_id = ?'),
    tierIns: p('INSERT INTO agency_affiliation_tiers (affiliation_id, ord, tier) VALUES (?, ?, ?)'),
    affHist: p(`INSERT INTO agency_affiliation_history (id, affiliation_id, ord, at, by_kind, by_id, by_name, by_role, action, detail_bootstrap, detail_reason_code)
      VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @action, @detail_bootstrap, @detail_reason_code)`),
    affHistTier: p('INSERT INTO agency_affiliation_history_tiers (history_id, list, ord, tier) VALUES (?, ?, ?, ?)'),
    agreement: p(upsertSql('representation_agreements', [...AGREEMENT_SPEC, idf('confirmedByPlayerId', 'confirmed_by_player_id'), ...AGREEMENT_KEYS_SPEC])),
    scopeIns: p('INSERT INTO agreement_scopes (agreement_id, ord, scope) VALUES (?, ?, ?)'),
    policyIns: p('INSERT INTO agreement_policy_versions (agreement_id, ord, policy_version_id) VALUES (?, ?, ?)'),
    share: p(upsertSql('agreement_opportunity_shares', [idf('agreementId', 'agreement_id', req), int('ord', 'ord', { req: true }), ...SHARE_SPEC, KEY_GROUP('keys', 'share')])),
    agrHist: p(`INSERT INTO agreement_history (id, agreement_id, ord, at, by_kind, by_id, by_name, by_role, action, detail_by, detail_from, detail_to, detail_had_reason, detail_phase, detail_reason_code, detail_review_id, detail_share_with_agency_staff, detail_club_presence, detail_contact_routing, detail_trial_visibility, detail_share_id, detail_via)
      VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @action, @detail_by, @detail_from, @detail_to, @detail_had_reason, @detail_phase, @detail_reason_code, @detail_review_id, @detail_share_with_agency_staff, @detail_club_presence, @detail_contact_routing, @detail_trial_visibility, @detail_share_id, @detail_via)`),
    settings: p('INSERT INTO org_agency_settings (org_id, description, updated_at) VALUES (?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at'),
    settingsJurDel: p('DELETE FROM org_agency_jurisdictions WHERE org_id = ?'),
    settingsJurIns: p('INSERT INTO org_agency_jurisdictions (org_id, ord, jurisdiction) VALUES (?, ?, ?)'),
  };
}
const b01 = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const NO_PROFILE_DETAIL = { detail_display_name: null, detail_jurisdictions: null, detail_licence_number: null, detail_facet: null, detail_ma: null, detail_from: null, detail_to: null, detail_state: null, detail_review_id: null };
function profileHistoryRow(h, owner, ord) {
  const d = h.detail;
  const row = { id: h.id, owner, ord, at: h.at, action: h.action, ...byColumns(h.by), ...NO_PROFILE_DETAIL };
  if (h.action === 'agent_profile_updated') for (const f of PROFILE_FIELDS) row[FIELD_COLUMN[f]] = d.fields.includes(f) ? 1 : 0;
  else if (d) {
    row.detail_facet = d.facet; row.detail_ma = d.memberAssociation;
    row.detail_from = d.from ?? null; row.detail_to = d.to ?? null; row.detail_state = d.state ?? null; row.detail_review_id = d.reviewId ?? null;
  }
  return row;
}
function profileHistoryOut(h) {
  const base = { id: h.id, at: h.at, action: h.action, by: byOf(h) };
  if (h.action === 'agent_profile_created') return { ...base, detail: null };
  if (h.action === 'agent_profile_updated') return { ...base, detail: { fields: PROFILE_FIELDS.filter((f) => h[FIELD_COLUMN[f]] === 1) } };
  const detail = { facet: h.detail_facet, memberAssociation: h.detail_ma };
  if (h.detail_to !== null) { detail.from = h.detail_from; detail.to = h.detail_to; }
  if (h.action === 'agent_verification_state_changed') { detail.state = h.detail_state; if (h.detail_review_id) detail.reviewId = h.detail_review_id; }
  return { ...base, detail };
}
function affiliationHistoryRow(h, owner, ord) {
  return { id: h.id, owner, ord, at: h.at, action: h.action, ...byColumns(h.by), detail_bootstrap: h.detail?.bootstrap ? 1 : null, detail_reason_code: h.action === 'agency_affiliation_ended' ? h.detail.reasonCode : null };
}
function affiliationHistoryOut(h, tiers) {
  const list = (which) => tiers.filter((t) => t.list === which).map((t) => t.tier);
  const base = { id: h.id, at: h.at, action: h.action, by: byOf(h) };
  if (h.action === 'agency_affiliation_ended') return { ...base, detail: { reasonCode: h.detail_reason_code } };
  if (h.action === 'agency_affiliation_created') return { ...base, detail: { tiers: list('to'), ...(h.detail_bootstrap ? { bootstrap: true } : {}) } };
  return { ...base, detail: { from: list('from'), to: list('to'), tiers: list('to') } };
}
const NO_AGREEMENT_DETAIL = { detail_by: null, detail_from: null, detail_to: null, detail_had_reason: null, detail_phase: null, detail_reason_code: null, detail_review_id: null, detail_share_with_agency_staff: null, detail_club_presence: null, detail_contact_routing: null, detail_trial_visibility: null, detail_share_id: null, detail_via: null };
function agreementHistoryRow(h, owner, ord) {
  const d = h.detail;
  const row = { id: h.id, owner, ord, at: h.at, action: h.action, ...byColumns(h.by), ...NO_AGREEMENT_DETAIL };
  if (h.action === 'representation_sharing_changed') for (const k of SHARING_KEYS) row[SHARING_COLUMN[k]] = b01(d[k]);
  else if (h.action === 'opportunity_shared' || h.action === 'opportunity_share_withdrawn') { row.detail_share_id = d.shareId; row.detail_via = d.via ?? null; }
  else if (h.action !== 'representation_requested') {
    row.detail_by = d.by; row.detail_from = d.from ?? null; row.detail_to = d.to ?? null; row.detail_had_reason = b01(d.hadReason);
    row.detail_phase = d.phase ?? null; row.detail_reason_code = d.reasonCode ?? null; row.detail_review_id = d.reviewId ?? null;
  }
  return row;
}
function agreementHistoryOut(h, own) {
  const base = { id: h.id, at: h.at, action: h.action, by: byOf(h) };
  if (h.action === 'representation_requested') return { ...base, detail: { scope: [...own.scope], termMonths: own.termMonths, jurisdiction: own.jurisdiction, policyVersions: [...own.policyVersions] } };
  if (h.action === 'representation_sharing_changed') return { ...base, detail: Object.fromEntries(SHARING_KEYS.filter((k) => h[SHARING_COLUMN[k]] !== null).map((k) => [k, h[SHARING_COLUMN[k]] === 1])) };
  if (h.action === 'opportunity_shared') return { ...base, detail: { shareId: h.detail_share_id, via: h.detail_via } };
  if (h.action === 'opportunity_share_withdrawn') return { ...base, detail: { shareId: h.detail_share_id } };
  if (h.detail_by === 'client') return { ...base, detail: { from: h.detail_from, to: h.detail_to, by: 'client', hadReason: h.detail_had_reason === 1 } };
  if (h.detail_by === 'trust_safety') return { ...base, detail: { by: 'trust_safety', phase: h.detail_phase, reviewId: h.detail_review_id, reasonCode: h.detail_reason_code } };
  return { ...base, detail: { by: h.detail_by, phase: h.detail_phase, reasonCode: h.detail_reason_code } };
}

/** Write a typed profile whole: the row, its jurisdictions and facets, and the history entries not yet stored. */
function writeProfile(st, p, knownHistory = 0) {
  st.profile.run(encode([...PROFILE_SPEC, text('fifaLicenceNumber', 'declared_fifa_licence_number', L.licenceNumber)], { ...p, fifaLicenceNumber: p.declared.fifaLicenceNumber }));
  st.profileJurDel.run(p.id);
  p.declared.jurisdictions.forEach((j, i) => st.profileJurIns.run(p.id, i, j));
  st.facetDel.run(p.id);
  st.facetIns.run(encode(FACET_ROW_SPEC, facetRow(p.id, 'fifa_licence', FIFA_MA, p.facets.fifa_licence)));
  for (const f of MA_FACETS) for (const [ma, rec] of Object.entries(p.facets[f])) st.facetIns.run(encode(FACET_ROW_SPEC, facetRow(p.id, f, ma, rec)));
  p.history.slice(knownHistory).forEach((h, i) => st.profileHist.run(profileHistoryRow(h, p.id, knownHistory + i)));
}
function writeAffiliation(st, a, knownHistory = 0) {
  st.affiliation.run(encode([...AFFILIATION_SPEC, KEY_GROUP('keys', 'create')], { ...a, keys: a.keys.create ?? null }));
  st.tierDel.run(a.id);
  a.tiers.forEach((t, i) => st.tierIns.run(a.id, i, t));
  a.history.slice(knownHistory).forEach((h, i) => {
    st.affHist.run(affiliationHistoryRow(h, a.id, knownHistory + i));
    if (h.action === 'agency_affiliation_updated') h.detail.from.forEach((t, j) => st.affHistTier.run(h.id, 'from', j, t));
    if (h.action !== 'agency_affiliation_ended') h.detail.tiers.forEach((t, j) => st.affHistTier.run(h.id, 'to', j, t));
  });
}
function writeAgreement(st, a, { isNew, knownHistory = 0 }) {
  st.agreement.run(encode([...AGREEMENT_SPEC, idf('confirmedByPlayerId', 'confirmed_by_player_id'), ...AGREEMENT_KEYS_SPEC], {
    ...a, confirmedByPlayerId: a.confirmedBy?.id ?? null, ...Object.fromEntries(AGREEMENT_KEY_SLOTS.map((s) => [s, a.keys[s] ?? null])),
  }));
  if (isNew) {
    a.scope.forEach((s, i) => st.scopeIns.run(a.id, i, s));
    a.policyVersions.forEach((pv, i) => st.policyIns.run(a.id, i, pv));
  }
  a.opportunityShares.forEach((s, i) => st.share.run(encode([idf('agreementId', 'agreement_id', req), int('ord', 'ord', { req: true }), ...SHARE_SPEC, KEY_GROUP('keys', 'share')], { ...s, agreementId: a.id, ord: i, keys: s.keys.share ?? null })));
  a.history.slice(knownHistory).forEach((h, i) => st.agrHist.run(agreementHistoryRow(h, a.id, knownHistory + i)));
}

function decodeProfiles(sqlite, rows) {
  const pids = rows.map((r) => r.id);
  const jur = childRowsOf(sqlite, 'agent_profile_jurisdictions', 'profile_id', pids, { order: 'ord' });
  const facets = childRowsOf(sqlite, 'agent_profile_facets', 'profile_id', pids, { order: 'rowid' });
  const hist = childRowsOf(sqlite, 'agent_profile_history', 'profile_id', pids, { order: 'ord' });
  return rows.map((row) => {
    const out = { ...decode(PROFILE_SPEC, row), declared: { fifaLicenceNumber: row.declared_fifa_licence_number, jurisdictions: jur.all(row.id).map((r) => r.jurisdiction) } };
    const f = { fifa_licence: null, ...Object.fromEntries(MA_FACETS.map((x) => [x, {}])) };
    for (const r of facets.all(row.id)) {
      const rec = decode(FACET_SPEC, r);
      const v = { state: rec.state, reference: rec.reference, memberAssociation: r.facet === 'fifa_licence' ? null : r.member_association, provenance: rec.provenance, submittedAt: rec.submittedAt, verifiedAt: rec.verifiedAt, recheckAt: rec.recheckAt, note: rec.note, staleNotifiedAt: rec.staleNotifiedAt };
      if (r.facet === 'fifa_licence') f.fifa_licence = v; else f[r.facet][r.member_association] = v;
    }
    return { ...out, facets: f, history: hist.all(row.id).map(profileHistoryOut) };
  });
}
function decodeAffiliations(sqlite, rows) {
  const aids = rows.map((r) => r.id);
  const tiers = childRowsOf(sqlite, 'agency_affiliation_tiers', 'affiliation_id', aids, { order: 'ord' });
  const hist = childRowsOf(sqlite, 'agency_affiliation_history', 'affiliation_id', aids, { order: 'ord' });
  const hids = rows.flatMap((r) => hist.all(r.id).map((h) => h.id));
  const htiers = childRowsOf(sqlite, 'agency_affiliation_history_tiers', 'history_id', hids, { order: 'list, ord' });
  return rows.map((row) => {
    const rec = decode(AFFILIATION_SPEC, row);
    return {
      ...rec, tiers: tiers.all(row.id).map((t) => t.tier),
      keys: row.create_key === null ? {} : { create: { key: row.create_key, fp: row.create_fp } },
      history: hist.all(row.id).map((h) => affiliationHistoryOut(h, htiers.all(h.id))),
    };
  });
}
function decodeAgreements(sqlite, rows) {
  const aids = rows.map((r) => r.id);
  const scopes = childRowsOf(sqlite, 'agreement_scopes', 'agreement_id', aids, { order: 'ord' });
  const pvs = childRowsOf(sqlite, 'agreement_policy_versions', 'agreement_id', aids, { order: 'ord' });
  const shares = childRowsOf(sqlite, 'agreement_opportunity_shares', 'agreement_id', aids, { order: 'ord' });
  const hist = childRowsOf(sqlite, 'agreement_history', 'agreement_id', aids, { order: 'ord' });
  return rows.map((row) => {
    const rec = decode(AGREEMENT_SPEC, row);
    const own = { ...rec, scope: scopes.all(row.id).map((s) => s.scope), policyVersions: pvs.all(row.id).map((p) => p.policy_version_id) };
    const keys = {};
    for (const s of AGREEMENT_KEY_SLOTS) if (row[`${SLOT_COLUMN[s]}_key`] !== null) keys[s] = { key: row[`${SLOT_COLUMN[s]}_key`], fp: row[`${SLOT_COLUMN[s]}_fp`] };
    return {
      ...own, isRegulatoryMinor: false,
      confirmedBy: row.confirmed_by_player_id === null ? null : { kind: 'player', id: row.confirmed_by_player_id },
      keys,
      opportunityShares: shares.all(row.id).map((s) => ({ ...decode(SHARE_SPEC, s), keys: s.share_key === null ? {} : { share: { key: s.share_key, fp: s.share_fp } } })),
      history: hist.all(row.id).map((h) => agreementHistoryOut(h, own)),
    };
  });
}

// ------------------------------------------------------------------ snapshot (fixtures and the persistence batteries)
export const agentCoreLive = (sqlite) => migrationApplied(sqlite, AGENT_CORE_MIGRATION);
function readAll(sqlite) {
  return {
    agentProfiles: decodeProfiles(sqlite, sqlite.prepare('SELECT * FROM agent_profiles ORDER BY rowid').all()),
    agencyAffiliations: decodeAffiliations(sqlite, sqlite.prepare('SELECT * FROM agency_affiliations ORDER BY rowid').all()),
    representationAgreements: decodeAgreements(sqlite, sqlite.prepare('SELECT * FROM representation_agreements ORDER BY rowid').all()),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back); null before its migration. */
export const AGENT_CORE_RECORDS = {
  names: AGENT_CORE_COLLECTIONS,
  read(sqlite) { return agentCoreLive(sqlite) ? readAll(sqlite) : null; },
};
const playerRefCount = (sqlite, cond) => sqlite.prepare(`SELECT count(*) AS n FROM representation_agreements x WHERE ${cond}`).get().n;
export const unresolvedPlayerReferences = (sqlite) => (agentCoreLive(sqlite) ? { agentCore: playerRefCount(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.client_id)') } : null);
export const retainedPlayerReferences = (sqlite) => (agentCoreLive(sqlite) ? { agentCore: playerRefCount(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.client_id AND p.deleted_at IS NOT NULL)') } : null);

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'save', 'redactClient']);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const EMPTY_SETTINGS = Object.freeze({ jurisdictions: Object.freeze([]), description: '' });
/**
 * `createAgentCoreRepository({ sqlite, unit, now, log, policyVersionKnown })`: `profiles`, `affiliations`, `agreements` and
 * `settings`, each with its writes and queries, plus `reads` (the queries alone: `agentReads`).
 */
export function createAgentCoreRepository({ sqlite, unit = null, now = Date.now, log = () => {}, policyVersionKnown = () => true } = {}) {
  if (!sqlite) throw new TypeError('the agent core repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const st = statements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key)) throw refusal('AGENT_CORE_NESTED_UPDATE', `${key} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try { return fn(); } finally { updating.delete(key); }
  };
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (!t.ok) throw refusal('AGENT_CORE_INPUT_INVALID', t.reason); return t.record; };
  const historyTaken = (h) => q('SELECT 1 FROM agent_profile_history WHERE id = ? UNION ALL SELECT 1 FROM agency_affiliation_history WHERE id = ? UNION ALL SELECT 1 FROM agreement_history WHERE id = ?').get(h.id, h.id, h.id);
  /** The shared rules of every update: unchanged fields, history that only grows, new entry ids not taken. */
  const checkUpdate = (table, id, stored, next, immutable) => {
    for (const k of immutable) if (!same(next[k], stored[k])) throw refusal('AGENT_CORE_INPUT_INVALID', `${table} ${id}: ${k} cannot change`);
    if (next.history.length < stored.history.length || stored.history.some((h, i) => !same(h, next.history[i]))) throw refusal('AGENT_CORE_INPUT_INVALID', `${table} ${id}: the history only grows (a stored entry cannot change or go)`);
    const taken = next.history.slice(stored.history.length).find(historyTaken);
    if (taken) throw refusal('AGENT_CORE_DUPLICATE', `history entry ${taken.id} already exists`);
  };
  const updater = (table, byId, type, immutable, write, extra = () => {}) => (id, change) => guard(`${table} ${id}`, () => operation(() => {
    if (typeof change !== 'function') throw new TypeError(`${table}: update(id, change) needs a function that edits the copy it is given`);
    const stored = byId(id);
    if (!stored) throw refusal('AGENT_CORE_NOT_FOUND', `${table} ${id} is not a record of the repository`);
    const draft = clone(stored);
    const returned = change(draft);
    const next = typedOr(type, returned === undefined ? draft : returned, table);
    checkUpdate(table, id, stored, next, immutable);
    extra(stored, next);
    write(next, stored);
    return byId(id);
  }));
  const one = (decoder, sql) => (...args) => { const row = q(sql).get(...args); return row ? deepFreeze(decoder(sqlite, [row])[0]) : null; };
  const many = (decoder, sql) => (...args) => decoder(sqlite, q(sql).all(...args)).map(deepFreeze);
  /** Newest first by cursor (`after` is the previous page's last `[rowid]`): `{ rows: [{ key, record }] }`, one row more than `limit` when there is a next page. */
  const pageOf = (table, decoder) => ({ limit, after = null }) => {
    const rows = q(`SELECT rowid AS rid, * FROM ${table} WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?`).all(after?.[0] ?? null, after?.[0] ?? null, limit + 1);
    return { rows: decoder(sqlite, rows).map((record, i) => ({ key: [rows[i].rid], record: deepFreeze(record) })) };
  };

  // ---- profiles
  const profileById = one(decodeProfiles, 'SELECT * FROM agent_profiles WHERE id = ?');
  const profiles = {
    create: (raw) => operation(() => {
      const p = typedOr(typeAgentProfile, raw, 'agentProfiles');
      if (profileById(p.id)) throw refusal('AGENT_CORE_DUPLICATE', `agent_profiles ${p.id} already exists`);
      if (q('SELECT 1 FROM agent_profiles WHERE user_id = ?').get(p.userId)) throw refusal('AGENT_CORE_DUPLICATE', `agent_profiles: ${p.userId} already has a profile`);
      const taken = p.history.find(historyTaken); if (taken) throw refusal('AGENT_CORE_DUPLICATE', `history entry ${taken.id} already exists`);
      writeProfile(st, p);
      return profileById(p.id);
    }),
    /** `update(id, change)`: the user, agency and creation never change; the history only grows. */
    update: updater('agent_profiles', profileById, typeAgentProfile, ['id', 'userId', 'agencyOrgId', 'createdAt'], (next, stored) => writeProfile(st, next, stored.history.length)),
    byId: profileById,
    /** The staff member's profile, or null. */
    forUser: one(decodeProfiles, 'SELECT * FROM agent_profiles WHERE user_id = ?'),
    /** The agency's profiles, oldest first (the agency audit and compliance lists). */
    forAgency: many(decodeProfiles, 'SELECT * FROM agent_profiles WHERE agency_org_id = ? ORDER BY rowid'),
    /** Every profile's facet states (the T&S metrics): `[{ facet, memberAssociation, state, recheckAt }]` per profile id. */
    facetStates: () => q('SELECT profile_id, facet, member_association, state, recheck_at FROM agent_profile_facets ORDER BY profile_id, rowid').all()
      .map((r) => ({ profileId: r.profile_id, facet: r.facet, memberAssociation: r.facet === 'fifa_licence' ? null : r.member_association, state: r.state, recheckAt: r.recheck_at })),
    /** Profiles holding a VERIFIED facet whose recheck date passed by `at` and that was not yet told (the sweep). */
    staleUnnotified: many(decodeProfiles, "SELECT * FROM agent_profiles WHERE id IN (SELECT profile_id FROM agent_profile_facets WHERE state = 'VERIFIED' AND stale_notified_at IS NULL AND recheck_at IS NOT NULL AND recheck_at <= ?) ORDER BY rowid"),
    /** Every profile, newest first, by cursor (the T&S oversight list). */
    page: pageOf('agent_profiles', decodeProfiles),
  };

  // ---- affiliations
  const affiliationById = one(decodeAffiliations, 'SELECT * FROM agency_affiliations WHERE id = ?');
  const ACTIVE = '(started_at <= @at AND (ended_at IS NULL OR ended_at > @at))';
  const affiliations = {
    create: (raw) => operation(() => {
      const a = typedOr(typeAgencyAffiliation, raw, 'agencyAffiliations');
      if (affiliationById(a.id)) throw refusal('AGENT_CORE_DUPLICATE', `agency_affiliations ${a.id} already exists`);
      const taken = a.history.find(historyTaken); if (taken) throw refusal('AGENT_CORE_DUPLICATE', `history entry ${taken.id} already exists`);
      writeAffiliation(st, a);
      return affiliationById(a.id);
    }),
    /** `update(id, change)`: the agency, member, start and create key never change; the history only grows. */
    update: updater('agency_affiliations', affiliationById, typeAgencyAffiliation, ['id', 'agencyOrgId', 'userId', 'startedAt', 'createdAt', 'keys'], (next, stored) => writeAffiliation(st, next, stored.history.length), (stored, next) => {
      if (stored.endedAt !== null && !same(next, { ...next, endedAt: stored.endedAt, endedReason: stored.endedReason })) throw refusal('AGENT_CORE_INPUT_INVALID', `agency_affiliations ${stored.id}: an ended membership does not reopen`);
    }),
    byId: affiliationById,
    /** The member's membership of the agency that is active at `at`, or null (every agent request). */
    activeFor: (userId, orgId, at) => { const row = q(`SELECT * FROM agency_affiliations WHERE user_id = @userId AND agency_org_id = @orgId AND ${ACTIVE} ORDER BY rowid LIMIT 1`).get({ userId, orgId, at }); return row ? deepFreeze(decodeAffiliations(sqlite, [row])[0]) : null; },
    /** Does the agency have any membership active at `at`? */
    anyActiveIn: (orgId, at) => !!q(`SELECT 1 FROM agency_affiliations WHERE agency_org_id = @orgId AND ${ACTIVE} LIMIT 1`).get({ orgId, at }),
    /** The agency's memberships, oldest first (the team page, the last-admin rule). */
    forAgency: many(decodeAffiliations, 'SELECT * FROM agency_affiliations WHERE agency_org_id = ? ORDER BY rowid'),
    /** The membership created under this client key in the agency, or null. */
    byCreateKey: one(decodeAffiliations, 'SELECT * FROM agency_affiliations WHERE agency_org_id = ? AND create_key = ?'),
  };

  // ---- agreements
  const agreementById = one(decodeAgreements, 'SELECT * FROM representation_agreements WHERE id = ?');
  const checkPolicies = (a) => { const unknown = a.policyVersions.find((p) => !policyVersionKnown(p)); if (unknown) throw refusal('AGENT_CORE_INPUT_INVALID', `representation_agreements ${a.id}: policy version ${unknown} is not a known policy`); };
  const agreements = {
    create: (raw) => operation(() => {
      const a = typedOr(typeRepresentationAgreement, raw, 'representationAgreements');
      if (agreementById(a.id)) throw refusal('AGENT_CORE_DUPLICATE', `representation_agreements ${a.id} already exists`);
      checkPolicies(a);
      const taken = a.history.find(historyTaken); if (taken) throw refusal('AGENT_CORE_DUPLICATE', `history entry ${taken.id} already exists`);
      writeAgreement(st, a, { isNew: true });
      return agreementById(a.id);
    }),
    /**
     * `update(id, change)`: the parties, scope, jurisdiction, exclusivity, term and policy versions never change; a key
     * slot is written once; shares only gain rows (a share's withdrawal, once, is its only change); the history only grows.
     */
    update: updater('representation_agreements', agreementById, typeRepresentationAgreement,
      ['id', 'agentUserId', 'agencyOrgId', 'clientKind', 'clientId', 'jurisdiction', 'scope', 'exclusive', 'termMonths', 'policyVersions', 'proposedAt', 'createdAt'],
      (next, stored) => writeAgreement(st, next, { isNew: false, knownHistory: stored.history.length }),
      (stored, next) => {
        for (const s of AGREEMENT_KEY_SLOTS) if (stored.keys[s] && !same(stored.keys[s], next.keys[s])) throw refusal('AGENT_CORE_INPUT_INVALID', `representation_agreements ${stored.id}: the ${s} key is written once`);
        if (next.opportunityShares.length < stored.opportunityShares.length) throw refusal('AGENT_CORE_INPUT_INVALID', `representation_agreements ${stored.id}: a share cannot be removed`);
        stored.opportunityShares.forEach((s, i) => {
          const n = next.opportunityShares[i];
          const { withdrawnAt: _w, rev: _r, revAt: _ra, ...fixed } = s; const { withdrawnAt: _nw, rev: _nr, revAt: _nra, ...nfixed } = n;
          if (!same(fixed, nfixed)) throw refusal('AGENT_CORE_INPUT_INVALID', `representation_agreements ${stored.id}: share ${s.id} keeps what was shared`);
          if (s.withdrawnAt !== null && n.withdrawnAt !== s.withdrawnAt) throw refusal('AGENT_CORE_INPUT_INVALID', `representation_agreements ${stored.id}: share ${s.id} was already withdrawn`);
        });
      }),
    byId: agreementById,
    /** The agency's agreements, oldest first (the agency figures, the client list before visibility). */
    forAgency: many(decodeAgreements, 'SELECT * FROM representation_agreements WHERE agency_org_id = ? ORDER BY rowid'),
    /** One agent's agreements in their agency, oldest first. */
    forAgent: many(decodeAgreements, 'SELECT * FROM representation_agreements WHERE agency_org_id = ? AND agent_user_id = ? ORDER BY rowid'),
    /** Every agreement naming this client, oldest first (the player's My Agent, Trust, the Passport, the integration layer). */
    forClient: many(decodeAgreements, "SELECT * FROM representation_agreements WHERE client_kind = 'player' AND client_id = ? ORDER BY rowid"),
    /** One agent's agreements with one client, oldest first (the request conflict and cool-down). */
    forAgentClient: many(decodeAgreements, "SELECT * FROM representation_agreements WHERE agent_user_id = ? AND client_kind = 'player' AND client_id = ? ORDER BY rowid"),
    /** The agreement the agent requested under this client key, or null. */
    byRequestKey: one(decodeAgreements, 'SELECT * FROM representation_agreements WHERE agency_org_id = ? AND agent_user_id = ? AND request_key = ?'),
    /** Active agreements ending within `windowMs` of `at` whose agent was not yet told (the sweep). */
    expiringUnnotified: (at, windowMs) => decodeAgreements(sqlite, q("SELECT * FROM representation_agreements WHERE status = 'active' AND expiry_notified_at IS NULL AND end_at IS NOT NULL AND end_at > ? AND end_at <= ? ORDER BY end_at").all(at, at + windowMs)).map(deepFreeze),
    /** Every agreement, newest first, by cursor (the T&S oversight list). */
    page: pageOf('representation_agreements', decodeAgreements),
    /**
     * A client's account removal: each of their agreements becomes an id-only tombstone (the removal instant, no dispute
     * text, a pending request declined) and the client's name leaves its history. The one write that changes stored
     * history entries: the actor's id and name of the client's own entries.
     */
    redactClient: (clientId, at) => operation(() => {
      for (const stored of agreements.forClient(clientId)) {
        const next = clone(stored);
        next.subjectRemovedAt = at;
        next.disputeReason = null;
        if (next.status === 'proposed') { next.status = 'declined'; next.declinedAt = at; }
        writeAgreement(st, typedOr(typeRepresentationAgreement, next, 'representationAgreements'), { isNew: false, knownHistory: stored.history.length });
      }
      q("UPDATE agreement_history SET by_id = NULL, by_name = NULL WHERE by_kind = 'player' AND agreement_id IN (SELECT id FROM representation_agreements WHERE client_kind = 'player' AND client_id = ?)").run(clientId);
    }),
  };

  // ---- agency settings (the retired orgs.agencySettings facet)
  const settings = {
    /** The agency's settings; the empty settings when none were saved. */
    forOrg: (orgId) => {
      const row = q('SELECT description FROM org_agency_settings WHERE org_id = ?').get(orgId);
      if (!row) return EMPTY_SETTINGS;
      return deepFreeze({ jurisdictions: q('SELECT jurisdiction FROM org_agency_jurisdictions WHERE org_id = ? ORDER BY ord').all(orgId).map((r) => r.jurisdiction), description: row.description });
    },
    /** Replace the agency's settings with `next` (`{ jurisdictions, description }`, typed whole). */
    save: (orgId, next) => operation(() => {
      const s = typedOr(typeAgencySettings, next, `agencySettings ${orgId}`);
      st.settings.run(orgId, s.description, now());
      st.settingsJurDel.run(orgId);
      s.jurisdictions.forEach((j, i) => st.settingsJurIns.run(orgId, i, j));
      return settings.forOrg(orgId);
    }),
  };

  const history = {
    /**
     * The agency's history entries of its profiles, memberships and agreements, newest first (`at`, then id, descending),
     * each with its record: `{ kind: 'profile'|'affiliation'|'agreement', entry, owner }` (the agency audit feed).
     */
    forAgency(orgId) {
      const out = [];
      for (const p of profiles.forAgency(orgId)) for (const h of p.history) out.push({ kind: 'profile', entry: h, owner: p });
      for (const a of affiliations.forAgency(orgId)) for (const h of a.history) out.push({ kind: 'affiliation', entry: h, owner: a });
      for (const a of agreements.forAgency(orgId)) for (const h of a.history) out.push({ kind: 'agreement', entry: h, owner: a });
      return out.sort((x, y) => (y.entry.at - x.entry.at) || String(y.entry.id).localeCompare(String(x.entry.id)));
    },
  };
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { profiles, affiliations, agreements, settings, history };
  const counters = { agentProfiles: q('SELECT COUNT(*) AS n FROM agent_profiles'), agencyAffiliations: q('SELECT COUNT(*) AS n FROM agency_affiliations'), representationAgreements: q('SELECT COUNT(*) AS n FROM representation_agreements') };
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (`agentReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!agentCoreLive(sqlite)) throw new Error(`the agent core repository needs ${AGENT_CORE_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(AGENT_CORE_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return AGENT_CORE_RECORDS.read(sqlite); },
    log,
    now,
  };
}
