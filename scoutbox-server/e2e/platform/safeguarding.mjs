// Safeguarding and audit routes, against a real server on a temporary data directory with the synthetic seed.
//
//   A the Trust & Safety lists page by cursor ({ items, nextCursor }): reports in triage order, blocks and
//     moderation newest first; junk paging is refused with 400
//   B the club's ledger and the guardian's log page the same way, each scoped to its owner
//   C junk the tables cannot hold is refused at the route: a block or report naming no organisation (404), an
//     over-long report reason, note or outcome (400 FIELD_INVALID)
//   D units of work: a player's block and its ledger row; a grooming hit and its urgent escalation; an urgent report
//     with its suspension block and frozen request; a resolution with the organisation's suspension and the
//     reporter's notice; a lifted block is gone at once
//   E responses are allowlists of the stored fields; the counts the admin overview and metrics show
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../scripts/testPort.mjs';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-safeguarding-'));
const ADMIN = { 'x-admin-key': 'scoutbox-admin' };

let passed = 0;
let negatives = 0;
let child = null;
function cleanup() {
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  fs.rmSync(DATA, { recursive: true, force: true });
}
process.on('exit', cleanup);
const ok = (cond, name) => {
  if (!cond) {
    console.error(`✗ ${name}`);
    cleanup();
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${name}`);
};
const neg = (cond, name) => {
  negatives++;
  ok(cond, `[neg] ${name}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const j = async (method, pathname, body, token, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const admin = (pathname) => j('GET', pathname, undefined, null, ADMIN);
const login = async (route, body) => {
  const r = await j('POST', route, body);
  ok(r.status === 200, `login ${route} ${JSON.stringify(body)}`);
  return r.body.token;
};

child = spawn('node', ['server.mjs'], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
  stdio: 'ignore',
});
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${API}/health`)).ok) break;
  } catch {
    /* booting */
  }
  if (i > 80) throw new Error('server did not boot');
  await new Promise((r) => setTimeout(r, 250));
}

const maria = await login('/auth/org/login', {
  orgId: 'org-eastport',
  scoutName: 'Maria Keane',
  role: 'Head of Recruitment',
});
const harbour = await login('/auth/org/login', {
  orgId: 'org-harbour',
  scoutName: 'Harbour Scout',
  role: 'Head of Recruitment',
});
const amara = await login('/auth/guardian/login', { guardianId: 'gd-amara' });
const signup = await j('POST', '/auth/player/signup', {
  name: 'Safeguarding Adult',
  dob: '2000-01-01',
  country: 'GB',
  password: 'synthetic-pass-1',
});
ok(signup.status === 201, 'an adult signs up');
const adult = signup.body.token;
const pid = signup.body.playerId;

section('C — junk refused at the route');
{
  neg(
    (await j('POST', '/player/block', { orgId: 'org-nobody' }, adult)).body?.error === 'ORG_NOT_FOUND',
    'a block naming no organisation: 404 ORG_NOT_FOUND',
  );
  neg(
    (await j('POST', '/player/report', { targetKind: 'club', targetOrgId: 'org-nobody', reason: 'Synthetic.' }, adult))
      .body?.error === 'ORG_NOT_FOUND',
    'a report naming no organisation: 404 ORG_NOT_FOUND',
  );
  const long = await j(
    'POST',
    '/player/report',
    { targetKind: 'scout', targetScoutName: 'Synthetic Scout', reason: 'x'.repeat(2001) },
    adult,
  );
  neg(
    long.status === 400 && long.body.error === 'FIELD_INVALID' && long.body.field === 'reason',
    'an over-long reason: 400 naming the field',
  );
  const longNote = await j('POST', `/org/players/${pid}/notes`, { text: 'x'.repeat(2001) }, maria);
  neg(longNote.status === 400 && longNote.body.field === 'text', 'an over-long note: 400 naming the field');
  for (const q of ['limit=0', 'limit=abc', 'limit=101', 'cursor=not-a-cursor']) {
    neg((await admin(`/admin/blocks?${q}`)).status === 400, `/admin/blocks?${q}: 400`);
  }
  neg(
    (await admin('/admin/reports?cursor=WzFd')).body?.error === 'PAGE_CURSOR_INVALID',
    'a blocks cursor is not a reports cursor: 400 PAGE_CURSOR_INVALID',
  );
  // Safety input is valid as sent or refused.
  const mine = async () => (await j('GET', '/player/reports', undefined, adult)).body.length;
  const before = await mine();
  const textUrgent = await j(
    'POST',
    '/player/report',
    { targetKind: 'club', targetOrgId: 'org-eastport', reason: 'Synthetic.', urgent: 'false' },
    adult,
  );
  neg(
    textUrgent.status === 400 && textUrgent.body.field === 'urgent' && textUrgent.body.problem === 'not_boolean',
    'IN1 "urgent" written as text is refused: "false" used to be read as urgent and suspend the club',
  );
  const kind = await j('POST', '/player/report', { targetKind: 'agent', reason: 'Synthetic.' }, adult);
  neg(
    kind.status === 400 && kind.body.error === 'TARGET_KIND_REQUIRED' && kind.body.allowed?.includes('club'),
    'IN2 an unknown target kind keeps TARGET_KIND_REQUIRED, listing the kinds',
  );
  const status = await j(
    'POST',
    '/player/report',
    { targetKind: 'scout', targetScoutName: 'Synthetic Scout', reason: 'Synthetic.', status: 'resolved' },
    adult,
  );
  neg(
    status.status === 400 && status.body.field === 'status' && status.body.problem === 'unknown_field',
    'IN3 a report cannot arrive already resolved',
  );
  ok((await mine()) === before, 'IN4 and none of the refused reports was filed');
  const listOrg = await j('POST', '/player/block', { orgId: ['org-harbour'] }, adult);
  neg(listOrg.status === 400 && listOrg.body.field === 'orgId', 'IN5 a block naming its club with a list is refused');
  const pw = await j('POST', '/admin/clubs/org-harbour/credentials', { password: 123456789 }, null, ADMIN);
  neg(
    pw.status === 400 && pw.body.field === 'password',
    'IN6 a club password that is not text is refused, not hashed as text',
  );
  const standing = await j(
    'POST',
    '/admin/clubs/org-harbour/verification',
    { verifiedDomain: 'harbour.example', orgName: 'Renamed' },
    null,
    ADMIN,
  );
  neg(
    standing.status === 400 && standing.body.field === 'orgName',
    'IN7 the standing switches take nothing the console does not send',
  );
}

section('D — units of work');
{
  ok(
    (await j('POST', '/player/block', { orgId: 'org-harbour', reason: 'Synthetic block.' }, adult)).status === 201,
    'the adult blocks Harbour',
  );
  const export1 = (await j('GET', '/player/export', undefined, adult)).body;
  ok(
    export1.ledgerEvents.some((l) => l.type === 'org_blocked_by_player' && l.orgId === 'org-harbour' && l.orgName),
    "the block's ledger row, with the organisation's name",
  );
  ok(
    (await j('GET', `/org/players/${pid}`, undefined, harbour)).status === 404,
    'the blocked club reads the player as absent',
  );
  // Moderation: a grooming hit and its escalation.
  const hit = await j('POST', '/player/timeline', { year: 2026, event: 'keep this a secret from everyone' }, adult);
  ok(hit.status === 400 && hit.body.error === 'MODERATION_BLOCKED', 'a grooming-pattern text is blocked');
  const mod = (await admin('/admin/moderation')).body.items;
  ok(
    mod[0].severity === 'grooming' &&
      mod[0].flags.includes('secrecy') &&
      mod[0].context.kind === 'timeline_event' &&
      mod[0].context.playerId === pid,
    'the hit is logged, newest first',
  );
  const triage = (await admin('/admin/reports')).body.items;
  ok(
    triage[0].by === 'system' && triage[0].urgent && triage[0].status === 'pending_review',
    'its escalation leads the triage',
  );
  // An urgent guardian report: the report, the suspension block and the frozen request.
  const req = await j(
    'POST',
    '/org/players/pl-guni/request',
    { type: 'contact', message: 'Synthetic contact request.' },
    maria,
  );
  ok(req.status === 201, 'Eastport asks to contact a child');
  const rep = await j(
    'POST',
    '/guardian/report',
    { targetKind: 'club', targetOrgId: 'org-eastport', reason: 'Synthetic urgent report.', urgent: true },
    amara,
  );
  ok(rep.status === 201 && rep.body.suspended === true, 'an urgent report suspends the club');
  const blocks = (await admin('/admin/blocks')).body.items;
  ok(
    blocks.some(
      (b) => b.playerId === 'pl-guni' && b.orgId === 'org-eastport' && b.reason === 'suspended_pending_review',
    ),
    'the suspension block is there',
  );
  ok(
    (await j('GET', '/guardian/inbox', undefined, amara)).body.items.find((r) => r.id === req.body.requestId)
      ?.status === 'suspended',
    'and the request froze with it',
  );
  ok(
    (await admin('/admin/clubs')).body.items.find((c) => c.id === 'org-eastport')?.safeguardingCertified === false,
    'an open urgent report withdraws the safeguarding certificate',
  );
  // The resolution, the suspension of the organisation, the reporter's notice.
  const res = await j(
    'POST',
    `/admin/reports/${rep.body.reportId}/resolve`,
    { outcome: 'Synthetic outcome.', action: 'suspend_org' },
    null,
    ADMIN,
  );
  ok(
    res.status === 200 &&
      res.body.status === 'resolved' &&
      res.body.outcome === 'Synthetic outcome.' &&
      Number.isInteger(res.body.resolvedAt),
    'the report is resolved',
  );
  neg(
    (await j('POST', `/admin/reports/${rep.body.reportId}/resolve`, { outcome: 'Again.' }, null, ADMIN)).status === 409,
    'a second resolution: 409',
  );
  neg(
    (await j('POST', '/admin/reports/rep-nobody/resolve', { outcome: 'x' }, null, ADMIN)).status === 404,
    'an unknown report: 404',
  );
  neg(
    (await j('POST', `/admin/reports/${triage[0].id}/resolve`, { outcome: 'x'.repeat(2001) }, null, ADMIN)).body
      ?.field === 'outcome',
    'an over-long outcome: 400 naming the field',
  );
  ok(
    (await admin('/admin/clubs')).body.items.find((c) => c.id === 'org-eastport')?.suspended === true,
    'the organisation is suspended with it',
  );
  ok(
    (await j('GET', '/guardian/notifications', undefined, amara)).body.some((n) => n.type === 'report_resolved'),
    'the reporter heard',
  );
  const sysRes = await j(
    'POST',
    `/admin/reports/${triage[0].id}/resolve`,
    { outcome: 'Reviewed.', action: 'dismiss' },
    null,
    ADMIN,
  );
  ok(sysRes.status === 200, 'a system escalation resolves too');
  // A lifted block is gone at once.
  const toLift = blocks.find((b) => b.playerId === pid && b.orgId === 'org-harbour');
  const lift = await j('POST', `/admin/blocks/${toLift.id}/lift`, {}, null, ADMIN);
  ok(lift.status === 200 && lift.body.lifted.id === toLift.id, 'the block is lifted');
  ok((await j('GET', `/org/players/${pid}`, undefined, harbour)).status === 200, 'and the club sees the player again');
  neg(
    (await j('POST', `/admin/blocks/${toLift.id}/lift`, {}, null, ADMIN)).status === 404,
    'lifting it again: 404 (Q5: the row is deleted)',
  );
}

section('A — the Trust & Safety lists page by cursor');
{
  for (let i = 0; i < 3; i++)
    ok(
      (
        await j(
          'POST',
          '/player/report',
          { targetKind: 'scout', targetScoutName: `Scout ${i}`, reason: `Synthetic report ${i}.` },
          adult,
        )
      ).status === 201,
      `report ${i}`,
    );
  const seen = [];
  let cursor = null;
  do {
    const p = (await admin(`/admin/reports?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).body;
    ok(p.items.length <= 2, 'a page holds at most the limit');
    seen.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor);
  const rank = (r) => (r.status === 'pending_review' ? (r.urgent ? 0 : 1) : 2);
  ok(
    seen.length === (await admin('/admin/reports?limit=100')).body.items.length &&
      new Set(seen.map((r) => r.id)).size === seen.length,
    'paging visits every report once',
  );
  ok(
    seen.every(
      (r, i) =>
        i === 0 ||
        rank(seen[i - 1]) < rank(r) ||
        (rank(seen[i - 1]) === rank(r) && (rank(r) < 2 ? seen[i - 1].ts <= r.ts : seen[i - 1].ts >= r.ts)),
    ),
    'in triage order across pages',
  );
  const mod = (await admin('/admin/moderation?limit=1')).body;
  ok(mod.items.length === 1 && mod.nextCursor === null, 'the moderation log pages (one hit, no next page)');
  const overview = (await admin('/admin/overview')).body;
  ok(
    overview.openReports === seen.filter((r) => r.status === 'pending_review').length &&
      overview.moderationHits === 1 &&
      overview.groomingEscalations === 1,
    'the overview counts match the lists',
  );
}

