// M15 acceptance suite — Football Passport.
// Unit fixtures for the pure engine (timeline §81, provenance §82,
// visibility/projection §83 building blocks), then full HTTP journeys with
// the §79 abuse catalogue: every safeguarding wall, privacy narrowing rule,
// share re-gate and ownership boundary is negative-tested. Well over a
// third of the checks are negative/abuse cases (the suite counts them).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTimeline, clubHistory, currentStatus, temporalConflicts,
  evaluateGaps, completeness, GAP_RULES, GAP_RULES_VERSION,
  PROVENANCE, provRank, provenanceFromMethod, PROVENANCE_COPY,
  viewerSees, normWhen, whenDisplay, evId, projectPassport,
  sha256, mintShareSecret, shareProblem, SHARE_MODES,
} from '../m15/shared.mjs';

const PORT = 4900 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m15-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0;
let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
// neg() — a negative/abuse-case check: something is REFUSED, hidden or inert.
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_FAST_RETRY: '1', M13_QUIET_LOGS: '1', TEST_LICENCE_REGISTRY: '1' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
{
  const proc = spawn(process.execPath, [SERVER], { env: ENV, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extraHeaders = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const A = { 'x-admin-key': 'scoutbox-admin' };
async function mailWith(to, re) {
  const r = await j('GET', '/admin/outbox', undefined, null, A);
  const mail = (r.body ?? []).find((m) => m.to === to);
  return mail ? (mail.text.match(re) ?? [])[1] ?? null : null;
}

// ===================================================================== U1
section('U1 — timeline engine (§81): deterministic, deduplicated, honest dates');
{
  const src = {
    careerEntries: [
      { id: 'c1', orgName: 'Riverside Youth', role: 'RW', from: '2019', to: '2021-06', submittedBy: 'player' },
      { id: 'c2', orgName: 'Old Boys', from: '2022-03-15', to: null, submittedBy: 'guardian' },
      { id: 'c3', orgName: 'Gone FC', from: '2015', to: null, submittedBy: 'player', withdrawnAt: 123 },
    ],
    squads: [{ orgId: 'o9', orgName: 'Marsh Lane', rowId: 'sq1', addedAt: Date.UTC(2024, 4, 2), orgVerified: true }],
    trials: [{ id: 't1', orgId: 'o2', orgName: 'City Academy', acceptedAt: Date.UTC(2023, 2, 1), proposedDate: '2023-03-10', report: { at: Date.UTC(2023, 2, 12) } }],
    assessments: [{ id: 'a1', orgId: 'o2', orgName: 'City Academy', submittedAt: Date.UTC(2023, 2, 20) }],
    references: [{ id: 'r1', coachName: 'Coach K', orgId: 'o2', orgName: 'City Academy', createdAt: Date.UTC(2023, 3, 1) }],
    evidence: [
      { id: 'e1', claimType: 'footage', label: 'Full match', recordedAt: Date.UTC(2024, 1, 1), tier: 'self_reported', sourceKind: 'player' },
      { id: 'e2', claimType: 'statistic', label: 'Goals', recordedAt: Date.UTC(2024, 1, 2), tier: 'self_reported', sourceKind: 'player' },
      { id: 'e3', claimType: 'footage', label: 'Old cut', recordedAt: Date.UTC(2023, 1, 1), superseded: true },
    ],
    signings: [{ id: 's1', orgId: 'o9', orgName: 'Marsh Lane', ts: Date.UTC(2024, 4, 2) }],
    achievements: [
      { id: 'ach1', title: 'Top scorer', when: '2024', submittedBy: 'player', confirmation: null },
      { id: 'ach2', title: 'Withdrawn one', when: '2024', submittedBy: 'player', withdrawnAt: 1 },
    ],
    positionHistory: [{ id: 'p1', from: '2020', primary: 'RW' }],
  };
  const tl = buildTimeline(src);
  ok(JSON.stringify(tl) === JSON.stringify(buildTimeline(src)), 'projection is deterministic — same sources, byte-identical timeline');
  const dup = buildTimeline({ ...src, trials: [src.trials[0], { ...src.trials[0] }] });
  neg(dup.length === tl.length, 'duplicated source row cannot create a duplicate event (canonical ids dedupe)');
  ok(tl.every((e, i) => i === 0 || tl[i - 1].when.t >= e.when.t), 'strictly reverse-chronological');
  ok(tl.every((e) => e.id.startsWith('pev:') && e.source?.type), 'every event carries a canonical id and a source reference (§33/§34)');
  const c1join = tl.find((e) => e.id === evId('career', 'c1', 'club_joined'));
  ok(c1join?.when.precision === 'year' && whenDisplay(c1join.when) === '2019', 'year-only input STAYS year precision — no invented month/day (§86)');
  const c1left = tl.find((e) => e.id === evId('career', 'c1', 'club_left'));
  ok(c1left?.when.precision === 'month' && whenDisplay(c1left.when) === '2021-06', 'month input stays month precision');
  ok(tl.find((e) => e.id === evId('career', 'c2', 'club_joined'))?.provenance === 'guardian_submitted', 'guardian-submitted entry carries guardian provenance');
  neg(!tl.some((e) => e.source.id === 'c3'), 'withdrawn career entry emits nothing');
  ok(tl.some((e) => e.type === 'trial_attended') && tl.some((e) => e.type === 'trial_outcome'), 'trial produces trial_* events');
  neg(!tl.some((e) => e.type === 'club_joined' && e.source.type === 'trial'), 'a trial NEVER becomes a club_joined event (trial ≠ employment §10/§24)');
  neg(!tl.some((e) => e.source.id === 'e3'), 'superseded evidence emits no event (supersession honoured §85)');
  neg(!tl.some((e) => e.source.id === 'e2'), 'non-footage evidence stays in the summary, not the timeline');
  ok(tl.some((e) => e.type === 'signed' && e.provenance === 'verified_club_confirmed'), 'signing event is club-confirmed');
  neg(!tl.some((e) => e.source.id === 'ach2'), 'withdrawn achievement emits nothing');
  ok(tl.find((e) => e.type === 'position_change')?.when.precision === 'year', 'position history keeps source precision');
  // Date normalisation honesty:
  ok(normWhen('sometime in 2019') === null && normWhen('') === null && normWhen(null) === null, 'unparseable dates become null, never a guessed timestamp');
  ok(normWhen({ year: 2019 }).precision === 'year' && normWhen('2019-03').precision === 'month' && normWhen(Date.UTC(2019, 2, 5)).precision === 'day', 'three precision levels normalise as given');
}

// ===================================================================== U2
section('U2 — provenance & precedence (§8/§9/§57/§58)');
{
  ok(provRank('player_submitted') < provRank('scoutbox_reviewed')
    && provRank('scoutbox_reviewed') < provRank('verified_club_confirmed')
    && provRank('verified_club_confirmed') < provRank('authoritative_registry'), 'provenance vocabulary is rank-ordered for precedence only');
  ok(PROVENANCE.length === 8, 'exactly the eight mandated provenance values');
  ok(provenanceFromMethod('organisation_admin_confirmation') === 'verified_club_confirmed'
    && provenanceFromMethod('scoutbox_manual_review') === 'scoutbox_reviewed'
    && provenanceFromMethod('authoritative_registry') === 'authoritative_registry'
    && provenanceFromMethod('migration') === 'historical_migration'
    && provenanceFromMethod('unknown_thing') === 'system_recorded', 'M14 verification methods map onto Passport provenance');
  ok(PROVENANCE_COPY.player_submitted.includes('has not independently confirmed'), 'player-submitted copy is honest about non-verification');
  ok(PROVENANCE_COPY.scoutbox_reviewed.includes('not an independent register check'), 'ScoutBox review copy names its own limitation');

  const mk = (extra = {}) => ({ id: 's1', orgId: 'o9', orgName: 'Marsh Lane', ts: Date.UTC(2024, 4, 2), endedAt: null, ...extra });
  let h = clubHistory({ signingRows: [mk()], squads: [{ orgId: 'o9', orgName: 'Marsh Lane', rowId: 'sq', addedAt: Date.UTC(2024, 4, 3), orgVerified: true }] });
  ok(h.rows.length === 1 && h.rows[0].current && h.rows[0].provenance === 'verified_club_confirmed', 'signing yields ONE current club-confirmed row (squad row folded away)');
  h = clubHistory({ signingRows: [mk({ endedAt: Date.UTC(2025, 0, 10) })] });
  ok(!h.rows[0].current && whenDisplay(h.rows[0].to) === '2025-01-10', 'outcome-report end date closes the period');
  h = clubHistory({ signingRows: [mk({ orgSuspended: true })] });
  neg(!h.rows[0].current, 'a suspended organisation lends no CURRENT relationship — history preserved (§79#20)');
  h = clubHistory({ signingRows: [mk()], careerEntries: [{ id: 'c9', orgName: '  marsh LANE ', from: '2024', to: null, submittedBy: 'player' }] });
  ok(h.rows.length === 1 && h.foldedConflicts.length === 1 && h.foldedConflicts[0].entryId === 'c9', 'self entry duplicating an authoritative row folds into it (flagged, not duplicated)');

  const authRow = { key: 'k1', orgName: 'Marsh Lane', orgId: 'o9', role: null, from: normWhen('2024'), to: null, current: true, provenance: 'verified_club_confirmed', source: { type: 'signing', id: 's1' } };
  const selfRow = { key: 'k2', orgName: 'Sunday Kings', orgId: null, role: null, from: normWhen('2018'), to: null, current: true, provenance: 'player_submitted', source: { type: 'career_entry', id: 'c1' } };
  let st = currentStatus({ history: { rows: [authRow, selfRow], foldedConflicts: [] }, prefs: null });
  ok(st.currentClub.orgName === 'Marsh Lane' && st.conflicts[0]?.code === 'CURRENT_CLUB_CONFLICT', 'authoritative current wins display; player input becomes a FLAGGED conflict, never silently discarded (§57)');
  st = currentStatus({ history: { rows: [selfRow], foldedConflicts: [] }, prefs: null });
  ok(st.currentClub.orgName === 'Sunday Kings' && st.currentClub.provenance === 'player_submitted' && st.conflicts.length === 0, 'with no authoritative record, self entry displays under its own honest provenance');

  const flags = temporalConflicts({
    events: [
      { id: 'ev1', when: normWhen('2001') },
      { id: 'ev2', when: normWhen('2031') },
    ],
    history: [
      { key: 'h1', from: normWhen('2020'), to: normWhen('2018'), current: false, role: null, provenance: 'verified_club_confirmed' },
      { ...authRow, key: 'h2' }, { ...authRow, key: 'h3', orgName: 'Other FC' },
    ],
    dob: '2010-02-01',
  });
  ok(flags.some((f) => f.kind === 'before_dob' && f.eventId === 'ev1'), 'event before date of birth → TEMPORAL_CONFLICT flag');
  ok(flags.some((f) => f.kind === 'far_future' && f.eventId === 'ev2'), 'far-future event → TEMPORAL_CONFLICT flag');
  ok(flags.some((f) => f.kind === 'left_before_joined'), 'left-before-joined period flagged');
  ok(flags.some((f) => f.kind === 'overlapping_current_authoritative'), 'two authoritative current clubs flagged for review');
  neg(flags.every((f) => f.code === 'TEMPORAL_CONFLICT'), 'impossible chronology is a correction flag — NEVER an automatic fraud accusation (§58)');
}

// ===================================================================== U3
section('U3 — visibility, gaps and share primitives (§16/§14/§18)');
{
  neg(!viewerSees('public', 'recruitment') && !viewerSees('public', 'private') && !viewerSees('other_player', 'recruitment'), 'public/other-player viewers see ONLY public items');
  ok(viewerSees('pro_club', 'recruitment') && !viewerSees('pro_club', 'private') && !viewerSees('pro_club', 'guardian_only'), 'clubs see public+recruitment, never private/guardian layers');
  ok(viewerSees('guardian', 'guardian_only') && !viewerSees('self', 'guardian_only'), 'guardian-only layer reaches the guardian, not the player');
  neg(!viewerSees('guardian', 'trust_and_safety') && viewerSees('trust_safety', 'trust_and_safety'), 'trust_and_safety layer is T&S-only');

  const bad = { hasRecentFullMatch: false, fullMatchCount: 0, clipCount: 0, referenceCount: 0, hasConfirmedCurrentClub: false, hasRecentAssessment: false, hasPosition: false, hasAvailability: false, identityConfirmed: false, historyRows: 0 };
  const good = { hasRecentFullMatch: true, fullMatchCount: 2, clipCount: 3, referenceCount: 1, hasConfirmedCurrentClub: true, hasRecentAssessment: true, hasPosition: true, hasAvailability: true, identityConfirmed: true, historyRows: 3 };
  const cBad = completeness(bad); const cGood = completeness(good);
  ok(cBad.evidenceCoverage === 'limited' && cGood.evidenceCoverage === 'strong', 'coverage descriptors are words about evidence, never ability');
  ok(cBad.eligibility.total === GAP_RULES.length && cBad.eligibility.rulesVersion === GAP_RULES_VERSION && cBad.eligibility.satisfied === 0, 'eligibility preview counts EXACTLY the versioned generic rules — never club criteria (§15/§55)');
  ok(cGood.gaps.length === 0 && evaluateGaps(bad).length === GAP_RULES.length, 'gap engine is deterministic over facts');
  neg(!JSON.stringify(cBad).match(/"score"|rating/i), 'completeness output contains no score and no rating (§13/§36)');
  ok(JSON.stringify(evaluateGaps(bad)) === JSON.stringify(evaluateGaps({ ...bad })), 'same facts → same gaps (versioned, no AI)');

  // Projection units on a small assembled fixture.
  const mini = {
    player: { id: 'px', name: 'P X', age: 22, minor: false, position: 'ST', city: 'Testville', level: 'amateur' },
    identity: null,
    prefs: { bio: null, positions: null, availability: null, availableFrom: null, publicSelections: [], positionHistory: [] },
    history: { rows: [{ key: 'k1', orgId: 'o2', orgName: 'City Academy', role: null, from: normWhen('2023'), to: null, current: true, provenance: 'verified_club_confirmed', source: { type: 'signing', id: 's' } }], foldedConflicts: [] },
    status: { currentClub: { orgId: 'o2', orgName: 'City Academy', role: null, since: '2023', provenance: 'verified_club_confirmed', assurance: null }, positions: null, availability: null, availableFrom: null, representation: null, identity: null, conflicts: [] },
    timeline: buildTimeline({
      trials: [{ id: 't1', orgId: 'o2', orgName: 'City Academy', acceptedAt: Date.UTC(2023, 2, 1), proposedDate: '2023-03-10' }],
      assessments: [{ id: 'a1', orgId: 'o2', orgName: 'City Academy', submittedAt: Date.UTC(2023, 2, 20) }],
      references: [{ id: 'r1', coachName: 'Coach K', orgId: 'o2', orgName: 'City Academy', createdAt: Date.UTC(2023, 3, 1) }],
    }),
    temporalConflicts: [],
    evidenceSummary: { fullMatches: 1, clips: 0, assessments: 1, references: 1, lastEvidenceDays: 4, note: 'n' },
    references: [], achievements: [], developmentSummary: { active: 0, completed: 0 }, trialsSummary: { total: 1, withReport: 0 },
    completeness: cBad, sharingSummary: { active: 0 }, assessmentsForOrg: [], trialsForOrg: [],
  };
  const trialId = evId('trial', 't1', 'trial_attended');
  let pub = projectPassport(mini, 'public');
  neg(!pub.timeline.some((e) => e.id === trialId), 'trial participation is NOT public by default');
  pub = projectPassport({ ...mini, prefs: { ...mini.prefs, publicSelections: [trialId, evId('assessment', 'a1', 'assessment_completed'), evId('reference', 'r1', 'reference_received')] } }, 'public');
  ok(pub.timeline.some((e) => e.id === trialId), 'explicit selection makes a public-ELIGIBLE item public (opt-in)');
  neg(!pub.timeline.some((e) => e.type === 'assessment_completed') && !pub.timeline.some((e) => e.type === 'reference_received'), 'selecting a non-eligible item id surfaces NOTHING — selections narrow, never widen (§16/§79#23)');
  const own = projectPassport(mini, 'pro_club', { orgId: 'o2' });
  const other = projectPassport(mini, 'pro_club', { orgId: 'oZ' });
  ok(own.timeline.some((e) => e.type === 'assessment_completed') && own.timeline.some((e) => e.type === 'trial_attended'), 'assessing org sees its own assessment/trial events');
  neg(!other.timeline.some((e) => e.type === 'assessment_completed') && !other.timeline.some((e) => e.type === 'trial_attended'), 'another org NEVER sees them (own-org visibility §25/§79#13)');
  ok(projectPassport(mini, 'self').timeline.every((e) => e.source.id) && own.timeline.every((e) => e.source.id === undefined), 'raw source ids stay with self/guardian/T&S; org viewers get the source TYPE only');
  const minorMini = { ...mini, player: { ...mini.player, age: 14, minor: true } };
  neg(projectPassport(minorMini, 'pro_club', { orgId: 'o2' }).player.location === null
    && projectPassport(minorMini, 'public').player.location === null, "a minor's location is stripped from org and public projections (existing redaction policy)");

  const s1 = mintShareSecret(); const s2 = mintShareSecret();
  ok(s1.length >= 32 && s1 !== s2 && /^[A-Za-z0-9_-]+$/.test(s1), 'share secrets are high-entropy url-safe strings (24 random bytes)');
  ok(sha256(s1) === sha256(s1) && sha256(s1) !== sha256(s2), 'hash-at-rest is deterministic per secret');
  ok(JSON.stringify(SHARE_MODES) === JSON.stringify(['public', 'recruitment']), 'exactly two share modes');
  ok(shareProblem(null) === 'SHARE_UNKNOWN'
    && shareProblem({ revokedAt: 1 }) === 'SHARE_REVOKED'
    && shareProblem({ revokedAt: null, expiresAt: 5 }, { now: 10 }) === 'SHARE_EXPIRED'
    && shareProblem({ revokedAt: null, expiresAt: null }, { playerRemoved: true }) === 'SUBJECT_REMOVED'
    && shareProblem({ revokedAt: null, expiresAt: Date.now() + 1000 }) === null, 'share validation codes are exact (all collapse to 404 at the route)');
}

// ====================================================== HTTP scenarios
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const sam = await login('org-eastport', 'Sam Cole', 'Coach');
const alex = await login('org-northstar', 'Alex Agent', 'Agent');
const ruth = await login('org-harbour', 'Ruth Vane', 'Scout');
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok([maria, sam, alex, ruth, dee, kola, guni, amara].every((a) => a?.token), 'all actors logged in');
await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: maria.userId, reason: 'M15 suite root admin' }, null, A);

section('H1 — self passport: canonical projection, honest identity, no rating');
{
  const r = await j('GET', '/player/football-passport', undefined, kola.token);
  ok(r.status === 200 && r.body.viewer === 'self' && r.body.passportVersion === 1, 'self passport is one server-built projection');
  ok(r.body.identity?.assurance === 'scoutbox_document_review' && r.body.identity.label === 'Identity confirmed by ScoutBox review', 'identity header states EXACTLY what ScoutBox did (a document review)');
  neg(!JSON.stringify(r.body).includes('Government identity verified'), 'never claims government identity verification — no authoritative IDV is configured (§5A)');
  ok(r.body.note.includes('not a rating of football ability'), 'passport self-describes as evidence+provenance, not a rating (§36)');
  ok(r.body.status.currentClub === null, 'no invented current club before any confirmed relationship');
  ok(r.body.completeness.eligibility.total === GAP_RULES.length && r.body.completeness.gaps.some((g) => g.id === 'gap.current_club_confirmed'), 'gap engine speaks in generic versioned checks');
  neg(!/"score"/.test(JSON.stringify(r.body)), 'no numeric score anywhere in the self projection');
  const forged = await j('GET', '/player/football-passport?viewer=trust_safety&orgId=org-eastport', undefined, kola.token);
  neg(forged.body.viewer === 'self' && !('graph' in forged.body), 'viewer context comes from the SESSION — query-string viewer forging is inert (§79#9)');
}

section('H2 — preferences, career entries, date honesty');
let sundayKingsId;
{
  let r = await j('PATCH', '/player/football-passport/prefs', { availability: 'sometimes' }, kola.token);
  neg(r.status === 400 && r.body.error === 'AVAILABILITY_INVALID', 'availability is a coarse enum — free text refused');
  r = await j('PATCH', '/player/football-passport/prefs', { availability: 'open_to_trials', positions: { primary: 'ST', secondary: ['RW'] }, positionHistoryAdd: { from: '2020', primary: 'RW' } }, kola.token);
  ok(r.status === 200 && r.body.prefs.availability === 'open_to_trials', 'coarse availability + player-declared positions accepted');
  r = await j('PATCH', '/player/football-passport/prefs', { bio: 'DM me on WhatsApp 07700 900123' }, kola.token);
  neg(r.status === 400 && r.body.error === 'MODERATION_BLOCKED', 'bio goes through the EXISTING moderation pipeline (§41)');
  r = await j('PATCH', '/player/football-passport/prefs', { bio: 'Right-footed forward developing link-up play.' }, kola.token);
  ok(r.status === 200 && r.body.prefs.bio.includes('link-up'), 'clean bio accepted');

  r = await j('POST', '/player/football-passport/career', { orgName: 'Sunday Kings FC', role: 'ST', from: '2018' }, kola.token);
  ok(r.status === 201 && r.body.provenance === 'player_submitted' && r.body.note.includes('has not independently confirmed'), 'self career entry lands with honest provenance copy');
  sundayKingsId = r.body.entry.id;
  r = await j('POST', '/player/football-passport/career', { orgName: 'Riverside Colts', from: '2016-09', to: '2017' }, kola.token);
  ok(r.status === 201, 'month-precision history accepted as given');
  r = await j('POST', '/player/football-passport/career', { orgName: 'No Date FC' }, kola.token);
  neg(r.status === 400 && r.body.error === 'DATE_REQUIRED', 'no date → refused (a year is enough; nothing is invented)');
  r = await j('POST', '/player/football-passport/career', { orgName: 'Bad FC', from: 'sometime in 2019' }, kola.token);
  neg(r.status === 400, 'unparseable date refused, not silently normalised');

  r = await j('POST', '/player/football-passport/career', { orgName: 'Future FC', from: '2031' }, kola.token);
  const futureId = r.body.entry.id;
  let sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp.temporalConflicts.some((f) => f.kind === 'far_future'), 'far-future entry is FLAGGED for correction, not rejected as fraud (§58)');
  await j('POST', `/player/football-passport/career/${futureId}/withdraw`, {}, kola.token);
  sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(!sp.temporalConflicts.some((f) => f.kind === 'far_future'), 'withdrawing the entry auto-resolves the flag');
  const joined = sp.timeline.find((e) => e.type === 'club_joined' && e.title.org === 'Sunday Kings FC');
  ok(joined?.when.display === '2018' && joined.when.precision === 'year', 'timeline renders the year AS a year');
}

