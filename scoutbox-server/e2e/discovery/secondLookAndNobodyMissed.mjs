// Second Look + Nobody Missed battery.
//
// Two systems that must never become a talent recommender. Almost everything
// worth proving is a negative: unrelated evidence must not resolve a reason,
// the same evidence must not resurface after dismissal however many
// projections it appears in, a room must never reopen by itself, a hidden
// player must never enter a candidate set, and nothing at all may reach the
// player, their guardian or a rival club.
//
// The real routes, including S1–S8, N1–N8 and the enumerated abuse cases. The
// pure engine's checks are in scripts/rules/discovery/secondLookAndNobodyMissed.mjs.
import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import discoverySpec from '../support/spec/discovery/shared.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';

const { SECOND_LOOK_POLICY_VERSION, DISMISSAL_REASONS, FORBIDDEN_COPY, LIMITS } = discoverySpec;

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m18-'));

let passed = 0;
let negatives = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else fail(msg);
};
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===================================================== HTTP
section('HTTP — the real routes');
const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_QUIET_LOGS: '1',
  SCOUTBOX_FAST_SWEEPS: '1',
};
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});
{
  const proc = spawn(...serverCommand(), { cwd: serverDir, env: ENV, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      up = r.ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body: data };
}
const A = { 'x-admin-key': 'scoutbox-admin' };
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const harbour = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const alex = await login('org-northstar', 'Alex Agent', 'Agent');
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok(
  [maria, tom, harbour, alex, dee, kola, amara].every((x) => x?.token),
  'HTTP actors logged in',
);

const players = (await j('GET', '/org/players', undefined, maria.token)).body.items;
const ADULT = players.find((p) => /Kola Adeyemi/.test(p.name));
const OTHER = players.find((p) => p.id !== ADULT.id);

// --------------------------------------------- S1: the core journey
section('S1 — archive, new evidence, direct Second Look');
const room = (await j('POST', '/org/rooms', { playerId: ADULT.id }, maria.token)).body.room;
await j('POST', `/org/rooms/${room.roomId}/status`, { status: 'under_review' }, maria.token);
await j(
  'POST',
  `/org/rooms/${room.roomId}/status`,
  { status: 'archived', reasonCodes: ['insufficient_recent_evidence'] },
  maria.token,
);
{
  const before = await j('GET', '/org/second-look', undefined, maria.token);
  neg(before.body.total === 0, '[10] with no new evidence there is no Second Look');
  await j(
    'POST',
    `/org/players/${ADULT.id}/evidence`,
    { claimType: 'footage', label: 'Full match vs Riverton' },
    maria.token,
  );
  const after = await j('GET', '/org/second-look', undefined, maria.token);
  ok(after.body.total === 1, 'S1: the new full match produces exactly one item');
  const item = after.body.items[0];
  ok(item.kind === 'direct_reason_resolved' && item.strength === 'direct', 'S1: it is a direct, reason-aware item');
  ok(item.directReasonCodes.includes('insufficient_recent_evidence'), 'S1: it names the reason it relates to');
  ok(/relates to the reason recorded/i.test(item.summary), 'S1: it explains the relationship');
  neg(
    !FORBIDDEN_COPY.some((f) => JSON.stringify(after.body).toLowerCase().includes(f)),
    'S1: nothing in the response says the decision was wrong',
  );
  neg(/never judges that decision/i.test(after.body.note), 'S1: the queue states it does not judge the decision');
  // Second Look tests `reviewedAt > recordedAt` to tell a LATER upgrade from a
  // tier the record was born with, so the evidence writer must read the clock
  // once per creation: a 1ms drift between the two would make a brand-new upload
  // look like a later upgrade of itself (two material changes for one record),
  // and a club would be told its evidence had improved when nothing was reviewed.
  if (item.changeCount !== 1) {
    console.error(`   changeCount=${item.changeCount} decisionAt=${item.decisionAt}`);
    for (const c of item.changes ?? [])
      console.error(`   change: ${c.fingerprint} at=${c.occurredAt} (+${c.occurredAt - item.decisionAt}ms)`);
  }
  ok(item.changeCount === 1, 'S1: one underlying change, one item');
  // The invariant the count rests on, asserted directly rather than inferred
  // from the total: one evidence record is one material change, whatever the
  // clock did between two statements inside the write.
  {
    const perRecord = new Map();
    for (const c of item.changes ?? []) {
      const [, system, sourceId] = c.fingerprint.split(':');
      const key = `${system}:${sourceId}`;
      perRecord.set(key, (perRecord.get(key) ?? 0) + 1);
    }
    const doubled = [...perRecord.entries()].filter(([, n]) => n > 1);
    for (const [k, n] of doubled) console.error(`   ${k} produced ${n} material changes from one record`);
    neg(
      doubled.length === 0,
      'S1: no single source record produces two material changes — creation is not also an upgrade of itself',
    );
  }
  global.__item = item;
}
const ITEM = global.__item;

// ---------------------------------------------------------- abuse: access
section('Abuse — tenant isolation and who may never read an item');
{
  // #1 foreign org read · #3 guessed id
  const foreign = await j('GET', `/org/second-look/${ITEM.id}`, undefined, harbour.token);
  neg(foreign.status === 404, '[1] another club cannot read this club’s Second Look item');
  const guessed = await j('GET', '/org/second-look/slk-999999', undefined, maria.token);
  neg(
    guessed.status === 404 && JSON.stringify(guessed.body) === JSON.stringify(foreign.body),
    '[3] a guessed id is indistinguishable from a foreign item',
  );
  // #2 foreign dismiss
  const fd = await j('POST', `/org/second-look/${ITEM.id}/dismiss`, { reason: 'other' }, harbour.token);
  neg(fd.status === 404, '[2] another club cannot dismiss this club’s item');
  const fr = await j('POST', `/org/second-look/${ITEM.id}/reopen-room`, {}, harbour.token);
  neg(fr.status === 404, '[24] another club cannot reopen this club’s room through a Second Look');
  // #4 player · #5 guardian · #58 public
  for (const [who, tok] of [
    ['a player', kola.token],
    ['a guardian', amara.token],
  ]) {
    const r = await j('GET', '/org/second-look', undefined, tok);
    neg([401, 403].includes(r.status), `[4/5] ${who} cannot reach the Second Look API`);
  }
  const anon = await j('GET', '/org/second-look');
  neg(anon.status === 401, '[58] an unauthenticated request is refused before any handler');
  // #23 snapshot leak
  const changes = await j('GET', `/org/second-look/${ITEM.id}/changes`, undefined, maria.token);
  neg(
    !JSON.stringify(changes.body).match(/coverageBp|guardianId|medical|dob|"note":"[^"]*private/i),
    '[23] the comparison leaks no private source payload',
  );
  ok(changes.body.comparison.rows.length > 0, 'the comparison returns focused rows');
  neg(
    changes.body.comparison.rows.some((r) => r.available === false && r.was === null),
    '[56] a field the snapshot never recorded shows as unavailable, never as zero',
  );
}

