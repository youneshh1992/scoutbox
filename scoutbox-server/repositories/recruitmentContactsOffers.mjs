/**
 * Recruitment contacts and offers — migration plan step S8c (docs/architecture/s8c-readiness-review.md, the design
 * independently accepted at 19f5ca8 after the reviews of 854d035, a5a7ed9 and 19f5ca8; plan §D.10; the Founder's
 * explicit answers of 24 October 2026: Q8c-a "Approve tolerant (Recommended)" for the player references, Q8c-b
 * "Approve strict checks (Recommended)" for the guardian references).
 *
 * Owns nine tables (and, since migration 0017, the owner CHECK of the ONE shared `idempotency_keys` table broadened to
 * the two parents) and two read-only collection views:
 *
 *   recruitment_contacts, contact_attempts, contact_history                           → db.recruitmentContacts
 *   recruitment_offers, offer_revisions, offer_revision_documents, offer_responses,
 *   offer_read_receipts, offer_history                                                → db.recruitmentOffers
 *   idempotency_keys (the `keys` of both, owned by the record's OWN id, beside the S8a and S8b rows)
 *
 * WHAT THE ROWS ARE. The two collections were JSON blobs every build since M23 P3 / P6 wrote and mutated IN PLACE from
 * m23/contactRoutes.mjs and m28/index.mjs (and the deletion unit's in-place edits). This step keeps that contract
 * exactly as S8a and S8b did: the two views are read-only ARRAYS (push/splice/assignment refused) whose elements are the
 * plain, mutable records the routes hold; every in-place change — a send, a response, an e-mail-copy outcome, an issue,
 * a revision, a receipt, a share, the deletion unit's nulled words — is detected and written by the next save's flush,
 * so each row lands in the save that carried its blob before; new records enter through `addContact` / `addOffer` (the
 * former `push` sites). No writer removes a contact or an offer; only a whole-snapshot write that no longer lists one does.
 *
 * LOSSLESS, AT EVERY LEVEL — the S8a engine (repositories/recruitment.mjs, shared here): the writers' literals key for
 * key; every scalar a column of the writer's nullability (no vocabulary or length CHECK — a storage step changes no
 * product rule; NOT NULL only on id, org_id, case_id, player_id); every known nested object columns of the same row;
 * every list a child table keyed (owner…, position) in list order (duplicates kept, never deduplicated; a non-object
 * entry in raw_json); absent keys in `absent_keys_json`, off-type values in `offtype_json`, unknown own fields (a
 * prototype-named one included) in `extra_json`; the `keys` maps under the S8a rule (a non-empty list act and a value act
 * carrying a string key are rows of idempotency_keys owned by the record's own id; a null act, a null-key send, an empty
 * list, a legacy non-array act's row and an unknown act stay as written).
 *
 * REFERENCES — THE APPROVED SCOPE (review §3, §4, §9; Q8c-a, Q8c-b):
 *   player ids (player_id, recipient_player_id, for_player_id, the player actor and viewer ids)
 *                             NO key, TOLERANT (Q8c-a): a live id resolves, a retained id resolves to the retained
 *                             record, a historically missing id is preserved and counted — never refused, never given a
 *                             fabricated account, never deleted.
 *   guardian ids (recipient_guardian_id of a contact and of a revision snapshot, the guardian actor and viewer ids)
 *                             NO key (the identity plan decides keys), STRICT in code (Q8c-b): a snapshot write or the
 *                             cutover naming a guardian that is not in the FINAL guardians table is refused with ids.
 *   org_id                    REFERENCES orgs RESTRICT (both parents).
 *   case_id                   REFERENCES recruitment_cases RESTRICT (both parents): a case pruned under a retained
 *                             contact or offer is named at the preflight with its table (CASE_STILL_REFERENCED).
 *   request_id                REFERENCES recruitment_requests RESTRICT — the ONE new real key: a request pruned under a
 *                             retained contact is named first (CONTACT_STILL_REFERENCED); the pair guard
 *                             (CONTACT_REQUEST_MISMATCH) replaces the drafted unique index.
 *   staff ids (created_by, sent_by, recorded_by, cancelled_by, routing_agent, agent_share) → org_users RESTRICT, nullable.
 *   contact_history / offer_history → RESTRICT (owned; removed explicitly before the owner); every other child CASCADE.
 *   THE FIVE OFFER POINTERS (current_revision_id, response_id, supersedes_revision_id, superseded_by_revision_id,
 *   discarded_by_response_id): plain columns stored as written, classified over the FINAL offer collection — a target
 *   within the same offer valid; a target naming NO row of its kind under any offer of the final collection an
 *   UNRESOLVED HISTORICAL pointer, kept verbatim and counted, never refused (the read-time integrity report stays the
 *   judge); a target that exists ONLY under ANOTHER offer of the final collection refused (OFFER_CHAIN_BROKEN, owner
 *   named; the engineering protection the review of 19f5ca8 confirmed). A departing offer owns nothing in that graph.
 *   decision_id, transaction_id, agreement ids, outbox id, evidence ids: plain ids; the dangling decision ids counted.
 *
 * COLLECTION SEMANTICS (review §6; the correction of a5a7ed9, R1): a collection OMITTED from a save is retained WHOLE; a
 * collection SUPPLIED as an array IS the entire final collection (an unlisted stored record departs; `[]` empties it);
 * an explicit null or non-array collection is refused, never an omission; in staged mode the mirror is complete and the
 * preflight classifies over the complete mirror while change tracking limits which rows are written.
 *
 * THE WRITE (review §5–§6), one algorithm for the import, a restore, a flush and a snapshot, inside one transaction:
 *   P   preflight over the FINAL combined graph, ids only, before any write;
 *   F0  the contacts/offers a SUPPLIED collection no longer lists: history rows and key rows explicitly, then the parent;
 *   R   a surviving contact whose stored request_id this write changes: its row's request_id set to NULL now, so the S8a
 *       request prune can never hit it (the final value arrives at A′);
 *       ── the S8b core, B1 the S8a request create/update, the S8b links/rooms, the channels ──
 *   A′  the supplied (or changed) contacts upserted with their FINAL request_id, children rewritten in list order;
 *   D′  the supplied (or changed) offers likewise, every pointer stored as written;
 *       ── the S8b room prune, F2 the S8a request prune (inside the recruitment hook in staged mode), the S8b case prune ──
 *   G   the final assertions over the tables: the pairs agree, the pointer rule, foreign_key_check empty.
 * In staged mode the two hooks sit at α (before the S8b core hook: P, F0, R) and β (after the recruitment hook: A′, D′, G).
 *
 * TWO FAILURE CONTRACTS (the store's, unchanged): a failed ORDINARY save leaves the records as they are — memory is the
 * intended state — and the next save lands them once (change tracking reflects COMMITTED state only); an aborted UNIT
 * OF WORK rolls the tables back AND restores the two mirrors in place through the graph memento.
 *
 * Whether the tables are authoritative is decided by the cutover record `0017_recruitment_contacts_offers` in
 * `data_migrations`, never by the tables existing. Refusals name collections, positions, tables and ids — never a
 * subject, a body, a note, a message or a name.
 */
import { markView } from './readonly.mjs';
import { captureGraph, restoreGraph } from './memento.mjs';
import { migrationApplied } from './database.mjs';
import { EXTRA_CHECK, ABSENT_CHECK, JSON_CHECK, describe, isPlainObject, nonEmpty, tableExists, setOwn, clone, parseJson, ids, sqlType, columnsOf, childSpecs, encode, decodeLevel, rowMeta, metaOf, columnAdmits, toColumn, fromColumn, copyRecord, recruitmentLive, readRequests } from './recruitment.mjs';
import { S8B_KEY_OWNERS, recruitmentCasesLive, assertKeyFormat } from './recruitmentCases.mjs';

export const RECRUITMENT_CONTACTS_OFFERS_MIGRATION = '0017_recruitment_contacts_offers';
/** `meta` key holding the cutover record: counts only, never data. */
export const RECRUITMENT_CONTACTS_OFFERS_CUTOVER_META = 'recruitmentContactsOffersCutover';
export const RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS = Object.freeze(['recruitmentContacts', 'recruitmentOffers']);
/** The owner tables the shared idempotency_keys CHECK names once 0017 is recorded (the S8a and S8b owners first). */
export const S8C_KEY_OWNERS = Object.freeze([...S8B_KEY_OWNERS, 'recruitment_contacts', 'recruitment_offers']);
export const recruitmentContactsOffersLive = (sqlite) => migrationApplied(sqlite, RECRUITMENT_CONTACTS_OFFERS_MIGRATION);

