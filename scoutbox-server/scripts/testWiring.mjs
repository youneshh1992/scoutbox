// The factories server.mjs wires together, tested on their own: each refuses to be built without what it needs (so a
// wiring mistake fails at boot, not on a request), and each does its one job. Covers the failed-login budget, live
// sync's delivery and staff-stream closing, moderation, the source-change clock, the player insights, the contract
// lookup, coach-reference views, the route helpers, and the write seams a domain offers the others.
// Run with: npm test
import assert from 'node:assert/strict';
import { createLoginBudget, createSessionAccess, devLoginRefused } from '../domains/identity/sessions.mjs';
import { createLiveSync } from '../domains/platform/liveSync.mjs';
import { createModeration } from '../domains/safety/moderation.mjs';
import { createSourceChanges } from '../domains/platform/sourceChanges.mjs';
import { createInsights } from '../domains/discovery/insights.mjs';
import { createContractLookup } from '../domains/recruitment/signings/contract.mjs';
import { createActivity } from '../domains/development/activity.mjs';
import {
  createGuardianRecord,
  createOrgRecord,
  createPlayerRecord,
  createSessionEnds,
  createStaffRecord,
} from '../domains/identity/index.mjs';
import { createScoutingActs } from '../domains/scouting/index.mjs';
import { createRecruitmentActs } from '../domains/recruitment/index.mjs';
import { createCoachReferences } from '../domains/verification/index.mjs';
import { createVouchReads, vouchView } from '../domains/verification/vouches.mjs';
import { installSignedMedia } from '../domains/media/signedMedia.mjs';
import { registerCapabilities } from '../domains/platform/operator.mjs';
import { buildRouteHelpers } from '../domains/platform/routeHelpers.mjs';
import { createRateLimiter } from '../domains/platform/rateLimit.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const resStub = () => {
  const r = {
    code: null,
    body: null,
    status(c) {
      r.code = c;
      return r;
    },
    json(b) {
      r.body = b;
      return r;
    },
  };
  return r;
};

test('every factory refuses to be built without its dependencies', () => {
  assert.throws(() => createLoginBudget({}), /needs the rate limiter/);
  assert.throws(() => createSessionAccess({}), /needs the sessions repository/);
  assert.throws(() => createLiveSync({ app: {} }), /createLiveSync needs findPlayer/);
  assert.throws(() => createModeration({}), /needs the safety-audit repository/);
  assert.throws(() => createSourceChanges({}), /needs the safety-audit repository/);
  assert.throws(() => createInsights({}), /needs the ledger reads/);
  assert.throws(() => createContractLookup({}), /needs the signings repository/);
  assert.throws(() => createActivity({}), /needs the players' reads, the identity domain's playerRecord/);
  assert.throws(() => createVouchReads({}), /needs the coach-reference reads/);
  assert.throws(() => installSignedMedia({ app: {} }), /installSignedMedia needs/);
  assert.throws(() => registerCapabilities({ app: {} }), /needs the Box Cam provider status/);
});

// A stand-in repository that records every call made on it, at any depth; a list query answers `answer`.
const recorder = (calls, answer = [], at = []) =>
  new Proxy(() => {}, {
    get: (_t, key) => recorder(calls, answer, [...at, key]),
    apply: (_t, _this, args) => {
      calls.push([at.join('.'), ...args]);
      return at.at(-1) === 'forOrgPlayer' ? answer : undefined;
    },
  });

