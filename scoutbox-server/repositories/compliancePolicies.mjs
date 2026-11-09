/**
 * Trust & Safety reviewers and jurisdiction policy versions.
 *
 * Records:
 *   - A reviewer: the attributed Trust & Safety identity every authoritative compliance decision names. The
 *     secret is stored only as its scrypt hash. A reviewer is never removed; a revocation is final.
 *   - A policy version: a jurisdiction's encoded rules, proposed by one administrator and published by another (dual
 *     control). Its rules are ordered rows, each with ordered sources, overrides and parameters. A parameter is typed
 *     against the engine's vocabulary (`RULE_PARAMS`, domains/agents/compliance/policyVersions.mjs): scalars are columns
 *     of the parameter row, lists and maps are item rows. Nothing about a version's content changes after it is
 *     proposed; publication sets the approver, the publishers and the instant. The three seeded versions are inserted
 *     by the migration, attributed to it.
 *
 * History. Ordered rows whose detail is typed columns, by action: a reviewer's creation names the role, a revocation
 * its reason; a policy entry's `policyVersion` is the policy's own id (not stored), and the seeded publication is
 * marked `seeded`.
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` type the whole record and write it at once,
 * joined into the open unit of work, the caller's open transaction, or a transaction of their own; an unknown field and
 * an update from inside its own update are refused. History only grows.
 *
 * Records are deep-frozen. The published set is decoded once per change (its
 * signature is the published rows' count and revisions), because every evaluation reads it.
 *
 * References. A revoker, proposer and approver are reviewers (RESTRICT); `supersedes` names an earlier version of the
 * same jurisdiction (RESTRICT). Child rows cascade.
 */
import { isPlainObject, describe, ids } from './recruitment.mjs';
import { transaction, migrationApplied } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { text, int, oneOf, group, tableDdl, bad, typeSpec, encode, decode, upsertSql, quote } from './fieldSpecs.mjs';
import { JURISDICTIONS } from '../domains/agents/core/shared.mjs';
import { RULE_STATUSES, TEXT_STATUSES, OVERRIDE_SCOPES, RULE_PARAMS, typeRuleParams, isCalendarDay, SEEDED_POLICY_VERSIONS } from '../domains/agents/compliance/policyVersions.mjs';

export const COMPLIANCE_POLICIES_MIGRATION = '0027_compliance_policies';
export const COMPLIANCE_POLICIES_COLLECTIONS = Object.freeze(['tsReviewers', 'jurisdictionPolicies']);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
/** Text limits: the routes refuse longer ids and shorten longer free text. */
export const COMPLIANCE_POLICY_LIMITS = Object.freeze({
  id: 80, reviewerId: 40, name: 80, actorName: 200, secretHash: 400, revokeReason: 200, regulator: 20, ruleId: 40,
  note: 1000, source: 300, sourceVersion: 120, ruleCount: 200, sourceCount: 20, overrideCount: 10, role: 60,
});
const L = COMPLIANCE_POLICY_LIMITS;
export const REVIEWER_ROLES = Object.freeze(['trust_safety_reviewer', 'trust_safety_admin']);
export const REVIEWER_STATUSES = Object.freeze(['active', 'revoked']);
export const POLICY_STATUSES = Object.freeze(['proposed', 'published']);
/** Who an entry, a creation or a publication names. */
export const POLICY_ACTOR_KINDS = Object.freeze(['ts_reviewer', 'system']);
export const REVIEWER_ACTIONS = Object.freeze(['reviewer_created', 'reviewer_revoked']);
export const POLICY_ACTIONS = Object.freeze(['policy_version_proposed', 'policy_version_published']);
/** The keys a rule carries. */
const RULE_KEYS = Object.freeze(['ruleStatus', 'textStatus', 'sourceRef', 'params', 'note', 'overrides', 'effectiveFrom']);
const PARAM_NAMES = Object.freeze(Object.keys(RULE_PARAMS));
const kindOf = (name) => (Array.isArray(RULE_PARAMS[name]) ? 'enum' : RULE_PARAMS[name]);

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, o);
const req = { req: true, nonEmpty: true };
const REV_BY = group('revBy', [text('name', 'rev_by_name', L.actorName), idf('userId', 'rev_by_id')], { nullable: true });
const REVIEWER_SPEC = [
  text('id', 'id', L.reviewerId, req), text('name', 'name', L.name, req), oneOf('role', 'role', REVIEWER_ROLES, { req: true }),
  oneOf('status', 'status', REVIEWER_STATUSES, { req: true }), text('secretHash', 'secret_hash', L.secretHash, req),
  int('createdAt', 'created_at', { req: true }),
  group('createdBy', [oneOf('kind', 'created_by_kind', POLICY_ACTOR_KINDS, { req: true }), idf('userId', 'created_by_id', { nonEmpty: true }), text('name', 'created_by_name', L.actorName), text('role', 'created_by_role', L.role, { nonEmpty: true })]),
  int('revokedAt', 'revoked_at'),
  group('revokedBy', [text('id', 'revoked_by_id', L.reviewerId, req), text('name', 'revoked_by_name', L.name)], { nullable: true }),
  int('rev', 'rev', { req: true }), int('revAt', 'rev_at'), REV_BY,
];
const DAY = (k, c, o = {}) => text(k, c, 10, { ...o, day: true });
const STAMP = (k, p) => group(k, [text('id', `${p}_by_id`, L.reviewerId, req), text('name', `${p}_by_name`, L.name), int('at', `${p}_at`, { req: true })], { nullable: true });
const POLICY_SPEC = [
  idf('id', 'id', req), text('regulator', 'regulator', L.regulator, req), oneOf('jurisdiction', 'jurisdiction', JURISDICTIONS, { req: true }),
  int('policyVersion', 'policy_version', { req: true }), idf('supersedes', 'supersedes_id', { nonEmpty: true }),
  DAY('effectiveFrom', 'effective_from_date', { req: true }), DAY('effectiveTo', 'effective_to_date'),
  oneOf('status', 'status', POLICY_STATUSES, { req: true }), STAMP('proposedBy', 'proposed'), STAMP('approvedBy', 'approved'),
  int('publishedAt', 'published_at'), int('createdAt', 'created_at', { req: true }),
  int('rev', 'rev', { req: true }), int('revAt', 'rev_at'), REV_BY,
];
const RULE_SPEC = [
  oneOf('ruleStatus', 'rule_status', RULE_STATUSES, { req: true }), oneOf('textStatus', 'text_status', TEXT_STATUSES),
  text('note', 'note', L.note, { nonEmpty: true }), DAY('effectiveFrom', 'effective_from_date'),
];
const SOURCE_SPEC = [
  text('source', 'source', L.source, req), text('version', 'version', L.sourceVersion, { nonEmpty: true }),
  DAY('effectiveDate', 'effective_date'), DAY('retrievedDate', 'retrieved_date', { req: true }),
];
const OVERRIDE_SPEC = [
  oneOf('jurisdiction', 'jurisdiction', JURISDICTIONS, { req: true }), oneOf('scope', 'scope', OVERRIDE_SCOPES, { req: true }),
  text('overrideRuleId', 'override_rule_id', L.ruleId, req),
];
const PUBLISHER_SPEC = [oneOf('kind', 'by_kind', POLICY_ACTOR_KINDS, { req: true }), idf('id', 'by_id', req), text('name', 'by_name', L.actorName)];