const blocked = (detail, extra = {}) => Object.assign(new Error(`CONTACTS_OFFERS_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'CONTACTS_OFFERS_IMPORT_BLOCKED', ...extra });
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });

// ------------------------------------------------------------------ the shapes (review §2; the writers' literals key for key; probe 1's draft as implemented)
const BY_KUN = (p) => ({ keys: ['kind', 'userId', 'name'], cols: { kind: [`${p}_kind`, 'text'], userId: [`${p}_user_id`, 'text'], name: [`${p}_name`, 'text'] } }); // contacts: actorOf(req)
const BY_KINR = (p) => ({ keys: ['kind', 'id', 'name', 'role'], cols: { kind: [`${p}_kind`, 'text'], id: [`${p}_user_id`, 'text'], name: [`${p}_name`, 'text'], role: [`${p}_role`, 'text'] } }); // offers: byOrg(req)
const BY_UN = (p) => ({ keys: ['userId', 'name'], cols: { userId: [`${p}_user_id`, 'text'], name: [`${p}_name`, 'text'] } }); // bumpRev's revBy
const CONTACT_ATTEMPTS = { table: 'contact_attempts', ownerCols: ['contact_id'], shape: { keys: ['at', 'ok', 'code'], cols: { at: ['at', 'int'], ok: ['ok', 'bool'], code: ['code', 'text'] } } };
const CONTACT_HISTORY = { table: 'contact_history', ownerCols: ['contact_id'], restrict: true, shape: { keys: ['id', 'at', 'action', 'by', 'detail'], cols: { id: ['id', 'text'], at: ['at', 'int'], action: ['action', 'text'], detail: ['detail_json', 'json'] }, objects: { by: BY_KUN('by') } }, indexes: ['CREATE INDEX contact_history_contact_at ON contact_history (contact_id, at)', 'CREATE INDEX contact_history_id ON contact_history (id)'] };
const CONTACT_SHAPE = {
  keys: ['id', 'orgId', 'caseId', 'playerId', 'status', 'channel', 'recipient', 'contactMode', 'routingSnapshot', 'subject', 'body', 'summary', 'createdBy', 'createdAt', 'updatedAt', 'sentBy', 'sentAt', 'deliveredAt', 'failedAt', 'failureCode', 'attempts', 'requestId', 'emailCopy', 'lifecycle', 'occurredAt', 'recordedBy', 'recordedAt', 'respondedAt', 'response', 'cancelledAt', 'cancelledBy', 'keys', 'history', 'rev', 'revAt', 'revBy', 'policyVersion'],
  cols: { id: ['id', 'id'], orgId: ['org_id', 'text'], caseId: ['case_id', 'text'], playerId: ['player_id', 'text'], status: ['status', 'text'], channel: ['channel', 'text'], contactMode: ['contact_mode', 'text'], subject: ['subject', 'text'], body: ['body', 'text'], summary: ['summary', 'text'], createdAt: ['created_at', 'int'], updatedAt: ['updated_at', 'int'], sentAt: ['sent_at', 'int'], deliveredAt: ['delivered_at', 'int'], failedAt: ['failed_at', 'int'], failureCode: ['failure_code', 'text'], requestId: ['request_id', 'text'], occurredAt: ['occurred_at', 'int'], recordedAt: ['recorded_at', 'int'], respondedAt: ['responded_at', 'int'], cancelledAt: ['cancelled_at', 'int'], rev: ['rev', 'int'], revAt: ['rev_at', 'int'], policyVersion: ['policy_version', 'int'] },
  objects: {
    recipient: { keys: ['type', 'playerId', 'guardianId', 'minor'], cols: { type: ['recipient_type', 'text'], playerId: ['recipient_player_id', 'text'], guardianId: ['recipient_guardian_id', 'text'], minor: ['recipient_minor', 'bool'] } },
    routingSnapshot: { keys: ['at', 'mode', 'player', 'guardian', 'agent', 'honest'], cols: { at: ['routing_at', 'int'], mode: ['routing_mode', 'text'], player: ['routing_player', 'bool'], guardian: ['routing_guardian', 'bool'], honest: ['routing_honest', 'text'] }, objects: { agent: { keys: ['agentUserId', 'agreementId'], cols: { agentUserId: ['routing_agent_user_id', 'text'], agreementId: ['routing_agent_agreement_id', 'text'] } } } },
    createdBy: BY_KUN('created_by'), sentBy: BY_KUN('sent_by'), recordedBy: BY_KUN('recorded_by'), cancelledBy: BY_KUN('cancelled_by'), revBy: BY_UN('rev_by'),
    emailCopy: { keys: ['state', 'to', 'outboxId', 'at'], cols: { state: ['email_copy_state', 'text'], to: ['email_copy_to', 'text'], outboxId: ['email_copy_outbox_id', 'text'], at: ['email_copy_at', 'int'] } },
    lifecycle: { keys: ['applied', 'from', 'to', 'at', 'reason'], cols: { applied: ['lifecycle_applied', 'bool'], from: ['lifecycle_from', 'text'], to: ['lifecycle_to', 'text'], at: ['lifecycle_at', 'int'], reason: ['lifecycle_reason', 'text'] } },
    response: { keys: ['kind', 'message', 'by', 'at'], cols: { kind: ['response_kind', 'text'], message: ['response_message', 'text'], by: ['response_by', 'text'], at: ['response_at', 'int'] } },
  },
  lists: { attempts: CONTACT_ATTEMPTS, history: CONTACT_HISTORY },
  maps: { keys: { table: 'idempotency_keys', ownerTable: 'recruitment_contacts' } },
};
const OFFER_DOCUMENTS = { table: 'offer_revision_documents', ownerCols: ['offer_id', 'revision_position'], shape: { keys: ['id', 'evidenceId', 'label', 'mime', 'bytes'], cols: { id: ['id', 'text'], evidenceId: ['evidence_id', 'text'], label: ['label', 'text'], mime: ['mime', 'text'], bytes: ['bytes', 'int'] } } };
const OFFER_REVISIONS = { table: 'offer_revisions', ownerCols: ['offer_id'], shape: {
  keys: ['id', 'revisionNumber', 'status', 'terms', 'recipientMessage', 'internalNote', 'documents', 'expiresAt', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'issuedAt', 'issuedBy', 'withdrawnAt', 'withdrawnBy', 'withdrawReason', 'respondedAt', 'response', 'supersedesRevisionId', 'supersededByRevisionId', 'supersededAt', 'recipientSnapshot', 'readinessSnapshot', 'rev', 'revAt', 'revBy', 'discardedByResponseId'],
  cols: { id: ['id', 'text'], revisionNumber: ['revision_number', 'int'], status: ['status', 'text'], recipientMessage: ['recipient_message', 'text'], internalNote: ['internal_note', 'text'], expiresAt: ['expires_at', 'int'], createdAt: ['created_at', 'int'], updatedAt: ['updated_at', 'int'], issuedAt: ['issued_at', 'int'], withdrawnAt: ['withdrawn_at', 'int'], withdrawReason: ['withdraw_reason', 'text'], respondedAt: ['responded_at', 'int'], supersedesRevisionId: ['supersedes_revision_id', 'text'], supersededByRevisionId: ['superseded_by_revision_id', 'text'], supersededAt: ['superseded_at', 'int'], rev: ['rev', 'int'], revAt: ['rev_at', 'int'], discardedByResponseId: ['discarded_by_response_id', 'text'] },
  objects: {
    terms: { keys: ['offerType', 'role', 'squad', 'startDate', 'endDate', 'conditions'], cols: { offerType: ['term_offer_type', 'text'], role: ['term_role', 'text'], squad: ['term_squad', 'text'], startDate: ['term_start_date', 'text'], endDate: ['term_end_date', 'text'], conditions: ['term_conditions', 'text'] } },
    createdBy: BY_KINR('created_by'), updatedBy: BY_KINR('updated_by'), issuedBy: BY_KINR('issued_by'), withdrawnBy: BY_KINR('withdrawn_by'), revBy: BY_UN('rev_by'),
    response: { keys: ['id'], cols: { id: ['response_id', 'text'] } },
    recipientSnapshot: { keys: ['type', 'playerId', 'guardianId', 'minor', 'at'], cols: { type: ['recipient_type', 'text'], playerId: ['recipient_player_id', 'text'], guardianId: ['recipient_guardian_id', 'text'], minor: ['recipient_minor', 'bool'], at: ['recipient_at', 'int'] } },
    readinessSnapshot: { keys: ['transactionId', 'evaluatedAt', 'status', 'blockers'], cols: { transactionId: ['readiness_transaction_id', 'text'], evaluatedAt: ['readiness_evaluated_at', 'int'], status: ['readiness_status', 'text'], blockers: ['readiness_blockers_json', 'json'] } },
  },
  lists: { documents: OFFER_DOCUMENTS },
}, indexes: ['CREATE INDEX offer_revisions_id ON offer_revisions (id)', 'CREATE INDEX offer_revisions_offer_status ON offer_revisions (offer_id, status)'] };
const OFFER_RESPONSES = { table: 'offer_responses', ownerCols: ['offer_id'], shape: { keys: ['id', 'revisionId', 'responseType', 'actorType', 'actorId', 'actorName', 'forPlayerId', 'occurredAt', 'reason', 'clientKey'], cols: { id: ['id', 'text'], revisionId: ['revision_id', 'text'], responseType: ['response_type', 'text'], actorType: ['actor_type', 'text'], actorId: ['actor_id', 'text'], actorName: ['actor_name', 'text'], forPlayerId: ['for_player_id', 'text'], occurredAt: ['occurred_at', 'int'], reason: ['reason', 'text'], clientKey: ['client_key', 'text'] } }, indexes: ['CREATE INDEX offer_responses_id ON offer_responses (id)', 'CREATE INDEX offer_responses_offer_client_key ON offer_responses (offer_id, client_key)'] };
const OFFER_RECEIPTS = { table: 'offer_read_receipts', ownerCols: ['offer_id'], shape: { keys: ['revisionId', 'viewerKind', 'viewerId', 'firstViewedAt'], cols: { revisionId: ['revision_id', 'text'], viewerKind: ['viewer_kind', 'text'], viewerId: ['viewer_id', 'text'], firstViewedAt: ['first_viewed_at', 'int'] } } };
const OFFER_HISTORY = { table: 'offer_history', ownerCols: ['offer_id'], restrict: true, shape: { keys: ['id', 'at', 'action', 'by', 'detail'], cols: { id: ['id', 'text'], at: ['at', 'int'], action: ['action', 'text'], detail: ['detail_json', 'json'] }, objects: { by: { keys: ['kind', 'id', 'name'], cols: { kind: ['by_kind', 'text'], id: ['by_id', 'text'], name: ['by_name', 'text'] } } } }, indexes: ['CREATE INDEX offer_history_offer_at ON offer_history (offer_id, at)', 'CREATE INDEX offer_history_id ON offer_history (id)'] };
const OFFER_SHAPE = {
  keys: ['id', 'orgId', 'caseId', 'playerId', 'type', 'decisionId', 'transactionId', 'status', 'currentRevisionId', 'revisions', 'responses', 'readReceipts', 'agentShare', 'keys', 'lifecycle', 'history', 'createdAt', 'createdBy', 'updatedAt', 'rev', 'revAt', 'revBy', 'policyVersion', 'subjectRemovedAt'],
  cols: { id: ['id', 'id'], orgId: ['org_id', 'text'], caseId: ['case_id', 'text'], playerId: ['player_id', 'text'], type: ['type', 'text'], decisionId: ['decision_id', 'text'], transactionId: ['transaction_id', 'text'], status: ['status', 'text'], currentRevisionId: ['current_revision_id', 'text'], createdAt: ['created_at', 'int'], updatedAt: ['updated_at', 'int'], rev: ['rev', 'int'], revAt: ['rev_at', 'int'], policyVersion: ['policy_version', 'int'], subjectRemovedAt: ['subject_removed_at', 'int'] },
  objects: {
    agentShare: { keys: ['agentUserId', 'agreementId', 'at', 'by'], cols: { agentUserId: ['agent_share_user_id', 'text'], agreementId: ['agent_share_agreement_id', 'text'], at: ['agent_share_at', 'int'] }, objects: { by: { keys: ['kind', 'id'], cols: { kind: ['agent_share_by_kind', 'text'], id: ['agent_share_by_id', 'text'] } } } },
    lifecycle: { keys: ['applied', 'action', 'reason', 'message', 'allowed', 'from', 'to', 'at'], cols: { applied: ['lifecycle_applied', 'bool'], action: ['lifecycle_action', 'text'], reason: ['lifecycle_reason', 'text'], message: ['lifecycle_message', 'text'], allowed: ['lifecycle_allowed_json', 'json'], from: ['lifecycle_from', 'text'], to: ['lifecycle_to', 'text'], at: ['lifecycle_at', 'int'] } },
    createdBy: BY_KINR('created_by'), revBy: BY_UN('rev_by'),
  },
  lists: { revisions: OFFER_REVISIONS, responses: OFFER_RESPONSES, readReceipts: OFFER_RECEIPTS, history: OFFER_HISTORY },
  maps: { keys: { table: 'idempotency_keys', ownerTable: 'recruitment_offers' } },
};
const COLL = (name, table, shape, indexes) => ({ name, table, shape, children: Object.freeze(childSpecs(shape)), indexes });
export const CONTACTS = COLL('recruitmentContacts', 'recruitment_contacts', CONTACT_SHAPE, ['CREATE INDEX recruitment_contacts_case_org ON recruitment_contacts (case_id, org_id)', 'CREATE INDEX recruitment_contacts_org_player ON recruitment_contacts (org_id, player_id)', 'CREATE INDEX recruitment_contacts_request ON recruitment_contacts (request_id)', 'CREATE INDEX recruitment_contacts_routing_agent ON recruitment_contacts (routing_agent_user_id)', 'CREATE INDEX recruitment_contacts_player ON recruitment_contacts (player_id)']);
export const OFFERS = COLL('recruitmentOffers', 'recruitment_offers', OFFER_SHAPE, ['CREATE INDEX recruitment_offers_case_org ON recruitment_offers (case_id, org_id)', 'CREATE INDEX recruitment_offers_org_player ON recruitment_offers (org_id, player_id)', 'CREATE INDEX recruitment_offers_agent_share ON recruitment_offers (agent_share_user_id)', 'CREATE INDEX recruitment_offers_decision ON recruitment_offers (decision_id)', 'CREATE INDEX recruitment_offers_player ON recruitment_offers (player_id)']);
const ALL = Object.freeze([CONTACTS, OFFERS]);
const byName = { recruitmentContacts: CONTACTS, recruitmentOffers: OFFERS };
export const RECRUITMENT_CONTACTS_OFFERS_TABLES = Object.freeze(ALL.flatMap((c) => [c.table, ...c.children.filter((ch) => !ch.ownerTable).map((ch) => ch.table)]));

// ------------------------------------------------------------------ the DDL (review §3: the real keys, NOT NULL on the four identifiers, no vocabulary CHECK, no unique child key)
const CONSTRAINTS = {
  recruitment_contacts: { id: 'TEXT NOT NULL UNIQUE', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT', case_id: 'TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT', player_id: 'TEXT NOT NULL', request_id: 'TEXT REFERENCES recruitment_requests(id) ON DELETE RESTRICT', created_by_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT', sent_by_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT', recorded_by_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT', cancelled_by_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT', routing_agent_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT' },
  recruitment_offers: { id: 'TEXT NOT NULL UNIQUE', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT', case_id: 'TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT', player_id: 'TEXT NOT NULL', created_by_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT', agent_share_user_id: 'TEXT REFERENCES org_users(id) ON DELETE RESTRICT' },
};
const colDdl = (table, [col, kind]) => `  ${col.padEnd(32)} ${CONSTRAINTS[table]?.[col] ?? sqlType(kind)}${kind === 'json' && !CONSTRAINTS[table]?.[col] ? ` ${JSON_CHECK(col)}` : ''}`;
function parentDdl(coll) {
  const cols = columnsOf(coll.shape).map((c) => colDdl(coll.table, c));
  return `CREATE TABLE ${coll.table} (\n  seq                              INTEGER PRIMARY KEY,\n${cols.join(',\n')},\n  absent_keys_json                 TEXT ${ABSENT_CHECK},\n  offtype_json                     TEXT ${EXTRA_CHECK('offtype_json')},\n  extra_json                       TEXT ${EXTRA_CHECK('extra_json')}\n) STRICT;\n${coll.indexes.map((ix) => `${ix};`).join('\n')}`;
}
function childDdl(spec, parentTable) {
  const owner = spec.ownerCols.map((c, i) => `  ${c.padEnd(32)} ${i === 0 ? `TEXT NOT NULL REFERENCES ${parentTable}(id) ON DELETE ${spec.restrict ? 'RESTRICT' : 'CASCADE'}` : 'INTEGER NOT NULL'}`);
  const cols = columnsOf(spec.shape).map((c) => colDdl(spec.table, c));
  return `CREATE TABLE ${spec.table} (\n${owner.join(',\n')},\n  position                         INTEGER NOT NULL,\n${[...cols, `  raw_json                         TEXT ${JSON_CHECK('raw_json')}`, `  absent_keys_json                 TEXT ${ABSENT_CHECK}`, `  offtype_json                     TEXT ${EXTRA_CHECK('offtype_json')}`, `  extra_json                       TEXT ${EXTRA_CHECK('extra_json')}`].join(',\n')},\n  PRIMARY KEY (${[...spec.ownerCols, 'position'].join(', ')})\n) STRICT;\n${(spec.indexes ?? []).map((ix) => `${ix};`).join('\n')}`;
}
/** The nine tables, each parent before its children. */
export const RECRUITMENT_CONTACTS_OFFERS_DDL = ALL.flatMap((coll) => [parentDdl(coll), ...coll.children.filter((ch) => !ch.ownerTable).map((ch) => childDdl(ch, coll.table))]).join('\n');

// ------------------------------------------------------------------ statements (lazily prepared per connection; re-prepared when `prepare` is replaced — the suites' statement-failure seam)
const stmtCache = new WeakMap();
function stmts(sqlite) {
  let s = stmtCache.get(sqlite); if (s && s.preparedBy === sqlite.prepare) return s;
  const insertFor = (table, cols) => sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  const parentFor = (coll) => {
    const cols = [...columnsOf(coll.shape).map((c) => c[0]), 'absent_keys_json', 'offtype_json', 'extra_json'];
    const set = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`);
    return { upsert: sqlite.prepare(`INSERT INTO ${coll.table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${set.join(', ')}`), select: sqlite.prepare(`SELECT * FROM ${coll.table} ORDER BY seq`), del: sqlite.prepare(`DELETE FROM ${coll.table} WHERE id = ?`) };
  };
  const childFor = (spec) => {
    const cols = [...spec.ownerCols, 'position', ...columnsOf(spec.shape).map((c) => c[0]), 'raw_json', 'absent_keys_json', 'offtype_json', 'extra_json'];
    return { insert: insertFor(spec.table, cols), deleteOwner: sqlite.prepare(`DELETE FROM ${spec.table} WHERE ${spec.ownerCols[0]} = ?`), select: sqlite.prepare(`SELECT * FROM ${spec.table} ORDER BY ${[...spec.ownerCols, 'position'].join(', ')}`) };
  };
  const children = {}; for (const coll of ALL) for (const ch of coll.children) if (!ch.ownerTable && !children[ch.table]) children[ch.table] = childFor(ch);
  s = {
    parents: Object.fromEntries(ALL.map((c) => [c.name, parentFor(c)])), children,
    keys: { insert: insertFor('idempotency_keys', ['owner_table', 'owner_id', 'position', 'act', 'shape', 'key', 'fp', 'at', 'entry_json']), deleteOwner: sqlite.prepare('DELETE FROM idempotency_keys WHERE owner_table = ? AND owner_id = ?'), select: sqlite.prepare('SELECT * FROM idempotency_keys WHERE owner_table = ? ORDER BY owner_id, position') },
    releaseRequest: sqlite.prepare('UPDATE recruitment_contacts SET request_id = NULL WHERE id = ?'),
    preparedBy: sqlite.prepare,
  };
  stmtCache.set(sqlite, s); return s;
}

