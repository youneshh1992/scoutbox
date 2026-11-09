// S12c — Recruitment Briefs, Nobody Missed reviews, Second Look items and Dynamic Watchlists as typed tables with
// explicit writes (repositories/discovery.mjs, migration 0032). What this suite proves: the migration creates the STRICT
// tables (no JSON column), empty; the typers refuse junk with the record and field named (an unknown foot, position
// groups that are not the positions', a day that does not exist, an unknown trigger, a system trail entry with a person,
// a criterion whose id is not its own, a live-linked list without a brief); every record is created and read back whole
// (every criterion kind the schema evaluates included, the position groups worked out); an update keeps the fields that
// never change, only grows the trail and refuses itself from inside itself; a review is unique per organisation, brief
// and player, an item per decision cycle; a reconciliation replaces the membership, appends only unseen transitions and
// records its clock; the watchlist list and its transitions page; a rolled-back unit leaves nothing; the db.* names
// throw; and a fixture written through the repository is typed, names a missing reference and reads back what it wrote. Temporary databases
// only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { fixtureDb, ORG, SCOUT, p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, legacyTrialRequest } from './recruitmentTestFixtures.mjs';
import { S8B_FIX } from './recruitmentCasesTestFixtures.mjs';
import {
  DISCOVERY_MIGRATION as MIGRATION, DISCOVERY_TABLES as TABLES, DISCOVERY_COLLECTIONS as COLLECTIONS,
  typeBrief, typeReview, typeSecondLookItem, typeWatchlist, typeCriterion, typeMembers, typeMembershipEvent,
} from '../repositories/discovery.mjs';
import { validateRecruitmentBrief } from '../domains/discovery/shared.mjs';
import { validateCriteria, criteriaVersion, CRITERION_TYPES } from '../domains/discovery/matching/criteria.mjs';
import { transitionFingerprint } from '../domains/discovery/matching/watchlists.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const plain = (v) => JSON.parse(JSON.stringify(v));
const by = { userId: SCOUT.userId, name: SCOUT.name };
const audit = (id, at, action, detail = null) => ({ id, at, byKind: 'org', byId: SCOUT.userId, byName: SCOUT.name, action, detail });

