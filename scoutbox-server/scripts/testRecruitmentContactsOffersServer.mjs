// S8c through the REAL server (server.mjs booted as a child process on temporary data directories, synthetic records
// only): recruitment contacts and offers as tables. A contact drafted, edited, sent with one injected transport
// failure and then delivered (its request row in the same save), answered through the real respond route; an external
// record; an offer created, edited, issued, revised (a draft beside the issued revision) and accepted by the recipient
// with the draft discarded; read receipts; /capabilities counting the rows and the Q8c-a references; the recipient's
// and another club's surfaces unchanged (no internal note, no decision id, no body in the journey; another club's 404);
// a SIGKILL right after a send; the deletion unit's in-place edits with a REAL COMMIT failure leaving every row as it
// was and the retry landing once; a restored backup given a contact naming a historically missing player serves and
// counts it (Q8c-a), while one naming a missing guardian is refused at the save (Q8c-b); the admin backup (a copy of the
// database) holding the two collections, a restore into a NEW directory serving them row for row.
// Every database read goes through a second read-only connection. Nothing here touches DATA_DIR or real data. Run
// with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { readContacts, readOffers } from '../repositories/recruitmentContactsOffers.mjs';
import { openStore } from '../store.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIGRATION = '0017_recruitment_contacts_offers';
const COLLECTIONS = ['recruitmentContacts', 'recruitmentOffers'];
const TABLES = ['recruitment_contacts', 'contact_attempts', 'contact_history', 'recruitment_offers', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts', 'offer_history', 'offer_keys'];
const OTHER_TABLES = ['recruitment_requests', 'trials', 'idempotency_keys', 'recruitment_cases', 'case_history', 'room_decisions', 'channels'];
const PRIVATE_BODY = 'Internal body: we would like to talk about next season.';
const PRIVATE_NOTE = 'Internal note: hold until the winter window.';
const DECISION_NOTE = 'Internal decision note: proceed.';

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [server], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
   
    let log = '';
    const j = async (method, p, body, token, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* no body */ } return { status: r.status, body: parsed, text }; };
    const S = { proc, port, dir, log: () => log, j, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }), kill: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGKILL'); }) };
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve(S); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(Object.assign(new Error(`server exited ${code} (${signal}): ${log.slice(-1500)}`), { code, log })));
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000).unref();
  });
}
const snap = (dir, fn) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { s.exec('BEGIN'); try { return fn({ get: (sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; }, all: (sql, ...p) => s.prepare(sql).all(...p).map((r) => ({ ...r })) }); } finally { s.exec('COMMIT'); } } finally { s.close(); } };
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const qAll = (dir, sql, ...p) => snap(dir, (c) => c.all(sql, ...p));
const live = (dir) => !!q1(dir, 'SELECT 1 AS one FROM data_migrations WHERE id = ?', MIGRATION);
const applied = (dir) => qAll(dir, 'SELECT id FROM data_migrations ORDER BY id').map((r) => r.id);
const blobOf = (dir, name) => snap(dir, (c) => { const r = c.get('SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : undefined; });
const tableExists = (dir, t) => !!q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const fkOf = (dir, t) => qAll(dir, `PRAGMA foreign_key_list(${t})`).map((r) => `${r.from}->${r.table}(${r.to}) ${r.on_delete}`);
const ddlOf = (dir, t) => q1(dir, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", t)?.sql ?? null;
const recDump = (dir) => JSON.stringify(Object.fromEntries([...TABLES, ...OTHER_TABLES].filter((t) => tableExists(dir, t)).map((t) => [t, qAll(dir, `SELECT * FROM ${t} ORDER BY rowid`)])));
/** The same tables compared by CONTENT (rows sorted; a rewrite reinserts a record's children, so rowid order is not a property of the data). */
const recCanon = (dir) => JSON.stringify(Object.fromEntries([...TABLES, ...OTHER_TABLES].filter((t) => tableExists(dir, t)).map((t) => [t, qAll(dir, `SELECT * FROM ${t}`).map((r) => JSON.stringify(r)).sort()])));
/** Names the first table whose canonical rows differ and the rows each side holds alone (ids and columns; a diagnostic for a failed row-for-row check). */
const canonDiff = (gotText, wantText) => { const got = JSON.parse(gotText); const want = JSON.parse(wantText); for (const t of new Set([...Object.keys(got), ...Object.keys(want)])) { const g = got[t] ?? [], w = want[t] ?? []; if (JSON.stringify(g) === JSON.stringify(w)) continue; const G = new Set(g), W = new Set(w); return `${t}: only restored ${JSON.stringify(g.filter((r) => !W.has(r))).slice(0, 1500)} | only live ${JSON.stringify(w.filter((r) => !G.has(r))).slice(0, 1500)}`; } return 'no table differs'; };
const contactRow = (dir, id) => q1(dir, 'SELECT * FROM recruitment_contacts WHERE id = ?', id);
const offerRow = (dir, id) => q1(dir, 'SELECT * FROM recruitment_offers WHERE id = ?', id);
const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, r.text); return r.body.token; };
const signupAdult = async (S, name) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text); return { pid: r.body.playerId, token: r.body.token }; };
const playerLogin = async (S, pid) => (await S.j('POST', '/auth/player/login', { playerId: pid, password: 'synthetic-pass-1' })).body.token;
async function guardianWithChild(S, tag) {
  const gs = await S.j('POST', '/auth/guardian/signup', { name: `Parent ${tag}`, email: `parent-${tag}@example.test`, password: 'synthetic-pass-1' }); assert.equal(gs.status, 201, gs.text);
  const token = gs.body.token;
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gs.body.guardianId, code: gs.body.devEmailCode })).status, 200);
  assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, token)).status, 200);
  assert.equal((await S.j('POST', '/guardian/disclaimer', { accepted: true }, token)).status, 200);
  const kid = await S.j('POST', '/guardian/children', { name: `Kid ${tag}`, dob: '2015-05-05' }, token); assert.equal(kid.status, 201, kid.text);
  return { token, guardianId: gs.body.guardianId, childId: kid.body.playerId };
}
const roomStatus = async (S, token, RID) => (await S.j('GET', `/org/rooms/${RID}`, undefined, token)).body.room.status;
const roomRev = async (S, token, RID) => (await S.j('GET', `/org/rooms/${RID}`, undefined, token)).body.room.rev;
const lifecycle = async (S, token, RID, action, extra = {}) => S.j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: await roomRev(S, token, RID), ...extra }, token);
/** A room at contact_planned (the contact routes' precondition). */
async function plannedRoom(S, token, playerId) {
  const r = await S.j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token); assert.equal(r.status, 201, r.text); const RID = r.body.room.roomId;
  if (await roomStatus(S, token, RID) === 'watching') assert.equal((await lifecycle(S, token, RID, 'startReview')).status, 200);
  const mv = await lifecycle(S, token, RID, 'planContact'); assert.equal(mv.status, 200, mv.text); return RID;
}
/** A room at offer_consideration (the offer routes' precondition): review → shortlist → a finalized progress decision. */
async function considerationRoom(S, token, playerId) {
  const r = await S.j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token); assert.ok(r.status === 201 || r.body?.existingRoomId, r.text); const RID = r.status === 201 ? r.body.room.roomId : r.body.existingRoomId;
  if (await roomStatus(S, token, RID) === 'watching') assert.equal((await lifecycle(S, token, RID, 'startReview')).status, 200);
  if (await roomStatus(S, token, RID) === 'under_review') { const s = await lifecycle(S, token, RID, 'shortlist'); assert.equal(s.status, 200, s.text); }
  const dr = await S.j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note: DECISION_NOTE }, token); assert.equal(dr.status, 201, dr.text);
  const fin = await S.j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: `fin-${RID}` }, token); assert.equal(fin.status, 201, fin.text); assert.equal(fin.body.lifecycle?.to, 'offer_consideration', fin.text);
  return { RID, DEC: fin.body.decision.id };
}
const TERMS = { role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical.' };

await test('[routes] a fresh boot records 0017_recruitment_contacts_offers; the ten typed tables exist with the real keys (the case and request keys deferred to COMMIT), no blob behind either collection; a contact drafted, edited, sent with one injected transport failure (the failed attempt a row) and then delivered — its request row, its send key and its history landing in the route\'s own unit of work — answered through the real respond route; an external record; an offer created, edited, issued, revised (a draft beside the issued revision), viewed by the recipient (a receipt row) and accepted with the draft discarded (discarded_by_response_id on it only); /capabilities counts the rows; a SIGKILL right after a send loses nothing; [compat] another club gets 404; the recipient\'s surfaces carry no internal note, no decision id and no contact body; the journey carries no body', async () => {
  const dir = tempDir('s8c-boot'); let S = await boot(dir);
  assert.equal(applied(dir).filter((id) => id < '0019').at(-2), MIGRATION, 'the recorded migration (0018_signings_follow_ups, S8d, follows it)'); for (const t of TABLES) assert.ok(tableExists(dir, t), `${t} exists`);
  assert.ok(fkOf(dir, 'recruitment_contacts').includes('request_id->recruitment_requests(id) NO ACTION'), `the request key: ${fkOf(dir, 'recruitment_contacts')}`); assert.ok(fkOf(dir, 'recruitment_offers').includes('case_id->recruitment_cases(id) RESTRICT'), 'the case key is immediate: the case is written before its offer');
  assert.match(ddlOf(dir, 'recruitment_contacts'), /request_id TEXT REFERENCES recruitment_requests\(id\) DEFERRABLE INITIALLY DEFERRED/, 'checked at COMMIT');
  assert.doesNotMatch(ddlOf(dir, 'idempotency_keys') ?? '', /'recruitment_contacts'|'recruitment_offers'/, 'the keys are the records\' own columns'); for (const n of COLLECTIONS) assert.equal(blobOf(dir, n), undefined, `${n}: no blob`);
  const maria = await orgLogin(S); const a = await signupAdult(S, 'Contact Adult'); const RID = await plannedRoom(S, maria, a.pid);
  // the contact: draft → edit → send (one injected transport failure first) → respond
  const draft = await S.j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest from Eastport', body: PRIVATE_BODY, clientKey: 'c-create' }, maria); assert.equal(draft.status, 201, draft.text); const CID = draft.body.contact.id;
  const row0 = contactRow(dir, CID); assert.ok(row0, 'the draft is a row the moment the route answers'); assert.equal(row0.status, 'draft'); assert.equal(row0.body, PRIVATE_BODY); assert.equal(row0.case_id, RID); assert.equal(row0.create_key, 'c-create', 'the create key is a column of the contact');
  const replay = await S.j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Interest from Eastport', body: PRIVATE_BODY, clientKey: 'c-create' }, maria); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.contact.id, CID, '[compat] the same clientKey replays');
  const edit = await S.j('PATCH', `/org/rooms/${RID}/contacts/${CID}`, { body: `${PRIVATE_BODY} Would a call suit you?`, expectedRev: draft.body.contact.rev }, maria); assert.equal(edit.status, 200, edit.text); assert.equal(contactRow(dir, CID).rev, edit.body.contact.rev);
  assert.equal((await S.j('POST', '/admin/delivery/inject-failure', { channel: 'contact', count: 1 }, null, A)).status, 200);
  const failed = await S.j('POST', `/org/rooms/${RID}/contacts/${CID}/send`, { expectedRev: edit.body.contact.rev, clientKey: 'c-send-1' }, maria); assert.equal(failed.status, 200, failed.text); assert.equal(failed.body.delivered, false, '[compat] the injected transport failure answers delivered:false with an honest failed attempt');
  const rowF = contactRow(dir, CID); assert.equal(rowF.status, 'failed'); assert.equal(rowF.failure_code, 'TRANSPORT_REFUSED'); assert.deepEqual(qAll(dir, 'SELECT ok, code FROM contact_attempts WHERE contact_id = ? ORDER BY position', CID), [{ ok: 0, code: 'TRANSPORT_REFUSED' }], 'the failed attempt is a row'); assert.equal(rowF.request_id, null, 'no request yet');
  const sent = await S.j('POST', `/org/rooms/${RID}/contacts/${CID}/send`, { expectedRev: failed.body?.contact?.rev ?? contactRow(dir, CID).rev, clientKey: 'c-send-2' }, maria); assert.equal(sent.status, 200, sent.text);
  const rowS = contactRow(dir, CID); assert.equal(rowS.status, 'delivered'); assert.ok(rowS.request_id, 'the request id on the row'); assert.equal(rowS.recipient_type, 'player'); assert.equal(rowS.recipient_player_id, a.pid); assert.equal(rowS.routing_mode, 'player_only');
  assert.equal(q1(dir, 'SELECT contact_id FROM recruitment_requests WHERE id = ?', rowS.request_id).contact_id, CID, 'the pair in the tables, written in the same save'); assert.equal(qAll(dir, 'SELECT ok FROM contact_attempts WHERE contact_id = ? ORDER BY position', CID).map((r) => r.ok).join(), '0,1', 'both attempts in order');
  assert.equal(rowS.send_key, 'c-send-2', 'the send key is a column'); assert.ok(qAll(dir, 'SELECT action FROM contact_history WHERE contact_id = ? ORDER BY position', CID).map((r) => r.action).includes('contact_sent'));
  const again = await S.j('POST', `/org/rooms/${RID}/contacts/${CID}/send`, { expectedRev: sent.body.contact.rev, clientKey: 'c-send-2' }, maria); assert.equal(again.status, 200, again.text); assert.equal(contactRow(dir, CID).rev, rowS.rev, '[compat] the same send key replays without a second send');
  const resp = await S.j('POST', `/player/requests/${rowS.request_id}/respond`, { accept: true, message: 'Yes, happy to talk next week.' }, a.token); assert.equal(resp.status, 200, resp.text);
  const rowR = contactRow(dir, CID); assert.equal(rowR.status, 'responded'); assert.equal(rowR.response_kind, 'accepted'); assert.equal(rowR.response_message, 'Yes, happy to talk next week.'); assert.equal(rowR.response_by, 'player');
  const ext = await S.j('POST', `/org/rooms/${RID}/contacts/external`, { channel: 'phone', occurredAt: Date.now() - 600_000, summary: 'Phoned to confirm the call time.', recipientType: 'player', clientKey: 'c-ext' }, maria); assert.equal(ext.status, 201, ext.text);
  const rowE = contactRow(dir, ext.body.contact.id); assert.equal(rowE.status, 'recorded'); assert.equal(rowE.channel, 'phone'); assert.equal(rowE.summary, 'Phoned to confirm the call time.'); assert.equal(rowE.record_key, 'c-ext');
  const list = await S.j('GET', `/org/rooms/${RID}/contacts`, undefined, maria); assert.equal(list.status, 200); assert.equal((list.body.contacts ?? list.body.items ?? list.body).length, 2, '[compat] the listing');
  // the offer: create → edit → issue → revise → viewed → accept (the draft beside it discarded)
  const b = await signupAdult(S, 'Offer Adult'); const { RID: ORID, DEC } = await considerationRoom(S, maria, b.pid);
  const c1 = await S.j('POST', `/org/rooms/${ORID}/offers`, { terms: { role: TERMS.role, squad: TERMS.squad }, internalNote: PRIVATE_NOTE, recipientMessage: 'Welcome.', clientKey: 'o-create' }, maria); assert.equal(c1.status, 201, c1.text); const OID = c1.body.offer.id; const R1 = c1.body.offer.currentRevision.id;
  const orow0 = offerRow(dir, OID); assert.ok(orow0, 'the offer is a row the moment the route answers'); assert.equal(orow0.status, 'DRAFT'); assert.equal(orow0.decision_id, DEC); assert.equal(orow0.current_revision_id, R1); assert.equal(q1(dir, 'SELECT internal_note FROM offer_revisions WHERE offer_id = ? AND id = ?', OID, R1).internal_note, PRIVATE_NOTE);
  const e1 = await S.j('PATCH', `/org/offers/${OID}/draft`, { terms: TERMS, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), expectedRev: c1.body.offer.rev }, maria); assert.equal(e1.status, 200, e1.text); assert.equal(q1(dir, 'SELECT term_end_date FROM offer_revisions WHERE id = ?', R1).term_end_date, '2029-06-30');
  const iss = await S.j('POST', `/org/offers/${OID}/issue`, { expectedRev: e1.body.offer.rev, clientKey: 'o-issue' }, maria); assert.equal(iss.status, 200, iss.text);
  const orow1 = offerRow(dir, OID); assert.equal(orow1.status, 'ISSUED'); assert.equal(q1(dir, 'SELECT status, recipient_player_id FROM offer_revisions WHERE id = ?', R1).status, 'ISSUED'); assert.deepEqual(q1(dir, "SELECT key, revision_id FROM offer_keys WHERE offer_id = ? AND act = 'issue'", OID), { key: 'o-issue', revision_id: R1 }, 'the issue key as an offer_keys row');
  const rv = await S.j('POST', `/org/offers/${OID}/revise`, { terms: { ...TERMS, squad: 'First team' }, expectedRev: iss.body.offer.rev, clientKey: 'o-revise' }, maria); assert.equal(rv.status, 201, rv.text); const R2 = rv.body.offer.currentRevision.id;
  assert.deepEqual(qAll(dir, 'SELECT id, status FROM offer_revisions WHERE offer_id = ? ORDER BY position', OID), [{ id: R1, status: 'ISSUED' }, { id: R2, status: 'DRAFT' }], 'a draft beside the issued revision'); assert.equal(q1(dir, 'SELECT supersedes_revision_id FROM offer_revisions WHERE id = ?', R2).supersedes_revision_id, R1); assert.equal(offerRow(dir, OID).current_revision_id, R2);
  const seen = await S.j('GET', `/player/offers/${OID}`, undefined, b.token); assert.equal(seen.status, 200, seen.text); assert.deepEqual(qAll(dir, 'SELECT revision_id, viewer_kind, viewer_id FROM offer_read_receipts WHERE offer_id = ?', OID), [{ revision_id: R1, viewer_kind: 'player', viewer_id: b.pid }], 'the receipt is a row');
  const pBlob = JSON.stringify([seen.body, (await S.j('GET', '/player/offers', undefined, b.token)).body]); assert.equal(pBlob.includes(PRIVATE_NOTE), false, '[compat] the recipient never receives the internal note'); assert.doesNotMatch(pBlob, new RegExp(DEC), '[compat] nor the decision id'); assert.equal(pBlob.includes(R2) && /DRAFT/.test(pBlob), false, '[compat] nor the draft');
  // §4.3 step 4: a list or a read of offers already seen is a read only. Nothing is committed (a second connection's
  // data_version moves on any other connection's commit), and the receipt is still the one row.
  { await sleep(1500); const side = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); const version = () => side.prepare('PRAGMA data_version').get().data_version; const v0 = version();
    for (let i = 0; i < 3; i += 1) { assert.equal((await S.j('GET', '/player/offers', undefined, b.token)).status, 200); assert.equal((await S.j('GET', `/player/offers/${OID}`, undefined, b.token)).status, 200); }
    await sleep(1500); assert.equal(version(), v0, 'reading seen offers commits nothing'); side.close();
    assert.equal(q1(dir, 'SELECT count(*) AS n FROM offer_read_receipts WHERE offer_id = ?', OID).n, 1, 'one receipt'); }
  const acc = await S.j('POST', `/player/offers/${OID}/accept`, { revisionId: R1, clientKey: 'o-accept' }, b.token); assert.equal(acc.status, 200, acc.text);
  const orow2 = offerRow(dir, OID); assert.equal(orow2.status, 'ACCEPTED'); assert.equal(orow2.current_revision_id, R1, 'the accepted revision is current again');
  const revs = qAll(dir, 'SELECT id, status, response_id, discarded_by_response_id FROM offer_revisions WHERE offer_id = ? ORDER BY position', OID); const RESP = q1(dir, 'SELECT id, response_type, actor_type, actor_id FROM offer_responses WHERE offer_id = ?', OID);
  assert.equal(RESP.response_type, 'accepted'); assert.equal(RESP.actor_id, b.pid); assert.equal(revs[0].response_id, RESP.id); assert.equal(revs[1].status, 'WITHDRAWN'); assert.equal(revs[1].discarded_by_response_id, RESP.id, 'the draft discarded by the response'); assert.equal(revs[0].discarded_by_response_id, null);
  const accAgain = await S.j('POST', `/player/offers/${OID}/accept`, { revisionId: R1, clientKey: 'o-accept' }, b.token); assert.equal(accAgain.status, 200, accAgain.text); assert.equal(q1(dir, 'SELECT count(*) AS n FROM offer_responses WHERE offer_id = ?', OID).n, 1, '[compat] the same clientKey replays without a second response');
  const cap = await S.j('GET', '/capabilities'); const dom = cap.body.dataLayer.domains.recruitmentContactsOffers; assert.ok(dom, '/capabilities carries the recruitmentContactsOffers domain'); assert.equal(dom.mode, 'live'); assert.equal(dom.rows.recruitmentContacts, 2); assert.equal(dom.rows.recruitmentOffers, 1); assert.deepEqual(dom.unresolvedPlayerReferences, { recruitmentContacts: 0, recruitmentOffers: 0 }); assert.match(dom.writeMode, /^explicit/); assert.equal(dom.pendingWrites, 0); assert.match(dom.references, /Q8c-a/); assert.match(dom.references, /Q8c-b/);
  // [compat] another club; the journey
  const rita = await orgLogin(S, 'org-harbour', 'Rita Vale', 'Head of Recruitment'); assert.equal((await S.j('GET', `/org/rooms/${RID}/contacts`, undefined, rita)).status, 404, '[compat] another club: 404'); assert.equal((await S.j('GET', `/org/offers/${OID}`, undefined, rita)).status, 404);
  const jr = await S.j('GET', `/org/rooms/${RID}/journey`, undefined, maria); assert.equal(jr.status, 200); assert.equal(JSON.stringify(jr.body).includes(PRIVATE_BODY), false, '[compat] the journey carries no contact body');
  // SIGKILL right after a send
  const c2 = await signupAdult(S, 'Kill Adult'); const RID2 = await plannedRoom(S, maria, c2.pid); const d2 = await S.j('POST', `/org/rooms/${RID2}/contacts`, { subject: 'Before the kill', body: 'Body before the kill.', clientKey: 'c-kill' }, maria); assert.equal(d2.status, 201, d2.text);
  const s2 = await S.j('POST', `/org/rooms/${RID2}/contacts/${d2.body.contact.id}/send`, { expectedRev: d2.body.contact.rev, clientKey: 'c-kill-send' }, maria); assert.equal(s2.status, 200, s2.text);
  await S.kill(); assert.equal(contactRow(dir, d2.body.contact.id).status, 'delivered', 'the send was in the route\'s own save'); assert.ok(q1(dir, 'SELECT 1 AS one FROM recruitment_requests WHERE id = ?', contactRow(dir, d2.body.contact.id).request_id), 'its request too');
  S = await boot(dir); const mariaR = await orgLogin(S); const back = await S.j('GET', `/org/rooms/${ORID}/offers`, undefined, mariaR); assert.equal(back.status, 200); assert.ok(back.body.offers.some((o) => o.id === OID && o.status === 'ACCEPTED'), 'served from the tables after the restart'); assert.equal((await S.j('GET', `/org/rooms/${RID}/contacts/${CID}`, undefined, mariaR)).body.contact.status, 'responded');
  await S.stop(); rm(dir);
});

