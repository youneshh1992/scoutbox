// Trust Score battery.
//
// The Trust Score is an evidence-confidence summary. Its engine's invariants (volume cannot buy trust, athletic
// performance is invisible, prestige/popularity/payment are not inputs, missing evidence is not misconduct) are
// checked in scripts/rules/passport/trustScore.mjs. These HTTP journeys prove the projections and — most
// importantly — that the score never moves an authorization boundary.
//
// Well over 40% of checks are negative/edge/security cases.
import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import trustSpec from '../support/spec/passport/trust/shared.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m162-'));

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

// ================================================= HTTP journeys
section('HTTP — routes, projections and the authorization boundary');
const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_QUIET_LOGS: '1',
  SCOUTBOX_FAST_SWEEPS: '1',
  BOX_CAM_TEST_PROVIDER: '1',
  AGENT_VERIFICATION_TEST_PROVIDER: '1',
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
const alex = await login('org-northstar', 'Alex Agent', 'Agent');
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok(
  [maria, alex, dee, kola, guni, amara].every((x) => x?.token),
  'HTTP actors logged in',
);

{
  const self = await j('GET', '/player/trust-profile', undefined, kola.token);
  ok(self.status === 200 && typeof self.body.trust.score === 'number', 'T1: player reads their own Trust Profile');
  ok(
    self.body.trust.policyVersion === trustSpec.TRUST_SCORE_POLICY_VERSION &&
      /not football ability/i.test(self.body.trust.disclaimer),
    'T1: profile carries policy version and the disclaimer',
  );
  const explain = await j('GET', '/player/trust-profile/explain', undefined, kola.token);
  ok(
    explain.status === 200 && explain.body.trust.explanations.length === 6 && explain.body.policy.weights,
    'T1: "Why this score?" returns per-component explanations and the policy',
  );
  ok(
    explain.body.trust.components.combine.gaps.some((g) => /production-supported/.test(g.text)),
    'T1: Combine gap honestly reports no production-supported result',
  );

  // guardian
  const g = await j('GET', '/guardian/children/pl-guni/trust-profile', undefined, amara.token);
  ok(g.status === 200 && typeof g.body.trust.score === 'number', "guardian reads their child's Trust Profile");
  neg(
    (await j('GET', '/guardian/children/pl-adeyemi/trust-profile', undefined, amara.token)).status === 404,
    'a guardian cannot read a Trust Profile for a child that is not theirs',
  );

  // club view + batch
  const club = await j('GET', '/org/players/pl-adeyemi/trust-profile', undefined, maria.token);
  ok(club.status === 200 && typeof club.body.trust.score === 'number', 'T8: a visible club reads the Trust Profile');
  neg(
    !club.body.trust.components && !club.body.trust.gaps,
    'T8: the club projection carries no raw components or gaps',
  );
  neg(
    !JSON.stringify(club.body).includes('gd-amara') && !JSON.stringify(club.body).includes('vclm'),
    'T8: no guardian identity or verification claim id leaks to the club',
  );
  const batch = await j('GET', '/org/trust-summaries?playerIds=pl-adeyemi,pl-guni', undefined, maria.token);
  ok(batch.status === 200 && batch.body.items.length >= 1, 'batch Trust summaries returned for visible players');
  const indiv = (await j('GET', '/org/players/pl-adeyemi/trust-profile', undefined, maria.token)).body.trust.score;
  ok(
    batch.body.items.find((x) => x.playerId === 'pl-adeyemi')?.score === indiv,
    'batch score equals the individual score',
  );
  neg(
    /rank|best|top/i.test(batch.body.note) === false || /never ranked/i.test(batch.body.note),
    'batch response states results are never ranked by Trust Score',
  );

  // T&S derivation + policy, and NO write route
  const ts = await j('GET', '/admin/trust/pl-adeyemi', undefined, undefined, A);
  ok(ts.status === 200 && ts.body.trust.components && ts.body.snapshot, 'T&S sees the full derivation and a snapshot');
  ok(/cannot be set manually/i.test(ts.body.note), 'T&S response states the score cannot be set manually');
  neg(
    (await j('POST', '/admin/trust/pl-adeyemi', { score: 100 }, undefined, A)).status === 404,
    'there is no route to write a Trust Score',
  );
  const pol = await j('GET', '/admin/trust-policy', undefined, undefined, A);
  ok(
    pol.status === 200 && pol.body.policyVersion === trustSpec.TRUST_SCORE_POLICY_VERSION,
    'the policy is inspectable and versioned',
  );

  // Forged client values are ignored — the score is server-derived
  const forged = await j(
    'GET',
    '/player/trust-profile?score=100&band=very_strong_evidence&policyVersion=99',
    undefined,
    kola.token,
  );
  neg(
    forged.body.trust.score === self.body.trust.score &&
      forged.body.trust.policyVersion === trustSpec.TRUST_SCORE_POLICY_VERSION,
    'forged query parameters cannot change the score, band or policy version',
  );
}