// ------------------------------------------------------------------ the mapping engine (record ↔ row + child rows)
function writeKeyRows(S, ownerTable, ownerId, map) {
  let i = 0;
  for (const [act, v] of Object.entries(map)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const e of v) { const c = clone(e, `keys.${act}`).value; S.keys.insert.run({ owner_table: ownerTable, owner_id: ownerId, position: i++, act, shape: 'list', key: isPlainObject(c) && typeof c.key === 'string' ? c.key : null, fp: isPlainObject(c) && typeof c.fp === 'string' ? c.fp : null, at: isPlainObject(c) && Number.isSafeInteger(c.at) ? c.at : null, entry_json: JSON.stringify(c === undefined ? null : c) }); }
    else { const c = clone(v, `keys.${act}`).value; S.keys.insert.run({ owner_table: ownerTable, owner_id: ownerId, position: i++, act, shape: 'value', key: isPlainObject(c) && typeof c.key === 'string' ? c.key : null, fp: isPlainObject(c) && typeof c.fp === 'string' ? c.fp : null, at: null, entry_json: JSON.stringify(c === undefined ? null : c) }); }
  }
}
function writeChildren(sqlite, children, ownerValues, owner) {
  const S = stmts(sqlite);
  for (const ch of children) {
    if (ch.spec.ownerTable) { writeKeyRows(S, ch.spec.ownerTable, owner.id, ch.map); continue; }
    const st = S.children[ch.spec.table];
    ch.items.forEach((item, position) => {
      const base = { ...Object.fromEntries(ch.spec.ownerCols.map((c, i) => [c, ownerValues[i]])), position };
      const blank = Object.fromEntries(columnsOf(ch.spec.shape).map(([col]) => [col, null]));
      if (!isPlainObject(item)) { st.insert.run({ ...base, ...blank, raw_json: JSON.stringify(clone(item, ch.path).value), absent_keys_json: null, offtype_json: null, extra_json: null }); return; }
      const enc = encode(ch.spec.shape, item);
      st.insert.run({ ...base, ...Object.fromEntries(columnsOf(ch.spec.shape).map(([col]) => [col, enc.cols[col] ?? null])), raw_json: null, ...rowMeta(enc) });
      if (enc.children.length) writeChildren(sqlite, enc.children, [...ownerValues, position], item);
    });
  }
}
/** Write one parent record: its row by upsert (seq kept), its key rows and every child row deleted and reinserted in list order. */
export function writeRecord(sqlite, coll, record) {
  const S = stmts(sqlite); const P = S.parents[coll.name];
  const enc = encode(coll.shape, record);
  S.keys.deleteOwner.run(coll.table, record.id);
  P.upsert.run({ ...Object.fromEntries(columnsOf(coll.shape).map(([col]) => [col, enc.cols[col] ?? null])), ...rowMeta(enc) });
  const seen = new Set(); for (const ch of coll.children) if (!ch.ownerTable && !seen.has(ch.table)) { seen.add(ch.table); S.children[ch.table].deleteOwner.run(record.id); }
  writeChildren(sqlite, enc.children, [record.id], record);
}
/** The owned RESTRICT history, the key rows and the parent of a departing record (the cascades follow). */
export function deleteRecord(sqlite, coll, id) {
  const S = stmts(sqlite);
  for (const ch of coll.children) if (!ch.ownerTable && ch.restrict) S.children[ch.table].deleteOwner.run(id);
  S.keys.deleteOwner.run(coll.table, id);
  S.parents[coll.name].del.run(id);
}
/** Read every parent record of a collection with its children, in `seq` order: fresh objects from the file. */
export function readRecords(sqlite, coll) {
  assertKeyFormat(sqlite, { label: `reading ${coll.name}` }); // a file of another S8b format is never decoded (the R1 rule of 2fe05df applies to every reader)
  const S = stmts(sqlite);
  const groups = new Map(); const seen = new Set();
  for (const c of coll.children) { if (c.ownerTable || seen.has(c.table)) continue; seen.add(c.table); for (const r of S.children[c.table].select.all()) { const key = `${c.table}|${c.ownerCols.map((col) => r[col]).join('|')}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ ...r }); } }
  const keys = new Map(); for (const r of S.keys.select.all(coll.table)) { if (!keys.has(r.owner_id)) keys.set(r.owner_id, []); keys.get(r.owner_id).push(r); }
  const rowsOf = (sub, ownerValues) => groups.get(`${sub.table}|${ownerValues.join('|')}`) ?? [];
  const decodeChildren = (shape, ownerValues, ownerId, out = new Map(), prefix = '') => {
    for (const [k, sub] of Object.entries(shape.lists ?? {})) out.set(`${prefix}${k}`, rowsOf(sub, ownerValues).map((r) => decodeChild(sub, r, ownerValues)));
    for (const [k] of Object.entries(shape.maps ?? {})) { const o = {}; for (const r of keys.get(ownerId) ?? []) { const v = parseJson(r.entry_json, 'entry_json'); if (r.shape === 'list') { if (!Object.hasOwn(o, r.act) || !Array.isArray(o[r.act])) setOwn(o, r.act, []); o[r.act].push(v); } else setOwn(o, r.act, v); } out.set(`${prefix}${k}`, o); }
    for (const [k, sub] of Object.entries(shape.objects ?? {})) decodeChildren(sub, ownerValues, ownerId, out, `${prefix}${k}.`);
    return out;
  };
  const decodeChild = (sub, r, ownerValues) => { if (r.raw_json !== null) return parseJson(r.raw_json, 'raw_json'); const m = metaOf(r); return decodeLevel(sub.shape, r, '', m.extra, m.absent, m.offtype, decodeChildren(sub.shape, [...ownerValues, r.position], null)); };
  return S.parents[coll.name].select.all().map((r) => { const m = metaOf(r); return decodeLevel(coll.shape, r, '', m.extra, m.absent, m.offtype, decodeChildren(coll.shape, [r.id], r.id)); });
}
export const readContacts = (sqlite) => readRecords(sqlite, CONTACTS);
export const readOffers = (sqlite) => readRecords(sqlite, OFFERS);
const READERS = { recruitmentContacts: readContacts, recruitmentOffers: readOffers };
void columnAdmits; void toColumn; void fromColumn;

// ------------------------------------------------------------------ validation (the literal's contract: the four identifiers the keys need; never a value in a message)
export function validateEntry(coll, raw, at = coll.name) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
  for (const k of ['orgId', 'caseId', 'playerId']) if (!nonEmpty(raw[k])) return { ok: false, reason: `${at}.${k} must be a non-empty string (${raw.id})` };
  try { encode(coll.shape, raw); } catch (e) { return { ok: false, reason: `${at} (${raw.id}): ${e.message}` }; }
  return { ok: true };
}
const presentKey = (raw, k) => Object.hasOwn(raw, k) && raw[k] !== undefined;
const unknownExtras = (enc) => Object.keys(enc.extra).some((k) => k !== 'keys');
const idSet = (list) => new Set((Array.isArray(list) ? list : []).filter(isPlainObject).map((x) => x.id));
const listOf = (v) => (Array.isArray(v) ? v.filter(isPlainObject) : []);

/** The five offer pointers of one offer record, ids only: [{ kind, holder, target }] for every STRING-valued pointer. */
export const POINTER_KINDS = Object.freeze(['current_revision_id', 'response_id', 'supersedes_revision_id', 'superseded_by_revision_id', 'discarded_by_response_id']);
const RESPONSE_KINDS = new Set(['response_id', 'discarded_by_response_id']);
function pointersOf(o) {
  const out = [];
  if (nonEmpty(o.currentRevisionId)) out.push({ kind: 'current_revision_id', holder: o.id, target: o.currentRevisionId });
  for (const r of listOf(o.revisions)) {
    const h = nonEmpty(r.id) ? r.id : '(revision)';
    if (isPlainObject(r.response) && nonEmpty(r.response.id)) out.push({ kind: 'response_id', holder: h, target: r.response.id });
    if (nonEmpty(r.supersedesRevisionId)) out.push({ kind: 'supersedes_revision_id', holder: h, target: r.supersedesRevisionId });
    if (nonEmpty(r.supersededByRevisionId)) out.push({ kind: 'superseded_by_revision_id', holder: h, target: r.supersededByRevisionId });
    if (nonEmpty(r.discardedByResponseId)) out.push({ kind: 'discarded_by_response_id', holder: h, target: r.discardedByResponseId });
  }
  return out;
}
/** The row ids one offer OWNS (its revisions' and responses' ids), from a record or from the ids-only stored form. */
const owned = (o) => ({ revisions: new Set(listOf(o.revisions).map((r) => r.id).filter(nonEmpty)), responses: new Set(listOf(o.responses).map((r) => r.id).filter(nonEmpty)) });
/**
 * THE POINTER RULE over a final offer collection (records, or the ids-only stored form): returns the broken pointers (a
 * target that exists ONLY under another offer of the collection) and the count of unresolved ones (no owner anywhere).
 */
export function classifyPointers(finalOffers) {
  const owners = { revisions: new Map(), responses: new Map() };
  const own = new Map();
  for (const o of finalOffers) { const w = owned(o); own.set(o.id, w); for (const id of w.revisions) { if (!owners.revisions.has(id)) owners.revisions.set(id, new Set()); owners.revisions.get(id).add(o.id); } for (const id of w.responses) { if (!owners.responses.has(id)) owners.responses.set(id, new Set()); owners.responses.get(id).add(o.id); } }
  const broken = []; const unresolved = Object.fromEntries(POINTER_KINDS.map((k) => [k, 0]));
  for (const o of finalOffers) for (const p of pointersOf(o)) {
    const table = RESPONSE_KINDS.has(p.kind) ? 'responses' : 'revisions';
    if (own.get(o.id)[table].has(p.target)) continue;
    const elsewhere = owners[table].get(p.target);
    if (elsewhere && elsewhere.size) broken.push(`${o.id}/${p.holder} ${p.kind}→${p.target} owned by offer ${[...elsewhere].join(',')}`);
    else unresolved[p.kind] += 1;
  }
  return { broken, unresolved };
}
/** The guardian ids a record names (Q8c-b, strict) and the player ids (Q8c-a, counted). */
function guardianIdsOf(coll, r) {
  const out = [];
  if (coll === CONTACTS) { if (isPlainObject(r.recipient) && nonEmpty(r.recipient.guardianId)) out.push(r.recipient.guardianId); }
  else { for (const rv of listOf(r.revisions)) if (isPlainObject(rv.recipientSnapshot) && nonEmpty(rv.recipientSnapshot.guardianId)) out.push(rv.recipientSnapshot.guardianId); for (const x of listOf(r.responses)) if (x.actorType === 'guardian' && nonEmpty(x.actorId)) out.push(x.actorId); for (const x of listOf(r.readReceipts)) if (x.viewerKind === 'guardian' && nonEmpty(x.viewerId)) out.push(x.viewerId); }
  return out;
}
/**
 * Every player-reference OCCURRENCE of a record (Q8c-a): the parent's player_id; a contact's recipient player id; an
 * offer's revision recipient player ids, the responses' for-player ids and PLAYER actor ids, the PLAYER receipt viewer
 * ids — a string id each time it occurs (a duplicate counts twice; a guardian-typed actor or viewer is not a player
 * reference; an absent or null id is no reference). The live counters below (`PLAYER_REFS_SQL`) read the same
 * occurrences from the tables, so the cutover record and the running report count alike (the review of 535e247, F3).
 */
function playerIdsOf(coll, r) {
  const out = [r.playerId];
  if (coll === CONTACTS) { if (isPlainObject(r.recipient) && nonEmpty(r.recipient.playerId)) out.push(r.recipient.playerId); }
  else { for (const rv of listOf(r.revisions)) if (isPlainObject(rv.recipientSnapshot) && nonEmpty(rv.recipientSnapshot.playerId)) out.push(rv.recipientSnapshot.playerId); for (const x of listOf(r.responses)) { if (nonEmpty(x.forPlayerId)) out.push(x.forPlayerId); if (x.actorType === 'player' && nonEmpty(x.actorId)) out.push(x.actorId); } for (const x of listOf(r.readReceipts)) if (x.viewerKind === 'player' && nonEmpty(x.viewerId)) out.push(x.viewerId); }
  return out;
}
/** The same occurrences over the tables, per collection (one row per occurrence, `pid` the referenced id). */
const PLAYER_REFS_SQL = {
  recruitmentContacts: 'SELECT player_id AS pid FROM recruitment_contacts UNION ALL SELECT recipient_player_id FROM recruitment_contacts WHERE recipient_player_id IS NOT NULL',
  recruitmentOffers: "SELECT player_id AS pid FROM recruitment_offers UNION ALL SELECT recipient_player_id FROM offer_revisions WHERE recipient_player_id IS NOT NULL UNION ALL SELECT for_player_id FROM offer_responses WHERE for_player_id IS NOT NULL UNION ALL SELECT actor_id FROM offer_responses WHERE actor_type = 'player' AND actor_id IS NOT NULL UNION ALL SELECT viewer_id FROM offer_read_receipts WHERE viewer_kind = 'player' AND viewer_id IS NOT NULL",
};
const STAFF_OF = {
  recruitmentContacts: (r) => [['created_by_user_id', r.createdBy], ['sent_by_user_id', r.sentBy], ['recorded_by_user_id', r.recordedBy], ['cancelled_by_user_id', r.cancelledBy]].map(([c, o]) => [c, isPlainObject(o) ? o.userId : null]).concat([['routing_agent_user_id', isPlainObject(r.routingSnapshot) && isPlainObject(r.routingSnapshot.agent) ? r.routingSnapshot.agent.agentUserId : null]]),
  recruitmentOffers: (r) => [['created_by_user_id', isPlainObject(r.createdBy) ? r.createdBy.id : null], ['agent_share_user_id', isPlainObject(r.agentShare) ? r.agentShare.agentUserId : null]],
};

/**
 * The preflight P of the review's §6 over the FINAL combined graph, ids only, before any write. `supplied` holds the two
 * collections as supplied (`undefined` = omitted, retained whole); `stored` the retained side as ids-only records (and the
 * stored offers' owned ids and pointers) for every omitted collection, plus the stored contacts' request ids;
 * `cases` the final case ids, `requests` the final requests (records: id, contactId), `departingRequests` the request
 * ids the S8a prune removes, `departingCases` the case ids the S8b prune removes; `orgs` / `users` / `guardians` the final
 * collections (records) or undefined for the tables; `only` (a flush) restricts the entry validation to the changed ids.
 * Returns `{ counts, departing }` or throws.
 */
export function preflight(sqlite, supplied, { stored, cases, requests, departingRequests = [], departingCases = [], orgs, users, guardians, retainedGuardianRefs = [], only = null, label = 'the snapshot' }) {
  const problems = [];
  const counts = { players: { live: 0, retained: 0, missing: 0 }, unresolvedPointers: Object.fromEntries(POINTER_KINDS.map((k) => [k, 0])), danglingDecisionIds: 0 };
  for (const coll of ALL) {
    const list = supplied[coll.name];
    counts[coll.name] = { imported: 0, withExtraFields: 0, withAbsentKeys: 0, withOfftypeValues: 0, children: 0, keyRows: 0 };
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw blocked(`${label}: ${coll.name} must be an array of entries (got ${describe(list)})`);
    const seen = new Set();
    list.forEach((raw, i) => {
      if (only && isPlainObject(raw) && !only[coll.name]?.has(raw.id)) { if (seen.has(raw.id)) problems.push(`${coll.name} entry #${i}: duplicates the id of an earlier entry (${raw.id})`); seen.add(raw.id); return; }
      const v = validateEntry(coll, raw, `${coll.name} entry #${i}`); if (!v.ok) { problems.push(v.reason); return; }
      if (seen.has(raw.id)) { problems.push(`${coll.name} entry #${i}: duplicates the id of an earlier entry (${raw.id})`); return; } seen.add(raw.id);
      const e = encode(coll.shape, raw); const c = counts[coll.name]; c.imported += 1; if (unknownExtras(e)) c.withExtraFields += 1; if (e.absent.length) c.withAbsentKeys += 1; if (Object.keys(e.offtype).length) c.withOfftypeValues += 1;
      const countChildren = (children) => { for (const ch of children) { if (ch.spec.ownerTable) { c.keyRows += Object.values(ch.map).reduce((a, v) => a + (Array.isArray(v) ? v.length : 1), 0); continue; } c.children += ch.items.length; for (const item of ch.items) if (isPlainObject(item)) countChildren(encode(ch.spec.shape, item).children); } }; countChildren(e.children);
    });
  }
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} in ${label} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  const final = (coll) => (supplied[coll.name] === undefined ? (stored[coll.name] ?? []) : supplied[coll.name]).filter(isPlainObject);
  const departing = {}; for (const coll of ALL) { const keep = idSet(supplied[coll.name]); departing[coll.name] = supplied[coll.name] === undefined ? [] : (stored[coll.name] ?? []).map((r) => r.id).filter((id) => !keep.has(id)); }
  const caseIds = cases instanceof Set ? cases : idSet(cases);
  // (1) the case of every SUPPLIED record in the final cases
  const noCase = []; for (const coll of ALL) for (const r of supplied[coll.name] ?? []) if (!caseIds.has(r.caseId)) noCase.push([coll.table, r.id, r.caseId]);
  if (noCase.length) throw refusal('CONTACT_OFFER_CASE_MISSING', `${noCase.length} row(s) in ${label} name a case that is not in the final recruitmentCases collection (${ids(noCase.map((x) => `${x[0]} ${x[1]} → ${x[2]}`))}); the write was rolled back and nothing was changed`, { rows: noCase.map((x) => `${x[0]} ${x[1]}`) });
  // (2) a RETAINED contact or offer whose case this write removes
  if (departingCases.length) {
    const gone = new Set(departingCases); const blockers = [];
    for (const coll of ALL) if (supplied[coll.name] === undefined) for (const r of stored[coll.name] ?? []) if (gone.has(r.caseId)) blockers.push([coll.table, r.id, r.caseId]);
    if (blockers.length) throw refusal('CASE_STILL_REFERENCED', `${blockers.length} retained row(s) in ${label} name a case this write removes (${ids(blockers.map((b) => `${b[0]} ${b[1]}`))} → cases ${ids([...new Set(blockers.map((b) => b[2]))])}); the write was rolled back and nothing was changed — remove the rows with their case in the same snapshot, or keep the case`, { rows: blockers.map((b) => `${b[0]} ${b[1]}`) });
  }
  // (3) the request of every SUPPLIED contact in the final requests; (4) a RETAINED contact whose request this write removes; (5) the pair guard
  const reqById = new Map(listOf(requests).map((r) => [r.id, r]));
  const dangling = []; const mismatched = [];
  for (const c of supplied.recruitmentContacts ?? []) {
    if (!nonEmpty(c.requestId)) continue;
    const r = reqById.get(c.requestId);
    if (!r) { dangling.push([c.id, c.requestId]); continue; }
    if (nonEmpty(r.contactId) && r.contactId !== c.id) mismatched.push(`contact ${c.id} → request ${c.requestId} → contact ${r.contactId}`);
  }
  if (dangling.length) throw refusal('CONTACT_REQUEST_DANGLING', `${dangling.length} contact(s) in ${label} name a request that is not in the final requests collection (${ids(dangling.map((d) => `${d[0]} → ${d[1]}`))}); the write was rolled back and nothing was changed — remove the contact with its request, or keep the request`, { rows: dangling.map((d) => d[0]) });
  if (departingRequests.length && supplied.recruitmentContacts === undefined) {
    const gone = new Set(departingRequests); const blockers = (stored.recruitmentContacts ?? []).filter((c) => nonEmpty(c.requestId) && gone.has(c.requestId));
    if (blockers.length) throw refusal('CONTACT_STILL_REFERENCED', `${blockers.length} retained contact(s) in ${label} name a request this write removes (recruitment_contacts ${ids(blockers.map((b) => b.id))} → requests ${ids([...new Set(blockers.map((b) => b.requestId))])}); the write was rolled back and nothing was changed — remove the contact with its request in the same snapshot, or keep the request`, { rows: blockers.map((b) => `recruitment_contacts ${b.id}`) });
  }
  if (mismatched.length) throw refusal('CONTACT_REQUEST_MISMATCH', `${mismatched.length} contact/request pair(s) in ${label} disagree — the request names another contact (${ids(mismatched)}); the write was rolled back and nothing was changed`, { links: mismatched });
  // (6) the organisation and staff keys (RESTRICT), named with ids
  const orgIds = orgs !== undefined ? idSet(orgs) : tableExists(sqlite, 'orgs') ? new Set(sqlite.prepare('SELECT id FROM orgs').all().map((r) => r.id)) : null;
  const userIds = users !== undefined ? idSet(users) : tableExists(sqlite, 'org_users') ? new Set(sqlite.prepare('SELECT id FROM org_users').all().map((r) => r.id)) : null;
  const noOrg = []; const noUser = [];
  for (const coll of ALL) for (const r of supplied[coll.name] ?? []) { if (orgIds && !orgIds.has(r.orgId)) noOrg.push([coll.table, r.id, r.orgId]); if (userIds) for (const [col, uid] of STAFF_OF[coll.name](r)) if (nonEmpty(uid) && !userIds.has(uid)) noUser.push([coll.table, r.id, `${col}=${uid}`]); }
  if (noOrg.length) throw refusal('CONTACTS_OFFERS_ORG_MISSING', `${noOrg.length} row(s) in ${label} name an organisation that does not exist in the final orgs table (${ids(noOrg.map((x) => `${x[0]} ${x[1]}`))}; organisations ${ids([...new Set(noOrg.map((x) => x[2]))])}); the write was rolled back and nothing was changed`, { rows: noOrg.map((x) => x[1]) });
  if (noUser.length) throw refusal('CONTACTS_OFFERS_USER_MISSING', `${noUser.length} row(s) in ${label} name a staff member that does not exist in the final org_users table (${ids(noUser.map((x) => `${x[0]} ${x[1]} ${x[2]}`))}); the write was rolled back and nothing was changed`, { rows: noUser.map((x) => x[1]) });
  // (7) the guardian references, STRICT (Q8c-b): against the final guardians collection or the table as it stands
  const guardianIds = guardians !== undefined ? idSet(guardians) : tableExists(sqlite, 'guardians') ? new Set(sqlite.prepare('SELECT id FROM guardians').all().map((r) => r.id)) : null;
  if (guardianIds) {
    const noGuardian = []; for (const coll of ALL) for (const r of supplied[coll.name] ?? []) for (const g of guardianIdsOf(coll, r)) if (!guardianIds.has(g)) noGuardian.push([coll.table, r.id, g]);
    // the FINAL combined state (the S8a Q7c rule applied to these tables): when the snapshot rewrites the guardians, every RETAINED contact/offer must still name an existing one
    if (guardians !== undefined) for (const [table, id, g] of retainedGuardianRefs) if (!guardianIds.has(g)) noGuardian.push([table, id, g]);
    if (noGuardian.length) throw refusal('CONTACTS_OFFERS_GUARDIAN_MISSING', `${noGuardian.length} row(s) in ${label} name a guardian that does not exist in the final guardians table (${ids(noGuardian.map((x) => `${x[0]} ${x[1]} → ${x[2]}`))}; Q8c-b: strict); the write was rolled back and nothing was changed — no account is created, unlinked or deleted to satisfy this`, { rows: noGuardian.map((x) => `${x[0]} ${x[1]}`) });
  }
  // (8) THE POINTER RULE over the FINAL offer collection: the supplied array alone when supplied (a departing offer owns nothing), the stored collection when omitted
  const finalOffers = final(OFFERS);
  const { broken, unresolved } = classifyPointers(finalOffers);
  if (broken.length) throw refusal('OFFER_CHAIN_BROKEN', `${broken.length} offer pointer(s) in ${label} name a row that belongs to ANOTHER offer of the final recruitmentOffers collection (${ids(broken)}); the write was rolled back and nothing was changed — a pointer resolves within its own offer, or names no known row (kept and counted)`, { links: broken });
  if (supplied.recruitmentOffers !== undefined) counts.unresolvedPointers = unresolved;
  // (9) counted, never refused: the player references (Q8c-a) and the dangling decision ids of the supplied records
  if (tableExists(sqlite, 'players')) {
    const live = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NULL').all().map((r) => r.id)); const retained = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NOT NULL').all().map((r) => r.id));
    const count = (pid) => { if (live.has(pid)) counts.players.live += 1; else if (retained.has(pid)) counts.players.retained += 1; else counts.players.missing += 1; };
    for (const coll of ALL) for (const r of supplied[coll.name] ?? []) for (const pid of playerIdsOf(coll, r)) count(pid);
  }
  if (tableExists(sqlite, 'room_decisions')) { const decisions = new Set(sqlite.prepare('SELECT id FROM room_decisions').all().map((r) => r.id)); for (const o of supplied.recruitmentOffers ?? []) if (nonEmpty(o.decisionId) && !decisions.has(o.decisionId)) counts.danglingDecisionIds += 1; }
  return { counts, departing };
}