section('H3 — evidence integration: projection only, no file duplication');
{
  const r = await j('POST', '/player/evidence', { claimType: 'footage', label: 'Full match vs Harbour City U23' }, kola.token);
  ok(r.status === 201, 'footage evidence recorded through the EXISTING M12 route');
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp.evidence.fullMatches === 1 && sp.evidence.note.includes('not football ability'), 'evidence summary counts coverage, disclaims ability');
  const ev = sp.timeline.find((e) => e.type === 'evidence_added');
  ok(ev?.provenance === 'player_submitted' && ev.provenanceCopy.includes('has not independently confirmed'), 'self-reported footage says so');
  neg(!JSON.stringify(sp.timeline).match(/mediaIds|\/media\/|dataUrl/), 'timeline carries NO media ids and NO file URLs — files stay in their source system (§12, §79#14/#15)');
}

section('H4 — trials: own-org only, never employment');
let eastportName;
{
  let r = await j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Trial invitation for our U23 squad.', proposedDate: '2026-10-01', venue: 'Eastport Training Ground' }, maria.token);
  ok(r.status === 201 && r.body.routedTo === 'player', 'trial requested through the existing flow');
  r = await j('POST', `/player/requests/${r.body.requestId}/respond`, { accept: true, chosenSlot: '2026-10-01' }, kola.token);
  ok(r.status === 200, 'player accepts — a trial record now exists');
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp.timeline.some((e) => e.type === 'trial_attended'), 'self timeline shows the trial');
  neg(!sp.clubHistory.some((x) => /eastport/i.test(x.orgName ?? '')), 'the trial creates NO club-history row — a trial is never employment (§10)');
  const mine = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  eastportName = mine.body.status?.currentClub?.orgName ?? null; // still null here; org name captured later
  ok(mine.status === 200 && mine.body.trials.length === 1, 'trialling org sees its own trial in the recruitment passport');
  const theirs = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, ruth.token);
  neg(theirs.status === 200 && theirs.body.trials.length === 0 && !theirs.body.timeline.some((e) => e.type === 'trial_attended'), "another org sees NEITHER the trial list NOR trial events (§24, §79#13)");
}