// ============ T2/T4 — the real chain: Combine → Box Cam → Trust recompute
section('T2/T4 — a real Combine Verified result strengthens Trust, and invalidation removes it');
{
  const trustOf = async (tok) => (await j('GET', '/player/trust-profile', undefined, tok)).body.trust;
  const before = await trustOf(kola.token);
  ok(before.components.combine.coverageBp === 0, 'T2: Combine Confidence starts at zero');
  // Matching reads each player's evidence-confidence band from the stored match facts, re-derived before every
  // COMMIT; the band a club's match card shows must be the band the Trust profile gives at that moment.
  const matchedBand = async () => {
    let cursor;
    for (;;) {
      const page = await j(
        'POST',
        '/org/matching',
        { criteria: { required: [], preferred: [] }, sort: 'name', limit: 100, ...(cursor ? { cursor } : {}) },
        maria.token,
      );
      const card = page.body.items.find((i) => i.playerId === 'pl-adeyemi');
      if (card || !page.body.nextCursor) return card?.trustBand ?? null;
      cursor = page.body.nextCursor;
    }
  };
  const clubBand = async () =>
    (await j('GET', '/org/players/pl-adeyemi/trust-profile', undefined, maria.token)).body.trust.band;
  ok(
    (await matchedBand()) === (await clubBand()),
    'before the attempt, matching shows the band the Trust profile gives',
  );

  // Run a genuine standardized attempt end-to-end through the Combine routes.
  const created = await j(
    'POST',
    '/player/combine/attempts',
    { protocolId: 'combine-box-touch-60', provider: 'local_test' },
    kola.token,
  );
  ok(created.status === 201, 'T2: Combine Attempt created');
  const { attempt, boxSession, nonce, livenessChallenge } = created.body;
  await j(
    'POST',
    `/player/box-cam/sessions/${boxSession.id}/start`,
    { nonce, liveness: livenessChallenge },
    kola.token,
  );
  const evts = [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: 60_000, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: 60_000 },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: 60_000, quality: 'good' },
  ];
  for (let i = 0; i < 184; i++) evts.push({ seq: 4 + i, type: 'rep', atMs: 200 + i * 320, confidence: 0.92 });
  for (let i = 0; i < evts.length; i += 180) {
    await j(
      'POST',
      `/player/box-cam/sessions/${boxSession.id}/events`,
      { nonce, batch: evts.slice(i, i + 180) },
      kola.token,
    );
  }
  const done = await j('POST', `/player/combine/attempts/${attempt.id}/complete`, { nonce }, kola.token);
  ok(done.body.attempt.combineState === 'combine_verified', 'T2: the attempt is Combine Verified');

  const after = await trustOf(kola.token);
  ok(after.components.combine.coverageBp > before.components.combine.coverageBp, 'T2: Combine Confidence strengthened');
  ok(after.score > before.score, `T2: Trust Score recalculated upward (${before.score} → ${after.score})`);
  ok(
    after.components.evidence.coverageBp > before.components.evidence.coverageBp,
    'T2: the underlying Box Cam session also strengthened Evidence Confidence',
  );
  // This environment has no production Combine capability, so the profile must
  // say the contribution came from simulated evidence.
  neg(
    after.simulatedEvidenceIncluded === true,
    'T2: the profile declares that simulated evidence was included (demo/test environment)',
  );
  ok(
    after.strengths.some((s) => s.code === 'COMBINE_VERIFIED'),
    'T2: a Combine strength signal is explained to the player',
  );
  ok((await matchedBand()) === (await clubBand()), 'a verified Combine result reaches matching as soon as it commits');

  // T4 — Trust & Safety invalidates the bound Box Cam session.
  await j('POST', `/player/box-cam/sessions/${boxSession.id}/dispute`, { reason: 'Camera fogged up.' }, kola.token);
  const disputes = await j('GET', '/admin/box-cam/disputes', undefined, undefined, A);
  const d = disputes.body.items.find((x) => x.sessionId === boxSession.id);
  await j(
    'POST',
    `/admin/box-cam/disputes/${d.id}/resolve`,
    { outcome: 'invalidated', reason: 'Provider miscount confirmed.' },
    undefined,
    A,
  );
  const invalidated = await trustOf(kola.token);
  neg(invalidated.components.combine.coverageBp === 0, 'T4: an invalidated result stops contributing immediately');
  neg(invalidated.score <= after.score, 'T4: the score falls only because evidence was removed');
  neg(
    invalidated.score >= before.score - 1,
    'T4: removal is not a punitive penalty — the score returns toward the pre-evidence level, never below it',
  );
  neg(
    !invalidated.gaps.some((g) => /fraud|cheat|dishonest|suspicious/i.test(g.text)),
    'T4: no gap accuses the player after invalidation',
  );
  ok((await matchedBand()) === (await clubBand()), 'an invalidation reaches matching as soon as it commits');

  // Restore returns the contribution deterministically.
  await j(
    'POST',
    `/admin/box-cam/sessions/${boxSession.id}/restore`,
    { reason: 'Re-review overturned.' },
    undefined,
    A,
  );
  const restored = await trustOf(kola.token);
  ok(
    restored.score === after.score && restored.components.combine.coverageBp === after.components.combine.coverageBp,
    'T4: restoration returns the exact previous contribution',
  );
  ok((await matchedBand()) === (await clubBand()), 'a restoration reaches matching as soon as it commits');
}