// ------------------------------------------------------------------ the stages against the tables (inside the caller's transaction)
/** F0: the departing contacts and offers (history and key rows explicitly, then the parent). */
export function stageDepartures(sqlite, departing) { for (const coll of ALL) for (const id of departing[coll.name] ?? []) deleteRecord(sqlite, coll, id); }
/** R: the surviving contacts whose stored request_id this write changes — released now so the S8a request prune never hits them. */
export function releaseRequests(sqlite, contacts, { only = null } = {}) {
  const S = stmts(sqlite); const storedReq = new Map(sqlite.prepare('SELECT id, request_id FROM recruitment_contacts').all().map((r) => [r.id, r.request_id]));
  let n = 0; for (const c of contacts) { if (only && !only.has(c.id)) continue; if (!storedReq.has(c.id)) continue; const was = storedReq.get(c.id); if (was !== null && was !== (nonEmpty(c.requestId) ? c.requestId : null)) { S.releaseRequest.run(c.id); n += 1; } }
  return n;
}
/** A′ / D′: the supplied (or changed) records upserted with their children in list order. */
export function stageRecords(sqlite, coll, records, { only = null } = {}) { for (const r of records) if (!only || only.has(r.id)) writeRecord(sqlite, coll, r); }
/** The pair guard over records (ids only): every contact naming a request of `requests` whose contactId names another contact is a refusal. */
export function assertPairsAgree(contacts, requests, label = 'the save') {
  const reqById = new Map(listOf(requests).map((r) => [r.id, r]));
  const mismatched = [];
  for (const c of listOf(contacts)) { if (!nonEmpty(c.requestId)) continue; const r = reqById.get(c.requestId); if (r && nonEmpty(r.contactId) && r.contactId !== c.id) mismatched.push(`contact ${c.id} → request ${c.requestId} → contact ${r.contactId}`); }
  if (mismatched.length) throw refusal('CONTACT_REQUEST_MISMATCH', `${mismatched.length} contact/request pair(s) in ${label} disagree — the request names another contact (${ids(mismatched)}); the write was rolled back and nothing was changed`, { links: mismatched });
}
/** G: the final assertions over the tables, ids only — the pairs agree, the pointer rule, foreign_key_check empty. */
export function assertContactsOffersConsistent(sqlite, { label = 'the snapshot' } = {}) {
  if (!recruitmentContactsOffersLive(sqlite)) return;
  const pairs = sqlite.prepare('SELECT c.id, c.request_id, r.contact_id FROM recruitment_contacts c JOIN recruitment_requests r ON r.id = c.request_id WHERE c.request_id IS NOT NULL AND r.contact_id IS NOT NULL AND r.contact_id <> c.id').all();
  if (pairs.length) throw refusal('CONTACT_REQUEST_MISMATCH', `${pairs.length} contact/request pair(s) in ${label} disagree in the final tables (${ids(pairs.map((p) => `contact ${p.id} → request ${p.request_id} → contact ${p.contact_id}`))}); the write was rolled back and nothing was changed`);
  // each pointer kind: the holder row (the offer itself for current_revision_id, a revision otherwise), the target table and
  // the pointer's own offer; a target that does not resolve within that offer but exists under another is the refusal
  const foreign = (col, holderTable, ownerExpr, targetTable) => sqlite.prepare(`SELECT ${ownerExpr} AS offer_id, h.id AS holder, h.${col} AS target, (SELECT group_concat(DISTINCT x.offer_id) FROM ${targetTable} x WHERE x.id = h.${col} AND x.offer_id <> ${ownerExpr}) AS elsewhere FROM ${holderTable} h WHERE h.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${targetTable} o WHERE o.offer_id = ${ownerExpr} AND o.id = h.${col}) AND EXISTS (SELECT 1 FROM ${targetTable} x WHERE x.id = h.${col} AND x.offer_id <> ${ownerExpr})`).all().map((r) => `${r.offer_id}/${r.holder} ${col}→${r.target} owned by offer ${r.elsewhere}`);
  const broken = [...foreign('current_revision_id', 'recruitment_offers', 'h.id', 'offer_revisions'), ...foreign('supersedes_revision_id', 'offer_revisions', 'h.offer_id', 'offer_revisions'), ...foreign('superseded_by_revision_id', 'offer_revisions', 'h.offer_id', 'offer_revisions'), ...foreign('response_id', 'offer_revisions', 'h.offer_id', 'offer_responses'), ...foreign('discarded_by_response_id', 'offer_revisions', 'h.offer_id', 'offer_responses')];
  if (broken.length) throw refusal('OFFER_CHAIN_BROKEN', `${broken.length} offer pointer(s) in ${label} name a row that belongs to ANOTHER offer in the final tables (${ids(broken)}); the write was rolled back and nothing was changed`, { links: broken });
  const fk = RECRUITMENT_CONTACTS_OFFERS_TABLES.flatMap((t) => sqlite.prepare(`PRAGMA foreign_key_check(${t})`).all());
  if (fk.length) throw refusal('CONTACTS_OFFERS_KEY_VIOLATION', `foreign_key_check found ${fk.length} broken reference(s) in ${label} (first: ${fk[0].table} rowid ${fk[0].rowid} → ${fk[0].parent}); the write was rolled back and nothing was changed`);
}
/**
 * The admin report's counts (Q8c-a: counted, never refused), per collection and count-only: every player-reference
 * OCCURRENCE (the parent's player_id, the contact recipient, the revision recipients, the responses' for-player and
 * PLAYER actor ids, the PLAYER receipt viewers — `PLAYER_REFS_SQL`, the fields `playerIdsOf` counts at the cutover) that
 * names no player at all (unresolved) or a retained (S4b-R) record; unresolved pointers per kind over the tables;
 * dangling decision ids.
 */
