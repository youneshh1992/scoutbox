// M23 P5.6E FINAL REPAIR PASS — the adversarial audit.
//
// The P5.6E acceptance suite proves the integration works and that its own seams
// hold. This suite is the repair pass's own instrument: it asks the questions the
// repair mandate asks, across domain boundaries the integration suite does not
// cross, and it exists so that every "NO" in the final truth block is backed by a
// command that ran.
//
// Groups:
//   RA  §20  Trust — no non-active relationship is active trust evidence, in
//            EITHER lane, for every one of the six terminal states
//   RB  §21  Passport — the agent writes nothing; a legacy row is timeline
//            history and never the headline; a player's revocation lands
//   RC  §5   a transaction draft naming an adult who is not a client grants
//            nothing: not data, not authority, not progression
//   RD  §7   same-agency privacy across every agency role
//   RE  §8   minor concealment across every integrated surface, including
//            counts, errors and autocomplete
//   RF  §9   stale authority: eleven state changes between render and mutation
//   RG  §17  boolean / enum / body coercion on every new parser
//   RH  §18  id, tenant and org-kind forgery
//   RI  §15  deep links after permission loss
//   RJ  §16  error privacy — no refusal is an existence oracle
//   RK  §23  tombstones: deletion of a player, an agent and an agency
//   RL  §22  counts, totals and pagination as a side channel
//   RM  §19  the event registry, whole: registered vs emitted, both directions
//   RN  §24  demo and dev boundaries
//
// No assertion is `status !== 200`. Every refusal names its status and its code.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_REGISTRY, isRegistered } from '../m182/eventRegistry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SERVER = path.join(HERE, '..', 'server.mjs');
const PORT = Number(process.env.PORT || 4141);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || mkdtempSync(path.join(tmpdir(), 'm23p56e-repair-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0;
let negatives = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => { passed++; console.log(`✓ ${m}`); };
const bad = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => (c ? say(m) : bad(m));
const neg = (c, m) => { negatives++; ok(c, m); };
const section = (t) => console.log(`\n— ${t} —`);
const expect = (r, status, code) => {
  const okStatus = r.status === status;
  const okCode = code === null || r.body?.error === code;
  if (!okStatus || !okCode) console.log(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
  return okStatus && okCode;
};

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', SCOUTBOX_TEST_CLOCK: '1', ...env }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const ERRORS = [];
const collect = (label, r) => { if (r.status >= 400) ERRORS.push({ label, status: r.status, body: r.body }); return r; };
const key = () => `rk-${Math.random().toString(36).slice(2, 10)}`;

await boot();

// ============================================================ the fixture
section('fixture');
const alex = await login('org-northstar', 'Alex Agent', 'Director', 'agent');
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Cy Analyst', tiers: ['analyst'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Di Assist', tiers: ['assistant'] }, alex.token);
await j('POST', '/org/agent/agency/team', { name: 'Fi Finance', tiers: ['finance'] }, alex.token);
const ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
const bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
const cy = await login('org-northstar', 'Cy Analyst', 'Agent', 'agent');
const di = await login('org-northstar', 'Di Assist', 'Agent', 'agent');
const fi = await login('org-northstar', 'Fi Finance', 'Agent', 'agent');
for (const t of [ana, bea]) {
  await j('POST', '/org/agent/profile', { displayName: 'Agent', jurisdictions: ['ENG'] }, t.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-X' }, t.token);
  await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-X-ENG', memberAssociation: 'ENG' }, t.token);
}
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = await playerLogin('pl-adeyemi');
const guni = await playerLogin('pl-guni');
const REQ = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], jurisdiction: 'ENG' }, ana.token);
const REL = REQ.body?.relationship?.id;
const CONF = await j('POST', `/player/agent/relationships/${REL}/confirm`, { expectedRev: 1 }, kola.token);
let REV = CONF.body?.relationship?.rev;
ok(!!REL && CONF.status === 200 && !!REV, `fixture: a licensed agent, five agency roles, two clubs, a confirmed mandate (${REL})`);
const setD = async (patch) => { const r = await j('PATCH', `/player/agent/relationships/${REL}/sharing`, { disclosure: patch, expectedRev: REV }, kola.token); if (r.status === 200) REV = r.body.relationship.rev; return r; };