test("the write seams: each refuses to be built without the owner's repository, is frozen, and writes only through the act it names", () => {
  for (const [make, name] of [
    [createPlayerRecord, 'createPlayerRecord: missing players'],
    [createGuardianRecord, 'createGuardianRecord: missing guardians'],
    [createOrgRecord, 'createOrgRecord: missing orgs'],
    [createStaffRecord, 'createStaffRecord: missing users'],
    [createSessionEnds, 'createSessionEnds: missing sessions'],
    [createScoutingActs, 'createScoutingActs: missing clubSetup, opportunitiesCampaigns, nextId'],
    [createRecruitmentActs, 'createRecruitmentActs: missing recruitment'],
    [createCoachReferences, 'createCoachReferences: missing transitionsVouches'],
  ])
    assert.throws(() => make({}), new RegExp(name));
  assert.throws(() => createPlayerRecord({ players: {}, users: {} }), /not declared: users/);

  const calls = [];
  const playerRecord = createPlayerRecord({ players: recorder(calls) });
  assert.ok(Object.isFrozen(playerRecord));
  for (const write of [
    'create',
    'erase',
    'ageUp',
    'setPasswordHash',
    'setEmailCodeHash',
    'addItem',
    'setItems',
    'patchItem',
  ])
    assert.equal(write in playerRecord, false, `another domain cannot ${write} a player`);
  playerRecord.annotateMedia('pl-1', 'md-1', { views: 3 });
  playerRecord.awardBadge('pl-1', 'First goal');
  playerRecord.recordAttendance('pl-1', { id: 'att-1' });
  playerRecord.recordSigning('pl-1', {
    level: 'pro',
    contractStatus: 'contracted',
    availability: 'not_available',
    timeline: [{ year: 2026, event: 'Signed' }],
  });
  assert.deepEqual(calls, [
    ['patchItem', 'pl-1', 'media', { id: 'md-1' }, { views: 3 }],
    ['addItem', 'pl-1', 'badges', 'First goal'],
    ['addItem', 'pl-1', 'attendance', { id: 'att-1' }],
    ['setLevel', 'pl-1', 'pro'],
    ['setAvailability', 'pl-1', { contractStatus: 'contracted', availability: 'not_available' }],
    ['addItem', 'pl-1', 'timeline', { year: 2026, event: 'Signed' }],
  ]);

  calls.length = 0;
  const staffRecord = createStaffRecord({ users: recorder(calls) });
  assert.equal(
    'setRole' in staffRecord || 'useRecoveryCode' in staffRecord,
    false,
    "a staff member's role and recovery codes stay identity's",
  );
  createOrgRecord({ orgs: recorder(calls) }).suspend('org-1');
  createSessionEnds({ sessions: recorder(calls) }).endAllFor('ts_reviewer', 'rev-1');
  assert.equal('create' in createSessionEnds({ sessions: {} }), false, 'only the identity domain mints a session');
  assert.deepEqual(calls, [
    ['setStanding', 'org-1', { suspended: true }],
    ['revokeFor', 'ts_reviewer', 'rev-1'],
  ]);
});

