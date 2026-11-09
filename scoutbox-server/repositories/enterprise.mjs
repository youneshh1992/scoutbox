/**
 * S13b — enterprise as typed tables (migration `0035_enterprise`; docs/architecture/migration.md §4.5 S13;
 * sql/08_operations_integrations.sql).
 *
 * Records:
 *   - A staff invite (F12): the emailed code is stored only as its sha-256 (`tokenHash`); the public accept looks the
 *     code up by its hash. Pending → accepted (naming the staff account it bound) | revoked | expired (written when an
 *     expired code is presented).
 *   - An SSO configuration (F12): at most one per organisation; only the local test identity provider can be named.
 *   - An SSO sign-in state (F12): the state and the nonce handed to the browser are stored only as hashes; single use.
 *   - A support ticket (F12): the records it references are ordered rows (`case` or `import`, by id, nothing copied);
 *     Trust & Safety replies are ordered rows.
 *   - A support access grant (F12): requested by Trust & Safety, approved by a lead of the organisation for a number
 *     of hours; every read under it is an ordered access-log row.
 *
 * WRITES are explicit operations; every write joins the open unit of work, the caller's transaction or its own.
 * READS are SQL: no mirror. Fresh, deep-frozen records; lists decode child rows in one batch. Modules receive the
 * queries as `enterpriseReads`.
 *
 * References. Organisations and the staff named are RESTRICT keys; so are the keys inside the domain (a grant's
 * ticket). Child rows cascade with their owner, except the access log, which is audit and RESTRICT.
 */
import { isPlainObject, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { text, int, oneOf, tableDdl, bad, typeSpec, encode, decode, insertSql, upsertSql } from './fieldSpecs.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const ENTERPRISE_MIGRATION = '0035_enterprise';
export const ENTERPRISE_COLLECTIONS = Object.freeze(['orgInvites', 'ssoConfigs', 'ssoStates', 'supportTickets', 'supportAccessGrants']);

// ------------------------------------------------------------------ vocabularies and limits (one definition)
export const INVITE_STATUSES = Object.freeze(['pending', 'accepted', 'revoked', 'expired']);
export const SSO_ISSUERS = Object.freeze(['local-test-idp']);
export const TICKET_STATUSES = Object.freeze(['open', 'closed']);
/** The kinds of record a ticket can reference (the only ones the support read resolves). */
export const SUPPORT_REF_KINDS = Object.freeze(['case', 'import']);
export const GRANT_STATUSES = Object.freeze(['requested', 'active']);
export const ACCESS_LOG_WHAT = Object.freeze(['org-records']);
export const ENTERPRISE_LIMITS = Object.freeze({
  id: 80, email: 254, inviteName: 80, role: 60, name: 200, clientId: 200, subject: 160, body: 2000, refs: 10,
  reply: 2000, replies: 500, hours: [1, 72], accessLog: 10_000,
});
const L = ENTERPRISE_LIMITS;
const HASH = /^[0-9a-f]{64}$/;

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };

const INVITE_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), text('email', 'email', L.email, { req: true, nonEmpty: true }),
  text('name', 'name', L.inviteName, { req: true, nonEmpty: true }), text('role', 'role', L.role, { req: true, nonEmpty: true }),
  text('tokenHash', 'token_hash', 64, req), oneOf('status', 'status', INVITE_STATUSES, req), text('invitedBy', 'invited_by_name', L.name),
  int('createdAt', 'created_at', req), int('expiresAt', 'expires_at', req), int('acceptedAt', 'accepted_at'), int('revokedAt', 'revoked_at'), idf('userId', 'user_id'),
];
const SSO_CONFIG_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), oneOf('issuer', 'issuer', SSO_ISSUERS, req), text('clientId', 'client_id', L.clientId, { req: true, nonEmpty: true }),
  int('createdAt', 'created_at', req), int('updatedAt', 'updated_at', req),
];
const SSO_STATE_SPEC = [
  idf('id', 'id', req), text('stateHash', 'state_hash', 64, req), text('nonceHash', 'nonce_hash', 64, req), idf('orgId', 'org_id', req),
  int('createdAt', 'created_at', req), int('expiresAt', 'expires_at', req), int('usedAt', 'used_at'),
];
const TICKET_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), idf('byUserId', 'by_user_id', req), text('byName', 'by_name', L.name),
  text('subject', 'subject', L.subject, { req: true, nonEmpty: true }), text('body', 'body', L.body, req),
  oneOf('status', 'status', TICKET_STATUSES, req), int('createdAt', 'created_at', req),
];
const GRANT_SPEC = [
  idf('id', 'id', req), idf('ticketId', 'ticket_id', req), idf('orgId', 'org_id', req), int('hours', 'hours', req),
  oneOf('status', 'status', GRANT_STATUSES, req), int('requestedAt', 'requested_at', req), text('approvedBy', 'approved_by_name', L.name),
  int('approvedAt', 'approved_at'), int('expiresAt', 'expires_at'),
];