// ------------------------------------------------------------- fixtures: the literals the routes write
/** POST /org/recruitment-briefs (domains/discovery/nobodyMissed.mjs), criteria from the route's own validator. */
const brief = (over = {}, input = { title: 'Left-footed CB', positions: ['CB', 'LB'], minAge: 17, maxAge: 23, foot: 'Left', evidenceRequirements: ['recent_full_match'], combineProtocols: ['sprint-30m'], availability: 'available_now', activeFrom: '2026-10-01', activeUntil: '2026-12-31' }) => {
  const v = validateRecruitmentBrief(input, { orgLevel: 'pro' });
  assert.ok(v.ok, JSON.stringify(v));
  return {
    id: 'brf-1', orgId: ORG.id, title: v.title, criteria: v.criteria, version: 1, status: 'draft',
    activeFrom: v.activeFrom, activeUntil: v.activeUntil, roleId: null, vacancyId: null,
    createdBy: by, createdAt: NOW, updatedAt: NOW, history: [audit('aud-b1', NOW, 'recruitment_brief_created', { version: 1 })],
    rev: 1, revAt: NOW, revBy: by, ...over,
  };
};
/** setReview (nobodyMissed.mjs): the first action. */
const review = (over = {}) => ({
  id: 'nmr-1', orgId: ORG.id, briefId: 'brf-1', briefVersion: 1, playerId: 'pl-adult', state: 'reviewed', createdAt: NOW, updatedAt: NOW,
  reviewedBy: by, reviewedAt: NOW, history: [{ at: NOW, state: 'reviewed', by }], ...over,
});
/** reconcile (secondLook.mjs): a surfaced item on case-1's head decision. */
const item = (over = {}) => ({
  id: 'slk-1', orgId: ORG.id, playerId: 'pl-adult', roomId: 'case-1', decisionId: 'rdec-2', policyVersion: 1,
  triggerType: 'direct_reason_resolved', changeFingerprints: ['full_match_added:evidence:ev-9', 'trial_completed:trial:trial-1'],
  directReasonCodes: ['insufficient_full_match'], status: 'open', createdAt: NOW, updatedAt: NOW, latestChangeAt: NOW - 1000,
  history: [{ at: NOW, action: 'surfaced', by: null }], ...over,
});
/** Every criterion kind the schema evaluates, normalised by validateCriteria (the route's own). */
const ALL_KINDS = {
  required: [
    { type: 'position', operator: 'in', values: ['CB', 'LB'], primaryOnly: true },
    { type: 'age', operator: 'between', values: [17, 23] },
    { type: 'age', operator: 'gte', value: 16 },
    { type: 'geography', operator: 'within_radius', value: 42.5 },
    { type: 'level', operator: 'lte', value: 'semi_pro' },
    { type: 'foot', operator: 'in', values: ['Left'] },
  ],
  preferred: [
    { type: 'level', operator: 'in', values: ['amateur', 'semi_pro'] },
    { type: 'availability', operator: 'equals', value: 'available_now' },
    { type: 'evidence', operator: 'exists', value: 'coach_reference' },
    { type: 'evidence_recency', operator: 'within_days', value: 90, evidenceKind: 'any' },
    { type: 'trust_band', operator: 'gte', value: 'established_evidence' },
    { type: 'combine_result', operator: 'exists', value: 'sprint-30m' },
    { type: 'combine_measurement', operator: 'lte', protocol: 'sprint-30m', value: 4.35 },
    { type: 'age', operator: 'lte', value: 30 },
  ],
};
const criteria = (input = ALL_KINDS) => { const v = validateCriteria(input, { orgLevel: 'pro' }); assert.ok(v.ok, JSON.stringify(v)); return v.criteria; };
/** POST /org/watchlists (domains/discovery/matching/index.mjs). */
const watchlist = (over = {}) => {
  const c = over.criteria ?? criteria();
  return {
    id: 'wl-1', orgId: ORG.id, name: 'Left side', mode: 'snapshot', status: 'active', sourceType: 'criteria', sourceId: null,
    criteria: c, criteriaVersion: criteriaVersion(c), schemaVersion: 1, notify: true, createdBy: SCOUT.userId, createdByName: SCOUT.name,
    createdAt: NOW, updatedAt: NOW, rev: 1, lastCriteriaVersion: null, lastReconciledAt: null, lastBriefVersion: null,
    history: [audit(`aud-${over.id ?? 'wl-1'}`, NOW, 'watchlist_created', { mode: 'snapshot', sourceType: 'criteria' })], ...over,
  };
};
const event = (w, playerId, transition, reason, at, over = {}) => ({
  id: nextId('wlh'), watchlistId: w.id, orgId: w.orgId, playerId, transition, reason, criterionId: null,
  text: 'First time this watchlist was evaluated', criteriaVersion: w.criteriaVersion, briefVersion: null, policyVersion: 1, at,
  fingerprint: transitionFingerprint({ watchlistId: w.id, playerId, criteriaVersion: w.criteriaVersion, transition, reason }), ...over,
});

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.discovery, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}
/** The S8b graph (case-1, the room of pl-adult at org-pro, with decisions rdec-1 and its head rdec-2) and the requests and trial it links. */
const CASES_FIX = () => ({ notifications: [], dispatches: [], requests: [acceptedRequest(p4bInvitation(), 'trial-1'), minorInvitation(), legacyTrialRequest()], trials: [scheduledTrial()], ...S8B_FIX() });
/** A watchlist is created unreconciled; its membership and transitions come from a reconciliation (needing the whole fixture). */
const writersFor = (fix) => ({
  dynamicWatchlists: (L, records) => {
    for (const { members = [], lastCriteriaVersion = null, lastBriefVersion = null, lastReconciledAt = null, ...w } of records) {
      L.discovery.watchlists.create({ ...w, lastCriteriaVersion: null, lastBriefVersion: null, lastReconciledAt: null });
      const events = (fix.watchlistHistory ?? []).filter((e) => e.watchlistId === w.id);
      if (lastReconciledAt !== null) L.discovery.watchlists.reconcile(w.id, { at: lastReconciledAt, criteriaVersion: lastCriteriaVersion, briefVersion: lastBriefVersion, members, events });
      else if (events.length) throw new Error(`dynamic_watchlists ${w.id}: transitions come from a reconciliation`);
    }
  },
  watchlistHistory: () => {}, // with their watchlist's reconciliation, above
});
const write = (dir, records) => writeFixture(dir, records, { now: NOW, writers: writersFor(records) });
const seeded = (label) => { const dir = tempDir(label); write(dir, fixtureDb(CASES_FIX())); return { dir, s: serverOpen(dir) }; };