export function unresolvedPlayerReferences(sqlite) {
  if (!recruitmentContactsOffersLive(sqlite)) return null;
  return Object.fromEntries(ALL.map((c) => [c.name, sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c.name]}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`).get().n]));
}
export function retainedPlayerReferences(sqlite) {
  if (!recruitmentContactsOffersLive(sqlite)) return null;
  return Object.fromEntries(ALL.map((c) => [c.name, sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c.name]}) x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)`).get().n]));
}
export function unresolvedPointerReferences(sqlite) {
  if (!recruitmentContactsOffersLive(sqlite)) return null;
  const rev = (holderTable, col) => sqlite.prepare(`SELECT count(*) AS n FROM ${holderTable} h WHERE h.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM offer_revisions o WHERE o.id = h.${col})`).get().n;
  const resp = (col) => sqlite.prepare(`SELECT count(*) AS n FROM offer_revisions h WHERE h.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM offer_responses o WHERE o.id = h.${col})`).get().n;
  return { current_revision_id: rev('recruitment_offers', 'current_revision_id'), response_id: resp('response_id'), supersedes_revision_id: rev('offer_revisions', 'supersedes_revision_id'), superseded_by_revision_id: rev('offer_revisions', 'superseded_by_revision_id'), discarded_by_response_id: resp('discarded_by_response_id'), danglingDecisionIds: tableExists(sqlite, 'room_decisions') ? sqlite.prepare('SELECT count(*) AS n FROM recruitment_offers o WHERE o.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM room_decisions d WHERE d.id = o.decision_id)').get().n : null };
}