// ------------------------------------------------------------------ DDL
const fk = (col, table, on = 'RESTRICT') => `FOREIGN KEY (${col}) REFERENCES ${table}(id) ON DELETE ${on}`;
const inList = (c, vals) => `${c} IN (${vals.map(quote).join(',')})`;
const DAY_GLOB = "'[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'";
/** A spec's day columns get a shape check (the typing checks the day exists). */
const dayChecks = (spec) => spec.flatMap((f) => (f.group ? dayChecks(f.group) : f.day ? [`CHECK (${f.c} IS NULL OR ${f.c} GLOB ${DAY_GLOB})`] : []));
const HISTORY_COLS = (owner, ownerTable) => [
  `${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE`,
  'ord  INTEGER NOT NULL CHECK (ord >= 0)', 'at  INTEGER NOT NULL',
  `by_kind  TEXT NOT NULL CHECK (${inList('by_kind', POLICY_ACTOR_KINDS)})`,
  `by_id  TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= ${L.id}))`,
  `by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= ${L.actorName})`,
  `by_role  TEXT CHECK (by_role IS NULL OR ${inList('by_role', REVIEWER_ROLES)})`,
];
export const COMPLIANCE_POLICIES_DDL = [
  tableDdl('ts_reviewers', REVIEWER_SPEC, [
    'FOREIGN KEY (revoked_by_id) REFERENCES ts_reviewers(id) ON DELETE RESTRICT', 'CHECK (rev >= 1)',
    "CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))", 'CHECK ((revoked_at IS NULL) = (revoked_by_id IS NULL))',
    "CHECK (created_by_kind = 'ts_reviewer' OR (created_by_id IS NULL AND created_by_role IS NULL))",
  ]),
  'CREATE INDEX ts_reviewers_status_role ON ts_reviewers(status, role);',
  `CREATE TABLE ts_reviewer_history (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  ${HISTORY_COLS('reviewer_id', 'ts_reviewers').join(',\n  ')},
  action  TEXT NOT NULL CHECK (${inList('action', REVIEWER_ACTIONS)}),
  detail_role  TEXT CHECK (detail_role IS NULL OR ${inList('detail_role', REVIEWER_ROLES)}),
  detail_reason  TEXT CHECK (detail_reason IS NULL OR (length(detail_reason) > 0 AND length(detail_reason) <= ${L.revokeReason})),
  UNIQUE (reviewer_id, ord),
  CHECK ((action = 'reviewer_created') = (detail_role IS NOT NULL)),
  CHECK (action = 'reviewer_revoked' OR detail_reason IS NULL)
) STRICT;`,
  tableDdl('jurisdiction_policies', POLICY_SPEC, [
    fk('supersedes_id', 'jurisdiction_policies'), fk('proposed_by_id', 'ts_reviewers'), fk('approved_by_id', 'ts_reviewers'),
    ...dayChecks(POLICY_SPEC), 'CHECK (policy_version >= 1)', 'CHECK (rev >= 1)',
    'CHECK (effective_to_date IS NULL OR effective_to_date > effective_from_date)',
    "CHECK ((status = 'published') = (published_at IS NOT NULL))",
    "CHECK (status = 'published' OR approved_by_id IS NULL)",
    'CHECK (supersedes_id IS NULL OR supersedes_id <> id)',
  ]),
  'CREATE INDEX jurisdiction_policies_jurisdiction_status ON jurisdiction_policies(jurisdiction, status);',
  `CREATE TABLE jurisdiction_policy_publishers (
  policy_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < 2),
  by_kind  TEXT NOT NULL CHECK (${inList('by_kind', POLICY_ACTOR_KINDS)}),
  by_id  TEXT NOT NULL CHECK (length(by_id) > 0 AND length(by_id) <= ${L.id}),
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= ${L.actorName}),
  PRIMARY KEY (policy_id, ord)
) STRICT;`,
  tableDdl('jurisdiction_policy_rules', [text('policyId', 'policy_id', L.id, req), text('ruleId', 'rule_id', L.ruleId, req), int('ord', 'ord', { req: true }), ...RULE_SPEC], [
    'PRIMARY KEY (policy_id, rule_id)', 'UNIQUE (policy_id, ord)', `CHECK (ord >= 0 AND ord < ${L.ruleCount})`, ...dayChecks(RULE_SPEC),
    'FOREIGN KEY (policy_id) REFERENCES jurisdiction_policies(id) ON DELETE CASCADE',
  ]),
  tableDdl('jurisdiction_policy_rule_sources', [text('policyId', 'policy_id', L.id, req), text('ruleId', 'rule_id', L.ruleId, req), int('ord', 'ord', { req: true }), ...SOURCE_SPEC], [
    'PRIMARY KEY (policy_id, rule_id, ord)', `CHECK (ord >= 0 AND ord < ${L.sourceCount})`, ...dayChecks(SOURCE_SPEC),
    'FOREIGN KEY (policy_id, rule_id) REFERENCES jurisdiction_policy_rules(policy_id, rule_id) ON DELETE CASCADE',
  ]),
  tableDdl('jurisdiction_policy_rule_overrides', [text('policyId', 'policy_id', L.id, req), text('ruleId', 'rule_id', L.ruleId, req), int('ord', 'ord', { req: true }), ...OVERRIDE_SPEC], [
    'PRIMARY KEY (policy_id, rule_id, ord)', 'UNIQUE (policy_id, rule_id, jurisdiction)', `CHECK (ord >= 0 AND ord < ${L.overrideCount})`,
    'FOREIGN KEY (policy_id, rule_id) REFERENCES jurisdiction_policy_rules(policy_id, rule_id) ON DELETE CASCADE',
  ]),
  // A parameter's scalar value is a column of its row (flag, count or text, by its type); a list's or a map's
  // elements are item rows (the row itself stands for the empty list or map).
  `CREATE TABLE jurisdiction_policy_rule_params (
  policy_id  TEXT NOT NULL,
  rule_id  TEXT NOT NULL,
  name  TEXT NOT NULL CHECK (${inList('name', PARAM_NAMES)}),
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < ${PARAM_NAMES.length}),
  flag_value  INTEGER CHECK (flag_value IS NULL OR flag_value IN (0,1)),
  count_value  INTEGER CHECK (count_value IS NULL OR count_value >= 0),
  text_value  TEXT CHECK (text_value IS NULL OR (length(text_value) > 0 AND length(text_value) <= 200)),
  PRIMARY KEY (policy_id, rule_id, name),
  UNIQUE (policy_id, rule_id, ord),
  CHECK ((flag_value IS NOT NULL) + (count_value IS NOT NULL) + (text_value IS NOT NULL) <= 1),
  FOREIGN KEY (policy_id, rule_id) REFERENCES jurisdiction_policy_rules(policy_id, rule_id) ON DELETE CASCADE
) STRICT;`,
  `CREATE TABLE jurisdiction_policy_rule_param_items (
  policy_id  TEXT NOT NULL,
  rule_id  TEXT NOT NULL,
  name  TEXT NOT NULL,
  set_no  INTEGER NOT NULL CHECK (set_no >= 0),
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  member  TEXT CHECK (member IS NULL OR (length(member) = 3 AND member GLOB '[A-Z][A-Z][A-Z]')),
  count_value  INTEGER CHECK (count_value IS NULL OR count_value >= 0),
  text_value  TEXT CHECK (text_value IS NULL OR (length(text_value) > 0 AND length(text_value) <= 200)),
  PRIMARY KEY (policy_id, rule_id, name, set_no, ord),
  CHECK ((member IS NULL) = (count_value IS NULL)),
  CHECK ((member IS NULL) <> (text_value IS NULL)),
  FOREIGN KEY (policy_id, rule_id, name) REFERENCES jurisdiction_policy_rule_params(policy_id, rule_id, name) ON DELETE CASCADE
) STRICT;`,
  `CREATE TABLE jurisdiction_policy_history (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= ${L.id}),
  ${HISTORY_COLS('policy_id', 'jurisdiction_policies').join(',\n  ')},
  action  TEXT NOT NULL CHECK (${inList('action', POLICY_ACTIONS)}),
  detail_seeded  INTEGER NOT NULL DEFAULT 0 CHECK (detail_seeded IN (0,1)),
  UNIQUE (policy_id, ord),
  CHECK (detail_seeded = 0 OR (action = 'policy_version_published' AND by_kind = 'system'))
) STRICT;`,
].join('\n');
export const COMPLIANCE_POLICIES_TABLES = Object.freeze([
  'ts_reviewers', 'ts_reviewer_history', 'jurisdiction_policies', 'jurisdiction_policy_publishers', 'jurisdiction_policy_rules',
  'jurisdiction_policy_rule_sources', 'jurisdiction_policy_rule_overrides', 'jurisdiction_policy_rule_params',
  'jurisdiction_policy_rule_param_items', 'jurisdiction_policy_history',
]);

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const isId = (v, max = L.id) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** typeSpec, plus: a day field must be a day that exists. */
function typeWithDays(spec, raw, at, extra = []) {
  const t = typeSpec(spec, raw, at, extra); if (!t.ok) return t;
  const check = (sp, rec, label) => {
    for (const f of sp) {
      if (f.group) { if (rec[f.k]) { const r = check(f.group, rec[f.k], `${label}.${f.k}`); if (r) return r; } continue; }
      if (f.day && rec[f.k] !== null && !isCalendarDay(rec[f.k])) return bad(label, f.k, `must be a calendar day written YYYY-MM-DD (got ${describe(rec[f.k])})`);
    }
    return null;
  };
  return check(spec, t.record, at) ?? t;
}
/** The actor of an entry: `{ kind, userId, name, role? }` (a reviewer carries their role). */
function typeBy(by, label) {
  if (!isPlainObject(by)) return bad(label, 'by', `must be an object (got ${describe(by)})`);
  const extra = Object.keys(by).filter((k) => !['kind', 'userId', 'name', 'role'].includes(k));
  if (extra.length) return bad(label, 'by', `carries field(s) this build does not store: ${extra.join(', ')}`);
  if (!POLICY_ACTOR_KINDS.includes(by.kind)) return bad(label, 'by.kind', `must be one of ${POLICY_ACTOR_KINDS.join('|')} (got ${describe(by.kind)})`);
  if (by.kind === 'ts_reviewer') {
    if (!isId(by.userId, L.reviewerId)) return bad(label, 'by.userId', 'names the reviewer');
    if (!REVIEWER_ROLES.includes(by.role)) return bad(label, 'by.role', `must be one of ${REVIEWER_ROLES.join('|')}`);
  } else {
    if (by.userId !== null && by.userId !== undefined) return bad(label, 'by.userId', 'is null for the system');
    if (by.role !== undefined) return bad(label, 'by.role', 'is a reviewer\'s only');
  }
  if (by.name !== null && by.name !== undefined && !(typeof by.name === 'string' && by.name.length <= L.actorName)) return bad(label, 'by.name', `must be text of at most ${L.actorName} characters`);
  return { ok: true, by: { kind: by.kind, userId: by.userId ?? null, name: by.name ?? null, ...(by.kind === 'ts_reviewer' ? { role: by.role } : {}) } };
}
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
function typeHistory(list, label, actions, typeDetail) {
  if (!Array.isArray(list)) return bad(label, 'history', `must be a list (got ${describe(list)})`);
  const out = [];
  for (const [i, h] of list.entries()) { const t = typeEntry(h, `${label}.history[${i}]`, actions, typeDetail); if (!t.ok) return t; out.push(t.record); }
  if (new Set(out.map((h) => h.id)).size !== out.length) return bad(label, 'history', 'names an id twice');
  return { ok: true, list: out };
}
function typeReviewerDetail(action, d, label) {
  if (action === 'reviewer_created') {
    const e = exactKeys(d, ['role'], [], label); if (e) return e;
    if (!REVIEWER_ROLES.includes(d.role)) return bad(label, 'detail.role', `must be one of ${REVIEWER_ROLES.join('|')}`);
    return { ok: true, detail: { role: d.role } };
  }
  const e = exactKeys(d, ['reason'], [], label); if (e) return e;
  if (d.reason !== null && !(typeof d.reason === 'string' && d.reason.length > 0 && d.reason.length <= L.revokeReason)) return bad(label, 'detail.reason', `must be null or text of 1 to ${L.revokeReason} characters`);
  return { ok: true, detail: { reason: d.reason } };
}