test('the club setup seam: joining a squad the player is already on writes nothing; a new member gets an id and a bounded name', () => {
  const rows = [];
  const clubSetup = {
    squad: {
      has: (orgId, playerId) => rows.some((r) => r.orgId === orgId && r.playerId === playerId),
      create: (r) => rows.push(r),
    },
  };
  const { joinSquad } = createScoutingActs({ clubSetup, opportunitiesCampaigns: {}, nextId: (p) => `${p}-1` });
  joinSquad({ orgId: 'org-1', playerId: 'pl-1', name: 'x'.repeat(500), source: 'signing', at: 5 });
  joinSquad({ orgId: 'org-1', playerId: 'pl-1', name: 'Again', source: 'signing', at: 6 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'sq-1');
  assert.ok(rows[0].name.length < 500);
  assert.equal('approvedBy' in rows[0], false);
});

test("the recruitment seam: a safeguarding suspension suspends only the player's pending requests from that club", () => {
  const calls = [];
  const requests = [
    { id: 'rq-1', status: 'pending' },
    { id: 'rq-2', status: 'accepted' },
    { id: 'rq-3', status: 'pending' },
  ];
  createRecruitmentActs({ recruitment: recorder(calls, requests) }).suspendPendingRequests('org-1', 'pl-1');
  assert.deepEqual(calls, [
    ['requests.forOrgPlayer', 'org-1', 'pl-1'],
    ['requests.suspend', 'rq-1'],
    ['requests.suspend', 'rq-3'],
  ]);
});

test('the failed-login budget: one bucket per trimmed, lower-cased identifier; only failures charge it; a locked identifier answers 429', () => {
  const { loginKey, loginLockedOut, noteLoginFailure } = createLoginBudget({ rateLimit: createRateLimiter() });
  assert.equal(loginKey('  Maria@Club.example '), 'maria@club.example');
  assert.equal(loginKey(''), 'unknown');
  assert.equal(loginLockedOut(resStub(), 'maria'), false, 'a fresh identifier is not locked');
  for (let i = 0; i < 200 && !loginLockedOut(resStub(), 'maria'); i++) noteLoginFailure('MARIA');
  const res = resStub();
  assert.equal(loginLockedOut(res, ' maria '), true, 'enough failures lock the identifier, whatever its case');
  assert.equal(res.code, 429);
  assert.equal(loginLockedOut(resStub(), 'someone-else'), false, 'another identifier is untouched');
  const refused = resStub();
  assert.equal(devLoginRefused(refused), true);
  assert.equal(refused.code, 403);
  assert.equal(refused.body.error, 'DEV_LOGIN_DISABLED');
});

test("live sync: a player event reaches its player's stream only; an org-private event only that org's; closing a staff member's streams ends them", () => {
  const routes = {};
  const app = {
    get: (p, h) => {
      routes[`GET ${p}`] = h;
    },
    post: (p, h) => {
      routes[`POST ${p}`] = h;
    },
  };
  const sessionsBySid = {
    sp: { sid: 'sp', kind: 'player', refId: 'pl-1' },
    so: { sid: 'so', kind: 'org', refId: 'org-1', userId: 'usr-1' },
  };
  let tick = 0;
  const live = createLiveSync({
    app,
    store: { inUnitOfWork: () => false },
    sessions: { bySid: (sid) => sessionsBySid[sid] ?? null },
    byId: {
      org: (id) => (id === 'org-1' ? { id, suspended: false } : null),
      user: (id) => ({ id }),
      guardian: () => null,
    },
    users: { byId: () => null },
    channels: { parties: () => null },
    findPlayer: (id) => (id === 'pl-1' ? { id, guardianId: null } : null),
    isBlocked: () => false,
    sessionFor: (req) => sessionsBySid[req.sid] ?? null,
    newToken: () => `tkt-${++tick}`,
  });
  const closers = [];
  const open = (sid) => {
    const t = resStub();
    routes['POST /events/ticket']({ sid }, t);
    const frames = [];
    let ended = false;
    const res = {
      set() {},
      flushHeaders() {},
      write: (f) => frames.push(f),
      end: () => {
        ended = true;
      },
    };
    let onClose = null;
    routes['GET /events'](
      {
        query: { ticket: t.body.ticket },
        headers: {},
        on: (_e, fn) => {
          onClose = fn;
        },
      },
      res,
    );
    closers.push(() => onClose?.());
    return { frames, ended: () => ended };
  };
  const player = open('sp');
  const org = open('so');
  live.publishEvent('ledger', { playerId: 'pl-1', orgId: 'org-1' });
  assert.equal(player.frames.length, 1, "connected only: the org-private event is not the player's");
  assert.equal(org.frames.length, 2, "the org's own stream got it");
  live.publishEvent('players', { playerId: 'pl-1' });
  assert.equal(player.frames.length, 2, "the player's own event reached them");
  assert.equal(org.frames.length, 2, 'a club the player is not visible to does not hear about them');
  live.closeStreamsOf('usr-1');
  assert.equal(org.ended(), true, "the staff member's stream was ended");
  live.publishEvent('ledger', { playerId: 'pl-1', orgId: 'org-1' });
  assert.equal(org.frames.length, 2, 'nothing more is written to a closed stream');
  assert.throws(
    () => live.broadcast('not_an_event', {}),
    /not in the event registry/,
    'an unregistered event fails loudly outside production',
  );
  for (const close of closers) close(); // the client disconnects: its keep-alive ping stops
});

test('moderation: clean text passes; a hit is logged in a unit and refused with MODERATION_BLOCKED', () => {
  const logged = [];
  const reports = [];
  let units = 0;
  const moderateOrRefuse = createModeration({
    safetyAudit: { moderationLog: { record: (r) => logged.push(r) }, reports: { file: (r) => reports.push(r) } },
    unit: (w) => {
      units++;
      return w();
    },
    nextId: (p) => `${p}-1`,
  });
  assert.equal(moderateOrRefuse(resStub(), 'See you at training on Saturday', { kind: 'message' }), true);
  const res = resStub();
  assert.equal(moderateOrRefuse(res, 'text me on 07700 900123', { kind: 'message', orgId: 'org-1' }), false);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'MODERATION_BLOCKED');
  assert.equal(logged.length, 1);
  assert.equal(units, 1);
});