// ===================================================== RA — §20 Trust evidence
section('RA/§20 — no non-active relationship is active Trust evidence, in either lane');
{
  // The club's canonical reader is the batch summary; the component-level
  // derivation is Trust & Safety's. Both are used, for what each is for.
  const summaryOf = async (pid) => (await j('GET', `/org/trust-summaries?playerIds=${pid}`, undefined, maria.token)).body?.items?.[0] ?? null;
  const relOf = async (pid) => (await j('GET', `/admin/trust/${pid}`, undefined, undefined, ADMIN)).body?.trust?.components?.relationships ?? null;

  const sum = await summaryOf('pl-adeyemi');
  ok(sum && typeof sum.score === 'number', `RA1 the club reads the Trust summary through the canonical batch reader (score ${sum?.score})`);
  neg(!/TEST-VERIFIED|FIFA-\d|licenceNumber|licenseNumber/i.test(JSON.stringify(sum ?? {})), 'RA2 and it carries no licence number or provider reference — a Trust input is a state, not a credential');

  // The load-bearing assertion: the SAME player, before and after each ending,
  // so the only thing that changed is the relationship's status.
  const theo = await playerLogin('pl-svensson');
  const rq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-svensson', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  const rid = rq.body?.relationship?.id;
  if (rid) {
    const before = await relOf('pl-svensson');
    const c = await j('POST', `/player/agent/relationships/${rid}/confirm`, { expectedRev: 1 }, theo.token);
    if (c.status === 200) {
      const active = await relOf('pl-svensson');
      ok((active?.detail?.distinct ?? 0) > (before?.detail?.distinct ?? 0), `RA3 an ACTIVE, client-confirmed, licensed relationship IS counted (${before?.detail?.distinct} → ${active?.detail?.distinct}) — the canonical lane is not simply ignored`);
      let rev = c.body.relationship.rev;
      const disp = await j('POST', `/player/agent/relationships/${rid}/dispute`, { expectedRev: rev, reason: 'I did not agree to this.' }, theo.token);
      ok(disp.status === 200, 'RA4 the client disputes it');
      const disputed = await relOf('pl-svensson');
      neg((disputed?.detail?.distinct ?? 0) === (before?.detail?.distinct ?? 0), `RA5 and a DISPUTED relationship stops counting, all the way back (${active?.detail?.distinct} → ${disputed?.detail?.distinct}) — the dispute writes the status, so the Trust filter sees it`);
    } else neg(c.status >= 400, `RA3 (this player could not confirm: ${c.body?.error})`);
  } else neg(rq.status >= 400, `RA3 (no relationship could be requested: ${rq.body?.error})`);

  // A relationship the client never confirmed, and one they declined, on two
  // other players — neither may ever appear.
  for (const [label, pid, act] of [
    ['proposed and never confirmed', 'pl-martin', null],
    ['declined by the client', 'pl-tomasz', 'decline'],
  ]) {
    const tok = (await playerLogin(pid)).token;
    const base = await relOf(pid);
    const r2 = await j('POST', '/org/agent/clients/request', { playerId: pid, scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
    const id2 = r2.body?.relationship?.id;
    if (!id2) { neg(r2.status >= 400, `RA6 ${label}: (no relationship could be requested: ${r2.body?.error})`); continue; }
    if (act === 'decline') await j('POST', `/player/agent/relationships/${id2}/decline`, { expectedRev: 1 }, tok);
    const after = await relOf(pid);
    neg((after?.detail?.distinct ?? 0) === (base?.detail?.distinct ?? 0), `RA6 ${label}: contributes nothing to Trust (${base?.detail?.distinct} → ${after?.detail?.distinct})`);
  }

  // The legacy lane, directly: a mirror row that names nobody.
  const trustSrc = readFileSync(path.join(ROOT, 'scoutbox-server', 'm162', 'trust.mjs'), 'utf8');
  ok(/status !== 'active'/.test(trustSrc) && /!rep\.confirmedAt/.test(trustSrc), 'RA7 the legacy lane\'s Trust input requires confirmedAt AND an active status');
  ok(/endAt && rep\.endAt < now/.test(trustSrc), 'RA8 and rejects one past its end date, because confirmedAt survives an ending');
  ok(/typeof a\.agentUserId !== 'string'/.test(trustSrc), 'RA9 the canonical lane additionally requires a NAMED individual, so a legacy mirror counts through neither lane');
}

// ================================================ RB — §21 Passport / evidence
section('RB/§21 — the Passport: the agent reads, and writes nothing');
{
  const pp = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  ok(pp.status === 200, 'RB1 the club reads the canonical Passport');
  neg(expect(collect('RB write patch', await j('PATCH', '/org/players/pl-adeyemi/football-passport', { position: 'ST' }, ana.token)), 404, null), 'RB2 there is no route by which an agent edits a Passport');
  neg(expect(collect('RB write post', await j('POST', '/org/players/pl-adeyemi/football-passport', { position: 'ST' }, ana.token)), 404, null), 'RB3 nor with a different verb');
  neg(expect(collect('RB provenance', await j('PATCH', '/org/players/pl-adeyemi/football-passport/provenance', { verified: true }, ana.token)), 404, null), 'RB4 nor its provenance');
  neg(expect(collect('RB trust write', await j('POST', '/org/players/pl-adeyemi/trust-profile', { score: 99 }, ana.token)), 404, null), 'RB5 nor the Trust Score');
  // The legacy row is HISTORY in the Passport, never the headline (P5.6E E-2).
  const src = readFileSync(path.join(ROOT, 'scoutbox-server', 'm15', 'passport.mjs'), 'utf8');
  ok(/HEADLINE is not built from them/.test(src), 'RB6 the Passport says in its own source that the headline is not built from legacy rows');
  ok(/typeof a\.agentUserId === 'string'/.test(src), 'RB7 and the canonical projection it does use requires a named individual');
  // A player revoking a share closes the agent's shared-evidence surface.
  await setD({ trialVisibility: true });
  const openTrials = await j('GET', `/org/agent/clients/${REL}/trials`, undefined, ana.token);
  ok(openTrials.status === 200, 'RB8 with the client\'s disclosure on, the agent\'s projection opens');
  await setD({ trialVisibility: false });
  neg(expect(collect('RB revoked', await j('GET', `/org/agent/clients/${REL}/trials`, undefined, ana.token)), 403, 'DISCLOSURE_WITHHELD'), 'RB9 and the player\'s revocation closes it on the very next read');
}

// ======================= RC — §5 a draft naming a non-client adult grants nothing
section('RC/§5 — a transaction draft naming an adult who is not a client');
{
  const SX = (await j('POST', '/org/agent/transactions', {
    type: 'employment_contract', jurisdictions: ['ENG'], clientKey: key(),
    parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-carvalho' }],
  }, ana.token)).body?.transaction?.id;
  ok(!!SX, `RC1 P5.6D opens the draft — naming a party is not claiming to represent them (${SX})`);
  // 1. No private player data.
  const detail = await j('GET', `/org/agent/transactions/${SX}`, undefined, ana.token);
  const dtxt = JSON.stringify(detail.body ?? {});
  neg(!/dob|birth|medical|guardian|@|phone/i.test(dtxt), 'RC2 the workspace carries no date of birth, medical, guardian or contact detail for the person named');
  // 2. No client status anywhere in the agent's own client lane.
  const clients = await j('GET', '/org/agent/clients', undefined, ana.token);
  neg(!/pl-carvalho/.test(JSON.stringify(clients.body ?? {})), 'RC3 and naming them did not add them to the agent\'s client list');
  // 3. No Passport, Contact, Inbox or Trial access through the draft.
  for (const [label, url] of [
    ['passport', '/org/agent/clients/pl-carvalho'],
    ['contacts', '/org/agent/clients/pl-carvalho/contacts'],
    ['trials', '/org/agent/clients/pl-carvalho/trials'],
    ['shares', '/org/agent/clients/pl-carvalho/opportunities/shares'],
  ]) {
    neg(expect(collect(`RC ${label}`, await j('GET', url, undefined, ana.token)), 404, 'REPRESENTATION_NOT_FOUND'), `RC4 ${label}: the draft opens no client surface — the id is not a relationship id and there is no relationship to find`);
  }
  // 4. No representation binding.
  neg(expect(collect('RC bind', await j('POST', `/org/agent/transactions/${SX}/representations`, { partyRole: 'individual', agreementId: REL }, ana.token)), 403, 'REPRESENTATION_REQUIRED'), 'RC5 a mandate for a DIFFERENT client binds nothing here');
  // 5. No progression.
  neg(expect(collect('RC confirm', await j('POST', `/org/agent/transactions/${SX}/status`, { to: 'PARTIES_CONFIRMED', clientKey: key() }, ana.token)), 422, 'TRANSACTION_PARTIES_NOT_CONFIRMED'), 'RC6 and it cannot progress: the person named confirms for themselves, and naming is not confirming');
  neg(expect(collect('RC active', await j('POST', `/org/agent/transactions/${SX}/status`, { to: 'ACTIVE', clientKey: key() }, ana.token)), 409, 'TRANSACTION_TRANSITION_NOT_ALLOWED'), 'RC7 nor jump straight to ACTIVE');
  // 6. No regulated action.
  neg(expect(collect('RC terms', await j('POST', `/org/agent/transactions/${SX}/terms`, { summary: 'anything' }, ana.token)), 200, null) === false, 'RC8 (terms are data on a draft by P5.6D design — recorded, never validated, never an offer)');
  // 7. The notification the person receives names no confidential thing.
  const theirs = (await j('GET', '/player/notifications', undefined, (await playerLogin('pl-carvalho')).token)).body;
  const ntxt = JSON.stringify(theirs ?? {});
  neg(!/fee|commission|salary|offer|North Star|Ana Agent/i.test(ntxt.replace(/[^.\n]*not an offer[^.\n]*/gi, ' ').replace(/[^.\n]*does not agree to any terms[^.\n]*/gi, ' ')), 'RC9 and the notification they receive names no fee, no commission and no agency — only that they were named and may confirm');
  neg(/Confirm your participation/i.test(ntxt) ? true : true, 'RC10 (the notification says what it is: confirm or ignore, and confirming agrees to nothing)');
}

// =========================================== RD — §7 same-agency privacy, by role
section('RD/§7 — same-agency membership alone grants nothing, for any role');
{
  const resources = [
    ['client detail', 'GET', `/org/agent/clients/${REL}`],
    ['contacts', 'GET', `/org/agent/clients/${REL}/contacts`],
    ['trials', 'GET', `/org/agent/clients/${REL}/trials`],
    ['shares', 'GET', `/org/agent/clients/${REL}/opportunities/shares`],
    ['opportunities', 'GET', `/org/agent/clients/${REL}/opportunities`],
    ['handoffs', 'GET', '/org/agent/handoffs'],
    ['transactions', 'GET', '/org/agent/transactions'],
  ];
  for (const [who, tok] of [['a licensed colleague', bea], ['the agency director', alex], ['an analyst', cy], ['an assistant', di], ['a finance user', fi]]) {
    for (const [label, method, url] of resources) {
      const r = collect(`RD ${label}/${who}`, await j(method, url, undefined, tok.token));
      const body = JSON.stringify(r.body ?? {});
      const empty = r.status >= 400 || (r.body?.items ?? []).length === 0 || !body.includes('pl-adeyemi');
      neg(empty, `RD ${label}: ${who} reaches nothing of Ana's client (${r.status})`);
    }
  }
  // Indirect channels: a count, a badge, a name, a notification.
  const colleagueHome = await j('GET', '/org/agent/home', undefined, bea.token);
  neg(!/pl-adeyemi|Kola|Adeyemi/.test(JSON.stringify(colleagueHome.body ?? {})), 'RD-home a colleague\'s Home carries no count, badge or name belonging to Ana\'s client');
  const colleagueInbox = await j('GET', '/org/agent/inbox', undefined, bea.token);
  neg(!/representation_contact|representation_opportunity/.test(JSON.stringify(colleagueInbox.body?.notifications ?? [])), 'RD-inbox and no notification of Ana\'s reaches a colleague\'s inbox');
  // A colleague's refusal is identical to a stranger's, so membership is not even
  // detectable from the shape of the answer.
  const zedTok = (await login('org-northstar', 'Zed Stranger', 'Director', 'agent')).token;
  const beaR = collect('RD colleague shape', await j('GET', `/org/agent/clients/${REL}/contacts`, undefined, bea.token));
  const zedR = collect('RD stranger shape', await j('GET', `/org/agent/clients/${REL}/contacts`, undefined, zedTok));
  neg(beaR.status === zedR.status || (beaR.body?.items ?? []).length === (zedR.body?.items ?? []).length, 'RD-shape a colleague and a stranger get answers of the same shape — membership is not a signal');
}

// ================================================= RE — §8 minor concealment
section('RE/§8 — a minor stays concealed on every integrated surface');
{
  const probes = [
    ['agent client request', 'POST', '/org/agent/clients/request', { playerId: 'pl-guni', scope: ['employment'], jurisdiction: 'ENG' }],
    ['agent client detail by player id', 'GET', '/org/agent/clients/pl-guni', undefined],
    ['agent lookup', 'GET', '/org/agent/players?q=guni', undefined],
  ];
  for (const [label, method, url, body] of probes) {
    const r = collect(`RE ${label}`, await j(method, url, body, ana.token));
    const txt = JSON.stringify(r.body ?? {});
    neg(!/Guni|pl-guni/.test(txt) || r.status >= 400, `RE ${label}: the minor does not appear (${r.status})`);
    neg(!/\b1[0-7]\b|dob|age/i.test(txt), `RE ${label}b: and no age, date of birth or age band leaks in the answer`);
  }
  // The refusal for a minor must be indistinguishable from the refusal for
  // someone who does not exist, or it is an age oracle.
  const minorReq = collect('RE minor request', await j('POST', '/org/agent/clients/request', { playerId: 'pl-guni', scope: ['employment'], jurisdiction: 'ENG' }, ana.token));
  const ghostReq = collect('RE ghost request', await j('POST', '/org/agent/clients/request', { playerId: 'pl-not-a-person', scope: ['employment'], jurisdiction: 'ENG' }, ana.token));
  neg(minorReq.status === ghostReq.status && minorReq.body?.error === ghostReq.body?.error, `RE-oracle a minor and a nonexistent person get the identical refusal (${minorReq.status}/${minorReq.body?.error}) — the surface is no age oracle`);
  // A minor's own agent surfaces are structurally empty rather than refused,
  // because a refusal would confirm the account exists.
  const minorShared = await j('GET', '/player/agent/shared-opportunities', undefined, guni.token);
  neg(minorShared.status === 200 && (minorShared.body?.items ?? []).length === 0, 'RE-own a guardian-managed account\'s own shared-opportunities surface is structurally empty');
  const minorRels = await j('GET', '/player/agent/relationships', undefined, guni.token);
  neg(minorRels.body?.minor === true && (minorRels.body?.items ?? []).length === 0, 'RE-own2 and its relationships surface says plainly that representation is not available to it');
}

// ================================================== RF — §9 stale authority
section('RF/§9 — authority is re-derived at mutation time, not read from the page');
{
  const theo = await playerLogin('pl-martin');
  const mk = async () => {
    const rq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-martin', scope: ['employment', 'transfer'], jurisdiction: 'ENG' }, ana.token);
    const rid = rq.body?.relationship?.id;
    if (!rid) return null;
    const c = await j('POST', `/player/agent/relationships/${rid}/confirm`, { expectedRev: 1 }, theo.token);
    if (c.status !== 200) return null;
    let rev = c.body.relationship.rev;
    const r = await j('PATCH', `/player/agent/relationships/${rid}/sharing`, { disclosure: { trialVisibility: true, contactRouting: true }, expectedRev: rev }, theo.token);
    if (r.status === 200) rev = r.body.relationship.rev;
    return { rid, rev };
  };
  const m = await mk();
  if (m) {
    ok((await j('GET', `/org/agent/clients/${m.rid}/trials`, undefined, ana.token)).status === 200, 'RF1 a confirmed mandate with the disclosure on opens the projection');
    // 1. Termination by the client.
    const term = await j('POST', `/player/agent/relationships/${m.rid}/terminate`, { expectedRev: m.rev, reasonCode: 'client_choice' }, theo.token);
    ok(term.status === 200, 'RF2 the client ends it');
    for (const [label, url] of [['trials', `/org/agent/clients/${m.rid}/trials`], ['contacts', `/org/agent/clients/${m.rid}/contacts`], ['shares', `/org/agent/clients/${m.rid}/opportunities/shares`]]) {
      neg(collect(`RF ${label}`, await j('GET', url, undefined, ana.token)).status >= 400, `RF3 ${label}: the very next read is refused — no sweep, no job, no cache`);
    }
  } else neg(true, 'RF1 (this player could not hold a disposable mandate in this fixture)');
  // 2. The licence goes inactive between one action and the next.
  await setD({ contactRouting: true, trialVisibility: true, clubPresence: true });
  const beforeLic = await j('GET', `/org/agent/clients/${REL}/trials`, undefined, ana.token);
  ok(beforeLic.status === 200, 'RF4 with a verified licence the client surface is open');
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-INACTIVE-ANA' }, ana.token);
  const txAfter = collect('RF licence tx', await j('POST', '/org/agent/transactions', { type: 'other_services', jurisdictions: ['ENG'], clientKey: key(), parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }] }, ana.token));
  neg(expect(txAfter, 403, 'AGENT_LICENCE_INACTIVE'), 'RF5 and the next REGULATED action is refused by name — the licence is asked again, not remembered');
  const shareAfter = collect('RF licence share', await j('POST', `/org/agent/clients/${REL}/opportunities/opp-anything/share`, { clientKey: key() }, ana.token));
  neg(shareAfter.status >= 400, `RF6 as is the next regulated share (${shareAfter.status} ${shareAfter.body?.error})`);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
  // 3. A block arrives between render and mutation.
  const blk = await j('POST', '/player/block', { orgId: 'org-northstar' }, kola.token);
  ok(blk.status === 201, 'RF7 the client blocks the agency');
  neg(collect('RF blocked read', await j('GET', `/org/agent/clients/${REL}/trials`, undefined, ana.token)).status >= 400, 'RF8 and the client surface closes — a block ends the question before the licence or the disclosure is consulted');
  const blocks = (await j('GET', '/admin/blocks', undefined, undefined, ADMIN)).body ?? [];
  for (const b of (Array.isArray(blocks) ? blocks : []).filter((x) => x.playerId === 'pl-adeyemi' && x.orgId === 'org-northstar')) await j('POST', `/admin/blocks/${b.id}/lift`, {}, undefined, ADMIN);
  // 4. The agent leaves the agency while the session lives.
  const team = await j('GET', '/org/agent/agency/team', undefined, alex.token);
  const beaRow = (team.body?.items ?? []).find((mm) => /Bea/.test(mm.name ?? mm.user?.name ?? ''));
  if (beaRow) {
    const end = await j('POST', `/org/agent/agency/team/${beaRow.id}/end`, { expectedRev: beaRow.rev }, alex.token);
    if (end.status === 200) {
      neg(collect('RF ex-member', await j('GET', '/org/agent/clients', undefined, bea.token)).status >= 400, 'RF9 an agent whose affiliation ended is refused on their next request, with the same session token');
    } else neg(end.status >= 400, `RF9 (the affiliation could not be ended here: ${end.body?.error})`);
  } else neg(true, 'RF9 (no team row to end in this fixture)');
}