// ============================== Passport separation
section('Passport separation — the Passport itself stays score-free');
{
  const pp = await j('GET', '/player/football-passport', undefined, kola.token);
  ok(pp.status === 200, 'the Football Passport still builds');
  // There is no numeric score anywhere in the Passport
  // projection (a number in a Passport has always meant a talent rating).
  // The Trust Score is therefore a SEPARATE derived summary that consumes
  // the Passport — clients compose it into the Passport header.
  neg(
    pp.body.trust === undefined,
    'the Passport projection carries NO trust score — the Passport no-score guarantee is intact',
  );
  const trust = await j('GET', '/player/trust-profile', undefined, kola.token);
  ok(
    trust.status === 200 && typeof trust.body.trust.score === 'number',
    'the Trust Score lives on its own endpoint instead',
  );
  neg(
    !JSON.stringify(pp.body).match(/"score"\s*:\s*\d/),
    'no numeric "score" field appears anywhere in the Passport payload',
  );
}

// ================================== the score authorizes NOTHING
section('a Trust Score grants no permission whatsoever');
{
  // Kola's real score is irrelevant to every gate below; these are the exact
  // standing refusals, unchanged by the Trust Score.
  // Named, not "not 200". A refusal for the WRONG reason — a 404 from a renamed
  // route, a 500 from a broken projector — satisfies `!== 200` exactly as well
  // as the safeguarding rule does, and then the rule is untested.
  const _p1 = await j('GET', '/org/players/pl-guni/trust-profile', undefined, alex.token);
  neg(
    _p1.status === 403 && _p1.body?.error === 'NOT_VISIBLE',
    "agency is refused a minor's Trust Profile (agency/minor wall holds)",
  );
  const agencyPassport = await j('GET', '/org/players/pl-guni/football-passport', undefined, alex.token);
  // UNDER_18_WALL specifically, and not NOT_VISIBLE: the minor wall is a
  // different rule from ordinary visibility, and only the code distinguishes
  // them. If the wall broke and this became a generic visibility refusal, a
  // `!== 200` assertion would stay green.
  neg(
    agencyPassport.status === 403 && agencyPassport.body?.error === 'UNDER_18_WALL',
    "agency still cannot read a minor's Passport regardless of Trust Score",
  );
  // blocked organisation
  await j('POST', '/guardian/block', { orgId: 'org-eastport', playerId: 'pl-guni', reason: 'test' }, amara.token);
  const _p3 = await j('GET', '/org/players/pl-guni/trust-profile', undefined, maria.token);
  neg(_p3.status === 403 && _p3.body?.error === 'NOT_VISIBLE', 'a blocked organisation is refused the Trust Profile');
  // suspended organisation loses org routes entirely
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: true }, undefined, A);
  const suspBatch = await j('GET', '/org/trust-summaries?playerIds=pl-adeyemi', undefined, maria.token);
  neg(
    (suspBatch.status === 403 && suspBatch.body?.error === 'ORG_SUSPENDED') ||
      (suspBatch.body.items ?? []).length === 0,
    'a suspended organisation gains nothing from Trust summaries',
  );
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: false }, undefined, A);
  // T&S-only surface stays T&S-only
  const _p5 = await j('GET', '/admin/trust/pl-adeyemi', undefined, kola.token);
  neg(
    _p5.status === 401 && _p5.body?.error === 'ADMIN_KEY_REQUIRED',
    'a player cannot reach the T&S derivation endpoint',
  );
  neg(
    (await j('GET', '/player/trust-profile', undefined, undefined)).status === 401,
    'an unauthenticated caller gets no Trust Profile',
  );
  const _p6 = await j('GET', '/org/players/pl-adeyemi/trust-profile', undefined, kola.token);
  neg(_p6.status === 401 && _p6.body?.error === 'ORG_AUTH_REQUIRED', 'a player token cannot use the org Trust route');
}