// ------------------------------------------------------------------ DDL
const rowOf = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE RESTRICT`;
const ownedBy = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE CASCADE`;
const col = (c, def) => `${c.padEnd(40)} ${def}`;
const idCol = (c) => col(c, `TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`);
const ordCol = (c = 'ord') => col(c, `INTEGER NOT NULL CHECK (${c} >= 0)`);
const table = (name, cols) => `CREATE TABLE ${name} (\n  ${cols.join(',\n  ')}\n) STRICT;`;
const enumIn = (vals) => vals.map((v) => `'${v}'`).join(',');
const hashCheck = (c) => `CHECK (length(${c}) = 64 AND ${c} NOT GLOB '*[^0-9a-f]*')`;

export const ENTERPRISE_DDL = [
  tableDdl('org_invites', INVITE_SPEC, [
    rowOf('orgs', 'org_id'), rowOf('org_users', 'user_id'), hashCheck('token_hash'),
    "CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))", "CHECK ((status = 'accepted') = (user_id IS NOT NULL))",
    "CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))",
  ]),
  'CREATE UNIQUE INDEX org_invites_token_hash ON org_invites (token_hash);',
  'CREATE INDEX org_invites_org ON org_invites (org_id);',

  tableDdl('sso_configs', SSO_CONFIG_SPEC, [rowOf('orgs', 'org_id'), 'UNIQUE (org_id)']),

  tableDdl('sso_states', SSO_STATE_SPEC, [rowOf('orgs', 'org_id'), hashCheck('state_hash'), hashCheck('nonce_hash')]),
  'CREATE UNIQUE INDEX sso_states_state_hash ON sso_states (state_hash);',

  tableDdl('support_tickets', TICKET_SPEC, [rowOf('orgs', 'org_id'), rowOf('org_users', 'by_user_id')]),
  'CREATE INDEX support_tickets_org ON support_tickets (org_id);',
  table('support_ticket_refs', [
    idCol('ticket_id'), ordCol(), col('kind', `TEXT NOT NULL CHECK (kind IN (${enumIn(SUPPORT_REF_KINDS)}))`), idCol('ref_id'),
    ownedBy('support_tickets', 'ticket_id'), 'PRIMARY KEY (ticket_id, ord)',
  ]),
  table('support_ticket_replies', [
    idCol('ticket_id'), ordCol(), col('at', 'INTEGER NOT NULL'), col('by_name', `TEXT NOT NULL CHECK (length(by_name) > 0 AND length(by_name) <= ${L.name})`),
    col('text', `TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= ${L.reply})`),
    ownedBy('support_tickets', 'ticket_id'), 'PRIMARY KEY (ticket_id, ord)',
  ]),

  tableDdl('support_access_grants', GRANT_SPEC, [
    rowOf('support_tickets', 'ticket_id'), rowOf('orgs', 'org_id'),
    `CHECK (hours >= ${L.hours[0]} AND hours <= ${L.hours[1]})`,
    "CHECK ((status = 'active') = (approved_at IS NOT NULL))", "CHECK ((status = 'active') = (expires_at IS NOT NULL))",
    "CHECK (status = 'active' OR approved_by_name IS NULL)",
  ]),
  'CREATE INDEX support_access_grants_ticket ON support_access_grants (ticket_id, status);',
  'CREATE INDEX support_access_grants_org ON support_access_grants (org_id);',
  table('support_access_log', [
    idCol('grant_id'), ordCol(), col('at', 'INTEGER NOT NULL'), col('what', `TEXT NOT NULL CHECK (what IN (${enumIn(ACCESS_LOG_WHAT)}))`),
    rowOf('support_access_grants', 'grant_id'), 'PRIMARY KEY (grant_id, ord)',
  ]),
].join('\n');
export const ENTERPRISE_TABLES = Object.freeze([
  'org_invites', 'sso_configs', 'sso_states', 'support_tickets', 'support_ticket_refs', 'support_ticket_replies', 'support_access_grants', 'support_access_log',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const withOnly = (raw, at, keys) => {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  return unknown.length ? { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` } : { ok: true };
};
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= L.id;

export function typeInvite(raw, at = 'orgInvites') {
  const label = labelOf(at, raw);
  const t = typeSpec(INVITE_SPEC, raw, label); if (!t.ok) return t;
  const r = t.record;
  if (!HASH.test(r.tokenHash)) return bad(label, 'tokenHash', 'must be a sha-256 hex digest');
  if ((r.status === 'accepted') !== (r.acceptedAt !== null) || (r.status === 'accepted') !== (r.userId !== null)) return bad(label, 'acceptedAt', 'and userId are set exactly when the invite is accepted');
  if ((r.status === 'revoked') !== (r.revokedAt !== null)) return bad(label, 'revokedAt', 'is set exactly when the invite is revoked');
  return t;
}
export const typeSsoConfig = (raw, at = 'ssoConfigs') => typeSpec(SSO_CONFIG_SPEC, raw, labelOf(at, raw));
export function typeSsoState(raw, at = 'ssoStates') {
  const label = labelOf(at, raw);
  const t = typeSpec(SSO_STATE_SPEC, raw, label); if (!t.ok) return t;
  if (!HASH.test(t.record.stateHash)) return bad(label, 'stateHash', 'must be a sha-256 hex digest');
  if (!HASH.test(t.record.nonceHash)) return bad(label, 'nonceHash', 'must be a sha-256 hex digest');
  return t;
}
/** A ticket's references: a list of at most ten `{ kind, id }`, kind `case` or `import`. */
export function typeRefs(list, at = 'refs') {
  if (!Array.isArray(list)) return { ok: false, field: at, reason: `${at} must be a list (got ${describe(list)})` };
  if (list.length > L.refs) return { ok: false, field: at, reason: `${at} holds more than ${L.refs} references` };
  const out = [];
  for (const [i, r] of list.entries()) {
    const f = `${at}[${i}]`;
    const shape = withOnly(r, f, ['kind', 'id']); if (!shape.ok) return { ...shape, field: f };
    if (!SUPPORT_REF_KINDS.includes(r.kind)) return { ok: false, field: `${f}.kind`, reason: `${f}.kind must be one of ${SUPPORT_REF_KINDS.join('|')} (got ${describe(r.kind)})` };
    if (!isId(r.id)) return { ok: false, field: `${f}.id`, reason: `${f}.id must be a record id (got ${describe(r.id)})` };
    out.push({ kind: r.kind, id: r.id });
  }
  return { ok: true, value: out };
}
function typeReply(raw, at) {
  const shape = withOnly(raw, at, ['at', 'by', 'text']); if (!shape.ok) return shape;
  if (!Number.isSafeInteger(raw.at)) return bad(at, 'at', `must be an integer (got ${describe(raw.at)})`);
  if (typeof raw.by !== 'string' || !raw.by.length || raw.by.length > L.name) return bad(at, 'by', 'must be a name');
  if (typeof raw.text !== 'string' || !raw.text.length || raw.text.length > L.reply) return bad(at, 'text', `must be text of 1 to ${L.reply} characters`);
  return { ok: true, record: { at: raw.at, by: raw.by, text: raw.text } };
}
export function typeTicket(raw, at = 'supportTickets') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { refs = [], replies = [], ...rest } = raw;
  const t = typeSpec(TICKET_SPEC, rest, label); if (!t.ok) return t;
  const r = typeRefs(refs, `${label}.refs`); if (!r.ok) return r;
  if (!Array.isArray(replies) || replies.length > L.replies) return bad(label, 'replies', `must be a list of at most ${L.replies}`);
  const rs = [];
  for (const [i, x] of replies.entries()) { const y = typeReply(x, `${label}.replies[${i}]`); if (!y.ok) return y; rs.push(y.record); }
  return { ok: true, record: { ...t.record, refs: r.value, replies: rs } };
}
function typeAccess(raw, at) {
  const shape = withOnly(raw, at, ['at', 'what']); if (!shape.ok) return shape;
  if (!Number.isSafeInteger(raw.at)) return bad(at, 'at', `must be an integer (got ${describe(raw.at)})`);
  if (!ACCESS_LOG_WHAT.includes(raw.what)) return bad(at, 'what', `must be one of ${ACCESS_LOG_WHAT.join('|')} (got ${describe(raw.what)})`);
  return { ok: true, record: { at: raw.at, what: raw.what } };
}
export function typeGrant(raw, at = 'supportAccessGrants') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { accessLog = [], ...rest } = raw;
  const t = typeSpec(GRANT_SPEC, rest, label); if (!t.ok) return t;
  const g = t.record;
  if (g.hours < L.hours[0] || g.hours > L.hours[1]) return bad(label, 'hours', `must be from ${L.hours[0]} to ${L.hours[1]}`);
  const active = g.status === 'active';
  if (active !== (g.approvedAt !== null) || active !== (g.expiresAt !== null)) return bad(label, 'approvedAt', 'and expiresAt are set exactly when the grant is active');
  if (!active && g.approvedBy !== null) return bad(label, 'approvedBy', 'is set once the grant is approved');
  if (!Array.isArray(accessLog) || accessLog.length > L.accessLog) return bad(label, 'accessLog', `must be a list of at most ${L.accessLog}`);
  if (!active && accessLog.length) return bad(label, 'accessLog', 'is empty until the grant is approved');
  const log = [];
  for (const [i, x] of accessLog.entries()) { const y = typeAccess(x, `${label}.accessLog[${i}]`); if (!y.ok) return y; log.push(y.record); }
  return { ok: true, record: { ...g, accessLog: log } };
}

// ------------------------------------------------------------------ rows
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    invite: p(upsertSql('org_invites', INVITE_SPEC)),
    ssoConfig: p(upsertSql('sso_configs', SSO_CONFIG_SPEC)),
    ssoState: p(insertSql('sso_states', SSO_STATE_SPEC)),
    ticket: p(upsertSql('support_tickets', TICKET_SPEC)),
    ref: p('INSERT INTO support_ticket_refs (ticket_id, ord, kind, ref_id) VALUES (?, ?, ?, ?)'),
    reply: p('INSERT INTO support_ticket_replies (ticket_id, ord, at, by_name, text) VALUES (?, ?, ?, ?, ?)'),
    grant: p(upsertSql('support_access_grants', GRANT_SPEC)),
    access: p('INSERT INTO support_access_log (grant_id, ord, at, what) VALUES (?, ?, ?, ?)'),
  };
}
function writeTicket(st, t) {
  st.ticket.run(encode(TICKET_SPEC, t));
  t.refs.forEach((r, i) => st.ref.run(t.id, i, r.kind, r.id));
  t.replies.forEach((r, i) => st.reply.run(t.id, i, r.at, r.by, r.text));
}
function writeGrant(st, g) {
  st.grant.run(encode(GRANT_SPEC, g));
  g.accessLog.forEach((a, i) => st.access.run(g.id, i, a.at, a.what));
}
function decodeTickets(sqlite, rows) {
  const tids = rows.map((r) => r.id);
  const refs = childRowsOf(sqlite, 'support_ticket_refs', 'ticket_id', tids, { order: 'ord' });
  const replies = childRowsOf(sqlite, 'support_ticket_replies', 'ticket_id', tids, { order: 'ord' });
  return rows.map((row) => ({
    ...decode(TICKET_SPEC, row),
    refs: refs.all(row.id).map((r) => ({ kind: r.kind, id: r.ref_id })),
    replies: replies.all(row.id).map((r) => ({ at: r.at, by: r.by_name, text: r.text })),
  }));
}
function decodeGrants(sqlite, rows) {
  const log = childRowsOf(sqlite, 'support_access_log', 'grant_id', rows.map((r) => r.id), { order: 'ord' });
  return rows.map((row) => ({ ...decode(GRANT_SPEC, row), accessLog: log.all(row.id).map((a) => ({ at: a.at, what: a.what })) }));
}

// ------------------------------------------------------------------ snapshot (fixtures and the persistence batteries)
export const enterpriseLive = (sqlite) => migrationApplied(sqlite, ENTERPRISE_MIGRATION);
function readAll(sqlite) {
  const all = (t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return {
    orgInvites: all('org_invites').map((r) => decode(INVITE_SPEC, r)),
    ssoConfigs: all('sso_configs').map((r) => decode(SSO_CONFIG_SPEC, r)),
    ssoStates: all('sso_states').map((r) => decode(SSO_STATE_SPEC, r)),
    supportTickets: decodeTickets(sqlite, all('support_tickets')),
    supportAccessGrants: decodeGrants(sqlite, all('support_access_grants')),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back); null before its migration. */
export const ENTERPRISE_RECORDS = {
  names: ENTERPRISE_COLLECTIONS,
  read(sqlite) { return enterpriseLive(sqlite) ? readAll(sqlite) : null; },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'revoke', 'expire', 'accept', 'configure', 'markUsed', 'reply', 'request', 'approve', 'logAccess']);

/**
 * `createEnterpriseRepository({ sqlite, unit, now, log })`: `invites`, `sso`, `ssoStates`, `tickets` and `grants`, each
 * with its writes and queries, plus `reads` (the queries alone: `enterpriseReads`).
 */
export function createEnterpriseRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the enterprise repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const st = statements(sqlite);
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (!t.ok) throw refusal('ENTERPRISE_INPUT_INVALID', t.reason); return t.record; };
  const str = (v) => typeof v === 'string';
  const needOrg = (table, rec) => { if (!q('SELECT 1 FROM orgs WHERE id = ?').get(rec.orgId)) throw refusal('ENTERPRISE_REFERENCE_MISSING', `${table} ${rec.id}: orgId names no organisation (${rec.orgId})`); };
  const needStaff = (table, rec, userId, field) => {
    const u = q('SELECT org_id FROM org_users WHERE id = ?').get(userId);
    if (!u) throw refusal('ENTERPRISE_REFERENCE_MISSING', `${table} ${rec.id}: ${field} names no staff member (${userId})`);
    if (u.org_id !== rec.orgId) throw refusal('ENTERPRISE_INPUT_INVALID', `${table} ${rec.id}: ${field} is another organisation's staff member`);
  };
  const notFound = (table, id) => refusal('ENTERPRISE_NOT_FOUND', `${table} ${id} is not a record of the repository`);
  const pageBy = (sql, params, { after = null, limit }, map) => {
    const rows = q(sql).all(...params, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
    const page = pageOf(rows, limit, (r) => [r.rowid]);
    return { items: map(page.items), nextCursor: page.nextCursor };
  };

  // ---- staff invites
  const inviteOf = (r) => (r ? deepFreeze(decode(INVITE_SPEC, r)) : null);
  const inviteById = (id) => (str(id) ? inviteOf(q('SELECT * FROM org_invites WHERE id = ?').get(id)) : null);
  const setInvite = (id, change) => {
    const i = inviteById(id);
    if (!i) throw notFound('org_invites', id);
    const next = typedOr(typeInvite, { ...i, ...change }, 'orgInvites');
    st.invite.run(encode(INVITE_SPEC, next));
    return inviteById(id);
  };
  const invites = {
    create: (raw) => operation(() => {
      const i = typedOr(typeInvite, raw, 'orgInvites');
      if (i.status !== 'pending') throw refusal('ENTERPRISE_INPUT_INVALID', `org_invites ${i.id}: a new invite is pending`);
      if (inviteById(i.id)) throw refusal('ENTERPRISE_DUPLICATE', `org_invites ${i.id} already exists`);
      needOrg('org_invites', i);
      st.invite.run(encode(INVITE_SPEC, i));
      return inviteById(i.id);
    }),
    /** A pending invite is revoked at `at`; any other is returned as it is. */
    revoke: (id, at) => operation(() => { const i = inviteById(id); if (!i) throw notFound('org_invites', id); return i.status === 'pending' ? setInvite(id, { status: 'revoked', revokedAt: at }) : i; }),
    /** A pending invite whose code was presented after it expired. */
    expire: (id) => operation(() => { const i = inviteById(id); if (!i) throw notFound('org_invites', id); return i.status === 'pending' ? setInvite(id, { status: 'expired' }) : i; }),
    /** A pending invite accepted at `at`, bound to the staff account `userId` of its organisation. */
    accept: (id, { userId, at }) => operation(() => {
      const i = inviteById(id);
      if (!i) throw notFound('org_invites', id);
      if (i.status !== 'pending') throw refusal('ENTERPRISE_INPUT_INVALID', `org_invites ${id} is ${i.status}, not pending`);
      needStaff('org_invites', i, userId, 'userId');
      return setInvite(id, { status: 'accepted', acceptedAt: at, userId });
    }),
    byId: inviteById,
    forOrgById: (orgId, id) => { const i = inviteById(id); return i && i.orgId === orgId ? i : null; },
    /** The invite whose code hashes to `tokenHash`, or null. */
    byTokenHash: (tokenHash) => (str(tokenHash) ? inviteOf(q('SELECT * FROM org_invites WHERE token_hash = ?').get(tokenHash)) : null),
    /** A page of the organisation's invites, newest first. */
    page: (orgId, page) => pageBy('SELECT rowid, * FROM org_invites WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?', [orgId], page, (rows) => rows.map(inviteOf)),
  };

  // ---- SSO configuration and sign-in states
  const configOf = (r) => (r ? deepFreeze(decode(SSO_CONFIG_SPEC, r)) : null);
  const sso = {
    /** Create or replace the organisation's configuration: `{ id, orgId, issuer, clientId, at }` (the id is used only on creation). */
    configure: ({ id, orgId, issuer, clientId, at }) => operation(() => {
      const cur = sso.forOrg(orgId);
      const c = typedOr(typeSsoConfig, { id: cur?.id ?? id, orgId, issuer, clientId, createdAt: cur?.createdAt ?? at, updatedAt: at }, 'ssoConfigs');
      needOrg('sso_configs', c);
      st.ssoConfig.run(encode(SSO_CONFIG_SPEC, c));
      return sso.forOrg(orgId);
    }),
    forOrg: (orgId) => (str(orgId) ? configOf(q('SELECT * FROM sso_configs WHERE org_id = ?').get(orgId)) : null),
  };
  const stateOf = (r) => (r ? deepFreeze(decode(SSO_STATE_SPEC, r)) : null);
  const ssoStates = {
    create: (raw) => operation(() => {
      const s = typedOr(typeSsoState, raw, 'ssoStates');
      if (s.usedAt !== null) throw refusal('ENTERPRISE_INPUT_INVALID', `sso_states ${s.id}: a new state is unused`);
      needOrg('sso_states', s);
      st.ssoState.run(encode(SSO_STATE_SPEC, s));
      return stateOf(q('SELECT * FROM sso_states WHERE id = ?').get(s.id));
    }),
    /** Mark the state used at `at`; false when it was already used (single use, decided in the database). */
    markUsed: (id, at) => operation(() => q('UPDATE sso_states SET used_at = ? WHERE id = ? AND used_at IS NULL').run(at, id).changes === 1),
    byStateHash: (stateHash) => (str(stateHash) ? stateOf(q('SELECT * FROM sso_states WHERE state_hash = ?').get(stateHash)) : null),
  };

  // ---- support tickets
  const decT = (rows) => decodeTickets(sqlite, rows).map(deepFreeze);
  const ticketById = (id) => (str(id) ? decT(q('SELECT * FROM support_tickets WHERE id = ?').all(id))[0] ?? null : null);
  const tickets = {
    create: (raw) => operation(() => {
      const t = typedOr(typeTicket, raw, 'supportTickets');
      if (t.status !== 'open' || t.replies.length) throw refusal('ENTERPRISE_INPUT_INVALID', `support_tickets ${t.id}: a new ticket is open, with no replies`);
      if (ticketById(t.id)) throw refusal('ENTERPRISE_DUPLICATE', `support_tickets ${t.id} already exists`);
      needOrg('support_tickets', t); needStaff('support_tickets', t, t.byUserId, 'byUserId');
      writeTicket(st, t);
      return ticketById(t.id);
    }),
    /** Trust & Safety replies `{ at, by, text }`; `close` closes the ticket too. */
    reply: (id, raw, { close = false } = {}) => operation(() => {
      const t = ticketById(id);
      if (!t) throw notFound('support_tickets', id);
      const r = typedOr((x, a) => typeReply(x, a), raw, `support_tickets ${id} reply`);
      if (t.replies.length >= L.replies) throw refusal('ENTERPRISE_INPUT_INVALID', `support_tickets ${id} holds ${L.replies} replies already`);
      st.reply.run(id, t.replies.length, r.at, r.by, r.text);
      if (close) q("UPDATE support_tickets SET status = 'closed' WHERE id = ?").run(id);
      return ticketById(id);
    }),
    byId: ticketById,
    /** A page of the organisation's tickets, newest first. */
    page: (orgId, page) => pageBy('SELECT rowid, * FROM support_tickets WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?', [orgId], page, (rows) => decT(rows)),
    /** A page of every organisation's tickets, newest first (Trust & Safety). */
    pageAll: (page) => pageBy('SELECT rowid, * FROM support_tickets WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?', [], page, (rows) => decT(rows)),
  };

  // ---- support access grants
  const decG = (rows) => decodeGrants(sqlite, rows).map(deepFreeze);
  const grantById = (id) => (str(id) ? decG(q('SELECT * FROM support_access_grants WHERE id = ?').all(id))[0] ?? null : null);
  const grants = {
    /** Trust & Safety asks for access to a ticket's organisation for `hours`. */
    request: (raw) => operation(() => {
      const g = typedOr(typeGrant, raw, 'supportAccessGrants');
      if (g.status !== 'requested') throw refusal('ENTERPRISE_INPUT_INVALID', `support_access_grants ${g.id}: a new grant is requested`);
      if (grantById(g.id)) throw refusal('ENTERPRISE_DUPLICATE', `support_access_grants ${g.id} already exists`);
      const t = ticketById(g.ticketId);
      if (!t) throw refusal('ENTERPRISE_REFERENCE_MISSING', `support_access_grants ${g.id}: no ticket ${g.ticketId}`);
      if (t.orgId !== g.orgId) throw refusal('ENTERPRISE_INPUT_INVALID', `support_access_grants ${g.id}: the ticket is another organisation's`);
      writeGrant(st, g);
      return grantById(g.id);
    }),
    /** A lead approves a requested grant at `at`; it runs for its hours. */
    approve: (id, { by, at }) => operation(() => {
      const g = grantById(id);
      if (!g) throw notFound('support_access_grants', id);
      if (g.status !== 'requested') throw refusal('ENTERPRISE_INPUT_INVALID', `support_access_grants ${id} is ${g.status}, not requested`);
      const next = typedOr(typeGrant, { ...g, accessLog: [], status: 'active', approvedBy: by, approvedAt: at, expiresAt: at + g.hours * 3600_000 }, 'supportAccessGrants');
      st.grant.run(encode(GRANT_SPEC, next));
      return grantById(id);
    }),
    /** Log one read under an active grant. */
    logAccess: (id, { at, what }) => operation(() => {
      const g = grantById(id);
      if (!g) throw notFound('support_access_grants', id);
      if (g.status !== 'active') throw refusal('ENTERPRISE_INPUT_INVALID', `support_access_grants ${id} is not active`);
      const a = typedOr((x, l) => typeAccess(x, l), { at, what }, `support_access_grants ${id} access`);
      st.access.run(id, g.accessLog.length, a.at, a.what);
      return grantById(id);
    }),
    byId: grantById,
    /** The ticket's oldest grant awaiting approval by the organisation, or null. */
    pendingFor: (orgId, ticketId) => decG(q("SELECT * FROM support_access_grants WHERE ticket_id = ? AND org_id = ? AND status = 'requested' ORDER BY rowid LIMIT 1").all(ticketId, orgId))[0] ?? null,
    /** The ticket's oldest grant running at `at`, or null. */
    liveFor: (ticketId, at) => decG(q("SELECT * FROM support_access_grants WHERE ticket_id = ? AND status = 'active' AND expires_at > ? ORDER BY rowid LIMIT 1").all(ticketId, at))[0] ?? null,
    /** Every grant of the organisation, oldest first (the audit export). */
    forOrg: (orgId) => decG(q('SELECT * FROM support_access_grants WHERE org_id = ? ORDER BY rowid').all(orgId)),
    /** The grants of the tickets named, newest first. */
    forTickets: (ticketIds) => decG(q('SELECT * FROM support_access_grants WHERE ticket_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC').all(JSON.stringify(ticketIds))),
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { invites, sso, ssoStates, tickets, grants };
  const counters = Object.fromEntries([
    ['orgInvites', 'org_invites'], ['ssoConfigs', 'sso_configs'], ['ssoStates', 'sso_states'], ['supportTickets', 'support_tickets'], ['supportAccessGrants', 'support_access_grants'],
  ].map(([n, t]) => [n, q(`SELECT COUNT(*) AS n FROM ${t}`)]));
  return {
    ...repo,
    /** The queries alone, for modules that must not write (`enterpriseReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!enterpriseLive(sqlite)) throw new Error(`the enterprise repository needs ${ENTERPRISE_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(ENTERPRISE_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return ENTERPRISE_RECORDS.read(sqlite); },
    log,
    now,
  };
}