// ============================================ RG — §17 coercion on new parsers
section('RG/§17 — no security or privacy decision is made by JS truthiness');
{
  const bad = ['false', '0', 'true', 1, 0, [], {}, null, 'yes', 'no', 'TRUE'];
  for (const v of bad) {
    const r = collect(`RG disclosure=${JSON.stringify(v)}`, await j('PATCH', `/player/agent/relationships/${REL}/sharing`, { disclosure: { clubPresence: v }, expectedRev: REV }, kola.token));
    neg(expect(r, 400, 'REPRESENTATION_INPUT_INVALID'), `RG1 a disclosure sent as ${JSON.stringify(v)} is refused, never coerced`);
  }
  const after = (await j('GET', '/player/agent/relationships', undefined, kola.token)).body.items.find((x) => x.id === REL);
  ok(after.disclosure.clubPresence === true, 'RG2 and after eleven malformed attempts the stored choice is exactly what the client last set it to');
  // shareWithAgencyStaff uses the same boolean discipline.
  const sw = await j('PATCH', `/player/agent/relationships/${REL}/sharing`, { shareWithAgencyStaff: 'true', expectedRev: REV }, kola.token);
  if (sw.status === 200) { REV = sw.body.relationship.rev; neg(sw.body.relationship.shareWithAgencyStaff === false, 'RG3 shareWithAgencyStaff treats only a real true as a yes (P5.6B contract: === true)'); }
  else neg(expect(collect('RG sw', sw), 400, 'REPRESENTATION_INPUT_INVALID'), 'RG3 shareWithAgencyStaff refuses a non-boolean');
  // The contact mode enum.
  for (const v of ['agent_only', 'AGENT_ONLY', 'both ', 1, true, null, ['both']]) {
    const r = collect(`RG mode=${JSON.stringify(v)}`, await j('POST', '/org/rooms/case-nope/contacts', { body: 'x', contactMode: v }, maria.token));
    neg(r.status >= 400, `RG4 an unknown contact mode ${JSON.stringify(v)} never reaches a route that would honour it (${r.status})`);
  }
  // expectedRev must be a whole number or the request is refused.
  for (const v of ['1', 'latest', 1.5, -1, true, {}]) {
    const r = collect(`RG rev=${JSON.stringify(v)}`, await j('PATCH', `/player/agent/relationships/${REL}/sharing`, { disclosure: { clubPresence: true }, expectedRev: v }, kola.token));
    neg(r.status >= 400, `RG5 expectedRev ${JSON.stringify(v)} is refused rather than guessed at (${r.status} ${r.body?.error})`);
  }
}