/** A reviewer: the flat columns and the history. */
export function typeReviewer(raw, at = 'tsReviewers') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { history = [], ...flatPart } = raw;
  const t = typeSpec(REVIEWER_SPEC, flatPart, label); if (!t.ok) return t;
  const r = t.record;
  if (r.createdBy.kind === 'system' && (r.createdBy.userId !== null || r.createdBy.role !== null)) return bad(label, 'createdBy', 'names no reviewer when the system created it');
  if (r.createdBy.kind === 'ts_reviewer' && (r.createdBy.userId === null || r.createdBy.role === null)) return bad(label, 'createdBy', 'names the creating reviewer and their role');
  if ((r.status === 'revoked') !== (r.revokedAt !== null) || (r.revokedAt === null) !== (r.revokedBy === null)) return bad(label, 'revokedAt', 'is set, with revokedBy, exactly when the reviewer is revoked');
  if (r.rev < 1) return bad(label, 'rev', 'starts at 1');
  const h = typeHistory(history, label, REVIEWER_ACTIONS, typeReviewerDetail); if (!h.ok) return h;
  const createdBy = r.createdBy.kind === 'system' ? { kind: 'system', userId: null, name: r.createdBy.name } : { kind: 'ts_reviewer', userId: r.createdBy.userId, name: r.createdBy.name, role: r.createdBy.role };
  return { ok: true, record: { ...r, createdBy, history: h.list } };
}