// ------------------------------------------------------------------ whole-snapshot access (writeTableBacked / readTableBacked)
/** The ids-only stored side (the retained contacts' case and request ids; the retained offers' case, owned ids and pointers). */
function storedRefs(sqlite) {
  const contacts = sqlite.prepare('SELECT id, case_id AS caseId, request_id AS requestId FROM recruitment_contacts ORDER BY seq').all().map((r) => ({ ...r }));
  const offers = new Map(sqlite.prepare('SELECT id, case_id AS caseId, current_revision_id AS currentRevisionId FROM recruitment_offers ORDER BY seq').all().map((r) => [r.id, { ...r, revisions: [], responses: [] }]));
  for (const r of sqlite.prepare('SELECT offer_id, id, response_id, supersedes_revision_id, superseded_by_revision_id, discarded_by_response_id FROM offer_revisions ORDER BY offer_id, position').all()) offers.get(r.offer_id)?.revisions.push({ id: r.id, response: r.response_id === null ? null : { id: r.response_id }, supersedesRevisionId: r.supersedes_revision_id, supersededByRevisionId: r.superseded_by_revision_id, discardedByResponseId: r.discarded_by_response_id });
  for (const r of sqlite.prepare('SELECT offer_id, id FROM offer_responses ORDER BY offer_id, position').all()) offers.get(r.offer_id)?.responses.push({ id: r.id });
  return { recruitmentContacts: contacts, recruitmentOffers: [...offers.values()] };
}
/** Every guardian id the stored rows name (Q8c-b: checked against the FINAL guardians whenever a snapshot rewrites them), as [table, record id, guardian id]. */
function storedGuardianRefs(sqlite) {
  const rows = sqlite.prepare("SELECT 'recruitment_contacts' AS t, id, recipient_guardian_id AS g FROM recruitment_contacts WHERE recipient_guardian_id IS NOT NULL UNION ALL SELECT 'recruitment_offers', offer_id, recipient_guardian_id FROM offer_revisions WHERE recipient_guardian_id IS NOT NULL UNION ALL SELECT 'recruitment_offers', offer_id, actor_id FROM offer_responses WHERE actor_type = 'guardian' AND actor_id IS NOT NULL UNION ALL SELECT 'recruitment_offers', offer_id, viewer_id FROM offer_read_receipts WHERE viewer_kind = 'guardian' AND viewer_id IS NOT NULL").all();
  return rows.map((r) => [r.t, r.id, r.g]);
}
const tableRequests = (sqlite) => sqlite.prepare('SELECT id, contact_id AS contactId FROM recruitment_requests').all().map((r) => ({ ...r }));
const tableCaseIds = (sqlite) => new Set(sqlite.prepare('SELECT id FROM recruitment_cases').all().map((r) => r.id));
const suppliedOf = (db) => Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, Object.hasOwn(db, n) && db[n] !== undefined ? db[n] : undefined]));
export const CONTACTS_OFFERS_SNAPSHOT = {
  names: RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS,
  read(sqlite) { if (!recruitmentContactsOffersLive(sqlite)) return null; return Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, READERS[n](sqlite)])); },
  /**
   * P, F0 and R for the supplied collections (either, both, or neither while the requests or cases change) against the
   * tables; returns the plan `write` and `assert` need (`null` before the cutover record: the caller writes the blobs).
   * `requests` / `cases` / `guardians` / `orgs` / `users` are the snapshot's supplied collections (undefined when omitted).
   */
  begin(sqlite, db, { requests, cases, orgs, users, guardians, label = 'the snapshot' } = {}) {
    if (!recruitmentContactsOffersLive(sqlite)) return null;
    if (!sqlite.isTransaction) throw new Error('recruitmentContactsOffers: begin() runs inside the caller\'s transaction');
    assertKeyFormat(sqlite, { label });
    const supplied = suppliedOf(db);
    const any = RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.some((n) => supplied[n] !== undefined);
    if (!any && requests === undefined && cases === undefined && guardians === undefined) return null;
    const stored = storedRefs(sqlite);
    const finalRequests = requests !== undefined ? requests : tableRequests(sqlite);
    const finalCases = cases !== undefined ? idSet(cases) : tableCaseIds(sqlite);
    const departingRequests = requests === undefined ? [] : (() => { const keep = idSet(requests); return sqlite.prepare('SELECT id FROM recruitment_requests').all().map((r) => r.id).filter((id) => !keep.has(id)); })();
    const departingCases = cases === undefined ? [] : [...tableCaseIds(sqlite)].filter((id) => !finalCases.has(id));
    // Q8c-b over the FINAL graph when the snapshot rewrites the guardians: the stored references of a collection OMITTED
    // from the save (retained whole) take part; a SUPPLIED collection contributes its final supplied rows only — a stored
    // row the array no longer lists departs at F0 and is no reference (the review of 535e247, F1: "retained" is by
    // collection, never by departing row, in the guardian path as in the pointer path).
    const retainedGuardianRefs = guardians === undefined ? [] : storedGuardianRefs(sqlite).filter(([table]) => supplied[table === 'recruitment_contacts' ? 'recruitmentContacts' : 'recruitmentOffers'] === undefined);
    const { counts, departing } = preflight(sqlite, supplied, { stored, cases: finalCases, requests: finalRequests, departingRequests, departingCases, orgs, users, guardians, retainedGuardianRefs, label });
    stageDepartures(sqlite, departing); // F0
    const released = supplied.recruitmentContacts === undefined ? 0 : releaseRequests(sqlite, supplied.recruitmentContacts); // R
    return { supplied, counts, departing, released, written: RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.filter((n) => supplied[n] !== undefined) };
  },
  /** A′ and D′ after the S8a request create/update. */
  write(sqlite, plan) { if (!plan) return; stageRecords(sqlite, CONTACTS, plan.supplied.recruitmentContacts ?? []); stageRecords(sqlite, OFFERS, plan.supplied.recruitmentOffers ?? []); },
  /** G. */
  assert(sqlite, { label } = {}) { assertContactsOffersConsistent(sqlite, { label }); },
};