await test('[routes] the deletion unit redacts the person\'s contacts and offers through the repository (the reply\'s message, the response names and the history names NULL, subject_removed_at set; ids, states and times stay) — a failure of the REAL COMMIT leaves every row as it was and the retry lands once; a restored backup to which a contact naming a historically missing player is added (a snapshot-mode save) serves it as today and counts it (Q8c-a), never refused; one naming a missing guardian is refused by the save with ids (Q8c-b), the file unchanged', async () => {
  const dir = tempDir('s8c-unit'); let S = await boot(dir);
  const maria = await orgLogin(S); const a = await signupAdult(S, 'Leaving Adult'); const RID = await plannedRoom(S, maria, a.pid);
  const d = await S.j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Hello', body: 'Body.', clientKey: 'u-create' }, maria); assert.equal(d.status, 201, d.text); const CID = d.body.contact.id;
  const s = await S.j('POST', `/org/rooms/${RID}/contacts/${CID}/send`, { expectedRev: d.body.contact.rev, clientKey: 'u-send' }, maria); assert.equal(s.status, 200, s.text);
  assert.equal((await S.j('POST', `/player/requests/${contactRow(dir, CID).request_id}/respond`, { accept: true, message: 'The reply text.' }, a.token)).status, 200);
  const { RID: ORID } = await considerationRoom(S, maria, a.pid); const c1 = await S.j('POST', `/org/rooms/${ORID}/offers`, { terms: TERMS, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), clientKey: 'u-offer' }, maria); assert.equal(c1.status, 201, c1.text); const OID = c1.body.offer.id; const R1 = c1.body.offer.currentRevision.id;
  assert.equal((await S.j('POST', `/org/offers/${OID}/issue`, { expectedRev: c1.body.offer.rev, clientKey: 'u-issue' }, maria)).status, 200); assert.equal((await S.j('POST', `/player/offers/${OID}/accept`, { revisionId: R1, clientKey: 'u-accept' }, a.token)).status, 200);
  assert.equal(q1(dir, 'SELECT actor_name FROM offer_responses WHERE offer_id = ?', OID).actor_name, 'Leaving Adult'); assert.equal(contactRow(dir, CID).response_message, 'The reply text.');
  const before = recDump(dir); const tok = await playerLogin(S, a.pid);
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' })).status, 200);
  const failed = await S.j('DELETE', '/player/account', {}, tok); assert.equal(failed.status, 500, failed.text);
  assert.equal(recDump(dir), before, 'a failed REAL COMMIT leaves every contact, offer, request and case row as it was'); assert.equal((await S.j('GET', '/player/me', undefined, tok)).status, 200);
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  const ok = await S.j('DELETE', '/player/account', {}, tok); assert.equal(ok.status, 200, ok.text);
  const crow = contactRow(dir, CID); assert.equal(crow.response_message, null, 'the reply\'s words go with the person'); assert.equal(crow.response_kind, 'accepted', 'the kind stays'); assert.equal(crow.player_id, a.pid, 'the id stays');
  const orow = offerRow(dir, OID); assert.ok(orow.subject_removed_at, 'subject_removed_at set'); assert.equal(orow.status, 'ACCEPTED'); assert.equal(q1(dir, 'SELECT actor_name FROM offer_responses WHERE offer_id = ?', OID).actor_name, null); assert.equal(qAll(dir, "SELECT by_name FROM offer_history WHERE offer_id = ? AND by_kind = 'player'", OID).every((h) => h.by_name === null), true);
  // every reference OCCURRENCE of the retained person is counted (the review of 535e247, F3): the contact's parent and its player recipient; the offer's parent, the issued revision's recipient snapshot, the acceptance's for-player id and its player actor
  const cap = await S.j('GET', '/capabilities'); assert.deepEqual(cap.body.dataLayer.domains.recruitmentContactsOffers.retainedPlayerReferences, { recruitmentContacts: 2, recruitmentOffers: 4 }, 'the retained person counted per occurrence');
  const rd = await S.j('GET', `/org/rooms/${RID}/contacts/${CID}`, undefined, maria); assert.equal(rd.status, 200, rd.text); assert.equal(rd.body.contact.response?.message ?? null, null, '[compat] the contact is served with the reply\'s words removed');
  // Q8c-a / Q8c-b through a restored backup
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text); await S.stop();
  const restored = tempDir('s8c-q8c'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  const addContact = (where, extra) => { const store = openStore(where); try { const loaded = store.load(); const base = loaded.db.recruitmentContacts.find((c) => c.id === CID); loaded.db.recruitmentContacts = [...loaded.db.recruitmentContacts, { ...base, keys: { create: null, send: null, record: null }, history: [], attempts: [], ...extra }]; store.save(loaded); } finally { store.sqlite.close(); } };
  addContact(restored, { id: 'rct-gone', playerId: 'pl-gone-long-ago', requestId: null, status: 'cancelled', recipient: null, response: null });
  S = await boot(restored); assert.ok(live(restored)); assert.ok((await S.j('GET', '/capabilities')).body.dataLayer.domains.recruitmentContactsOffers.retainedPlayerReferences.recruitmentContacts >= 1);
  const mariaR = await orgLogin(S); const l = await S.j('GET', `/org/rooms/${RID}/contacts`, undefined, mariaR); assert.ok(JSON.stringify(l.body).includes('rct-gone'), 'the contact of a missing player is served as today');
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.domains.recruitmentContactsOffers.unresolvedPlayerReferences.recruitmentContacts, 1); await S.stop();
  const strict = tempDir('s8c-q8cb'); fs.cpSync(bk.body.dir, strict, { recursive: true }); const strictBefore = recDump(strict);
  assert.throws(() => addContact(strict, { id: 'rct-ghost', requestId: null, status: 'cancelled', recipient: { type: 'guardian', playerId: a.pid, guardianId: 'gd-ghost', minor: true }, response: null }), (e) => { assert.match(e.message, /CONTACTS_OFFERS_GUARDIAN_MISSING/); assert.match(e.message, /rct-ghost → guardians gd-ghost/); assert.doesNotMatch(e.message, /The reply text|Leaving Adult/, 'ids only'); return true; }, 'Q8c-b: refused by the save');
  assert.equal(recDump(strict), strictBefore, 'the refused save changed nothing');
  S = await boot(strict); assert.equal(q1(strict, "SELECT count(*) AS n FROM recruitment_contacts WHERE id = 'rct-ghost'").n, 0, 'the server boots on the unchanged copy'); await S.stop();
  rm(dir, restored, strict, bk.body.dir);
});