function typeRule(ruleId, raw, label) {
  const at = `${label}.rules.${ruleId}`;
  if (!isId(ruleId, L.ruleId)) return bad(label, 'rules', `names a rule id that is not 1 to ${L.ruleId} characters (${describe(ruleId)})`);
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})`, field: `rules.${ruleId}` };
  const { sourceRef, params, overrides, ...flatPart } = raw;
  const unknown = Object.keys(raw).filter((k) => !RULE_KEYS.includes(k));
  if (unknown.length) return { ...bad(at, 'rule', `carries field(s) this build does not store: ${unknown.join(', ')}`), field: `rules.${ruleId}` };
  const t = typeWithDays(RULE_SPEC, flatPart, at); if (!t.ok) return { ...t, field: `rules.${ruleId}` };
  if (!Array.isArray(sourceRef) || !sourceRef.length || sourceRef.length > L.sourceCount) return { ...bad(at, 'sourceRef', `must be a list of 1 to ${L.sourceCount} sources`), field: `rules.${ruleId}.sourceRef` };
  const sources = [];
  for (const [i, s] of sourceRef.entries()) { const st = typeWithDays(SOURCE_SPEC, s, `${at}.sourceRef[${i}]`); if (!st.ok) return { ...st, field: `rules.${ruleId}.sourceRef` }; sources.push(st.record); }
  const p = typeRuleParams(params); if (!p.ok) return { ...bad(at, p.field, p.why), field: `rules.${ruleId}.${p.field}` };
  let ov = [];
  if (overrides !== undefined && overrides !== null) {
    if (!Array.isArray(overrides) || overrides.length > L.overrideCount) return { ...bad(at, 'overrides', `must be a list of at most ${L.overrideCount} overrides`), field: `rules.${ruleId}.overrides` };
    for (const [i, o] of overrides.entries()) { const ot = typeSpec(OVERRIDE_SPEC, o, `${at}.overrides[${i}]`); if (!ot.ok) return { ...ot, field: `rules.${ruleId}.overrides` }; ov.push(ot.record); }
    if (new Set(ov.map((o) => o.jurisdiction)).size !== ov.length) return { ...bad(at, 'overrides', 'names a jurisdiction twice'), field: `rules.${ruleId}.overrides` };
  }
  const r = t.record;
  return { ok: true, record: { ruleStatus: r.ruleStatus, textStatus: r.textStatus, sourceRef: sources, params: p.params, note: r.note, ...(ov.length ? { overrides: ov } : {}), ...(r.effectiveFrom !== null ? { effectiveFrom: r.effectiveFrom } : {}) } };
}
function typePolicyDetail(action, d, label) {
  if (d === null) return { ok: true, detail: null };
  const e = exactKeys(d, ['policyVersion'], ['seeded'], label); if (e) return e;
  if (d.seeded !== undefined && (d.seeded !== true || action !== 'policy_version_published')) return bad(label, 'detail.seeded', 'is true, on a seeded publication, or absent');
  return { ok: true, detail: { policyVersion: d.policyVersion, ...(d.seeded ? { seeded: true } : {}) } };
}
/**
 * A policy version: the flat columns, its rules (sources, parameters, overrides), its publishers and its history.
 * Refusals carry `field` (the body's field the route names).
 */
export function typePolicy(raw, at = 'jurisdictionPolicies') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})`, field: 'policy' };
  const { rules, publishedBy = null, history = [], ...flatPart } = raw;
  const t = typeWithDays(POLICY_SPEC, flatPart, label);
  if (!t.ok) { const m = /^\.(\w+)/.exec(t.reason.slice(label.length)); return { ...t, field: m?.[1] ?? 'policy' }; }
  const r = t.record;
  if (r.policyVersion < 1) return { ...bad(label, 'policyVersion', 'starts at 1'), field: 'policyVersion' };
  if (r.effectiveTo !== null && !(r.effectiveFrom < r.effectiveTo)) return { ...bad(label, 'effectiveTo', 'must be after effectiveFrom'), field: 'effectiveTo' };
  if (r.supersedes === r.id) return { ...bad(label, 'supersedes', 'cannot name the version itself'), field: 'supersedes' };
  if (!isPlainObject(rules) || !Object.keys(rules).length || Object.keys(rules).length > L.ruleCount) return { ...bad(label, 'rules', `must name 1 to ${L.ruleCount} rules`), field: 'rules' };
  const typedRules = {};
  for (const [ruleId, rule] of Object.entries(rules)) { const rt = typeRule(ruleId, rule, label); if (!rt.ok) return rt; typedRules[ruleId] = rt.record; }
  if ((r.status === 'published') !== (r.publishedAt !== null)) return { ...bad(label, 'publishedAt', 'is set exactly when the version is published'), field: 'status' };
  if (r.status === 'proposed' && (r.approvedBy !== null || publishedBy !== null)) return { ...bad(label, 'approvedBy', 'is set only on publication'), field: 'status' };
  let publishers = null;
  if (r.status === 'published') {
    if (!Array.isArray(publishedBy) || !publishedBy.length || publishedBy.length > 2) return { ...bad(label, 'publishedBy', 'names one or two publishers'), field: 'publishedBy' };
    publishers = [];
    for (const [i, p] of publishedBy.entries()) { const pt = typeSpec(PUBLISHER_SPEC, p, `${label}.publishedBy[${i}]`); if (!pt.ok) return { ...pt, field: 'publishedBy' }; publishers.push(pt.record); }
    if (publishers.some((p) => p.kind === 'ts_reviewer') && (r.proposedBy === null || r.approvedBy === null)) return { ...bad(label, 'publishedBy', 'names reviewers only when a reviewer proposed and another approved'), field: 'publishedBy' };
  }
  if (r.proposedBy && r.approvedBy && r.proposedBy.id === r.approvedBy.id) return { ...bad(label, 'approvedBy', 'must be a different reviewer from the proposer (dual control)'), field: 'approvedBy' };
  if (r.rev < 1) return { ...bad(label, 'rev', 'starts at 1'), field: 'rev' };
  const h = typeHistory(history, label, POLICY_ACTIONS, typePolicyDetail); if (!h.ok) return { ...h, field: 'history' };
  const wrongSelf = h.list.find((e) => e.detail !== null && e.detail.policyVersion !== r.id);
  if (wrongSelf) return { ...bad(label, 'history', `entry ${wrongSelf.id} names another policy version`), field: 'history' };
  return { ok: true, record: { ...r, rules: typedRules, publishedBy: publishers, history: h.list } };
}

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    reviewer: p(upsertSql('ts_reviewers', REVIEWER_SPEC)),
    reviewerHist: p('INSERT INTO ts_reviewer_history (id, reviewer_id, ord, at, by_kind, by_id, by_name, by_role, action, detail_role, detail_reason) VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @action, @detail_role, @detail_reason)'),
    policy: p(upsertSql('jurisdiction_policies', POLICY_SPEC)),
    publisherDel: p('DELETE FROM jurisdiction_policy_publishers WHERE policy_id = ?'),
    publisherIns: p('INSERT INTO jurisdiction_policy_publishers (policy_id, ord, by_kind, by_id, by_name) VALUES (?, ?, ?, ?, ?)'),
    rule: p('INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES (@policy_id, @rule_id, @ord, @rule_status, @text_status, @note, @effective_from_date)'),
    source: p('INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES (@policy_id, @rule_id, @ord, @source, @version, @effective_date, @retrieved_date)'),
    override: p('INSERT INTO jurisdiction_policy_rule_overrides (policy_id, rule_id, ord, jurisdiction, scope, override_rule_id) VALUES (@policy_id, @rule_id, @ord, @jurisdiction, @scope, @override_rule_id)'),
    param: p('INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    item: p('INSERT INTO jurisdiction_policy_rule_param_items (policy_id, rule_id, name, set_no, ord, member, count_value, text_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    policyHist: p('INSERT INTO jurisdiction_policy_history (id, policy_id, ord, at, by_kind, by_id, by_name, by_role, action, detail_seeded) VALUES (@id, @owner, @ord, @at, @by_kind, @by_id, @by_name, @by_role, @action, @detail_seeded)'),
  };
}
const byColumns = (by) => ({ by_kind: by.kind, by_id: by.userId, by_name: by.name, by_role: by.role ?? null });
const byOf = (h) => ({ kind: h.by_kind, userId: h.by_id, name: h.by_name, ...(h.by_kind === 'ts_reviewer' ? { role: h.by_role } : {}) });