// ------------------------------------------------------------- schema
test('[schema] 0032 is registered after 0031 and creates the STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0031_box_cam') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s12c-empty'); const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.doesNotMatch(sql, /json_valid|_json\s/i, `${t} has no JSON column`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] junk is refused naming the record and field', () => {
  assert.ok(typeBrief(brief()).ok);
  assert.match(typeBrief(brief({ criteria: { ...brief().criteria, foot: 'left' } })).reason, /recruitmentBriefs brf-1\.criteria\.foot/);
  assert.match(typeBrief(brief({ criteria: { ...brief().criteria, positionGroups: ['ATT'] } })).reason, /positionGroups/);
  assert.match(typeBrief(brief({ criteria: { ...brief().criteria, positions: ['XX'] } })).reason, /positions\[0\]/);
  assert.match(typeBrief(brief({ activeUntil: '2026-02-30' })).reason, /activeUntil/, 'a day that does not exist');
  assert.match(typeBrief(brief({ roleId: { id: 1 } })).reason, /roleId/);
  assert.match(typeBrief({ ...brief(), extra: 1 }).reason, /carries field\(s\).*extra/);
  assert.match(typeBrief(brief({ history: [audit('aud-x', NOW, 'recruitment_brief_deleted')] })).reason, /action/);
  assert.match(typeReview(review({ state: 'dismissed' })).reason, /dismissedAt/);
  assert.match(typeReview(review({ state: 'added_to_room' })).reason, /roomId/);
  assert.match(typeSecondLookItem(item({ triggerType: 'trust_change' })).reason, /triggerType/);
  assert.match(typeSecondLookItem(item({ history: [{ at: NOW, action: 'surfaced', by }] })).reason, /by is null/);
  assert.match(typeSecondLookItem(item({ history: [{ at: NOW, action: 'resurfaced', by: null }] })).reason, /reason/);
  assert.match(typeSecondLookItem(item({ directReasonCodes: ['made_up'] })).reason, /directReasonCodes\[0\]/);
  assert.match(typeSecondLookItem(item({ status: 'reviewed' })).reason, /reviewedAt/);
  assert.match(typeWatchlist(watchlist({ mode: 'live_linked' })).reason, /live_linked only for a brief-sourced/);
  assert.match(typeWatchlist(watchlist({ sourceType: 'brief' })).reason, /names the brief/);
  assert.match(typeWatchlist(watchlist({ notify: 'yes' })).reason, /notify/);
  assert.match(typeWatchlist(watchlist({ lastReconciledAt: NOW })).reason, /lastCriteriaVersion/);
  const c = criteria().required[0];
  assert.match(typeCriterion({ ...c, id: 'position:in:values=CB' }, 'c', 'required').reason, /own id/);
  assert.match(typeCriterion({ ...c, weight: 3 }, 'c', 'required').reason, /carries field\(s\).*weight/, 'no hidden weight');
  assert.match(typeCriterion({ ...c, type: 'ethnicity' }, 'c', 'required').reason, /criterion the schema evaluates/);
  assert.match(typeCriterion(c, 'c', 'preferred').reason, /class/);
  assert.match(typeMembers([{ playerId: 'pl-1', required: [] }, { playerId: 'pl-1', required: [] }], 'w').reason, /names a player twice/);
  assert.match(typeMembershipEvent({ ...event(watchlist(), 'pl-1', 'entered', 'got_better', NOW) }).reason, /reason/);
});