test('source changes: a change is recorded with the clock it is given, and refused without a player, type or source', () => {
  const rows = [];
  const { recordSourceChange, sourceChangesFor } = createSourceChanges({
    nextId: (p) => `${p}-${rows.length + 1}`,
    safetyAudit: {
      sourceChanges: {
        record: (r) => {
          rows.push(r);
          return r;
        },
        forPlayer: (id) => rows.filter((r) => r.playerId === id),
      },
    },
  });
  assert.equal(
    recordSourceChange({ playerId: 'pl-1', type: 'position_changed' }),
    null,
    'no source system: nothing recorded',
  );
  const row = recordSourceChange({
    playerId: 'pl-1',
    type: 'position_changed',
    sourceSystem: 'passport',
    occurredAt: 1234,
  });
  assert.equal(row.occurredAt, 1234);
  assert.equal(row.sourceId, null);
  assert.deepEqual(
    sourceChangesFor('pl-1').map((r) => r.id),
    ['srcc-1'],
  );
});

test('insights: views, saves and requests are counted per club and per week from the ledger rows', () => {
  const now = Date.now();
  const rows = [
    { type: 'view', orgName: 'A', scoutName: 's', ts: now - 1000 },
    { type: 'save', orgName: 'A', scoutName: 's', ts: now - 2000 },
    { type: 'contact_request', orgName: 'B', scoutName: 't', ts: now - 40 * 86_400_000 },
  ];
  const out = createInsights({ ledger: { forPlayer: () => rows } })('pl-1');
  assert.deepEqual(out.thisWeek, { views: 1, saves: 1, shortlists: 0 });
  assert.equal(out.weeklySeries.length, 8);
  assert.equal(out.weeklySeries[7], 1);
  assert.deepEqual(
    out.byOrg.map((o) => [o.orgName, o.requests]),
    [
      ['A', 0],
      ['B', 1],
    ],
  );
});

test("the canonical contract: only a completed package's own signing counts, not a cancelled one, an expired one or the excepted club's", () => {
  const signings = [
    { id: 's-cancel', signingPackageId: 'pk-1', orgId: 'org-1', cancelledAt: 1 },
    { id: 's-old', signingPackageId: 'pk-2', orgId: 'org-1', contract: { endDate: '2000-01-01' } },
    { id: 's-live', signingPackageId: 'pk-3', orgId: 'org-2', contract: { endDate: '2999-01-01' } },
  ];
  const pkgs = {
    'pk-1': { status: 'COMPLETED', completion: { signingId: 's-cancel' } },
    'pk-2': { status: 'COMPLETED', completion: { signingId: 's-old' } },
    'pk-3': { id: 'pk-3', status: 'COMPLETED', completion: { signingId: 's-live' } },
  };
  const lookup = createContractLookup({
    signingsFollowUps: { signings: { forPlayer: () => signings }, signingPackages: { byId: (id) => pkgs[id] ?? null } },
  });
  assert.equal(lookup('pl-1')?.signing.id, 's-live');
  assert.equal(lookup('pl-1', Date.now(), { exceptOrgId: 'org-2' }), null);
});

test('coach references are served from an allowlist: no e-mail, no code', () => {
  const v = vouchView({
    id: 'v1',
    coachName: 'Coach',
    coachEmail: 'c@x.example',
    code: '123456',
    status: 'published',
    withdrawn: null,
  });
  assert.equal('coachEmail' in v, false);
  assert.equal('code' in v, false);
  assert.equal(v.coachName, 'Coach');
});

test('route helpers: one bag for every module, with the lead gate, the small-group rule and history entries', () => {
  const h = buildRouteHelpers({ nextId: () => 'aud-1', isBlocked: () => false });
  const res = resStub();
  assert.equal(h.requireLead({ orgUser: { role: 'Scout' } }, res), false);
  assert.equal(res.code, 403);
  assert.equal(h.requireLead({ orgUser: { role: 'Head of Recruitment' } }, resStub()), true);
  assert.equal(h.suppress(2), true);
  assert.equal(h.suppress(3), false);
  const rec = {};
  h.histAppend(rec, 'org_user', 'usr-1', 'Maria', 'created');
  assert.deepEqual(
    rec.history.map((e) => [e.id, e.action]),
    [['aud-1', 'created']],
  );
});

console.log(`wiring: ${passed} checks passed`);