section('H5 — assessments: own-org privacy, notes never travel');
{
  let r = await j('POST', '/org/assessments', { playerId: 'pl-adeyemi', positionGroup: 'ATT', context: { viewing: 'live', minutesWatched: 90 } }, maria.token);
  const ass = r.body.assessment;
  const attrs = ass.attributesSnapshot ?? [];
  r = await j('PUT', `/org/assessments/${ass.id}`, {
    ratings: attrs.slice(0, 1).map((a) => ({ attrId: a.id, rating: 4 })),
    recommendation: { verdict: 'monitor', reasons: 'Track for six months before deciding.' },
  }, maria.token);
  ok(r.status === 200, 'assessment rated');
  r = await j('POST', `/org/assessments/${ass.id}/submit`, {}, maria.token);
  ok(r.status === 200, 'assessment submitted');
  const mine = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  ok(mine.body.assessments.length === 1 && mine.body.assessments[0].state === 'submitted', 'assessing org sees its own assessment existence');
  const theirs = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, ruth.token);
  neg(theirs.body.assessments.length === 0 && !theirs.body.timeline.some((e) => e.type === 'assessment_completed'), "org B never sees org A's assessment (§25, §79#13)");
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(!JSON.stringify(sp).includes('Track for six months'), 'raw scout reasoning never reaches the player through the Passport');
  neg(!JSON.stringify(theirs.body).includes('Track for six months'), 'raw scout reasoning never reaches other orgs either');
}