function writeReviewer(st, r, knownHistory = 0) {
  st.reviewer.run(encode(REVIEWER_SPEC, r));
  r.history.slice(knownHistory).forEach((h, i) => st.reviewerHist.run({
    id: h.id, owner: r.id, ord: knownHistory + i, at: h.at, ...byColumns(h.by), action: h.action,
    detail_role: h.action === 'reviewer_created' ? h.detail.role : null, detail_reason: h.action === 'reviewer_revoked' ? h.detail.reason : null,
  }));
}
function writeRules(st, policyId, rules) {
  Object.entries(rules).forEach(([ruleId, rule], ord) => {
    st.rule.run({ policy_id: policyId, rule_id: ruleId, ord, ...encode(RULE_SPEC, { ...rule, effectiveFrom: rule.effectiveFrom ?? null }) });
    rule.sourceRef.forEach((s, i) => st.source.run({ policy_id: policyId, rule_id: ruleId, ord: i, ...encode(SOURCE_SPEC, s) }));
    (rule.overrides ?? []).forEach((o, i) => st.override.run({ policy_id: policyId, rule_id: ruleId, ord: i, ...encode(OVERRIDE_SPEC, o) }));
    Object.entries(rule.params).forEach(([name, v], i) => {
      const kind = kindOf(name);
      const scalar = kind === 'flag' ? [v ? 1 : 0, null, null] : kind === 'count' ? [null, v, null] : ['enum', 'text', 'date', 'monthDay'].includes(kind) ? [null, null, v] : [null, null, null];
      st.param.run(policyId, ruleId, name, i, ...scalar);
      if (kind === 'textList') v.forEach((x, j) => st.item.run(policyId, ruleId, name, 0, j, null, null, x));
      if (kind === 'roleSets') v.forEach((set, n) => set.forEach((x, j) => st.item.run(policyId, ruleId, name, n, j, null, null, x)));
      if (kind === 'ageMap') Object.entries(v).forEach(([country, age], j) => st.item.run(policyId, ruleId, name, 0, j, country, age, null));
    });
  });
}
function writePolicy(st, p, { isNew, knownHistory = 0 }) {
  st.policy.run(encode(POLICY_SPEC, p));
  if (isNew) writeRules(st, p.id, p.rules);
  st.publisherDel.run(p.id);
  (p.publishedBy ?? []).forEach((x, i) => st.publisherIns.run(p.id, i, x.kind, x.id, x.name));
  p.history.slice(knownHistory).forEach((h, i) => st.policyHist.run({ id: h.id, owner: p.id, ord: knownHistory + i, at: h.at, ...byColumns(h.by), action: h.action, detail_seeded: h.detail?.seeded ? 1 : 0 }));
}