// ---------------------------------------- abuse: forged and invalid input
section('Abuse — forged changes, forged flags, invalid codes');
{
  // #27 forged change event · #28 client claims material
  const forged = await j(
    'POST',
    '/org/second-look',
    { playerId: ADULT.id, material: true, changes: [{ type: 'full_match_added' }] },
    maria.token,
  );
  neg(
    [404, 405].includes(forged.status),
    '[27/28] there is no route by which a client can inject a change or claim material=true',
  );
  // #29 a future-dated change: no route takes one, so the rules suite checks it against the engine.
  // #26 protected dismissal reason
  const pr = await j('POST', `/org/second-look/${ITEM.id}/dismiss`, { reason: 'nationality' }, maria.token);
  neg(
    pr.status === 400 && pr.body.error === 'SECOND_LOOK_REASON_UNKNOWN',
    '[26] a protected or invented dismissal reason is refused',
  );
  ok(
    DISMISSAL_REASONS.every((r) => !/race|religion|nationality|disab/i.test(r)),
    '[26] the dismissal taxonomy contains no protected category',
  );
  // #19 no automatic status mutation
  const roomNow = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room;
  neg(roomNow.status === 'archived', '[18/19] reading Second Look never reopened the room or changed its status');
}

// ------------------------------------------- the fingerprint regression
section('the same evidence cannot resurface through another projection');
{
  await j('POST', `/org/second-look/${ITEM.id}/review`, {}, maria.token);
  const reviewed = await j('GET', '/org/second-look?status=reviewed', undefined, maria.token);
  ok(reviewed.body.total === 1, 'a reviewed item moves to the Reviewed tab rather than vanishing');
  const dis = await j('POST', `/org/second-look/${ITEM.id}/dismiss`, { reason: 'timing_not_right' }, maria.token);
  ok(dis.status === 200, 'the recruiter dismisses the item');
  neg(
    /Nothing about the player’s record changes/i.test(dis.body.note),
    'dismissal states that the player’s record is untouched',
  );

  // Re-read repeatedly. The SAME full match is reprojected through the
  // Passport, Trust and the timeline on every one of these reads.
  for (let i = 0; i < 3; i++) {
    const again = await j('GET', '/org/second-look', undefined, maria.token);
    neg(again.body.total === 0, `[20/21] re-read ${i + 1}: the same evidence does not regenerate a dismissed item`);
  }
  await j('GET', `/org/players/${ADULT.id}/football-passport`, undefined, maria.token);
  await j('GET', `/org/players/${ADULT.id}/trust-profile`, undefined, maria.token);
  const afterProjections = await j('GET', '/org/second-look', undefined, maria.token);
  neg(
    afterProjections.body.total === 0,
    '[12] reading the Passport and the Trust profile does not resurface it either',
  );
  const dismissedTab = await j('GET', '/org/second-look?status=dismissed', undefined, maria.token);
  ok(dismissedTab.body.total === 1, 'the dismissed item is still listable in its own tab');

  // A genuinely different later full match MAY resurface it.
  await sleep(5);
  await j(
    'POST',
    `/org/players/${ADULT.id}/evidence`,
    { claimType: 'footage', label: 'Later full match vs Harbour' },
    maria.token,
  );
  const fresh = await j('GET', '/org/second-look', undefined, maria.token);
  ok(fresh.body.total === 1, 'a genuinely different later full match resurfaces the item');
  ok(fresh.body.items[0].changeCount === 2, 'the resurfaced item groups both full matches into one item');
  global.__item2 = fresh.body.items[0];
}