section('H6 — coach reference: snapshot provenance survives departure (§26/§23)');
{
  const aff = await j('POST', '/org/verification/affiliation', { role: 'Coach' }, sam.token);
  await j('POST', '/org/verification/work-email', { email: 'sam.cole@eastportfc.com' }, sam.token);
  const code = await mailWith('sam.cole@eastportfc.com', /code is ([A-Za-z0-9_-]{8,})/);
  await j('POST', '/org/verification/work-email/confirm', { code }, sam.token);
  let r = await j('POST', `/org/verification/requests/${aff.body.affiliation.id}/decide`, { action: 'confirm' }, maria.token);
  ok(r.status === 200, 'coach affiliation verified (M14 flow)');
  r = await j('POST', '/org/verification/references', { playerId: 'pl-adeyemi', relationship: 'Head coach, two seasons', capacity: 'U23s', fromYear: 2023, toYear: 2025, strengths: 'Pressing triggers', development: 'Weak-foot delivery', summary: 'Reliable, coachable forward.' }, sam.token);
  ok(r.status === 201, 'verified coach submits a structured reference');
  let sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp.references[0]?.provenanceCopy.includes('affiliation is verified'), 'while the coach is current, the copy says the affiliation IS verified');
  r = await j('POST', `/org/verification/staff/${sam.userId}/departed`, {}, maria.token);
  ok(r.status === 200, 'coach recorded as departed');
  sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp.references[0]?.provenanceCopy === 'Coach affiliation was verified when this reference was submitted.', 'after departure the SNAPSHOT copy displays — the historical truth is never rewritten (§23/§85)');
  ok(sp.timeline.some((e) => e.type === 'reference_received' && e.provenance === 'verified_coach_confirmed'), 'reference event keeps coach-confirmed provenance');
}