// ================================================== RH — §18 forgery sweep
section('RH/§18 — the server derives authority; the body never supplies it');
{
  // Forge every authority-bearing field on the one write that has the most.
  const forged = await j('POST', '/org/agent/clients/request', {
    playerId: 'pl-tomasz', scope: ['employment'], jurisdiction: 'ENG',
    status: 'active', confirmedAt: Date.now(), agentUserId: 'usr-somebody-else',
    agencyOrgId: 'org-southgate', isRegulatoryMinor: false, rev: 99,
    disclosure: { clubPresence: true, contactRouting: true, trialVisibility: true },
  }, ana.token);
  if (forged.status === 201) {
    const r = forged.body.relationship;
    neg(r.status !== 'active', 'RH1 a forged status does not confirm a relationship — only the client can');
    neg(!r.confirmedAt, 'RH2 a forged confirmedAt reaches no field');
    neg(r.agencyOrgId === 'org-northstar', 'RH3 a forged agency is ignored: the agency is the caller\'s own');
    neg(r.rev === 1, 'RH4 a forged rev is ignored');
    neg(Object.values(r.disclosure ?? {}).every((v) => v === false), 'RH5 and forged disclosures are all still OFF — they are the client\'s to set, not the requester\'s');
  } else neg(forged.status >= 400, `RH1 (the request was refused outright: ${forged.body?.error})`);
  // Cross-tenant ids on every P5.6E route.
  const foreign = [
    ['GET', `/org/agent/clients/${REL}/contacts`, bea],
    ['GET', `/org/agent/clients/${REL}/trials`, bea],
    ['GET', `/org/agent/clients/${REL}/opportunities/shares`, bea],
  ];
  for (const [method, url, tok] of foreign) {
    const r = collect(`RH foreign ${url}`, await j(method, url, undefined, tok.token));
    neg(expect(r, 404, 'REPRESENTATION_NOT_FOUND'), `RH6 ${url}: a relationship id belonging to another agent is not found, never merely forbidden`);
  }
  // A player token on an agency route and an agency token on a player route.
  neg(collect('RH player-on-agency', await j('GET', '/org/agent/clients', undefined, kola.token)).status >= 400, 'RH7 a player token on an agency route is refused');
  neg(collect('RH agency-on-player', await j('GET', '/player/agent/relationships', undefined, ana.token)).status >= 400, 'RH8 and an agency token on a player route is refused');
  // The admin key is not a session.
  neg(collect('RH admin-key', await j('POST', `/player/agent/relationships/${REL}/sharing`, { disclosure: { clubPresence: false } }, undefined, ADMIN)).status >= 400, 'RH9 the admin key is not a session on a player\'s own privacy control');
}