// ------------------------------------------------------------- briefs
test('[briefs] create and read back whole; an update keeps the fixed fields, only grows the trail, bumps the version', () => {
  const { dir, s } = seeded('s12c-briefs');
  const made = s.repo.briefs.create(brief());
  assert.deepEqual(plain(made), plain(brief()), 'read back exactly as written (the position groups worked out)');
  assert.deepEqual(made.criteria.positionGroups, ['DEF']);
  assert.ok(Object.isFrozen(made.criteria.positions), 'reads are deep-frozen');
  refused(() => s.repo.briefs.create(brief()), /DISCOVERY_DUPLICATE/);
  refused(() => s.repo.briefs.create(brief({ id: 'brf-x', orgId: 'org-nowhere' })), /orgId names no organisation/);
  const next = s.repo.briefs.update('brf-1', (d) => {
    d.criteria = validateRecruitmentBrief({ title: d.title, positions: ['ST'] }).criteria;
    d.version += 1; d.status = 'active'; d.updatedAt = NOW + 1; d.rev += 1;
    d.history.push(audit('aud-b2', NOW + 1, 'recruitment_brief_updated', { version: 2, criteriaChanged: true }));
    d.history.push(audit('aud-b3', NOW + 1, 'recruitment_brief_activated', { from: 'draft', to: 'active' }));
  });
  assert.equal(next.version, 2); assert.deepEqual(next.criteria.positions, ['ST']); assert.deepEqual(next.criteria.positionGroups, ['ATT']);
  assert.deepEqual(next.history.map((h) => h.detail), [{ version: 1 }, { version: 2, criteriaChanged: true }, { from: 'draft', to: 'active' }]);
  refused(() => s.repo.briefs.update('brf-1', (d) => { d.orgId = 'org-grass'; }), /orgId cannot change/);
  refused(() => s.repo.briefs.update('brf-1', (d) => { d.history.pop(); }), /history only grows/);
  refused(() => s.repo.briefs.update('brf-1', (d) => { d.version = 1; }), /criteria version only grows/);
  refused(() => s.repo.briefs.update('brf-1', () => { s.repo.briefs.update('brf-1', (d2) => { d2.title = 'x'; }); }), /DISCOVERY_NESTED_UPDATE/);
  assert.equal(s.repo.reads.briefs.forOrgById('brf-1', 'org-grass'), null, 'another organisation does not see it');
  assert.equal(s.repo.reads.briefs.countForOrg(ORG.id), 1);
  assert.deepEqual(s.repo.reads.briefs.historyFeed(ORG.id, ['recruitment_brief_activated']).map((r) => [r.entry.id, r.brief.title]), [['aud-b3', 'Left-footed CB']]);
  assert.equal(s.repo.reads.briefs.create, undefined, 'the reads cannot write');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- Nobody Missed reviews
test('[reviews] one per organisation, brief and player; an update appends to the trail; the brief must be the organisation\'s', () => {
  const { dir, s } = seeded('s12c-reviews');
  s.repo.briefs.create(brief());
  const r = s.repo.reviews.create(review());
  assert.deepEqual(plain(r), plain({ ...review(), dismissReason: null, dismissedBy: null, dismissedAt: null, roomId: null }));
  refused(() => s.repo.reviews.create(review({ id: 'nmr-2' })), /already has a review/);
  refused(() => s.repo.reviews.create(review({ id: 'nmr-3', briefId: 'brf-none' })), /briefId names no brief/);
  const d = s.repo.reviews.update('nmr-1', (x) => {
    Object.assign(x, { state: 'dismissed', dismissReason: 'timing', dismissedBy: by, dismissedAt: NOW + 5, updatedAt: NOW + 5 });
    x.history.push({ at: NOW + 5, state: 'dismissed', by });
  });
  assert.deepEqual(d.history.map((h) => h.state), ['reviewed', 'dismissed']);
  refused(() => s.repo.reviews.update('nmr-1', (x) => { x.playerId = 'pl-other'; }), /playerId cannot change/);
  refused(() => s.repo.reviews.update('nmr-1', (x) => { x.state = 'added_to_room'; x.history.push({ at: NOW + 6, state: 'added_to_room', by }); }), /roomId/);
  const added = s.repo.reviews.update('nmr-1', (x) => { x.state = 'added_to_room'; x.roomId = 'case-1'; x.history.push({ at: NOW + 7, state: 'added_to_room', by }); });
  assert.equal(added.roomId, 'case-1');
  assert.equal(s.repo.reads.reviews.byKey(ORG.id, 'brf-1', 'pl-adult').id, 'nmr-1');
  assert.deepEqual(s.repo.reads.reviews.forBrief(ORG.id, 'brf-1').map((x) => x.id), ['nmr-1']);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- Second Look
test('[second look] an item names its organisation\'s room and decision, one per decision cycle; the trail keeps its reasons', () => {
  const { dir, s } = seeded('s12c-items');
  const made = s.repo.secondLook.create(item());
  assert.deepEqual(plain(made), plain({ ...item(), reviewedAt: null, reviewedBy: null, dismissedAt: null, dismissedBy: null, dismissReason: null, reopenedAt: null, reopenedBy: null }));
  refused(() => s.repo.secondLook.create(item({ id: 'slk-2' })), /already has an item for room case-1 and decision rdec-2/);
  refused(() => s.repo.secondLook.create(item({ id: 'slk-3', decisionId: 'rdec-1', playerId: 'pl-child1' })), /not this organisation's room for this player/);
  refused(() => s.repo.secondLook.create(item({ id: 'slk-4', roomId: 'case-none' })), /roomId names no room/);
  assert.ok(s.repo.secondLook.create(item({ id: 'slk-5', decisionId: 'rdec-1' })), 'an earlier decision cycle is its own item');
  const handled = s.repo.secondLook.update('slk-1', (d) => {
    Object.assign(d, { status: 'dismissed', dismissedAt: NOW + 1, dismissedBy: by, dismissReason: null, updatedAt: NOW + 1 });
    d.history.push({ at: NOW + 1, action: 'dismissed', by, reason: null });
  });
  const back = s.repo.secondLook.update('slk-1', (d) => {
    d.status = 'open'; d.changeFingerprints = ['combine_verified_added:combine:sprint-30m@2']; d.updatedAt = NOW + 2;
    d.history.push({ at: NOW + 2, action: 'resurfaced', by: null, reason: 'materially_new_evidence' });
  });
  assert.deepEqual(plain(back.history), [{ at: NOW, action: 'surfaced', by: null }, { at: NOW + 1, action: 'dismissed', by, reason: null }, { at: NOW + 2, action: 'resurfaced', by: null, reason: 'materially_new_evidence' }]);
  assert.deepEqual(back.changeFingerprints, ['combine_verified_added:combine:sprint-30m@2'], 'the fingerprints are replaced whole');
  assert.equal(handled.status, 'dismissed');
  refused(() => s.repo.secondLook.update('slk-1', (d) => { d.decisionId = 'rdec-1'; }), /decisionId cannot change/);
  assert.equal(s.repo.reads.secondLook.byKey(ORG.id, 'case-1', 'rdec-2').id, 'slk-1');
  assert.equal(s.repo.reads.secondLook.forOrgById('slk-1', 'org-grass'), null);
  assert.deepEqual(s.repo.reads.secondLook.forOrgPlayer(ORG.id, 'pl-adult').map((i) => i.id), ['slk-1', 'slk-5']);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- watchlists
test('[watchlists] every criterion kind reads back as written; a brief-sourced list keys its brief; the list pages', () => {
  const { dir, s } = seeded('s12c-watchlists');
  assert.equal(Object.keys(CRITERION_TYPES).length, 11, 'the fixture covers every criterion type');
  const made = s.repo.watchlists.create(watchlist());
  assert.deepEqual(plain(made), plain({ ...watchlist(), revAt: null, revBy: null }), 'every criterion kind, in order, with its own id (a list never edited has no rev clock)');
  s.repo.briefs.create(brief());
  const linked = s.repo.watchlists.create(watchlist({ id: 'wl-2', mode: 'live_linked', sourceType: 'brief', sourceId: 'brf-1', updatedAt: NOW + 1, history: [audit('aud-w2', NOW + 1, 'watchlist_created', { mode: 'live_linked', sourceType: 'brief' })] }));
  assert.equal(linked.sourceId, 'brf-1');
  assert.equal(s.store.sqlite.prepare('SELECT brief_id, source_ref FROM dynamic_watchlists WHERE id = ?').get('wl-2').brief_id, 'brf-1');
  refused(() => s.repo.watchlists.create(watchlist({ id: 'wl-3', sourceType: 'brief', sourceId: 'brf-none' })), /sourceId names no brief/);
  s.repo.watchlists.create(watchlist({ id: 'wl-4', sourceId: 'search-7', updatedAt: NOW + 1 }));
  for (let i = 0; i < 3; i++) s.repo.watchlists.create(watchlist({ id: `wl-a${i}`, status: 'archived', updatedAt: NOW - 10 + i }));
  const p1 = s.repo.reads.watchlists.page(ORG.id, { limit: 2 });
  assert.deepEqual(p1.rows.map((w) => w.id), ['wl-2', 'wl-4', 'wl-1'], 'newest activity first, id as the tie-break; one row over the page');
  assert.equal(p1.total, 6);
  const p2 = s.repo.reads.watchlists.page(ORG.id, { limit: 2, after: [NOW + 1, 'wl-4'] });
  assert.deepEqual(p2.rows.map((w) => w.id), ['wl-1', 'wl-a2', 'wl-a1']);
  assert.deepEqual(s.repo.reads.watchlists.page(ORG.id, { status: 'archived' }).rows.map((w) => w.id), ['wl-a2', 'wl-a1', 'wl-a0']);
  assert.equal(s.repo.reads.watchlists.openCount(ORG.id), 3);
  const upd = s.repo.watchlists.update('wl-1', (d) => {
    d.name = 'Renamed'; d.status = 'archived'; d.rev = 2; d.revAt = NOW + 9; d.revBy = by; d.updatedAt = NOW + 9;
    d.history.push(audit('aud-w9', NOW + 9, 'watchlist_archived', { changed: ['name', 'status'], mode: 'snapshot', status: 'archived' }));
  });
  assert.deepEqual(upd.history[1].detail, { changed: ['name', 'status'], mode: 'snapshot', status: 'archived' });
  refused(() => s.repo.watchlists.update('wl-1', (d) => { d.lastReconciledAt = NOW; d.lastCriteriaVersion = 'cv1:x'; }), /cannot change/, 'only a reconciliation records its clock');
  refused(() => s.repo.watchlists.update('wl-1', (d) => { d.sourceId = 'other'; }), /sourceId cannot change/);
  s.close(); rm(dir);
});

test('[watchlists] a reconciliation replaces the membership, appends only unseen transitions and records its clock', () => {
  const { dir, s } = seeded('s12c-reconcile');
  const w = s.repo.watchlists.create(watchlist());
  assert.equal(s.repo.reads.watchlists.membership('wl-1'), null, 'never evaluated: no membership');
  const req0 = w.criteria.required.map((c) => ({ criterionId: c.id, met: true }));
  const first = [event(w, 'pl-a', 'entered', 'first_evaluation', NOW), event(w, 'pl-b', 'entered', 'first_evaluation', NOW)];
  const appended = s.repo.watchlists.reconcile('wl-1', { at: NOW, criteriaVersion: w.criteriaVersion, members: [{ playerId: 'pl-a', required: req0 }, { playerId: 'pl-b', required: req0 }], events: first });
  assert.equal(appended.length, 2);
  const m = s.repo.reads.watchlists.membership('wl-1');
  assert.deepEqual([...m.playerIds], ['pl-a', 'pl-b']); assert.deepEqual(plain(m.required.get('pl-a')), plain(req0));
  const after = s.repo.reads.watchlists.byId('wl-1');
  assert.equal(after.lastReconciledAt, NOW); assert.equal(after.lastCriteriaVersion, w.criteriaVersion); assert.equal(after.rev, 1, 'a reconciliation is not an edit');
  // The same transition observed again is one transition; a new one is appended.
  const again = s.repo.watchlists.reconcile('wl-1', { at: NOW + 5, criteriaVersion: w.criteriaVersion, members: [{ playerId: 'pl-a', required: req0 }], events: [event(w, 'pl-a', 'entered', 'first_evaluation', NOW + 5), event(w, 'pl-b', 'left', 'unavailable', NOW + 5, { text: 'This player is no longer available in this watchlist' })] });
  assert.deepEqual(again.map((e) => [e.playerId, e.transition]), [['pl-b', 'left']]);
  assert.deepEqual([...s.repo.reads.watchlists.membership('wl-1').playerIds], ['pl-a']);
  assert.deepEqual(s.repo.reads.events.lastBatch('wl-1').map((e) => e.playerId), ['pl-b']);
  const page = s.repo.reads.events.page('wl-1', { limit: 2 });
  assert.equal(page.total, 3); assert.equal(page.rows[0].transition, 'left', 'newest first');
  assert.deepEqual(s.repo.reads.events.forOrg(ORG.id, { from: NOW + 1 }).map((e) => e.playerId), ['pl-b']);
  refused(() => s.repo.watchlists.reconcile('wl-1', { at: NOW + 6, criteriaVersion: w.criteriaVersion, members: [], events: [event({ ...w, id: 'wl-other' }, 'pl-c', 'entered', 'newly_visible', NOW + 6)] }), /names another watchlist/);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- units, the db.* names, fixtures
test('[unit] a rolled-back unit leaves nothing', () => {
  const { dir, s } = seeded('s12c-unit');
  assert.throws(() => s.unit(() => { s.repo.briefs.create(brief()); s.repo.watchlists.create(watchlist()); throw new Error('boom'); }), /boom/);
  assert.equal(s.repo.reads.briefs.byId('brf-1'), null); assert.equal(s.repo.reads.watchlists.byId('wl-1'), null);
  s.close(); rm(dir);
});

test('[fixtures] a record written through the repository is typed, a missing reference is named, a refused write leaves nothing, and the records read back as written', () => {
  const dir = tempDir('s12c-fix');
  const w = watchlist();
  write(dir, fixtureDb({
    ...CASES_FIX(),
    recruitmentBriefs: [brief()], nobodyMissedReviews: [review()], secondLookItems: [item()],
    dynamicWatchlists: [{ ...w, lastReconciledAt: NOW, lastCriteriaVersion: w.criteriaVersion, members: [{ playerId: 'pl-a', required: [] }] }],
    watchlistHistory: [event(w, 'pl-a', 'entered', 'first_evaluation', NOW, { id: 'wlh-1' })],
  }));
  const back = readRecords(dir);
  assert.deepEqual(plain(back.recruitmentBriefs), [plain(brief())]);
  assert.deepEqual(back.dynamicWatchlists[0].members, [{ playerId: 'pl-a', required: [] }]);
  assert.deepEqual(back.watchlistHistory.map((e) => e.id), ['wlh-1']);
  // the mutual links read back as the literals: a case's requests and trials, a decision chain
  assert.deepEqual(back.recruitmentCases.map((c) => c.links), S8B_FIX().recruitmentCases.map((c) => plain(c.links)));
  assert.deepEqual(back.roomDecisions.map((d) => [d.id, d.supersedes, d.supersededById]), [['rdec-1', null, 'rdec-2'], ['rdec-2', 'rdec-1', null]]);
  refused(() => write(dir, { secondLookItems: [item({ id: 'slk-9', decisionId: 'rdec-none' })] }), /DISCOVERY_REFERENCE_MISSING.*rdec-none/);
  refused(() => write(dir, { secondLookItems: [item({ id: 'slk-8', triggerType: 'trust_change' })] }), /DISCOVERY_INPUT_INVALID.*triggerType/, 'the journey battery\'s old planted trigger is refused');
  refused(() => write(dir, { recruitmentBriefs: [brief()] }), /DISCOVERY_DUPLICATE.*brf-1/);
  assert.deepEqual(readRecords(dir).secondLookItems.map((i) => i.id), ['slk-1'], 'a refused write changed nothing');
  rm(dir);
});

console.log(`\n${passed} discovery checks passed`);