section('H7 — conflict engine over HTTP: confirmed club vs player claim (§57)');
{
  const inv = await j('POST', '/org/verification/player-invites', { name: 'Kola Adeyemi', playerId: 'pl-adeyemi' }, maria.token);
  const r = await j('POST', '/player/invites/accept', { code: inv.body.code }, kola.token);
  ok(r.status === 200, 'player accepts the club squad invitation (M14 flow)');
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  eastportName = sp.status.currentClub?.orgName;
  ok(!!eastportName && sp.status.currentClub.provenance === 'verified_club_confirmed', 'confirmed relationship becomes the displayed current club');
  const conflict = sp.conflicts.find((c) => c.code === 'CURRENT_CLUB_CONFLICT');
  ok(conflict && conflict.submitted.orgName === 'Sunday Kings FC' && conflict.authoritative.orgName === eastportName, 'self view EXPLAINS the conflict with the still-open player entry');
  const orgView = (await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, ruth.token)).body;
  neg(!('conflicts' in orgView) && !JSON.stringify(orgView).includes('CURRENT_CLUB_CONFLICT'), 'conflict flags are for the player and T&S — never shown to recruiting orgs');
  const fold = await j('POST', '/player/football-passport/career', { orgName: eastportName, from: '2024' }, kola.token);
  ok(fold.status === 201, 'player also logs the same club as a career entry');
  const sp2 = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp2.foldedConflicts.length >= 1 && sp2.clubHistory.filter((x) => x.orgName === eastportName).length === 1, 'duplicate self entry folds into the authoritative row — one row, flagged fold (§10)');
}

section('H8 — achievements: forged provenance inert, confirmation upgrades (§27/§56)');
let confirmedAchEvId;
{
  let r = await j('POST', '/player/football-passport/achievements', {}, kola.token);
  neg(r.status === 400 && r.body.error === 'TITLE_REQUIRED', 'empty achievement refused');
  r = await j('POST', '/player/football-passport/achievements', { title: 'County Cup Winner 2024', when: '2024', provenance: 'verified_club_confirmed', confirmation: { provenance: 'authoritative_registry', orgName: 'FA' } }, kola.token);
  neg(r.status === 201 && r.body.provenance === 'player_submitted' && r.body.achievement.confirmation === null, 'client-asserted provenance/confirmation is IGNORED — new achievements are player-submitted (§79#16)');
  const achId = r.body.achievement.id;
  confirmedAchEvId = evId('achievement', achId, 'achievement');
  r = await j('POST', '/player/football-passport/achievements', { title: "Players' Player 2023", when: '2023' }, kola.token);
  const ach2 = r.body.achievement.id;
  r = await j('POST', `/org/players/pl-adeyemi/football-passport/achievements/${achId}/confirm`, {}, ruth.token);
  neg(r.status === 403 && r.body.error === 'ORG_NOT_ELIGIBLE', 'an UNVERIFIED organisation cannot confirm achievements');
  r = await j('POST', `/org/players/pl-adeyemi/football-passport/achievements/${achId}/confirm`, {}, maria.token);
  ok(r.status === 200 && r.body.achievement.confirmation.provenance === 'verified_club_confirmed', 'verified club confirmation upgrades provenance without rewriting the record');
  r = await j('POST', `/org/players/pl-adeyemi/football-passport/achievements/${achId}/confirm`, {}, maria.token);
  neg(r.status === 409, 'double confirmation conflicts');
  r = await j('POST', `/player/football-passport/achievements/${achId}/withdraw`, {}, kola.token);
  neg(r.status === 403 && r.body.error === 'CONFIRMED_RECORD', 'a CONFIRMED achievement cannot be deleted by the player — corrections instead (§21, §79#10)');
  r = await j('POST', `/player/football-passport/achievements/${ach2}/withdraw`, {}, kola.token);
  ok(r.status === 200, 'an unconfirmed self achievement remains withdrawable');
}