/**
 * Import the legacy (or exported) two blobs into the tables inside the migration's transaction (every entry validated,
 * the references checked against the file's own tables, insertion in array order, the two blob rows retired). An absent
 * blob imports nothing; a non-array, non-JSON or PRESENT-null blob refuses the step. Returns the counts the migration
 * records (never a value).
 */
export function importRecruitmentContactsOffersBlobs(sqlite) {
  const read = (name) => { const row = tableExists(sqlite, 'collections') ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name) : null; if (!row) return undefined; try { return JSON.parse(row.value); } catch { throw blocked(`the ${name} blob is not valid JSON`); } };
  const supplied = {};
  for (const n of RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS) { const v = read(n); supplied[n] = v === undefined ? [] : v; if (!Array.isArray(supplied[n])) throw blocked(`the ${n} blob must be an array of entries (got ${describe(supplied[n])})`); }
  const requests = recruitmentLive(sqlite) ? readRequests(sqlite) : [];
  const cases = recruitmentCasesLive(sqlite) ? tableCaseIds(sqlite) : new Set();
  let counts;
  try { ({ counts } = preflight(sqlite, supplied, { stored: { recruitmentContacts: [], recruitmentOffers: [] }, cases, requests, label: 'the recruitment contacts and offers blobs' })); }
  catch (e) { if (e?.code && e.code !== 'CONTACTS_OFFERS_IMPORT_BLOCKED') throw blocked(e.message, { refusal: e.code, rows: e.rows, problems: e.problems }); throw e; }
  stageRecords(sqlite, CONTACTS, supplied.recruitmentContacts); // A′
  stageRecords(sqlite, OFFERS, supplied.recruitmentOffers); // D′
  if (tableExists(sqlite, 'collections')) sqlite.prepare(`DELETE FROM collections WHERE name IN (${RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map(() => '?').join(', ')})`).run(...RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS);
  return counts;
}