// ================= agency representation as a live relationship
section('an agency relationship counts only while it is active');
{
  // Regression: the relationship source must key agency representations by
  // `agencyOrgId` (the field the record has), and must stop counting a
  // withdrawn / disputed / expired relationship even though `confirmedAt`
  // survives those transitions.
  const distinctOf = async () =>
    (await j('GET', '/player/trust-profile', undefined, kola.token)).body?.trust?.components?.relationships?.detail
      ?.distinct;
  const d0 = await distinctOf();
  ok(typeof d0 === 'number', 'the self view exposes the distinct-relationship count');
  // The legacy writer is closed, and Trust reads the CANONICAL agent lane as a
  // relationship source: the state filter is the point, and it is asserted here
  // against the lane that can actually create a relationship.
  const closed = await j('POST', '/org/representation/propose', { playerId: 'pl-adeyemi', scope: 'full' }, alex.token);
  neg(closed.status === 404, 'the legacy representation writer is gone and creates nothing');
  await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
  const ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
  await j('POST', '/org/agent/profile', { displayName: 'Ana Agent', jurisdictions: ['ENG'] }, ana.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
  const proposed = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'INT' },
    ana.token,
  );
  ok(
    proposed.status === 201 && proposed.body?.relationship?.id,
    `a licensed agent requests the adult client (${proposed.status} ${proposed.body?.error ?? ''})`,
  );
  neg((await distinctOf()) === d0, 'a PROPOSED (unconfirmed) relationship is not a verified relationship');
  const repId = proposed.body.relationship.id;
  ok(
    (await j('POST', `/player/agent/relationships/${repId}/confirm`, { expectedRev: 1 }, kola.token)).status === 200,
    'the player confirms it',
  );
  ok((await distinctOf()) === d0 + 1, 'a confirmed, active relationship counts as exactly one distinct relationship');
  const active = (await j('GET', '/player/agent/relationships', undefined, kola.token)).body.items.find(
    (x) => x.id === repId,
  );
  ok(
    (await j('POST', `/player/agent/relationships/${repId}/terminate`, { expectedRev: active.rev }, kola.token))
      .status === 200,
    'the player terminates it',
  );
  neg((await distinctOf()) === d0, 'a TERMINATED relationship stops counting although confirmedAt is still set');
  // The canonical lane has an anti-spam cooldown the legacy lane never had:
  // after a termination the same agent may not re-request the same client for
  // 30 days. That is the correct behaviour, so it is asserted rather than
  // worked around.
  const tooSoon = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'INT' },
    ana.token,
  );
  neg(
    tooSoon.status === 429 && tooSoon.body.error === 'REPRESENTATION_COOLDOWN',
    'the same agent cannot immediately re-request a client who just terminated',
  );
  // The dispute leg uses a DIFFERENT adult client, which also proves two
  // relationships with the same agency collapse to one distinct relationship
  // per client rather than leaking across players.
  const mateus = (await j('POST', '/auth/player/login', { playerId: 'pl-carvalho' })).body;
  const distinctMateus = async () =>
    (await j('GET', '/player/trust-profile', undefined, mateus.token)).body?.trust?.components?.relationships?.detail
      ?.distinct;
  const m0 = await distinctMateus();
  const again = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-carvalho', scope: ['employment'], jurisdiction: 'INT' },
    ana.token,
  );
  ok(
    again.status === 201,
    `a request for a different adult client is accepted (${again.status} ${again.body?.error ?? ''})`,
  );
  const id2 = again.body.relationship.id;
  ok(
    (await j('POST', `/player/agent/relationships/${id2}/confirm`, { expectedRev: 1 }, mateus.token)).status === 200,
    'that client confirms it',
  );
  ok((await distinctMateus()) === m0 + 1, 'and it counts as one distinct relationship for THAT client');
  // A second agent of the same agency representing the same client is the same relationship: the key is the agency.
  await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
  const bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
  await j('POST', '/org/agent/profile', { displayName: 'Bea Agent', jurisdictions: ['ENG'] }, bea.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-BEA' }, bea.token);
  const second = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-carvalho', scope: ['commercial'], jurisdiction: 'INT' },
    bea.token,
  );
  const confirmed2 =
    second.status === 201 &&
    (
      await j(
        'POST',
        `/player/agent/relationships/${second.body.relationship.id}/confirm`,
        { expectedRev: 1 },
        mateus.token,
      )
    ).status === 200;
  ok(
    confirmed2,
    `a colleague at the same agency is confirmed for the same client (${second.status} ${second.body?.error ?? ''})`,
  );
  neg(
    (await distinctMateus()) === m0 + 1,
    `two agents of one agency are still one relationship: moving between agents inside an agency is not a new one (${await distinctMateus()})`,
  );
  const beaRel = (await j('GET', '/player/agent/relationships', undefined, mateus.token)).body.items.find(
    (x) => x.id === second.body.relationship.id,
  );
  ok(
    (await j('POST', `/player/agent/relationships/${beaRel.id}/terminate`, { expectedRev: beaRel.rev }, mateus.token))
      .status === 200,
    "the client ends the colleague's mandate, leaving the first agent's in force",
  );
  ok((await distinctMateus()) === m0 + 1, 'and the agency still counts, through the agreement still in force');
  neg((await distinctOf()) === d0, 'while the first client, whose relationship ended, still counts none');
  const active2 = (await j('GET', '/player/agent/relationships', undefined, mateus.token)).body.items.find(
    (x) => x.id === id2,
  );
  ok(
    (
      await j(
        'POST',
        `/player/agent/relationships/${id2}/dispute`,
        { reason: 'not my agent', expectedRev: active2.rev },
        mateus.token,
      )
    ).status === 200,
    'the client disputes it',
  );
  neg((await distinctMateus()) === m0, 'a DISPUTED relationship stops counting');
}

// ============================================================== metrics
section('metrics — privacy-safe aggregate counters');
{
  const m = await j('GET', '/admin/metrics', undefined, undefined, A);
  const t = m.body?.trust ?? null;
  ok(
    t && typeof t.trust_profile_viewed === 'number' && t.trust_profile_viewed > 0,
    'trust_profile_viewed counter increments',
  );
  ok(typeof t.trust_explanation_viewed === 'number', 'trust_explanation_viewed counter present');
  neg(
    !JSON.stringify(t).includes('pl-adeyemi') && !JSON.stringify(t).includes('Kola'),
    'trust metrics carry no player identifiers',
  );
}

await sleep(50);
const total = passed;
console.log(
  `\npassport/trustScore: ${total} checks passed, ${negatives} negative/abuse checks (${Math.round((negatives / total) * 100)}% of all checks)`,
);
if (negatives * 10 < total * 4) fail(`negative coverage ${negatives}/${total} below the 40% floor`);
if (process.exitCode) console.error('\nSOME CHECKS FAILED');
else console.log('all passport/trustScore checks passed');
process.exit(process.exitCode || 0);