section('H9 — corrections: dispute flow, never direct edits (§22)');
{
  let r = await j('POST', '/player/football-passport/corrections', { targetType: 'weird' }, kola.token);
  neg(r.status === 400 && r.body.error === 'TARGET_INVALID', 'unknown correction target refused');
  r = await j('POST', '/player/football-passport/corrections', { targetType: 'club_history', targetId: 'row-eastport', reason: '' }, kola.token);
  neg(r.status === 400 && r.body.error === 'REASON_REQUIRED', 'a correction needs a reason');
  r = await j('POST', '/player/football-passport/corrections', { targetType: 'club_history', targetId: 'row-eastport', reason: 'Joined in August, the record says July.' }, kola.token);
  ok(r.status === 201 && r.body.note.includes('never silently edited'), 'correction filed — the record itself is untouched');
  const corrId = r.body.correction.id;
  r = await j('POST', `/player/football-passport/career/${corrId}/withdraw`, {}, kola.token);
  neg(r.status === 404, 'withdraw route only reaches OWN career entries — other records are out of scope (§79#11)');
  let list = await j('GET', '/admin/passport/corrections', undefined, null, A);
  ok(list.body.items.some((c) => c.id === corrId), 'T&S queue lists the open correction');
  r = await j('POST', `/admin/passport/corrections/${corrId}/resolve`, { resolution: 'maybe' }, null, A);
  neg(r.status === 400, 'resolution outcome must be explicit');
  r = await j('POST', `/admin/passport/corrections/${corrId}/resolve`, { resolution: 'corrected', reason: 'Date fixed after club confirmation.' }, null, A);
  ok(r.status === 200 && r.body.correction.status === 'resolved', 'T&S resolves with an attributed reason');
  r = await j('POST', `/admin/passport/corrections/${corrId}/resolve`, { resolution: 'rejected', reason: 'x' }, null, A);
  neg(r.status === 409, 'a resolved correction cannot be re-resolved');
}

section('H10 — representation (adults only) + signing');
let signingDone = false;
{
  let r = await j('POST', '/org/representation/propose', { playerId: 'pl-adeyemi', scope: 'contracts_only' }, alex.token);
  ok(r.status === 201, 'agency proposes representation to an adult (M13 flow)');
  r = await j('POST', `/player/representation/${r.body.representation.id}/confirm`, {}, kola.token);
  ok(r.status === 200, 'player confirms — representation active');
  const agView = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, alex.token);
  ok(agView.status === 200 && agView.body.viewer === 'agency' && !!agView.body.representation?.agencyName, 'agency passport view shows the (adult) representation status');
  r = await j('POST', '/org/players/pl-adeyemi/signing', {}, maria.token);
  ok(r.status === 201, 'club records the signing (existing route)');
  signingDone = true;
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp.status.currentClub?.provenance === 'verified_club_confirmed' && sp.timeline.some((e) => e.type === 'signed'), 'signing is a club-confirmed timeline event and current-club source');
  r = await j('GET', '/guardian/children/pl-adeyemi/football-passport', undefined, amara.token);
  neg(r.status === 403 && r.body.error === 'NOT_YOUR_CHILD', "a guardian cannot open an unrelated adult's passport");
}

section('H11 — public selections + public share (§17/§18/§46)');
let kolaPublicUrl;
{
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  const trialEv = sp.timeline.find((e) => e.type === 'trial_attended')?.id;
  const refEv = sp.timeline.find((e) => e.type === 'reference_received')?.id;
  const assEv = sp.timeline.find((e) => e.type === 'assessment_completed')?.id;
  let r = await j('PATCH', '/player/football-passport/prefs', { publicSelections: [trialEv, confirmedAchEvId, refEv, assEv, 'hist:Sunday Kings FC'] }, kola.token);
  ok(r.status === 200, 'player selects what may go public (including two ids that are NOT public-eligible)');
  r = await j('POST', '/player/football-passport/shares', { mode: 'public', expiresDays: 30 }, kola.token);
  ok(r.status === 201 && r.body.url.startsWith('/passport/shared/') && !JSON.stringify(r.body.share).match(/tokenHash|[a-f0-9]{64}/), 'share minted — the secret appears ONCE, never the stored hash');
  kolaPublicUrl = r.body.url;
  const pub = await j('GET', kolaPublicUrl);
  ok(pub.status === 200 && pub.body.viewer === 'public', 'anonymous link resolves to the SAFE PUBLIC projection');
  ok(typeof pub.body.player.age === 'number', 'public shows age…');
  const raw = JSON.stringify(pub.body);
  neg(!raw.includes('"dob"'), '…never the raw date of birth (§17/§87)');
  neg(!/guardian/i.test(raw), 'no guardian details in the public passport');
  neg(!raw.match(/mediaIds|\/media\/|dataUrl/), 'no media URLs or file references leak publicly (§79#21/#22)');
  neg(!raw.includes('Track for six months') && !pub.body.timeline.some((e) => e.type === 'assessment_completed'), 'no assessments and no scout reasoning publicly');
  neg(!pub.body.timeline.some((e) => e.type === 'reference_received'), 'selecting a reference id did NOT make it public (not public-eligible)');
  ok(pub.body.timeline.some((e) => e.type === 'trial_attended'), 'the explicitly selected trial participation IS public (opt-in)');
  ok(pub.body.achievements.some((a) => a.title.includes('County Cup') && a.provenance === 'verified_club_confirmed'), 'selected CONFIRMED achievement is public with its provenance');
  ok(pub.body.status.currentClub?.orgName === eastportName && Object.keys(pub.body.status).join(',') === 'currentClub', 'public status card = confirmed current club, nothing else');
  ok(pub.body.clubHistory.some((x) => x.orgName === 'Sunday Kings FC' && x.provenance === 'player_submitted'), 'opted-in self history row appears publicly WITH its honest provenance');
  neg(!raw.includes('agencyName'), 'representation never appears publicly (§17)');
  const shares = await j('GET', '/player/football-passport/shares', undefined, kola.token);
  ok(shares.body.items.length >= 1 && shares.body.items[0].views >= 1, 'player sees their shares and view counts');
}