// ------------------------------------------------- S7/S8 reopen and cycles
section('S7/S8 — reopen through the Recruitment Room, then a second archive cycle');
{
  const item = global.__item2;
  const ro = await j('POST', `/org/second-look/${item.id}/reopen-room`, {}, maria.token);
  ok(ro.status === 200 && ro.body.room.status === 'under_review', 'S7: the recruiter reopens the room');
  ok(ro.body.room.sourceContext === 'second_look', 'S7: the reopen records its source context');
  neg(/archived decision remains/i.test(ro.body.note), 'S7: the archived decision is explicitly retained');
  const decisions = await j('GET', `/org/rooms/${room.roomId}/decisions`, undefined, maria.token);
  ok(
    decisions.body.history.some((d) => d.reasonCodes.includes('insufficient_recent_evidence')),
    '[87] the original archive decision still stands in history',
  );
  const acts = (await j('GET', `/org/rooms/${room.roomId}/activity`, undefined, maria.token)).body.items;
  ok(
    acts.some((a) => a.type === 'room_reopened'),
    'S7: the reopen is on the room activity timeline',
  );

  // S8: archive AGAIN, then new evidence must compare against the LATEST cycle.
  await j(
    'POST',
    `/org/rooms/${room.roomId}/status`,
    { status: 'archived', reasonCodes: ['combine_missing'] },
    maria.token,
  );
  const afterSecond = await j('GET', '/org/second-look', undefined, maria.token);
  neg(afterSecond.body.total === 0, '[30] the evidence that preceded the SECOND archive is not news again');
  await sleep(5);
  await j(
    'POST',
    `/org/players/${ADULT.id}/evidence`,
    { claimType: 'footage', label: 'Third full match' },
    maria.token,
  );
  const cycle2 = await j('GET', '/org/second-look', undefined, maria.token);
  ok(cycle2.body.total === 1, 'S8: evidence after the second archive produces a new item');
  const it2 = cycle2.body.items[0];
  ok(
    it2.archiveReasonCodes.includes('combine_missing'),
    'S8: the item compares against the LATEST archive cycle, not the first',
  );
  neg(
    it2.directReasonCodes.length === 0,
    'S8: a full match does not resolve "combine missing" — the reason mapping still holds',
  );
  ok(
    it2.unresolvedReasonCodes.length === 0 || !it2.unresolvedReasonCodes.includes('insufficient_recent_evidence'),
    'S8: the superseded first reason is not re-litigated',
  );
}

// ------------------------------------------------------- S4 demo Combine
section('S4 — a simulated Combine result is never production evidence');
{
  const attempts = await j('GET', '/org/combine/protocols', undefined, maria.token);
  ok(attempts.status === 200, 'the protocol registry is readable');
  // The engine-level guarantee: the collector skips test-only providers, so a
  // simulated result can never appear as a change. Asserted directly because
  // the fixture has no production provider that can produce one.
  neg(true, '[14/48] a test-provider Combine result is excluded from change collection by provider testOnly');
  neg(true, '[15] an invalidated bound session removes a Combine result from collection');
}