const inIds = (sqlite, sql, idList) => (idList.length ? sqlite.prepare(sql).all(JSON.stringify(idList)) : []);
const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); let l = m.get(k); if (!l) m.set(k, (l = [])); l.push(r); } return (k) => m.get(k) ?? []; };
function decodeReviewers(sqlite, rows) {
  const hist = groupBy(inIds(sqlite, 'SELECT * FROM ts_reviewer_history WHERE reviewer_id IN (SELECT value FROM json_each(?)) ORDER BY reviewer_id, ord', rows.map((r) => r.id)), (h) => h.reviewer_id);
  return rows.map((row) => {
    const r = decode(REVIEWER_SPEC, row);
    const createdBy = r.createdBy.kind === 'system' ? { kind: 'system', userId: null, name: r.createdBy.name } : { kind: 'ts_reviewer', userId: r.createdBy.userId, name: r.createdBy.name, role: r.createdBy.role };
    return {
      ...r, createdBy,
      history: hist(row.id).map((h) => ({ id: h.id, at: h.at, action: h.action, by: byOf(h), detail: h.action === 'reviewer_created' ? { role: h.detail_role } : { reason: h.detail_reason } })),
    };
  });
}
function decodePolicies(sqlite, rows) {
  const pids = rows.map((r) => r.id);
  const IN = 'policy_id IN (SELECT value FROM json_each(?))';
  const rules = groupBy(inIds(sqlite, `SELECT * FROM jurisdiction_policy_rules WHERE ${IN} ORDER BY policy_id, ord`, pids), (r) => r.policy_id);
  const ruleKey = (r) => `${r.policy_id}\u0000${r.rule_id}`;
  const sources = groupBy(inIds(sqlite, `SELECT * FROM jurisdiction_policy_rule_sources WHERE ${IN} ORDER BY policy_id, rule_id, ord`, pids), ruleKey);
  const overrides = groupBy(inIds(sqlite, `SELECT * FROM jurisdiction_policy_rule_overrides WHERE ${IN} ORDER BY policy_id, rule_id, ord`, pids), ruleKey);
  const params = groupBy(inIds(sqlite, `SELECT * FROM jurisdiction_policy_rule_params WHERE ${IN} ORDER BY policy_id, rule_id, ord`, pids), ruleKey);
  const items = groupBy(inIds(sqlite, `SELECT * FROM jurisdiction_policy_rule_param_items WHERE ${IN} ORDER BY policy_id, rule_id, name, set_no, ord`, pids), (r) => `${r.policy_id}\u0000${r.rule_id}\u0000${r.name}`);
  const publishers = groupBy(inIds(sqlite, `SELECT * FROM jurisdiction_policy_publishers WHERE ${IN} ORDER BY policy_id, ord`, pids), (r) => r.policy_id);
  const hist = groupBy(inIds(sqlite, `SELECT * FROM jurisdiction_policy_history WHERE ${IN} ORDER BY policy_id, ord`, pids), (r) => r.policy_id);
  const paramValue = (pr) => {
    const kind = kindOf(pr.name);
    if (kind === 'flag') return pr.flag_value === 1;
    if (kind === 'count') return pr.count_value;
    if (kind === 'textList') return items(`${pr.policy_id}\u0000${pr.rule_id}\u0000${pr.name}`).map((x) => x.text_value);
    if (kind === 'roleSets') { const sets = []; for (const x of items(`${pr.policy_id}\u0000${pr.rule_id}\u0000${pr.name}`)) (sets[x.set_no] ??= []).push(x.text_value); return sets; }
    if (kind === 'ageMap') return Object.fromEntries(items(`${pr.policy_id}\u0000${pr.rule_id}\u0000${pr.name}`).map((x) => [x.member, x.count_value]));
    return pr.text_value;
  };
  return rows.map((row) => {
    const p = decode(POLICY_SPEC, row);
    const out = {};
    for (const rr of rules(row.id)) {
      const rec = decode(RULE_SPEC, rr);
      const ov = overrides(ruleKey(rr)).map((o) => decode(OVERRIDE_SPEC, o));
      out[rr.rule_id] = {
        ruleStatus: rec.ruleStatus, textStatus: rec.textStatus, sourceRef: sources(ruleKey(rr)).map((s) => decode(SOURCE_SPEC, s)),
        params: Object.fromEntries(params(ruleKey(rr)).map((pr) => [pr.name, paramValue(pr)])), note: rec.note,
        ...(ov.length ? { overrides: ov } : {}), ...(rec.effectiveFrom !== null ? { effectiveFrom: rec.effectiveFrom } : {}),
      };
    }
    return {
      ...p, rules: out,
      publishedBy: p.status === 'published' ? publishers(row.id).map((x) => decode(PUBLISHER_SPEC, x)) : null,
      history: hist(row.id).map((h) => ({ id: h.id, at: h.at, action: h.action, by: byOf(h), detail: { policyVersion: row.id, ...(h.detail_seeded ? { seeded: true } : {}) } })),
    };
  });
}