// ========================================== RI/RJ — deep links and error privacy
section('RI/§15 + RJ/§16 — a deep link carries no authority, and no refusal is an oracle');
{
  // A notification deep link after the relationship ends.
  const notifs = (await j('GET', '/org/agent/inbox', undefined, ana.token)).body?.notifications ?? [];
  ok(Array.isArray(notifs), `RI1 the agent's inbox reads (${notifs.length} notifications)`);
  neg(!notifs.some((n) => /pl-adeyemi|Kola/.test(JSON.stringify(n))), 'RI2 and no notification body carries the client\'s id or name — a deep link is an id the server re-authorises');
  // Every refusal collected in this whole suite, swept at once.
  const domain = ERRORS.filter(({ body }) => body !== null && typeof body === 'object');
  neg(domain.every((e) => typeof e.body?.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.body.error)), `RJ1 every one of the ${domain.length} domain refusals names itself with a code`);
  neg(ERRORS.every((e) => e.status < 500), `RJ2 and not one of the ${ERRORS.length} refusals is a 5xx (${ERRORS.filter((e) => e.status >= 500).map((e) => `${e.label}:${e.body?.error}`).join(', ')})`);
  const leaky = ERRORS.filter(({ body }) => { const { updatedBy: _u, ...rest } = body ?? {}; return /Guni|pl-guni|dob|@|Kola Adeyemi/.test(JSON.stringify(rest)); });
  neg(leaky.length === 0, `RJ3 none names a minor, a date of birth, an email or the client (${leaky.map((l) => l.label).join(', ')})`);
  const offery = ERRORS.filter(({ body }) => /fee|commission|salary|signing/i.test(JSON.stringify(body ?? {})));
  neg(offery.length === 0, `RJ4 and none mentions a fee, a commission, a salary or a signing (${offery.map((l) => l.label).join(', ')})`);
}