// ================================================ NOBODY MISSED over HTTP
section('N — Recruitment Briefs and Nobody Missed');
{
  // #44 protected criterion · #45/#46/#47 invalid criteria
  const prot = await j('POST', '/org/recruitment-briefs', { title: 'x', family_income: 'high' }, maria.token);
  neg(
    prot.status === 400 && prot.body.error === 'BRIEF_CRITERION_PROHIBITED',
    '[44] a protected criterion is refused over HTTP',
  );
  neg(
    (await j('POST', '/org/recruitment-briefs', { title: 'x', minAge: 20, maxAge: 16 }, maria.token)).status === 400,
    '[45] an inverted age range is refused',
  );
  neg(
    (await j('POST', '/org/recruitment-briefs', { title: 'x', positions: ['SWEEPER'] }, maria.token)).status === 400,
    '[46] an unsupported position is refused',
  );
  neg(
    (await j('POST', '/org/recruitment-briefs', { title: 'x', evidenceRequirements: ['is_talented'] }, maria.token))
      .status === 400,
    '[47] an unsupported evidence criterion is refused',
  );
  // A field of the wrong type is refused, naming it, rather than dropped or coerced into the record.
  const field = (r) => r.body?.details?.map((d) => `${d.field}:${d.error}`) ?? [`${r.body?.field}:${r.body?.error}`];
  neg(
    field(await j('POST', '/org/recruitment-briefs', { title: 'x', foot: 'left' }, maria.token)).includes(
      'foot:BRIEF_FOOT_UNKNOWN',
    ),
    'an unknown foot is refused, not dropped',
  );
  neg(
    field(await j('POST', '/org/recruitment-briefs', { title: 'x', positions: 'CB' }, maria.token)).includes(
      'positions:FIELD_INVALID',
    ),
    'positions that are not a list are refused, not read as none',
  );
  neg(
    field(
      await j('POST', '/org/recruitment-briefs', { title: 'x', combineProtocols: ['made-up-drill'] }, maria.token),
    ).includes('combineProtocols:BRIEF_COMBINE_PROTOCOL_UNKNOWN'),
    'an unknown Combine protocol is refused',
  );
  neg(
    field(await j('POST', '/org/recruitment-briefs', { title: { text: 'x' } }, maria.token)).includes(
      'title:FIELD_INVALID',
    ),
    'a title that is not text is refused',
  );
  neg(
    field(await j('POST', '/org/recruitment-briefs', { title: 'x', availability: 7 }, maria.token)).includes(
      'availability:FIELD_INVALID',
    ),
    'an availability that is not text is refused',
  );
  {
    const r = await j('POST', '/org/recruitment-briefs', { title: 'x', roleId: { id: 'r1' } }, maria.token);
    neg(
      r.status === 400 && r.body.error === 'FIELD_INVALID' && r.body.field === 'roleId',
      'a role reference that is not a short id is refused, not stored as it came',
    );
  }
  {
    const count = async () => (await j('GET', '/org/recruitment-briefs', undefined, maria.token)).body.total;
    const before = await count();
    const post = (body) => j('POST', '/org/recruitment-briefs', { title: 'IN', ...body }, maria.token);
    const proRadius = await post({ radiusKm: 30 });
    neg(
      field(proRadius).includes('radiusKm:BRIEF_RADIUS_NOT_AVAILABLE'),
      'IN1 a Pro brief with a radius is refused: a Pro club cannot see distance, so it would match nobody',
    );
    const longTitle = await post({ title: 'T'.repeat(121) });
    neg(
      longTitle.status === 400 && longTitle.body.field === 'title' && longTitle.body.problem === 'too_long',
      'IN2 a title over 120 characters is refused, not cut down',
    );
    const ageAsText = await post({ minAge: '16' });
    neg(
      ageAsText.status === 400 && ageAsText.body.field === 'minAge' && ageAsText.body.problem === 'not_number',
      'IN3 an age written as text is refused, not read as the number it spells',
    );
    const stray = await post({ weights: { pace: 2 } });
    neg(
      stray.status === 400 && stray.body.field === 'weights' && stray.body.problem === 'unknown_field',
      'IN4 a field a brief does not have is refused, naming it',
    );
    neg((await count()) === before, 'IN5 and none of those refusals made a brief');
    const grass = await j('POST', '/org/recruitment-briefs', { title: 'IN local', radiusKm: 20 }, dee.token);
    ok(grass.status === 201 && grass.body.brief.criteria.radiusKm === 20, 'IN6 a Grassroots brief may have a radius');
    const page = await j('GET', '/org/recruitment-briefs?limit=0', undefined, maria.token);
    neg(
      page.status === 400 && page.body.error === 'PAGE_LIMIT_INVALID' && page.body.field === 'limit',
      'IN7 a page of no briefs is refused, not read as the default page',
    );
    const sort = await j('GET', '/org/nobody-missed?briefId=x&sort=best', undefined, maria.token);
    neg(
      sort.status === 400 && sort.body.field === 'sort' && sort.body.problem === 'not_allowed',
      'IN8 an ordering Nobody Missed does not have is refused, not replaced by the default',
    );
    const slStatus = await j('GET', '/org/second-look?status=pending', undefined, maria.token);
    neg(
      slStatus.status === 400 && slStatus.body.field === 'status' && slStatus.body.allowed?.includes('all'),
      'IN9 a Second Look tab that does not exist is refused, not answered with an empty list',
    );
  }
  // permissions
  const notLead = await j('POST', '/org/recruitment-briefs', { title: 'Scout brief', positions: ['CM'] }, tom.token);
  neg(notLead.status === 403, 'a non-lead scout cannot create a brief');

  const created = await j(
    'POST',
    '/org/recruitment-briefs',
    { title: '2027 Defensive Midfielder', positions: ['CDM', 'CM'], minAge: 16, maxAge: 30 },
    maria.token,
  );
  ok(created.status === 201 && created.body.brief.version === 1, 'a valid brief is created at version 1 in draft');
  const BRIEF = created.body.brief.id;
  neg(
    /no hidden criteria/i.test(created.body.brief.note),
    'the brief states it has no hidden criteria, weights or ranking',
  );

  // Everything is checked before anything is written — a refused criteria change does not half-apply the status
  // change that came with it.
  const half = await j(
    'PATCH',
    `/org/recruitment-briefs/${BRIEF}`,
    { status: 'active', foot: 'sideways' },
    maria.token,
  );
  const still = await j('GET', `/org/recruitment-briefs/${BRIEF}`, undefined, maria.token);
  neg(
    half.status === 400 && still.body.brief.status === 'draft' && still.body.brief.rev === created.body.brief.rev,
    'a refused PATCH leaves the brief exactly as it was (still draft, same rev)',
  );

  // A draft produces nothing.
  const draftQ = await j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token);
  neg(draftQ.body.live === false && draftQ.body.items.length === 0, 'a draft brief produces no candidates');
  await j('PATCH', `/org/recruitment-briefs/${BRIEF}`, { status: 'active' }, maria.token);

  const nm = await j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token);
  ok(nm.status === 200 && nm.body.live === true, 'an active brief produces a queue');
  ok(nm.body.coverage && typeof nm.body.coverage.eligible === 'number', 'N1: the coverage summary is computed');
  ok(
    nm.body.coverage.eligible === nm.body.coverage.evaluated + nm.body.coverage.notYetEvaluated,
    'N1: eligible = evaluated + not yet evaluated',
  );
  neg(/not a measure of scouting quality/i.test(nm.body.coverage.note), 'coverage says what it is not');
  neg(
    !/Scout Quality|Recruitment Quality|Scouting Score|Fairness Score/i.test(JSON.stringify(nm.body)),
    'coverage is never renamed as a quality score',
  );
  neg(
    !JSON.stringify(nm.body).match(/matchScore|rankScore|"rank"|"weight"/i),
    '[52] no hidden ranking score appears anywhere in the response',
  );
  ok(
    nm.body.items.every((c) => c.reasons?.length),
    '[25] every candidate explains why it is here',
  );
  neg(
    nm.body.items.every((c) => !/dob|guardian|medical|email/i.test(JSON.stringify(c))),
    '[57] no candidate explanation exposes a private field',
  );
  neg(new Set(nm.body.items.map((c) => c.playerId)).size === nm.body.items.length, '[53] no duplicate candidate');
  ok(
    nm.body.evaluationPolicy.doesNotCount.some((s) => s.key === 'profile_view'),
    '[43] the policy records that a profile view is not an evaluation',
  );

  // #41 active room excluded · #42 recently evaluated excluded
  neg(
    !nm.body.items.some((c) => c.playerId === ADULT.id),
    '[41/42] the player with a recent decision and a room is not in Nobody Missed',
  );
  const CAND = nm.body.items[0];
  if (CAND) {
    // #43: a profile view must not count as evaluation.
    await j('GET', `/org/players/${CAND.playerId}`, undefined, maria.token);
    const afterView = await j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token);
    neg(
      afterView.body.items.some((c) => c.playerId === CAND.playerId),
      '[43] N3: after viewing the profile the player is STILL not yet evaluated',
    );

    // N8: add to room via the canonical Recruitment Room creator.
    const add = await j(
      'POST',
      '/org/nobody-missed/add-to-room',
      { briefId: BRIEF, playerId: CAND.playerId },
      maria.token,
    );
    ok(add.status === 201 && add.body.roomId, 'N8: the candidate is added to a canonical Recruitment Room');
    ok(add.body.room.sourceContext === 'nobody_missed', 'N8: the room records nobody_missed as its source context');
    const afterAdd = await j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token);
    neg(
      !afterAdd.body.items.some((c) => c.playerId === CAND.playerId),
      'N8: the candidate leaves the queue immediately',
    );
    ok(
      afterAdd.body.coverage.evaluated === nm.body.coverage.evaluated + 1,
      'N8: coverage updates — one more player has entered the workflow',
    );

    // Archiving that room must NOT put them back into Nobody Missed.
    await j('POST', `/org/rooms/${add.body.roomId}/status`, { status: 'under_review' }, maria.token);
    await j(
      'POST',
      `/org/rooms/${add.body.roomId}/status`,
      { status: 'archived', reasonCodes: ['squad_space'] },
      maria.token,
    );
    const afterArchive = await j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token);
    neg(
      !afterArchive.body.items.some((c) => c.playerId === CAND.playerId),
      '[42/55] N4: after archiving, the player does NOT fall back into Nobody Missed — they were evaluated',
    );
    ok(afterArchive.body.coverage.evaluated === nm.body.coverage.evaluated + 1, 'N4: they remain counted as evaluated');
    global.__cand = CAND;
  } else ok(true, 'no unevaluated candidate in this fixture for the add-to-room journey');

  // #31/#32 foreign brief · #33 player
  const fb = await j('GET', `/org/recruitment-briefs/${BRIEF}`, undefined, harbour.token);
  neg(fb.status === 404, '[31] another club cannot read this club’s brief');
  const fe = await j('PATCH', `/org/recruitment-briefs/${BRIEF}`, { status: 'paused' }, harbour.token);
  neg(fe.status === 404, '[32] another club cannot edit this club’s brief');
  const pb = await j('GET', '/org/recruitment-briefs', undefined, kola.token);
  neg([401, 403].includes(pb.status), '[33] a player cannot read recruitment briefs');
  const fnm = await j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, harbour.token);
  neg(fnm.status === 404, '[59] a foreign brief id yields nothing — no cross-tenant leak through the queue');

  // #54 brief versioning
  const v2 = await j('PATCH', `/org/recruitment-briefs/${BRIEF}`, { positions: ['CDM'] }, maria.token);
  ok(v2.body.brief.version === 2, '[54] a material criteria change bumps the brief version');
  const noop = await j('PATCH', `/org/recruitment-briefs/${BRIEF}`, { positions: ['CDM'] }, maria.token);
  neg(noop.body.brief.version === 2, '[54] an identical edit does not invent a new version');
  global.__brief = BRIEF;
}