// ------------------------------------------------------------------ the repository
/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null; `staged` selects the server's write mode (the
 * two hooks must be registered in the order attachDataLayer registers them: preHook before the S8b core hook, writeHook
 * after the recruitment hook); `recruitment` is an accessor for the S8a repository (its mirror is the final requests of a
 * flush; its departures() the prune set); `cases` an accessor for the final recruitmentCases collection (the S8b view).
 */
export function createRecruitmentContactsOffersRepository({ sqlite, now = Date.now, log = () => {}, unit = null, staged = false, recruitment = null, cases = null } = {}) {
  if (!sqlite) throw new TypeError('the recruitment contacts/offers repository needs a SQLite connection (node:sqlite); the two collections have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the recruitment contacts/offers repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null');
  if (staged && !unit) throw new TypeError('the recruitment contacts/offers repository in staged mode needs the store\'s participant API `unit` and the store must register its hooks');
  for (const [k, v] of [['recruitment', recruitment], ['cases', cases]]) if (v !== null && typeof v !== 'function') throw new TypeError(`the recruitment contacts/offers repository takes \`${k}\` as an accessor function`);
  void now;
  const cutover = sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?');
  const refuse = (what) => { throw new TypeError(`${what} is written through the recruitment contacts/offers repository (addContact / addOffer), never directly on the in-memory collection; a record's own fields are edited in place and land in the next save`); };
  const mirrors = Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, []]));
  const arrayView = (target, label) => markView(new Proxy(target, { set() { return refuse(`the ${label} collection`); }, deleteProperty() { return refuse(`the ${label} collection`); }, defineProperty() { return refuse(`the ${label} collection`); } }));
  const views = Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, arrayView(mirrors[n], n)]));
  const committed = Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, new Map()])); // id → fingerprint as last COMMITTED
  let inFlight = null;
  const fp = (r) => JSON.stringify(r);
  const load = () => { for (const n of RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS) { mirrors[n].length = 0; committed[n].clear(); } if (!recruitmentContactsOffersLive(sqlite)) return; for (const n of RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS) for (const r of READERS[n](sqlite)) { mirrors[n].push(r); committed[n].set(r.id, fp(r)); } };
  load();
  const inUnit = () => !!unit?.active?.();
  let hooksTaken = 0;
  const hookRefusal = (what) => new Error(`recruitmentContactsOffers: ${what} needs the repository's two save hooks registered with the store first (preHook before the recruitment-cases core hook, writeHook after the recruitment hook): the hooks are how a save writes the changed records and how a unit of work's rollback restores this repository's memory`);
  const mutate = (fn) => { if (inUnit()) return unit.join(() => { if (hooksTaken < 2) throw hookRefusal('a write inside a unit of work'); return fn(); }); if (staged && hooksTaken < 2) throw hookRefusal('a write'); return fn(); };
  const caseIdsNow = () => { const c = cases ? cases() : undefined; return c === undefined ? tableCaseIds(sqlite) : idSet(c); };
  const add = (coll, record) => mutate(() => {
    const v = validateEntry(coll, record); if (!v.ok) throw new TypeError(`a ${coll.name} record needs the writer's literal: ${v.reason}`);
    if (mirrors[coll.name].some((r) => r.id === record.id)) throw new Error(`recruitmentContactsOffers: a ${coll.name} record with id ${record.id} already exists`);
    if (!caseIdsNow().has(record.caseId)) throw refusal('CONTACT_OFFER_CASE_MISSING', `recruitmentContactsOffers: ${coll.table} ${record.id} names case ${record.caseId}, which is not in the recruitmentCases collection`);
    mirrors[coll.name].push(record); return record;
  });
  const changes = () => { const changed = {}; const removed = {}; let touched = false; for (const n of RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS) { changed[n] = new Set(mirrors[n].filter((r) => committed[n].get(r.id) !== fp(r)).map((r) => r.id)); removed[n] = [...committed[n].keys()].filter((id) => !mirrors[n].some((r) => r.id === id)); if (changed[n].size || removed[n].length) touched = true; } return { changed, removed, touched }; };

  const repo = {
    attach() {
      if (!cutover.get(RECRUITMENT_CONTACTS_OFFERS_MIGRATION)) throw new Error(`recruitmentContactsOffers: the cutover record ${RECRUITMENT_CONTACTS_OFFERS_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      load();
      log(`recruitment contacts/offers: ${RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => `${mirrors[n].length} ${n}`).join(', ')} loaded from the tables`);
      return { engine: 'sqlite', ...Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, mirrors[n].length])) };
    },
    reload() { load(); return RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.reduce((a, n) => a + mirrors[n].length, 0); },
    contactsView: views.recruitmentContacts, offersView: views.recruitmentOffers, views,
    counts: () => Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, mirrors[n].length])),
    pending: () => { const { changed, removed } = changes(); return Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, changed[n].size + removed[n].length])); },
    /** A new record at the end (the former `push` sites): the record itself is kept, validated like an import; its case must exist (ids only). */
    addContact: (record) => add(CONTACTS, record),
    addOffer: (record) => add(OFFERS, record),
    /** Every record in its legacy shape, detached (the admin backup). */
    exportContacts: () => mirrors.recruitmentContacts.map(copyRecord),
    exportOffers: () => mirrors.recruitmentOffers.map(copyRecord),
    exportAll: () => Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, mirrors[n].map(copyRecord)])),

    // ---------------------------------------------------------- the two save hooks (α: P F0 R before the S8b core hook | … the recruitment hook … | β: A′ D′ G)
    flushPre() {
      if (!sqlite.isTransaction) throw new Error('recruitmentContactsOffers.flushPre runs inside a save transaction; the store reports its commit or rollback afterwards');
      assertKeyFormat(sqlite, { label: 'the save' });
      const { changed, removed, touched } = changes();
      const rec = recruitment ? recruitment() : null;
      const departingRequests = rec ? rec.departures().requests : [];
      // The requests this save changes (the S8a staged mirror: an edited or new request, a departure) are part of the
      // FINAL combined graph even when no contact or offer is dirty (the review of 535e247, F2): the pair guard is applied
      // at P over the COMPLETE contact mirror against the final requests, ids only, before any write — and G runs at β.
      const requestsDirty = !!rec && (rec.pending().requests > 0 || departingRequests.length > 0);
      if (!touched && !requestsDirty) { inFlight = { changed, removed, plan: null, assert: false }; return 0; }
      const requests = rec ? rec.requestsView : tableRequests(sqlite);
      if (requestsDirty) assertPairsAgree(mirrors.recruitmentContacts, requests, 'the save (a changed request against the complete contact mirror)');
      if (!touched) { inFlight = { changed, removed, plan: null, assert: true }; return 0; } // nothing of S8c to write; the final guard still runs
      // the FINAL graph of a flush is the complete mirrors (a staged dirty subset is not a snapshot collection): every collection "supplied"
      const supplied = Object.fromEntries(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => [n, mirrors[n]]));
      for (const n of RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS) for (const id of changed[n]) { const v = validateEntry(byName[n], mirrors[n].find((x) => x.id === id)); if (!v.ok) throw new TypeError(`recruitmentContactsOffers: a ${n} record cannot be saved: ${v.reason}`); }
      const stored = storedRefs(sqlite);
      preflight(sqlite, supplied, { stored, cases: caseIdsNow(), requests, departingRequests, only: changed, label: 'the save' });
      stageDepartures(sqlite, removed); // F0
      releaseRequests(sqlite, mirrors.recruitmentContacts, { only: changed.recruitmentContacts }); // R
      inFlight = { changed, removed, plan: true, assert: true };
      return RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.reduce((a, n) => a + changed[n].size + removed[n].length, 0);
    },
    flushWrite() {
      if (!inFlight?.plan && !inFlight?.assert) return;
      if (inFlight.plan) {
        stageRecords(sqlite, CONTACTS, mirrors.recruitmentContacts, { only: inFlight.changed.recruitmentContacts }); // A′
        stageRecords(sqlite, OFFERS, mirrors.recruitmentOffers, { only: inFlight.changed.recruitmentOffers }); // D′
      }
      assertContactsOffersConsistent(sqlite, { label: 'the save (contacts, offers, requests and cases together)' }); // G — after the S8a request create/update, whether or not an S8c row was written
    },
    commit() { if (!inFlight) return; for (const n of RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS) { for (const id of inFlight.changed[n]) committed[n].set(id, fp(mirrors[n].find((x) => x.id === id))); for (const id of inFlight.removed[n]) committed[n].delete(id); } inFlight = null; },
    rollback() { inFlight = null; },
    /** Unit-of-work participation: the graph memento of the two mirrors, restored IN PLACE. The committed fingerprints reflect committed state, which a rollback does not change. */
    snapshotState: () => ({ graph: captureGraph(RECRUITMENT_CONTACTS_OFFERS_COLLECTIONS.map((n) => mirrors[n])) }),
    restoreState(state) { if (!state) return; inFlight = null; restoreGraph(state.graph); },
    preHook: () => { hooksTaken += 1; return { flush: () => repo.flushPre(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
    writeHook: () => { hooksTaken += 1; return { flush: () => repo.flushWrite() }; },
  };
  return repo;
}