section("B — the club's ledger and the guardian's log");
{
  for (const id of ['pl-svensson', 'pl-adeyemi']) await j('GET', `/org/players/${id}`, undefined, harbour);
  ok(
    (await j('POST', '/org/players/pl-svensson/shortlist', {}, harbour)).status === 201,
    'Harbour shortlists a player',
  );
  const first = (await j('GET', '/org/ledger?limit=2', undefined, harbour)).body;
  ok(
    first.items.length === 2 && first.items[0].type === 'shortlist' && first.nextCursor,
    'the club ledger, newest first, paged',
  );
  const rest = (await j('GET', `/org/ledger?limit=100&cursor=${first.nextCursor}`, undefined, harbour)).body;
  ok(
    rest.items.every((l) => l.orgId === 'org-harbour') &&
      !rest.items.some((l) => first.items.some((f) => f.id === l.id)),
    "the next page continues, the club's own rows only",
  );
  ok(
    (await j('GET', '/org/shortlist', undefined, harbour)).body.some((p) => p.id === 'pl-svensson'),
    'the shortlist reads the ledger',
  );
  ok(
    (await j('GET', '/org/funnel', undefined, harbour)).body.stages.find((s) => s.key === 'shortlists').count === 1,
    'the funnel counts it',
  );
  const children = (await j('GET', '/guardian/me', undefined, amara)).body.childIds;
  const log = (await j('GET', '/guardian/log', undefined, amara)).body;
  ok(
    log.items.length > 0 && log.items.every((l) => children.includes(l.playerId)),
    "the guardian log is a page of the children's rows only",
  );
  ok(
    log.items.some((l) => l.type === 'contact_request_to_guardian' && l.orgId === 'org-eastport'),
    'including the contact request about their child',
  );
}

section('E — responses are allowlists');
{
  const b = (await admin('/admin/blocks')).body.items[0];
  ok(JSON.stringify(Object.keys(b)) === JSON.stringify(['id', 'playerId', 'orgId', 'by', 'reason', 'ts']), 'a block');
  const l = (await j('GET', '/org/ledger', undefined, harbour)).body.items[0];
  ok(
    JSON.stringify(Object.keys(l)) ===
      JSON.stringify(['id', 'ts', 'type', 'playerId', 'orgId', 'orgName', 'userId', 'scoutName', 'detail']),
    'a ledger row',
  );
  const m = (await admin('/admin/metrics')).body;
  ok(Number.isInteger(m.deliveryFailures) && Array.isArray(m.opsEvents), 'the metrics count ops events');
}

console.log(`\nsafeguarding: ${passed} checks passed (${negatives} negative)`);
cleanup();