section('H12 — recruitment share re-runs every gate; blocks hold (§20/§50)');
let kolaRecSecret;
{
  let r = await j('POST', '/player/football-passport/shares', { mode: 'recruitment' }, kola.token);
  kolaRecSecret = r.body.url.split('/').pop();
  const anon = await j('GET', `/passport/shared/${kolaRecSecret}`);
  neg(anon.status === 404, 'a recruitment link resolves NOWHERE anonymously (mode concealment, §79#24)');
  r = await j('GET', `/org/passport/shared/${kolaRecSecret}`, undefined, alex.token);
  ok(r.status === 200 && r.body.viewer === 'agency' && r.body.shareMode === 'recruitment', 'authenticated agency opens the recruitment share for an ADULT');
  r = await j('GET', `/org/passport/shared/${kolaRecSecret}?viewer=self&orgId=org-eastport`, undefined, ruth.token);
  neg(r.status === 200 && r.body.viewer === 'pro_club', 'query-string viewer/org forging on a share is inert — session decides (§79#25)');
  r = await j('POST', '/player/block', { orgId: 'org-harbour' }, kola.token);
  ok(r.status === 201, 'player blocks Harbour (existing route)');
  r = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, ruth.token);
  neg(r.status === 403 && r.body.error === 'NOT_VISIBLE', 'blocked org loses the recruitment passport instantly (§79#4)');
  r = await j('GET', `/org/passport/shared/${kolaRecSecret}`, undefined, ruth.token);
  neg(r.status === 403, 'the share link does NOT bypass the block — it locates, it never authorises');
}

section('H13 — minors: guardian control, agency wall, radius, redaction (§38–§40)');
{
  let r = await j('GET', '/guardian/children/pl-guni/football-passport', undefined, amara.token);
  ok(r.status === 200 && r.body.viewer === 'guardian' && r.body.identity?.assurance === 'scoutbox_document_review', "guardian sees the child's full passport");
  r = await j('POST', '/guardian/children/pl-guni/football-passport/career', { orgName: 'Hackney Youth', from: '2005' }, amara.token);
  ok(r.status === 201 && r.body.provenance === 'guardian_submitted', 'guardian-submitted history carries guardian provenance');
  r = await j('GET', '/guardian/children/pl-guni/football-passport', undefined, amara.token);
  ok(r.body.temporalConflicts.some((f) => f.kind === 'before_dob'), 'an entry before the child was born is flagged for correction, not silently accepted');
  r = await j('POST', '/player/football-passport/shares', { mode: 'public' }, guni.token);
  neg(r.status === 403 && r.body.error === 'GUARDIAN_MANAGED', "a minor cannot mint share links — sharing is guardian-controlled (§18, §79#12)");
  r = await j('GET', '/org/players/pl-guni/football-passport', undefined, alex.token);
  neg(r.status === 403 && r.body.error === 'UNDER_18_WALL', 'agency NEVER reaches a minor passport (§40, §79#1)');
  r = await j('GET', '/org/players/pl-guni/football-passport', undefined, ruth.token);
  neg(r.status === 403 && r.body.error === 'NOT_VISIBLE', 'unverified club never reaches a minor passport (§79#2)');
  r = await j('GET', '/org/players/pl-guni/football-passport', undefined, dee.token);
  ok(r.status === 200 && r.body.viewer === 'grassroots_club', 'verified LOCAL grassroots club sees the minor (standing rule, unchanged)');
  neg(r.body.player.location === null && !JSON.stringify(r.body).includes('"dob"'), "minor's location and DOB are stripped from every org view");
  r = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, dee.token);
  neg(r.status === 403, 'the 50 km grassroots radius holds for passports too (§39, §79#3)');
  r = await j('GET', '/org/players/pl-guni/football-passport', undefined, maria.token);
  ok(r.status === 200 && r.body.player.location === null, 'verified pro club sees the minor — still without location');

  r = await j('POST', '/guardian/children/pl-adeyemi/football-passport/shares', { mode: 'public' }, amara.token);
  neg(r.status === 403 && r.body.error === 'NOT_YOUR_CHILD', 'guardian share routes bind to the guardian’s OWN children only');
  r = await j('POST', '/guardian/children/pl-guni/football-passport/shares', { mode: 'recruitment' }, amara.token);
  const guniRec = r.body.url.split('/').pop();
  r = await j('GET', `/org/passport/shared/${guniRec}`, undefined, alex.token);
  neg(r.status === 403 && r.body.error === 'UNDER_18_WALL', 'a guardian-minted share still NEVER opens a minor to an agency (§79#7)');
  r = await j('GET', `/org/passport/shared/${guniRec}`, undefined, ruth.token);
  neg(r.status === 403, 'nor to an unverified club');
  r = await j('GET', `/org/passport/shared/${guniRec}`, undefined, dee.token);
  ok(r.status === 200 && r.body.viewer === 'grassroots_club', 'the SAME share works for an org that already passes every gate');

  r = await j('POST', '/guardian/children/pl-guni/football-passport/shares', { mode: 'public' }, amara.token);
  const guniPub = r.body.url;
  const shareId = r.body.share.id;
  const pub = await j('GET', guniPub);
  ok(pub.status === 200 && typeof pub.body.player.age === 'number', 'guardian-controlled public share shows the safe projection');
  neg(!JSON.stringify(pub.body).includes('London') && !JSON.stringify(pub.body).includes('"dob"'), "public share of a minor: no location, no DOB");
  r = await j('POST', `/guardian/children/pl-guni/football-passport/shares/${shareId}/revoke`, {}, amara.token);
  ok(r.status === 200, 'guardian revokes');
  const revoked = await j('GET', guniPub);
  const bogus = await j('GET', '/passport/shared/definitely-not-a-real-token-000');
  neg(revoked.status === 404 && bogus.status === 404 && JSON.stringify(revoked.body) === JSON.stringify(bogus.body), 'revoked link is INDISTINGUISHABLE from an unknown token (§79#6)');
}