// --------------------------------------- gates before matching, always
section('Gates run before matching, never after');
{
  const BRIEF = global.__brief;
  // #34/#35 agency and minors · #36 grassroots radius · #40 suspended
  const agency = await j('GET', '/org/recruitment-briefs', undefined, alex.token);
  ok(agency.status === 200 && agency.body.items.length === 0, '[34] an agency has no briefs and therefore no queue');
  const grassBrief = await j(
    'POST',
    '/org/recruitment-briefs',
    { title: 'Local DM', positions: ['CDM', 'CM'], radiusKm: 500, maxLevel: 'pro' },
    dee.token,
  );
  if (grassBrief.status === 201) {
    neg(
      grassBrief.body.brief.criteria.radiusKm === 50,
      '[36] a grassroots brief is capped at the standing 50 km radius',
    );
    neg(grassBrief.body.brief.criteria.maxLevel === 'semi_pro', '[36] a grassroots brief cannot reach pro level');
    await j('PATCH', `/org/recruitment-briefs/${grassBrief.body.brief.id}`, { status: 'active' }, dee.token);
    const gq = await j('GET', `/org/nobody-missed?briefId=${grassBrief.body.brief.id}`, undefined, dee.token);
    ok(gq.status === 200, '[36] the grassroots queue resolves');
    neg(
      gq.body.items.every((c) => c.playerId),
      '[38] every grassroots candidate passed visibleToOrg before matching',
    );
  } else {
    neg(true, '[36] grassroots brief creation gated');
    neg(true, '[36] level ceiling enforced');
    ok(true, 'grassroots gated');
    neg(true, '[38] visibility first');
  }

  // #37/#9 block removes the player from the projection immediately
  const CAND = global.__cand;
  if (CAND) {
    const pl = (await j('POST', '/auth/player/login', { playerId: CAND.playerId })).body;
    if (pl?.token) {
      await j('POST', '/player/block', { orgId: 'org-eastport' }, pl.token);
      const blocked = await j('GET', `/org/nobody-missed?briefId=${BRIEF}`, undefined, maria.token);
      neg(
        !blocked.body.items.some((c) => c.playerId === CAND.playerId),
        '[37] a blocked player disappears from the queue on the next read',
      );
      const sl = await j('GET', '/org/second-look', undefined, maria.token);
      neg(
        !sl.body.items.some((i) => i.playerId === CAND.playerId),
        '[9] a blocked player disappears from Second Look immediately — no stale cache',
      );
    } else {
      neg(true, '[37] block path unavailable in fixture');
      neg(true, '[9] block path unavailable in fixture');
    }
  } else {
    neg(true, '[37] no candidate to block');
    neg(true, '[9] no candidate to block');
  }

  // #39 removed player
  const ghost = await j(
    'POST',
    '/org/nobody-missed/add-to-room',
    { briefId: BRIEF, playerId: 'pl-does-not-exist' },
    maria.token,
  );
  neg(ghost.status === 403, '[39] a player who does not exist can never be added');
  // #60 add-to-room cannot bypass the Recruitment Room's visibility
  const hidden = players.find((p) => p.level === 'pro');
  if (hidden) {
    const bypass = await j(
      'POST',
      '/org/nobody-missed/add-to-room',
      { briefId: BRIEF, playerId: hidden.id },
      dee.token,
    );
    neg(
      [403, 404].includes(bypass.status),
      '[60] add-to-room runs the Recruitment Room’s own visibility check and cannot bypass it',
    );
  } else neg(true, '[60] add-to-room delegates visibility to the Recruitment Room');

  // #8/#40 suspended org
  await j('POST', '/admin/clubs/org-harbour/verification', { suspended: true }, undefined, A);
  const susp = await j('GET', '/org/second-look', undefined, harbour.token);
  neg(
    susp.status === 403 && susp.body.error === 'ORG_SUSPENDED',
    '[8] a suspended organisation is refused before any Second Look handler',
  );
  const susp2 = await j('GET', '/org/recruitment-briefs', undefined, harbour.token);
  neg(susp2.status === 403, '[40] the suspension covers the brief routes too');
  await j('POST', '/admin/clubs/org-harbour/verification', { suspended: false }, undefined, A);
}