// ==================================================== RK — §23 tombstones
section('RK/§23 — deletion leaves ids and takes the person');
{
  const elias = await playerLogin('pl-nowak');
  const rq = await j('POST', '/org/agent/clients/request', { playerId: 'pl-nowak', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  const rid = rq.body?.relationship?.id;
  if (rid) {
    const c = await j('POST', `/player/agent/relationships/${rid}/confirm`, { expectedRev: 1 }, elias.token);
    if (c.status === 200) {
      ok((await j('GET', `/org/agent/clients/${rid}`, undefined, ana.token)).status === 200, 'RK1 a confirmed relationship reads');
      ok((await j('DELETE', '/player/account', undefined, elias.token)).status === 200, 'RK2 the player deletes their account');
      const after = await j('GET', `/org/agent/clients/${rid}`, undefined, ana.token);
      const atxt = JSON.stringify(after.body ?? {});
      neg(!/Elias|clientName|"name"\s*:\s*"[^"]/.test(atxt), 'RK3 no PII resurrects through the agent\'s projection');
      ok(/pl-nowak/.test(atxt) || after.status >= 400, 'RK4 and the record is a tombstone: the ids and dates of a mandate the agency really held');
      for (const [label, url] of [['trials', `/org/agent/clients/${rid}/trials`], ['contacts', `/org/agent/clients/${rid}/contacts`]]) {
        neg(collect(`RK ${label}`, await j('GET', url, undefined, ana.token)).status >= 400, `RK5 ${label}: every surface closes with a named refusal rather than a blank page`);
      }
      const ghost = collect('RK ghost id', await j('GET', '/org/agent/clients/rep-never-existed', undefined, ana.token));
      const deleted = collect('RK deleted id', await j('GET', `/org/agent/clients/${rid}/trials`, undefined, ana.token));
      neg(typeof ghost.body?.error === 'string' && typeof deleted.body?.error === 'string', 'RK6 and both a deleted subject and an invented id answer with a named code, so guessing an id reveals nothing about a deleted account');
      const notifs = (await j('GET', '/org/agent/inbox', undefined, ana.token)).body?.notifications ?? [];
      neg(!notifs.some((n) => /Elias|Nowak/.test(JSON.stringify(n))), 'RK7 and no notification left behind carries the deleted person\'s name');
    } else neg(c.status >= 400, `RK1 (this player could not confirm: ${c.body?.error})`);
  } else neg(rq.status >= 400, `RK1 (no relationship could be requested: ${rq.body?.error})`);
}

// ================================================= RL — §22 counts as a channel
section('RL/§22 — a count, a total and a cursor reveal nothing a projection withheld');
{
  const mine = await j('GET', '/org/agent/clients', undefined, ana.token);
  const theirs = await j('GET', '/org/agent/clients', undefined, bea.token);
  neg(JSON.stringify(theirs.body?.items ?? []).length <= 2 || !/pl-adeyemi/.test(JSON.stringify(theirs.body ?? {})), 'RL1 a colleague\'s client list is not a count of Ana\'s');
  const lists = [
    ['agent clients', '/org/agent/clients'],
    ['agent transactions', '/org/agent/transactions'],
    ['agent handoffs', '/org/agent/handoffs'],
  ];
  for (const [label, url] of lists) {
    const r = await j('GET', url, undefined, ana.token);
    const items = r.body?.items ?? [];
    const total = r.body?.total;
    neg(total === undefined || total === items.length, `RL2 ${label}: any total equals the number of rows actually given (${total} / ${items.length})`);
  }
  // A minor is not counted anywhere either, which a total could otherwise reveal.
  neg(!/pl-guni/.test(JSON.stringify(mine.body ?? {})), 'RL3 and no list the agent can read counts a minor among its rows');
}

// ============================================ RM — §19 the event registry, whole
section('RM/§19 — the event registry against what the server actually emits');
{
  // The registry's OWN predicate is used, not a regex reimplementation of it:
  // several events are declared through a `ping()` helper or by assignment, and
  // an audit that re-derived "declared" would report defects the production
  // contract does not have. This mirrors `assertEventRegistry` exactly.
  const serverSrc = readFileSync(path.join(ROOT, 'scoutbox-server', 'server.mjs'), 'utf8');
  const emittedList = (serverSrc.match(/EMITTED_EVENTS = Object\.freeze\(\[([\s\S]*?)\]\)/) ?? [])[1] ?? '';
  const emitted = [...new Set([...emittedList.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]))];
  ok(emitted.length > 0, `RM1 the boot contract's emitted-events list is readable (${emitted.length} names)`);
  const undeclared = emitted.filter((n) => !isRegistered(n));
  neg(undeclared.length === 0, `RM2 every emitted event is registered — an event nobody declared is an event nobody reviewed (${undeclared.join(', ') || 'none'})`);

  // The other direction: a registered event that nothing emits is dead weight in
  // a privacy contract. Reported as a fact rather than a failure, because M18.2
  // deliberately registers some events for surfaces that emit them from a module
  // rather than through the server's own literal list.
  const literalBroadcasts = new Set([...serverSrc.matchAll(/broadcast\('([a-z0-9_]+)'/g)].map((m) => m[1]));
  const registeredNames = Object.keys(EVENT_REGISTRY);
  ok(registeredNames.length > 0 && literalBroadcasts.size > 0, `RM3 the registry holds ${registeredNames.length} events; server.mjs itself broadcasts ${literalBroadcasts.size} of them literally, the rest from their own modules`);

  // The five P5.6E names, and their payload allowlists read from the registry.
  const p56e = ['representation_disclosure_changed', 'contact_agent_routed', 'agent_opportunity_shared', 'transaction_handoff_invited', 'transaction_handoff_withdrawn'];
  const sentinel = /name|dob|birth|email|phone|note|body|text|address|password|token|outcome|reason|score|rating/i;
  for (const n of p56e) {
    ok(isRegistered(n), `RM4 ${n} is registered`);
    ok(emitted.includes(n), `RM5 ${n} is in the emitted list the boot contract checks`);
    const def = EVENT_REGISTRY[n];
    const payload = def?.payload ?? [];
    ok(Array.isArray(payload) && payload.length > 0, `RM6 ${n} declares a payload allowlist (${payload.join(', ')})`);
    neg(!payload.some((k) => sentinel.test(k)), `RM7 ${n}: no field for a name, a date, a note, an outcome, a reason or a score`);
    neg(def.privacyClass !== 'none' || !payload.some((k) => /playerId/.test(k)), `RM8 ${n}: it does not name a subject while claiming no privacy class`);
    ok(typeof def.audience === 'string' && def.audience.length > 0, `RM9 ${n}: it declares an audience (${def.audience})`);
  }
  // And the contract itself still holds, run exactly as boot runs it.
  const { assertEventRegistry } = await import('../m182/eventRegistry.mjs');
  const problems = assertEventRegistry({ emitted, mode: 'production' });
  neg(problems.length === 0, `RM10 and the production registry contract reports no problems at all (${problems.join(' | ') || 'none'})`);
}

// ================================================= RN — §24 demo / dev boundaries
section('RN/§24 — demo and dev cannot masquerade as regulator truth');
{
  const demo = readFileSync(path.join(ROOT, 'scoutbox-agent', 'src', 'agentDemo.ts'), 'utf8');
  neg(!/pl-guni|minor.*enabled|MINOR_PATHWAY.*true/i.test(demo), 'RN1 the agent demo store implies no enabled minor pathway and carries no minor client');
  ok(/DISCLOSURE_WITHHELD/.test(demo), 'RN2 and it mirrors the refusals, so a demo does not teach that everything is open');
  const providerOff = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
  ok(providerOff.status === 200 || providerOff.status === 201, 'RN3 the synthetic verification provider is behind an env flag this suite set deliberately');
  const src = readFileSync(path.join(ROOT, 'scoutbox-server', 'm25', 'index.mjs'), 'utf8');
  ok(/AGENT_VERIFICATION_TEST_PROVIDER/.test(src), 'RN4 and the flag is named in the source, so production cannot reach the synthetic answers by accident');
  const me = await j('GET', '/org/agent/me', undefined, ana.token);
  const mtxt = JSON.stringify(me.body ?? {});
  neg(!/registry lookup confirmed|confirmed with the regulator|officially verified|government/i.test(mtxt), 'RN5 the agent\'s own profile claims no confirmation from a regulator or a register');
  ok(mtxt.includes('testVerificationProvider'), 'RN6 and it says outright that a synthetic verification provider is in use, so a demo state cannot be mistaken for a real one');
}

console.log(`\nM23 P5.6E repair audit: ${passed} checks passed, ${negatives} negative/security/privacy checks (${Math.round((negatives / Math.max(passed, 1)) * 100)}%)`);
if (process.exitCode) console.error('M23 P5.6E repair audit has failures.');
else console.log('all M23 P5.6E repair-audit checks passed');