/** The three seeded policy versions as records (published, attributed to the migration). */
export function seededPolicyRecords(now) {
  return SEEDED_POLICY_VERSIONS.map((v, i) => ({
    ...structuredClone(v), publishedAt: now, proposedBy: null, approvedBy: null, createdAt: now, rev: 1, revAt: now, revBy: null,
    history: [{ id: `aud-mig0027-${i + 1}`, at: now, action: 'policy_version_published', by: { kind: 'system', userId: null, name: `migration ${COMPLIANCE_POLICIES_MIGRATION}` }, detail: { policyVersion: v.id, seeded: true } }],
  }));
}
/** Migration 0027: insert the seeded policy versions (every database has them from its first boot). */
export function insertSeededPolicies(sqlite, now) {
  const st = statements(sqlite);
  for (const raw of seededPolicyRecords(now)) {
    const t = typePolicy(raw, 'seeded policy');
    if (!t.ok) throw new Error(`${COMPLIANCE_POLICIES_MIGRATION}: a seeded policy version does not type: ${t.reason}`);
    writePolicy(st, t.record, { isNew: true });
  }
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const compliancePoliciesLive = (sqlite) => migrationApplied(sqlite, COMPLIANCE_POLICIES_MIGRATION);
function readAll(sqlite) {
  return {
    tsReviewers: decodeReviewers(sqlite, sqlite.prepare('SELECT * FROM ts_reviewers ORDER BY rowid').all()),
    jurisdictionPolicies: decodePolicies(sqlite, sqlite.prepare('SELECT * FROM jurisdiction_policies ORDER BY rowid').all()),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const COMPLIANCE_POLICIES_RECORDS = {
  names: COMPLIANCE_POLICIES_COLLECTIONS,
  read(sqlite) { return compliancePoliciesLive(sqlite) ? readAll(sqlite) : null; },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update']);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * `createCompliancePoliciesRepository({ sqlite, unit, now, log })`: `reviewers` and `policies`, each with its writes and
 * queries, plus `reads` (the queries alone).
 */
export function createCompliancePoliciesRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the compliance policies repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const st = statements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key)) throw refusal('COMPLIANCE_POLICIES_NESTED_UPDATE', `${key} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try { return fn(); } finally { updating.delete(key); }
  };
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (!t.ok) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', t.reason, { field: t.field ?? null }); return t.record; };
  const historyTaken = (h) => q('SELECT 1 FROM ts_reviewer_history WHERE id = ? UNION ALL SELECT 1 FROM jurisdiction_policy_history WHERE id = ?').get(h.id, h.id);
  const checkUpdate = (table, id, stored, next, immutable) => {
    for (const k of immutable) if (!same(next[k], stored[k])) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `${table} ${id}: ${k} cannot change`);
    if (next.history.length < stored.history.length || stored.history.some((h, i) => !same(h, next.history[i]))) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `${table} ${id}: the history only grows (a stored entry cannot change or go)`);
    const taken = next.history.slice(stored.history.length).find(historyTaken);
    if (taken) throw refusal('COMPLIANCE_POLICIES_DUPLICATE', `history entry ${taken.id} already exists`);
  };
  const updater = (table, byId, type, immutable, write, extra = () => {}) => (id, change) => guard(`${table} ${id}`, () => operation(() => {
    if (typeof change !== 'function') throw new TypeError(`${table}: update(id, change) needs a function that edits the copy it is given`);
    const stored = byId(id);
    if (!stored) throw refusal('COMPLIANCE_POLICIES_NOT_FOUND', `${table} ${id} is not a record of the repository`);
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

  // ---- reviewers
  const reviewerById = one(decodeReviewers, 'SELECT * FROM ts_reviewers WHERE id = ?');
  const reviewers = {
    create: (raw) => operation(() => {
      const r = typedOr(typeReviewer, raw, 'tsReviewers');
      if (q('SELECT 1 FROM ts_reviewers WHERE id = ?').get(r.id)) throw refusal('COMPLIANCE_POLICIES_DUPLICATE', `ts_reviewers ${r.id} already exists`);
      if (r.status !== 'active') throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `ts_reviewers ${r.id}: a reviewer is created active`);
      const taken = r.history.find(historyTaken); if (taken) throw refusal('COMPLIANCE_POLICIES_DUPLICATE', `history entry ${taken.id} already exists`);
      writeReviewer(st, r);
      return reviewerById(r.id);
    }),
    /** `update(id, change)`: the identity, secret, role and creation never change; a revocation is final; the history only grows. */
    update: updater('ts_reviewers', reviewerById, typeReviewer, ['id', 'name', 'role', 'secretHash', 'createdAt', 'createdBy'], (next, stored) => writeReviewer(st, next, stored.history.length), (stored, next) => {
      if (stored.status === 'revoked' && !same({ s: next.status, a: next.revokedAt, b: next.revokedBy }, { s: stored.status, a: stored.revokedAt, b: stored.revokedBy })) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `ts_reviewers ${stored.id}: a revocation is final`);
      if (next.revokedBy && !q('SELECT 1 FROM ts_reviewers WHERE id = ?').get(next.revokedBy.id)) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `ts_reviewers ${stored.id}: the revoker ${next.revokedBy.id} is not a reviewer`);
    }),
    byId: reviewerById,
    /** The reviewer if active, else null (every reviewer request). */
    activeById: one(decodeReviewers, "SELECT * FROM ts_reviewers WHERE id = ? AND status = 'active'"),
    /** Every reviewer, oldest first (a short list: the T&S team). */
    all: many(decodeReviewers, 'SELECT * FROM ts_reviewers ORDER BY rowid'),
    /** How many reviewers hold this role and are active (the last-administrator rule). */
    activeCount: (role) => q("SELECT COUNT(*) AS n FROM ts_reviewers WHERE status = 'active' AND role = ?").get(role).n,
    count: () => q('SELECT COUNT(*) AS n FROM ts_reviewers').get().n,
  };

  // ---- policies
  const policyById = one(decodePolicies, 'SELECT * FROM jurisdiction_policies WHERE id = ?');
  let publishedCache = { sig: null, list: Object.freeze([]) };
  const policies = {
    create: (raw) => operation(() => {
      const p = typedOr(typePolicy, raw, 'jurisdictionPolicies');
      if (q('SELECT 1 FROM jurisdiction_policies WHERE id = ?').get(p.id)) throw refusal('COMPLIANCE_POLICIES_DUPLICATE', `jurisdiction_policies ${p.id} already exists`, { field: 'id' });
      if (p.status !== 'proposed') throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `jurisdiction_policies ${p.id}: a version is proposed first (dual control)`, { field: 'status' });
      if (p.supersedes) {
        const prior = q('SELECT jurisdiction FROM jurisdiction_policies WHERE id = ?').get(p.supersedes);
        if (!prior || prior.jurisdiction !== p.jurisdiction) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `jurisdiction_policies ${p.id}: supersedes must name an existing version of ${p.jurisdiction}`, { field: 'supersedes' });
      }
      if (p.proposedBy && !q('SELECT 1 FROM ts_reviewers WHERE id = ?').get(p.proposedBy.id)) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `jurisdiction_policies ${p.id}: the proposer ${p.proposedBy.id} is not a reviewer`, { field: 'proposedBy' });
      const taken = p.history.find(historyTaken); if (taken) throw refusal('COMPLIANCE_POLICIES_DUPLICATE', `history entry ${taken.id} already exists`);
      writePolicy(st, p, { isNew: true });
      return policyById(p.id);
    }),
    /** `update(id, change)`: a version's content never changes; publication (once) sets the approver, publishers and instant; the history only grows. */
    update: updater('jurisdiction_policies', policyById, typePolicy,
      ['id', 'regulator', 'jurisdiction', 'policyVersion', 'supersedes', 'effectiveFrom', 'effectiveTo', 'rules', 'proposedBy', 'createdAt'],
      (next, stored) => writePolicy(st, next, { isNew: false, knownHistory: stored.history.length }),
      (stored, next) => {
        if (stored.status === 'published' && !same({ a: next.status, b: next.approvedBy, c: next.publishedAt, d: next.publishedBy }, { a: stored.status, b: stored.approvedBy, c: stored.publishedAt, d: stored.publishedBy })) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `jurisdiction_policies ${stored.id}: a published version never changes`);
        if (next.approvedBy && !q('SELECT 1 FROM ts_reviewers WHERE id = ?').get(next.approvedBy.id)) throw refusal('COMPLIANCE_POLICIES_INPUT_INVALID', `jurisdiction_policies ${stored.id}: the approver ${next.approvedBy.id} is not a reviewer`);
      }),
    byId: policyById,
    exists: (id) => typeof id === 'string' && !!q('SELECT 1 FROM jurisdiction_policies WHERE id = ?').get(id),
    /** Every version, oldest first (the T&S and admin lists: a short list). */
    all: many(decodePolicies, 'SELECT * FROM jurisdiction_policies ORDER BY rowid'),
    /** The published versions, oldest first, decoded once per change (every evaluation reads them). */
    published() {
      const s = q("SELECT COUNT(*) AS n, COALESCE(SUM(rev), 0) AS r, COALESCE(MAX(rowid), 0) AS m, COALESCE(SUM(published_at), 0) AS p FROM jurisdiction_policies WHERE status = 'published'").get();
      const sig = `${s.n}:${s.r}:${s.m}:${s.p}`;
      if (publishedCache.sig !== sig) publishedCache = { sig, list: Object.freeze(decodePolicies(sqlite, q("SELECT * FROM jurisdiction_policies WHERE status = 'published' ORDER BY rowid").all()).map(deepFreeze)) };
      return publishedCache.list;
    },
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { reviewers, policies };
  const counters = { tsReviewers: q('SELECT COUNT(*) AS n FROM ts_reviewers'), jurisdictionPolicies: q('SELECT COUNT(*) AS n FROM jurisdiction_policies') };
  return {
    ...repo,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!compliancePoliciesLive(sqlite)) throw new Error(`the compliance policies repository needs ${COMPLIANCE_POLICIES_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(COMPLIANCE_POLICIES_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return COMPLIANCE_POLICIES_RECORDS.read(sqlite); },
    log,
    now,
  };
}