await test('[backup] the admin backup is a copy of the database: the two collections read back from it (keys reassembled, the attempt, the internal note, the status); a restore into a NEW directory serves them row for row', async () => {
  const dir = tempDir('s8c-backup'); let S = await boot(dir);
  const maria = await orgLogin(S); const a = await signupAdult(S, 'Backup Adult'); const RID = await plannedRoom(S, maria, a.pid);
  const d = await S.j('POST', `/org/rooms/${RID}/contacts`, { subject: 'Kept through everything', body: 'Body kept through everything.', clientKey: 'b-create' }, maria); assert.equal(d.status, 201, d.text); const CID = d.body.contact.id;
  const s = await S.j('POST', `/org/rooms/${RID}/contacts/${CID}/send`, { expectedRev: d.body.contact.rev, clientKey: 'b-send' }, maria); assert.equal(s.status, 200, s.text);
  const { RID: ORID } = await considerationRoom(S, maria, a.pid); const c1 = await S.j('POST', `/org/rooms/${ORID}/offers`, { terms: TERMS, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), internalNote: PRIVATE_NOTE, clientKey: 'b-offer' }, maria); assert.equal(c1.status, 201, c1.text); const OID = c1.body.offer.id;
  // A second boot before the backup, then a saving route: M13's boot-time normaliser (m13/shared.mjs: a case without a
  // budget gets `budget: null`) is an in-place change the S8b staged flush lands in the NEXT save. The restored server's
  // boot applies it too, so the live file must have been through a boot and a save as well for the two sides to be
  // comparable row for row (an S8b property, not an S8c one; the two S8c collections are unaffected by it).
  await S.stop(); S = await boot(dir); const maria2 = await orgLogin(S);
  assert.equal((await S.j('POST', `/org/offers/${OID}/issue`, { expectedRev: c1.body.offer.rev, clientKey: 'b-issue' }, maria2)).status, 200);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  { const c = new DatabaseSync(path.join(bk.body.dir, 'scoutbox.db'), { readOnly: true }); const contacts = readContacts(c); const offers = readOffers(c);
    assert.equal(contacts.length, 1); assert.equal(contacts[0].keys.send.key, 'b-send', 'keys reassembled'); assert.equal(contacts[0].attempts.length, 1);
    assert.equal(offers.length, 1); assert.deepEqual(offers[0].keys.issue.map((k) => k.key), ['b-issue']); assert.equal(offers[0].revisions[0].internalNote, PRIVATE_NOTE); assert.equal(offers[0].status, 'ISSUED'); c.close(); }
  const liveCanon = recCanon(dir); await S.stop();
  const restored = tempDir('s8c-restore'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored)); { const got = recCanon(restored); assert.equal(got, liveCanon, `row for row (every table's rows equal by content; a rewrite reinserts children, so rowid order is not compared): ${got === liveCanon ? '' : canonDiff(got, liveCanon)}`); } const mariaR = await orgLogin(S); assert.equal((await S.j('GET', `/org/rooms/${RID}/contacts/${CID}`, undefined, mariaR)).body.contact.status, 'delivered'); await S.stop();
  rm(dir, restored, bk.body.dir);
});

console.log(`\n${passed} recruitment contacts/offers server checks passed`);