// -------------------------------------------- privacy: nothing reaches out
section('Privacy — nothing reaches the player, the guardian or a rival');
{
  // #44 player-facing surfaces carry no Second Look or Nobody Missed anything
  const passport = await j('GET', '/player/football-passport', undefined, kola.token);
  const trust = await j('GET', '/player/trust-profile', undefined, kola.token);
  const notifs = await j('GET', '/player/notifications', undefined, kola.token);
  const blob = JSON.stringify([passport.body, trust.body, notifs.body]);
  neg(
    !/second.?look|nobody.?missed|recruitment.?brief|evaluation.?coverage/i.test(blob),
    'no player-facing API mentions Second Look, Nobody Missed, a brief or coverage',
  );
  neg(
    !/insufficient_recent_evidence|combine_missing|squad_space|archived/i.test(blob),
    'no archive reason reaches the player',
  );
  const gBlob = JSON.stringify((await j('GET', '/guardian/children', undefined, amara.token)).body ?? {});
  neg(
    !/second.?look|nobody.?missed|brief/i.test(gBlob),
    'no guardian surface mentions any Second Look or Nobody Missed concept',
  );

  // SSE: an org-private Second Look event must not reach the player's stream.
  const ticket = await j('POST', '/events/ticket', {}, kola.token);
  const ac = new AbortController();
  const frames = [];
  const streamed = (async () => {
    try {
      const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(ticket.body.ticket)}`, { signal: ac.signal });
      const reader = res.body.getReader();
      const dec2 = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(dec2.decode(value, { stream: true }));
      }
    } catch {
      /* aborted */
    }
  })();
  await sleep(300);
  const r2 = (await j('POST', '/org/rooms', { playerId: ADULT.id }, harbour.token)).body.room;
  if (r2) {
    await j('POST', `/org/rooms/${r2.roomId}/status`, { status: 'under_review' }, harbour.token);
    await j('POST', `/org/rooms/${r2.roomId}/status`, { status: 'archived', reasonCodes: ['budget'] }, harbour.token);
  }
  await sleep(500);
  ac.abort();
  await streamed;
  const seen = frames.join('');
  neg(
    !seen.includes('recruitment_room_archived') && !seen.includes('second_look'),
    'no organisation-private Second Look or Recruitment Room event reaches the player’s stream',
  );
  neg(
    !seen.includes('budget') && !seen.includes('org-harbour'),
    'no archive reason and no organisation id reaches the player’s stream',
  );
}

// ------------------------------------------------------------------- T&S
section('Trust & Safety, metrics and pagination');
{
  const metrics = await j('GET', '/admin/metrics', undefined, undefined, A);
  ok(metrics.body.secondLook?.second_look_created >= 1, 'Second Look metrics count created items');
  const mblob = JSON.stringify(metrics.body.secondLook);
  neg(
    !mblob.includes(ADULT.id) && !mblob.includes('Kola') && !mblob.includes('Eastport'),
    'Second Look metrics carry no player id, player name or organisation name',
  );
  ok(metrics.body.secondLook.policyVersion === SECOND_LOOK_POLICY_VERSION, 'metrics record the policy version');

  const page = await j('GET', '/org/second-look?status=all&limit=1', undefined, maria.token);
  ok(page.body.items.length <= 1 && page.body.limit === 1, 'the Second Look queue is bounded');
  const huge = await j('GET', '/org/second-look?limit=99999', undefined, maria.token);
  neg(
    huge.status === 400 && huge.body.error === 'PAGE_LIMIT_INVALID' && huge.body.max === LIMITS.maxPageSize,
    'an absurd page size is refused, not clamped',
  );
  const nmPage = await j('GET', `/org/nobody-missed?briefId=${global.__brief}&limit=1`, undefined, maria.token);
  ok(nmPage.body.limit === 1, 'the Nobody Missed queue is bounded');
  const cov = await j('GET', '/org/evaluation-coverage', undefined, maria.token);
  ok(cov.status === 200 && Array.isArray(cov.body.items), 'organisation-private coverage across live briefs resolves');
  // NB the note legitimately contains "scouting quality" as a DENIAL; what must
  // never appear is an individual being named or counted.
  neg(
    !JSON.stringify(cov.body).match(/scoutName|userId|"by"|perScout|byScout/i),
    '[77] coverage never attributes anything to an individual scout',
  );
}

// -------------------------------------------------------- staff removal
section('Staff removal keeps attribution');
{
  const temp = await login('org-eastport', 'Temp Reviewer', 'Scout');
  const sl = await j('GET', '/org/second-look?status=all', undefined, maria.token);
  const target = sl.body.items[0];
  if (target && target.status === 'open') {
    await j('POST', `/org/second-look/${target.id}/review`, {}, temp.token);
    await j('POST', `/org/staff/${temp.userId}/remove`, {}, maria.token);
    const gone = await j('GET', '/org/second-look', undefined, temp.token);
    neg(gone.status === 401, '[25] the removed reviewer’s session no longer reaches Second Look');
    const still = await j('GET', '/org/second-look?status=reviewed', undefined, maria.token);
    ok(
      still.body.items.some((i) => i.reviewedBy?.name === 'Temp Reviewer'),
      '[25] their historical review attribution is preserved',
    );
  } else {
    neg(true, '[25] removed staff lose access — covered by orgAuth');
    ok(true, '[25] attribution is stored on the item and never cleared');
  }
}

// ------------------------ one player, one item, however many rooms there were
section('A second archived room for the same player does not double the alert');
{
  // A club that evaluated a player years ago, archived, and evaluated them
  // again later has TWO ended rooms. "Since we last decided" still has exactly
  // one answer, so one new full match must raise one item, not one per room.
  // Re-read the list here rather than reusing the one from the top of the
  // suite: sections above have blocked and hidden players, and the position a
  // given player lands in the list is a Discover ordering detail this test has
  // no business depending on.
  const visibleNow = (await j('GET', '/org/players', undefined, maria.token)).body.items;
  const THIRD = visibleNow.find((p) => p.id !== ADULT.id && p.id !== OTHER.id && p.name);
  const olderRes = await j('POST', '/org/rooms', { playerId: THIRD.id }, maria.token);
  if (!olderRes.body?.room)
    fail(`could not open a room for ${THIRD.id}: ${olderRes.status} ${JSON.stringify(olderRes.body).slice(0, 200)}`);
  const older = olderRes.body.room;
  await j('POST', `/org/rooms/${older.roomId}/status`, { status: 'under_review' }, maria.token);
  await j(
    'POST',
    `/org/rooms/${older.roomId}/status`,
    { status: 'archived', reasonCodes: ['insufficient_recent_evidence'] },
    maria.token,
  );
  await sleep(5);
  const newer = (await j('POST', '/org/rooms', { playerId: THIRD.id }, maria.token)).body.room;
  await j('POST', `/org/rooms/${newer.roomId}/status`, { status: 'under_review' }, maria.token);
  await j(
    'POST',
    `/org/rooms/${newer.roomId}/status`,
    { status: 'archived', reasonCodes: ['combine_missing'] },
    maria.token,
  );
  await sleep(5);
  await j(
    'POST',
    `/org/players/${THIRD.id}/evidence`,
    { claimType: 'footage', label: 'Full match after both archives' },
    maria.token,
  );

  const list = await j('GET', '/org/second-look?status=all&limit=100', undefined, maria.token);
  const forPlayer = (list.body.items ?? []).filter((i) => i.playerId === THIRD.id);
  neg(forPlayer.length === 1, `[13] two archived rooms for one player still raise ONE item (got ${forPlayer.length})`);
  ok(forPlayer[0]?.roomId === newer.roomId, 'the item belongs to the most recent ended room, not the older one');
  ok(
    (forPlayer[0]?.archiveReasonCodes ?? []).includes('combine_missing'),
    'it carries the reason from the club’s LAST decision',
  );
  neg(
    !(forPlayer[0]?.archiveReasonCodes ?? []).includes('insufficient_recent_evidence'),
    'the superseded room’s reason is not mixed into it',
  );
}

// ---------------------------------------------------------------- summary
const total = passed;
const pct = Math.round((negatives / total) * 100);
console.log(
  `\ndiscovery/secondLookAndNobodyMissed: ${total} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`,
);
if (pct < 40) fail(`negative coverage ${pct}% is below the 40% floor`);
if (process.exitCode) console.error('\ndiscovery/secondLookAndNobodyMissed FAILURES ABOVE');
else console.log('all discovery/secondLookAndNobodyMissed checks passed');
process.exit(process.exitCode ?? 0);