section('H14 — suspended organisation lends no current relationship (§79#20)');
{
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: true }, null, A);
  let sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(sp.status.currentClub?.orgName !== eastportName && sp.status.currentClub?.provenance !== 'verified_club_confirmed',
    'while suspended, the org confers NO club-confirmed current club');
  ok(sp.status.currentClub?.orgName === 'Sunday Kings FC' && sp.status.currentClub.provenance === 'player_submitted' && sp.conflicts.length === 0,
    'display falls back to the self-declared entry under its own honest provenance');
  ok(sp.timeline.some((e) => e.type === 'signed'), 'the historical signing fact itself is preserved');
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: false }, null, A);
  sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(sp.status.currentClub?.orgName === eastportName && sp.status.currentClub.provenance === 'verified_club_confirmed', 'lifting the suspension restores the confirmed current club — nothing was destroyed');
}

section('H15 — batch summaries: light, gated, measured (§62/§63/§84)');
{
  const seedIds = ['pl-adeyemi', 'pl-carvalho', 'pl-okafor', 'pl-svensson', 'pl-martin', 'pl-tanaka', 'pl-alvarez', 'pl-nowak', 'pl-mensah', 'pl-kim', 'pl-guni', 'pl-imani', 'pl-tomasz', 'pl-osei', 'pl-fake'];
  const t0 = Date.now();
  let r = await j('GET', `/org/football-passports?ids=${seedIds.join(',')}`, undefined, maria.token);
  const ms = Date.now() - t0;
  ok(r.status === 200 && r.body.items.length > 5, `batch summary returns (${r.body.items.length} players in ${ms}ms)`);
  ok(ms < 500, `batch of ${seedIds.length} ids completes in <500ms (measured ${ms}ms — light assembly, no timelines)`);
  neg(!r.body.items.some((i) => i.playerId === 'pl-fake'), 'unknown ids are silently absent — concealment by omission');
  neg(r.body.items.every((i) => !('timeline' in i) && !('dob' in i)), 'summaries carry NO timelines and NO DOB');
  ok(r.body.items.some((i) => i.playerId === 'pl-guni'), 'verified pro club batch includes visible minors');
  const kolaRow = r.body.items.find((i) => i.playerId === 'pl-adeyemi');
  ok(kolaRow?.currentClub?.provenance === 'verified_club_confirmed' && typeof kolaRow.evidenceCoverage === 'string', 'summary rows carry provenance-tagged club + coverage descriptor');
  r = await j('GET', `/org/football-passports?ids=${seedIds.join(',')}`, undefined, alex.token);
  neg(!r.body.items.some((i) => ['pl-guni', 'pl-tomasz'].includes(i.playerId)), 'agency batch NEVER contains minors — same wall, no error leak');
}

section('H16 — deletion: shares die with the subject (§79#19/§89)');
{
  const signup = await j('POST', '/auth/player/signup', { name: 'Bob Forward', dob: '1995-05-05', country: 'GB', position: 'ST', password: 'longenough1' });
  const bob = signup.body?.token ? signup.body : (await j('POST', '/auth/player/login', { playerId: signup.body.playerId })).body;
  ok(!!bob?.token, 'second adult player exists');
  await j('POST', '/player/football-passport/career', { orgName: 'Dockside Rovers', from: '2015' }, bob.token);
  let r = await j('POST', '/player/football-passport/shares', { mode: 'public' }, bob.token);
  const bobUrl = r.body.url;
  r = await j('GET', bobUrl);
  ok(r.status === 200 && r.body.player.name === 'Bob Forward', "Bob's token resolves to Bob");
  const crossed = await j('GET', `${bobUrl}?playerId=pl-adeyemi&viewer=self`);
  neg(crossed.body.player.id === r.body.player.id && crossed.body.viewer === 'public', "token A can never be steered to player B or a wider view (§79#8)");
  r = await j('DELETE', '/player/account', undefined, guni.token);
  neg(r.status === 403 && r.body.error === 'GUARDIAN_MANAGED', 'a minor cannot delete the account (existing guardian-managed rule)');
  r = await j('DELETE', '/player/account', undefined, bob.token);
  ok(r.status === 200, 'adult deletes their account (existing route)');
  const gone = await j('GET', bobUrl);
  const bogus = await j('GET', '/passport/shared/also-not-a-token-1234567890');
  neg(gone.status === 404 && JSON.stringify(gone.body) === JSON.stringify(bogus.body), "a removed subject's share is dead AND indistinguishable from unknown (§79#19)");
}

section('H17 — audit + metrics honesty (§51/§52/§64)');
{
  const ledger = await j('GET', '/org/ledger', undefined, maria.token);
  ok(ledger.body.some((l) => l.type === 'passport_recruitment_view' && l.playerId === 'pl-adeyemi'), 'recruitment passport views land in the existing ledger');
  const m = await j('GET', '/admin/metrics', undefined, null, A);
  const p = m.body.passport;
  ok(p && p.views_self > 0 && p.views_recruitment > 0 && p.share_created >= 4 && p.share_opened_public > 0 && p.correction_filed > 0 && p.achievement_confirmed > 0, 'passport product metrics count events');
  neg(!JSON.stringify(p).includes('pl-') && Object.values(p).every((v) => typeof v === 'number'), 'metrics are pure counters — no player ids, no recruiter identities (§51/§52)');
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(!JSON.stringify(sp).match(/scoutName|Maria Keane|Ruth Vane/), 'the player never learns WHICH scout viewed them through the Passport');
}

// Token enumeration LAST — it deliberately exhausts the per-IP rate window.
section('H18 — share token enumeration hits the rate limit (§79#5)');
{
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    const r = await j('GET', `/passport/shared/guess-${i}-abcdefghijklmnop`);
    statuses.push(r.status);
  }
  neg(!statuses.includes(200), 'guessing never resolves a passport');
  neg(statuses.includes(404) && statuses.includes(429) && statuses.at(-1) === 429, 'enumeration starts as concealed 404s and ends rate-limited (429) well before the keyspace matters');
}

const ratio = Math.round((negatives / passed) * 100);
console.log(`\nM15 acceptance suite: ${passed} checks passed, ${negatives} negative/abuse checks (${ratio}% of all checks)${process.exitCode ? ' (WITH FAILURES)' : ''}`);
if (negatives * 3 < passed) { console.error('✗ negative-test ratio below one third'); process.exitCode = 1; }
process.exit(process.exitCode ?? 0);
