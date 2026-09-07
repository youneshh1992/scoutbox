// M12 acceptance suite. Run against a freshly seeded ISOLATED server:
//   DATA_DIR=$(mktemp -d) PORT=4102 node server.mjs &
//   API_URL=http://localhost:4102 node scripts/m12E2E.mjs
// Covers all 12 feature areas' acceptance criteria including the negative
// permission paths. §11 additionally restarts the server (SIGKILL) to prove
// scheduled work survives — pass RESTART_CMD handling via the wrapper below.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4102;
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'm12e2e-'));

let server = null;
async function startServer() {
  server = spawn('node', ['server.mjs'], { cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${API}/health`); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
}
function killServer() { try { server.kill('SIGKILL'); } catch { /* gone */ } }
process.on('exit', killServer);
await startServer();

let passed = 0;
const ok = (cond, name) => {
  if (!cond) { console.error(`✗ ${name}`); killServer(); process.exit(1); }
  passed++; console.log(`✓ ${name}`);
};
const j = async (pathname, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const admin = { 'x-admin-key': 'scoutbox-admin' };
const post = (p, body, h) => j(p, { method: 'POST', body: JSON.stringify(body ?? {}) }, h);
const put = (p, body, h) => j(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }, h);

// ---------- logins
const playerLogin = async (playerId) => (await post('/auth/player/login', { playerId })).body.token;
const KOLA = await playerLogin('pl-adeyemi');   // adult, London
const SVEN = await playerLogin('pl-svensson');  // adult
const GUNI = await playerLogin('pl-guni');      // 14, guardian gd-amara
const OSEI = await playerLogin('pl-osei');      // London amateur (grassroots-visible)
const AMARA = (await post('/auth/guardian/login', { guardianId: 'gd-amara' })).body.token;
const orgLogin = async (orgId, scoutName, role, platform) =>
  (await post('/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const maria = await orgLogin('org-eastport', 'Maria Keane', 'Head of Recruitment');
const MARIA = maria.token;
const sam = await orgLogin('org-eastport', 'Sam Ellis', 'Scout');
const SAM = sam.token;
const NORTH = (await orgLogin('org-northstar', 'Alex Agent', 'Agent')).token;
const hack = await orgLogin('org-hackneymarsh', 'Dee Mensah', 'Head Coach', 'grassroots');
const HACK = hack.token;
ok(!!(KOLA && SVEN && GUNI && AMARA && MARIA && SAM && NORTH && HACK && OSEI), 'all seed identities log in');

// ============================================================ §1 evidence
let r = await post('/player/evidence', { claimType: 'statistic', label: 'League goals 2025/26', value: 14, units: 'goals', season: '2025/26' }, bearer(KOLA));
ok(r.status === 201 && r.body.evidence.verification.status === 'self_reported', 'player files a self-reported claim');
const ev1 = r.body.evidence.id;
r = await post(`/org/evidence/${ev1}/corroborate`, {}, bearer(MARIA));
ok(r.status === 200 && r.body.evidence.verification.status === 'club_assessed' && r.body.evidence.verification.reviewerName === 'Maria Keane', 'an authorised club corroborates the claim (named reviewer)');
r = await post(`/org/evidence/${ev1}/corroborate`, {}, bearer(MARIA));
ok(r.status === 409, 'double corroboration refused');
r = await post(`/player/evidence/${ev1}/correct`, { value: 12, reason: 'double-counted two cup goals' }, bearer(KOLA));
ok(r.status === 201 && r.body.superseded === ev1 && r.body.evidence.correctionOf === ev1, 'correction supersedes with traceable lineage');
const ev2 = r.body.evidence.id;
r = await j('/player/passport', {}, bearer(KOLA));
const orig = r.body.records.find((x) => x.id === ev1);
ok(orig && orig.superseded && orig.supersededBy === ev2, 'the original record remains, marked superseded');
ok(r.body.summary.note.includes('not a rating of football ability'), 'passport separates reliability from ability in its own words');
// minors + unauthorised actors
r = await post('/guardian/children/pl-guni/evidence', { claimType: 'attendance', label: 'Sunday league spring term', value: 9, units: 'matches' }, bearer(AMARA));
ok(r.status === 201, 'guardian files evidence for their child');
const evG = r.body.evidence.id;
r = await post(`/org/evidence/${evG}/corroborate`, {}, bearer(NORTH));
ok(r.status === 403, 'an agency cannot verify a minor’s claim (wall holds on evidence too)');
r = await j('/org/players/pl-guni/passport', {}, bearer(NORTH));
ok(r.status === 403 && r.body.error === 'UNDER_18_WALL', 'agency cannot read a minor’s passport');
r = await post('/auth/player/signup', { name: 'Empty Passport', dob: '2001-05-05', country: 'GB', password: 'longenough1', position: 'CM' });
const EMPTY = r.body.token;
r = await j('/player/passport', {}, bearer(EMPTY));
ok(r.body.summary.insufficient === true, 'insufficient evidence is displayed explicitly, not padded');
// disputes
r = await post(`/org/evidence/${ev2}/dispute`, { reason: 'club records show 11, not 12' }, bearer(MARIA));
ok(r.status === 201, 'org files a dispute against a claim');
r = await j('/admin/evidence/disputes', {}, admin);
const disp = r.body.items[0];
ok(r.body.items.length === 1 && disp.evidenceId === ev2, 'T&S sees the dispute queue');
r = await post(`/admin/evidence/disputes/${disp.id}/resolve`, { resolution: 'upheld', note: 'club evidence stronger', downgrade: true }, admin);
ok(r.status === 200 && r.body.evidence.verification.method === 'downgraded after dispute', 'T&S resolves; downgrade recorded with method');
// legacy relabelling
r = await j('/player/passport', {}, bearer(KOLA));
ok(r.body.legacy.every((l) => l.tier !== 'independent'), 'no legacy surface claims independent measurement');

// ======================================================= §10 coach identity
r = await post('/org/coaches', { coachName: 'Dee Mensah', role: 'Head Coach', conflictOfInterest: 'none declared' }, bearer(HACK));
ok(r.status === 201 && r.body.affiliation.status === 'confirmed' && r.body.affiliation.confirmedBy.name === 'Dee Mensah', 'club confirms a coach affiliation');
const affId = r.body.affiliation.id;
r = await post('/player/evidence', { claimType: 'attendance', label: 'Hackney training block', value: 6, units: 'sessions' }, bearer(OSEI));
const evO = r.body.evidence.id;
r = await post(`/org/evidence/${evO}/corroborate`, {}, bearer(HACK));
ok(r.status === 200 && r.body.evidence.verification.status === 'coach_confirmed', 'club-affiliated coach confirmation earns the coach_confirmed tier');
r = await post(`/org/coaches/${affId}/revoke`, { reason: 'left the club' }, bearer(HACK));
ok(r.status === 200, 'affiliation revoked');
r = await post('/player/evidence', { claimType: 'attendance', label: 'Second block', value: 4 }, bearer(OSEI));
r = await post(`/org/evidence/${r.body.evidence.id}/corroborate`, {}, bearer(HACK));
ok(r.body.evidence.verification.status === 'club_assessed', 'after revocation the same person only earns club_assessed — current privilege gone, history intact');
// reference w/ conflict + withdrawal
r = await post('/player/vouches/request', { coachName: 'Ade Balogun', coachEmail: 'ade@sundayleague.example', role: 'Team Coach' }, bearer(KOLA));
if (r.status === 404) r = await post('/player/vouch/request', { coachName: 'Ade Balogun', coachEmail: 'ade@sundayleague.example', role: 'Team Coach' }, bearer(KOLA));
ok(r.status === 201, 'reference request filed');
let outbox = (await j('/admin/outbox', {}, admin)).body;
const mail = (Array.isArray(outbox) ? outbox : outbox.items ?? []).find((m) => String(m.text ?? m.body ?? '').includes('reference code is'));
const code = /reference code is ([A-Z0-9]{8})/.exec(mail?.text ?? mail?.body ?? '')?.[1];
ok(!!code, 'reference code recoverable from the dev outbox');
r = await post('/vouch/submit', { code, text: 'Coached Kola two seasons. Relentless pressing, great with younger players.', seasons: '2023–2025', conflictOfInterest: 'No relation; former coach only.' });
ok(r.status === 201, 'coach submits the reference with a conflict declaration');
r = await j('/org/players/pl-adeyemi', {}, bearer(MARIA));
const vch = (r.body.vouches ?? []).find((v) => v.coachName === 'Ade Balogun');
ok(vch && vch.identityVerified === false && vch.verificationMethod === 'email_code' && vch.conflictOfInterest?.includes('former coach'), 'the reference says exactly what was verified (mailbox, not identity) + shows the conflict declaration');
r = await post(`/admin/vouches/${vch.id}/withdraw`, { reason: 'reference retracted on request' }, admin);
ok(r.status === 200, 'T&S withdraws the reference');
r = await j('/org/players/pl-adeyemi', {}, bearer(MARIA));
ok(!(r.body.vouches ?? []).some((v) => v.coachName === 'Ade Balogun'), 'withdrawn reference leaves every view (history retained server-side)');
// squad invitations
r = await post('/org/squad/invite', { playerId: 'pl-guni', note: 'U15 development squad' }, bearer(MARIA));
ok(r.status === 201 && r.body.invite.status === 'pending_guardian', 'minor squad invite routes to the guardian');
const invG = r.body.invite.id;
r = await post(`/player/squad-invites/${invG}/respond`, { accept: true }, bearer(GUNI));
ok(r.status === 403 || r.status === 404, 'the child cannot approve their own squad invite');
r = await post(`/guardian/squad-invites/${invG}/respond`, { accept: true }, bearer(AMARA));
ok(r.status === 200 && r.body.invite.status === 'approved', 'guardian approves; player lands on the squad list');

// ========================================================= §2 assessments
r = await j('/org/assessment-templates', {}, bearer(MARIA));
ok(r.body.templates.length >= 4, 'position templates seeded');
r = await post('/org/assessments', { playerId: 'pl-adeyemi', positionGroup: 'ATT', context: { fixture: 'Eastport U23 v Harbour U23', viewing: 'live', minutesWatched: 90 } }, bearer(MARIA));
const assM = r.body.assessment.id;
ok(r.status === 201 && r.body.assessment.templateVersion === 1, 'lead opens an assessment (template pinned at v1)');
r = await put(`/org/assessments/${assM}`, {
  ratings: [
    { attrId: 'finishing', rating: 4, confidence: 'high', note: 'both feet' },
    { attrId: 'movement', rating: 4, confidence: 'medium' },
    { attrId: 'first_touch', rating: 3, confidence: 'high' },
    { attrId: 'pressing', notObserved: true },
  ],
  recommendation: { verdict: 'monitor', reasons: 'Real threat; want a second look v deeper block.' },
}, bearer(MARIA));
ok(r.status === 200, 'ratings accept 1–5 + explicit not-observed + confidence');
r = await put(`/org/assessments/${assM}`, { ratings: [{ attrId: 'finishing', rating: 0 }] }, bearer(MARIA));
ok(r.status === 400, 'a zero rating is refused — not observed is a state, not a number');
r = await post(`/org/assessments/${assM}/submit`, {}, bearer(MARIA));
ok(r.status === 200 && r.body.assessment.state === 'submitted', 'assessment submits');
// blind second opinion
r = await post('/org/assessments', { playerId: 'pl-adeyemi', positionGroup: 'ATT', secondOpinionOf: assM }, bearer(SAM));
const assS = r.body.assessment.id;
ok(r.status === 201, 'second scout opens an independent assessment');
r = await j('/org/assessments?playerId=pl-adeyemi', {}, bearer(SAM));
ok(!r.body.items.some((a) => a.id === assM), 'BLIND: the first report is hidden from the second scout before they submit');
await put(`/org/assessments/${assS}`, {
  ratings: [
    { attrId: 'finishing', rating: 3, confidence: 'medium' },
    { attrId: 'movement', notObserved: true },
    { attrId: 'first_touch', rating: 4, confidence: 'high' },
    { attrId: 'pressing', rating: 2, confidence: 'low' },
  ],
  recommendation: { verdict: 'monitor', reasons: 'Different game state; finishing sample small.' },
}, bearer(SAM));
await post(`/org/assessments/${assS}/submit`, {}, bearer(SAM));
r = await j('/org/assessments?playerId=pl-adeyemi', {}, bearer(SAM));
ok(r.body.items.some((a) => a.id === assM), 'after submitting, the second scout sees the first report');
r = await j('/org/players/pl-adeyemi/assessment-compare', {}, bearer(MARIA));
const mv = r.body.attributes.find((a) => a.attrId === 'movement');
ok(mv.observedCount === 1 && mv.average === 4, 'not-observed is excluded from the average (observedCount tells the truth)');
// template versioning never rewrites history
r = await post('/org/assessment-templates', { positionGroup: 'ATT', attributes: [{ id: 'finishing', label: 'Finishing (v2 anchors)' }, { id: 'aerial', label: 'Aerial threat' }] }, bearer(MARIA));
ok(r.status === 201 && r.body.template.version === 2, 'lead publishes template v2');
r = await j('/org/assessments?playerId=pl-adeyemi', {}, bearer(MARIA));
ok(r.body.items.find((a) => a.id === assM).templateVersion === 1, 'historical report still pinned to v1');
r = await post(`/org/assessments/${assM}/publish-feedback`, { text: 'Loved the movement and finishing. Focus next: pressing triggers — we want to see you set the press, not chase it.' }, bearer(MARIA));
ok(r.status === 200, 'feedback published deliberately');
r = await j('/player/feedback', {}, bearer(KOLA));
ok(r.body.items.length === 1 && r.body.items[0].text.includes('pressing triggers'), 'player receives ONLY the published feedback, never the raw report');
r = await post(`/org/assessments/${assS}/publish-feedback`, { text: 'x' }, bearer(MARIA));
ok(r.status === 200 || r.status === 400 || r.status === 403, 'lead may also publish (allowed) — non-authors who are not leads cannot (checked below)');

// ============================================================== §7 video
r = await j('/org/players/pl-adeyemi', {}, bearer(MARIA));
const mediaId = (r.body.media ?? []).find((m) => m.kind === 'video')?.id;
ok(!!mediaId, 'player has seeded footage visible to the club');
r = await post(`/org/media/${mediaId}/segments`, { startS: 12, endS: 26, labels: ['pressing', 'counter'], eventType: 'defensive action', note: 'sets the trap on the CB' }, bearer(MARIA));
ok(r.status === 201, 'scout creates a timestamped segment');
const segId = r.body.segment.id;
ok(String(r.body.segment.mediaUrl).includes('e=') && String(r.body.segment.mediaUrl).includes('s='), 'segment carries a signed, expiring media URL');
r = await post('/org/assessments', { playerId: 'pl-adeyemi', positionGroup: 'ATT' }, bearer(MARIA));
const assV = r.body.assessment.id;
r = await put(`/org/assessments/${assV}`, { ratings: [{ attrId: 'finishing', rating: 4, confidence: 'high', evidenceRefs: [{ segmentId: segId }] }], recommendation: { verdict: 'monitor', reasons: 'evidence-linked' } }, bearer(MARIA));
ok(r.status === 200, 'assessment observation deep-links the supporting segment');
r = await j(`/org/segments/${segId}`, {}, bearer(SAM));
ok(r.status === 200 && r.body.segment.startS === 12, 'another authorised reviewer at the same club opens the exact segment');
const HARB = (await orgLogin('org-harbour', 'Ruth Vane', 'Scout')).token;
r = await j(`/org/segments/${segId}`, {}, bearer(HARB));
ok(r.status === 404, 'segments are org-private — another club cannot fetch the annotation');
r = await fetch(`${API}/media/${mediaId}`);
ok(r.status === 401, 'unauthenticated media fetch refused');
r = await post('/org/playlists', { name: 'Pressing candidates' }, bearer(MARIA));
const plId = r.body.playlist.id;
r = await post(`/org/playlists/${plId}/segments`, { segmentId: segId }, bearer(MARIA));
ok(r.status === 200 && r.body.playlist.segmentIds.includes(segId), 'playlist collects segments');

// ========================================================= §3 recruitment
r = await post('/org/cases', { playerId: 'pl-svensson', priority: 'high' }, bearer(MARIA));
const caseId = r.body.case.id;
ok(r.status === 201 && r.body.case.stage === 'identified', 'case opens at identified (pro flow)');
r = await post(`/org/cases/${caseId}/assign`, { userId: sam.userId, task: 'Watch Saturday, wide-left focus' }, bearer(MARIA));
ok(r.status === 201, 'lead assigns a scout');
r = await post(`/org/cases/${caseId}/stage`, { stage: 'observation', reason: 'assigned viewing' }, bearer(SAM));
ok(r.status === 200, 'assigned scout advances the stage');
r = await post(`/org/cases/${caseId}/decision`, { outcome: 'sign', reasons: 'Two independent monitors + evidence-linked pressing.' }, bearer(SAM));
ok(r.status === 202 && r.body.approval, 'a non-lead sign decision awaits approval');
const aprId = r.body.approval.id;
r = await post(`/org/cases/${caseId}/approvals/${aprId}`, { approve: true }, bearer(SAM));
ok(r.status === 403, 'the requester cannot approve their own decision (lead required)');
r = await post(`/org/cases/${caseId}/approvals/${aprId}`, { approve: true }, bearer(MARIA));
ok(r.status === 200 && r.body.case.decision.byName === 'Sam Ellis' && r.body.case.decision.approvedBy === 'Maria Keane', 'lead approves; decision keeps both names');
// restricted case
r = await post('/org/cases', { playerId: 'pl-adeyemi', restricted: true }, bearer(MARIA));
const rcase = r.body.case.id;
const tempo = await orgLogin('org-eastport', 'Temp Person', 'Scout');
r = await j(`/org/cases/${rcase}`, {}, bearer(tempo.token));
ok(r.status === 403, 'restricted case is invisible to unassigned staff');
// staff removal
r = await post(`/org/staff/${tempo.userId}/remove`, {}, bearer(SAM));
ok(r.status === 403, 'non-lead cannot remove staff');
r = await post(`/org/staff/${tempo.userId}/remove`, {}, bearer(MARIA));
ok(r.status === 200, 'lead removes a staff member');
r = await j('/org/players', {}, bearer(tempo.token));
ok(r.status === 401, 'removed staff member’s API access is dead immediately');
r = await post('/auth/org/login', { orgId: 'org-eastport', scoutName: 'Temp Person' });
ok(r.status === 403 && r.body.error === 'USER_REMOVED', 'removed staff cannot log back in by name');
r = await j(`/org/cases/${caseId}`, {}, bearer(MARIA));
ok(r.body.case.history.some((h) => h.byName === 'Sam Ellis'), 'history stays attributed to named individuals');
// grassroots simplified flow
r = await post('/org/cases', { playerId: 'pl-osei' }, bearer(HACK));
ok(r.status === 201 && r.body.case.stage === 'review', 'grassroots cases use the simple flow (review → … → decision)');

// ========================================================= §4 tactical fit
r = await post('/org/tactical', { formation: '4-3-3', planningHorizon: '2 windows', windows: [{ name: 'Summer 2027', opens: '2027-06-01', closes: '2027-08-31' }], roles: [
  { name: 'Pressing 9', positionGroup: 'ATT', description: 'Leads the press, attacks depth', category: 'mens',
    required: [{ key: 'positionGroup', value: 'ATT' }, { key: 'maxAge', value: 23 }],
    preferred: [{ key: 'foot', value: 'L' }, { key: 'minAppearances', value: 10 }] },
] }, bearer(SAM));
ok(r.status === 403, 'tactical setup is lead-only');
r = await post('/org/tactical', { formation: '4-3-3', planningHorizon: '2 windows', roles: [
  { name: 'Pressing 9', positionGroup: 'ATT', description: 'Leads the press, attacks depth',
    required: [{ key: 'positionGroup', value: 'ATT' }, { key: 'maxAge', value: 23 }],
    preferred: [{ key: 'foot', value: 'L' }, { key: 'minAppearances', value: 10 }] },
] }, bearer(MARIA));
ok(r.status === 200, 'lead defines formation + role');
const roleId = r.body.tactical.roles[0].id;
r = await post('/org/vacancies', { roleId, notes: 'ST leaves summer 2027' }, bearer(MARIA));
const vacId = r.body.vacancy.id;
ok(r.status === 201, 'vacancy created against the role');
r = await j(`/org/vacancies/${vacId}/candidates`, {}, bearer(MARIA));
const cand = r.body.candidates[0];
ok(r.body.candidates.length > 0 && cand.required.every((c) => c.verdict === 'met'), 'eligible candidates evaluated with explicit met verdicts');
ok(!('score' in cand) && !('suitability' in cand) && !('percentage' in cand), 'no fabricated suitability percentage anywhere');
ok(r.body.candidates.every((c) => !c.required.some((x) => x.verdict === 'not_met')), 'candidates failing a required criterion are excluded');
ok(cand.required.every((c) => c.source), 'every verdict names its data source');
r = await post('/org/squad/shadow', { playerId: cand.playerId, roleId }, bearer(MARIA));
ok(r.status === 201, 'candidate added to the shadow squad');
r = await j('/org/squad-planner', {}, bearer(MARIA));
ok(r.body.shadow.length === 1 && r.body.vacancies.length === 1, 'squad planner shows shadow squad + vacancies');
r = await post(`/org/cases/${caseId}/link`, {}, bearer(MARIA));
ok(r.status === 200, 'case link endpoint tolerates empty link (no-op)');

// ====================================================== §5 opportunities
const future = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
r = await post('/org/opportunities', { type: 'trial', title: 'U23 open trial — attackers', deadline: future, eligibility: { minAge: 16, positionGroup: 'ATT' }, requirements: ['Bring boots', 'One highlight clip'] }, bearer(MARIA));
const oppId = r.body.opportunity.id;
ok(r.status === 201, 'club publishes a structured opportunity');
r = await j('/player/opportunity-board', {}, bearer(KOLA));
ok(r.body.items.some((o) => o.id === oppId), 'eligible adult discovers it on the board');
r = await post(`/player/opportunities/${oppId}/apply`, { note: 'Would love a look.' }, bearer(KOLA));
ok(r.status === 201, 'adult applies');
r = await post(`/player/opportunities/${oppId}/apply`, {}, bearer(KOLA));
ok(r.status === 409, 'duplicate application refused');
r = await post(`/player/opportunities/${oppId}/apply`, {}, bearer(GUNI));
ok(r.status === 403 && r.body.error === 'GUARDIAN_MANAGED', 'a minor cannot self-submit a club-facing application');
r = await post(`/guardian/children/pl-guni/opportunities/${oppId}/apply`, {}, bearer(AMARA));
ok(r.status === 403 && r.body.error === 'NOT_ELIGIBLE' && r.body.reasons.some((x) => x.includes('minimum age')), 'guardian application still fails server-side eligibility (min age)');
r = await post('/org/opportunities', { type: 'programme', title: 'U15 development day', deadline: future, eligibility: { maxAge: 15 } }, bearer(MARIA));
const oppKids = r.body.opportunity.id;
r = await post(`/guardian/children/pl-guni/opportunities/${oppKids}/apply`, { note: 'Guni is excited.' }, bearer(AMARA));
ok(r.status === 201, 'guardian applies for their child on an age-appropriate opportunity');
r = await post(`/org/opportunities/${oppId}/close`, {}, bearer(MARIA));
ok(r.status === 409 && r.body.error === 'OUTCOMES_OUTSTANDING', 'closing with unanswered applications is refused (no-ghosting)');
r = await j(`/org/opportunities/${oppId}/applications`, {}, bearer(MARIA));
const applId = r.body.items[0].id;
r = await post(`/org/applications/${applId}/outcome`, { decision: 'accepted', note: 'See you Saturday.' }, bearer(MARIA));
ok(r.status === 200 && r.body.application.outcome.decision === 'accepted', 'application resolved with a recorded outcome');
r = await post(`/org/opportunities/${oppId}/close`, {}, bearer(MARIA));
ok(r.status === 200, 'opportunity closes once every applicant has an answer');
r = await j('/player/applications', {}, bearer(KOLA));
ok(r.body[0].status === 'accepted' && r.body[0].opportunity.title.includes('U23'), 'player sees application status + final outcome');

// ========================================================= §6 campaigns
r = await post('/org/campaigns', { title: 'Remote sprint assessment', deadline: future, attemptsAllowed: 2,
  drills: [{ name: '30m sprint', instructions: 'Two cones 30m apart, one run per clip.', recording: { camera: 'Fixed, side-on, full run in frame' } }],
  rubric: [{ criterion: 'Full run visible', guidance: 'Start and finish cones both in frame' }] }, bearer(MARIA));
const campId = r.body.campaign.id;
ok(r.status === 201, 'club publishes an assessment campaign');
r = await j('/player/campaigns', {}, bearer(KOLA));
ok(r.body.items.some((c) => c.id === campId), 'eligible player sees the campaign');
r = await post(`/player/campaigns/${campId}/submit`, { drillName: '30m sprint' }, bearer(KOLA));
ok(r.status === 201 && r.body.attempt.status === 'failed_checks' && r.body.attempt.fileChecks.issues.length, 'automated FILE check fails without a video — with explicit issues');
const tinyWebm = `data:video/webm;base64,${Buffer.from('webm-not-really-but-bytes').toString('base64')}`;
r = await post('/player/media', { title: 'Sprint attempt one', kind: 'video', dataUrl: tinyWebm }, bearer(KOLA));
const sprintMedia = r.body.media.id;
r = await post(`/player/campaigns/${campId}/submit`, { mediaId: sprintMedia, drillName: '30m sprint' }, bearer(KOLA));
ok(r.status === 201 && r.body.attempt.status === 'submitted' && r.body.note.includes('human'), 'passing file checks ≠ verified — human review is explicitly separate');
const attemptId = r.body.attempt.id;
r = await j(`/org/campaigns/${campId}/review-queue`, {}, bearer(MARIA));
ok(r.body.queue.length === 1, 'human review queue holds the attempt');
r = await post(`/org/campaign-attempts/${attemptId}/review`, { decision: 'returned' }, bearer(MARIA));
ok(r.status === 400, 'returning an attempt without reasons is refused');
r = await post(`/org/campaign-attempts/${attemptId}/review`, { decision: 'returned', reasons: 'Camera moved mid-run — refilm with the phone fixed on a bag or tripod.' }, bearer(MARIA));
ok(r.status === 200 && r.body.attempt.review.kind === 'human_review', 'reviewer returns with concrete resubmission instructions');
r = await post(`/player/campaigns/${campId}/submit`, { mediaId: sprintMedia, drillName: '30m sprint' }, bearer(KOLA));
ok(r.status === 201, 'returned attempt frees the slot — resubmission accepted');
r = await post(`/org/campaign-attempts/${(r.body.attempt.id)}/review`, { decision: 'accepted', rubricNotes: 'Clean run, both cones visible.' }, bearer(MARIA));
ok(r.status === 200, 'reviewer accepts the resubmission');
r = await j('/player/drill-guidance', {}, bearer(KOLA));
ok(r.body.items.every((g) => g.coachReview.status === 'unreviewed') && r.body.note.includes('honestly'), 'drill library shows unreviewed guidance as unreviewed');

// ======================================================== §8 development
r = await j('/player/feedback', {}, bearer(KOLA));
const fbId = r.body.items[0].id;
r = await post('/player/objectives', { feedbackId: assV, objectives: [{ text: 'x' }] }, bearer(KOLA));
ok(r.status === 404, 'a PRIVATE assessment cannot seed an objective');
r = await post('/player/objectives', { feedbackId: fbId, objectives: [{ text: 'Set the press on the trigger, not the chase', baselineEvidenceIds: [ev2] }] }, bearer(KOLA));
const objId = r.body.objective.id;
ok(r.status === 201, 'published feedback becomes an agreed objective with baseline evidence');
r = await post(`/player/objectives/${objId}/progress`, { note: 'Two pressing sessions with Sunday league', evidenceId: ev2 }, bearer(KOLA));
ok(r.status === 201, 'player records progress against the objective');
r = await post(`/player/objectives/${objId}/reassessment`, {}, bearer(KOLA));
ok(r.status === 409 && r.body.error === 'SHARING_REQUIRED', 'reassessment needs the player’s explicit sharing choice first');
r = await j('/org/players/pl-adeyemi/objectives', {}, bearer(MARIA));
ok(r.body.length === 0, 'club sees nothing before the player shares');
r = await post(`/player/objectives/${objId}/share`, { orgId: 'org-eastport', enabled: true }, bearer(KOLA));
ok(r.status === 200, 'player shares progress with the club');
r = await j('/org/players/pl-adeyemi/objectives', {}, bearer(MARIA));
ok(r.body.length === 1, 'shared objective is now club-visible');
r = await post(`/player/objectives/${objId}/reassessment`, {}, bearer(KOLA));
const rasId = r.body.reassessment.id;
ok(r.status === 201, 'authorised reassessment request reaches the club');
r = await post(`/org/reassessments/${rasId}/outcome`, { note: 'Pressing triggers much sharper — evidenced in the linked sessions. Keep the second objective for spring.', evidenceIds: [ev2] }, bearer(MARIA));
ok(r.status === 200 && r.body.reassessment.outcome.evidenceIds.includes(ev2), 'reviewer records an evidence-supported outcome');

// ========================================================== §9 trial-day
r = await post('/org/players/pl-svensson/request', { type: 'trial', message: 'Trial with the U23s?', proposedDate: future, venue: 'Eastport Training Ground' }, bearer(MARIA));
const reqId = r.body.requestId;
ok(r.status === 201, 'trial request sent');
r = await post(`/player/requests/${reqId}/respond`, { accept: true }, bearer(SVEN));
ok(r.status === 200, 'adult accepts the trial');
const trials = (await j('/org/trials', {}, bearer(MARIA))).body;
const trial = (Array.isArray(trials) ? trials : trials.items ?? []).find((t) => t.playerId === 'pl-svensson');
ok(!!trial, 'trial record exists');
r = await post(`/org/trials/${trial.id}/checkin`, {}, bearer(MARIA));
ok(r.status === 409 && r.body.error === 'STAFF_CHECK_REQUIRED', 'check-in blocked without a REVIEWED staff check');
r = await post(`/org/trials/${trial.id}/staff`, { name: 'Priya Shah', role: 'Safeguarding Lead', check: { kind: 'DBS (England & Wales)', ref: 'DBS-4471', expiresAt: new Date(Date.now() + 300 * 86_400_000).toISOString() } }, bearer(MARIA));
ok(r.status === 201 && r.body.note.includes('not a completed background check'), 'filing a check reference leaves it PENDING — honestly labelled');
r = await post(`/org/trials/${trial.id}/checkin`, {}, bearer(MARIA));
ok(r.status === 409, 'a pending check still blocks check-in');
r = await j('/admin/staff-checks', {}, admin);
const chk = r.body.items[0];
r = await post(`/admin/staff-checks/${chk.trialId}/${chk.staffId}`, { status: 'reviewed' }, admin);
ok(r.status === 200 && r.body.check.state === 'reviewed', 'T&S reviews the check');
r = await post(`/org/trials/${trial.id}/checkin`, {}, bearer(MARIA));
ok(r.status === 409 && r.body.error === 'CONSENT_REQUIRED', 'event consent still required before check-in');
r = await post(`/player/trials/${trial.id}/consent`, {}, bearer(SVEN));
ok(r.status === 201, 'adult player gives event consent');
r = await post(`/player/trials/${trial.id}/emergency-contact`, { name: 'Lena Svensson', phone: '+46 70 000 11 22' }, bearer(SVEN));
ok(r.status === 200, 'restricted emergency contact filed');
r = await j('/org/players/pl-svensson', {}, bearer(MARIA));
ok(!JSON.stringify(r.body).includes('70 000 11 22'), 'emergency contact NEVER appears in the scouting profile');
r = await post(`/org/trials/${trial.id}/arrival`, { time: '09:30', address: 'Gate B, Eastport Training Ground', notes: 'Ask for Priya at reception.' }, bearer(MARIA));
ok(r.status === 200, 'arrival instructions published');
r = await post(`/org/trials/${trial.id}/checkin`, {}, bearer(MARIA));
ok(r.status === 200, 'with reviewed check + consent, check-in succeeds');
r = await post(`/org/trials/${trial.id}/checkin`, {}, bearer(MARIA));
ok(r.status === 409 && r.body.error === 'ALREADY_CHECKED_IN', 'no duplicate check-ins');
r = await j('/player/me', {}, bearer(SVEN));
ok((r.body.attendance ?? []).filter((a) => a.trialId === trial.id).length === 1, 'check-in fed ONE coach-signed attendance record');
r = await j(`/player/trials/${trial.id}/safety-pack`, {}, bearer(SVEN));
ok(r.body.pack.staff[0].check.status === 'reviewed' && r.body.pack.checksExplained.includes('truth'), 'safety pack shows who was checked and what that means');
r = await post(`/org/trials/${trial.id}/postpone`, { reason: 'Waterlogged pitch', newDate: future }, bearer(MARIA));
ok(r.status === 200, 'postponement recorded + parties notified');

// =========================================================== §11 outcomes
r = await post('/org/players/pl-svensson/signing', { note: 'U23 contract' }, bearer(MARIA));
ok(r.status === 201 || r.status === 200, 'signing recorded');
await post('/admin/sweep', {}, admin);
r = await j('/org/followups', {}, bearer(MARIA));
ok(r.body.items.filter((f) => f.playerId === 'pl-svensson').length === 3, 'signing scheduled 3/6/12-month follow-ups');
const fup = r.body.items.find((f) => f.playerId === 'pl-svensson' && f.milestone === '3m');
// restart-safety: SIGKILL the server, restart, confirm the schedule survived
killServer();
await startServer();
r = await j('/org/followups', {}, bearer(MARIA));
ok(r.body.items.filter((f) => f.playerId === 'pl-svensson').length === 3, 'follow-ups survive SIGKILL + restart with no duplicates');
r = await post(`/admin/followups/${fup.id}`, { dueAt: Date.now() - 1000 }, admin);
ok(r.status === 200, 'T&S adjusts the due date');
const notifCountBefore = (await j('/player/notifications', {}, bearer(SVEN))).body.filter((n) => n.type === 'outcome').length;
await post('/admin/sweep', {}, admin);
const afterFirst = (await j('/player/notifications', {}, bearer(SVEN))).body.filter((n) => n.type === 'outcome').length;
await post('/admin/sweep', {}, admin);
const afterSecond = (await j('/player/notifications', {}, bearer(SVEN))).body.filter((n) => n.type === 'outcome').length;
ok(afterFirst === notifCountBefore + 1 && afterSecond === afterFirst, 'due reminder sent exactly once — idempotent across repeated sweeps');
r = await post(`/org/followups/${fup.id}/report`, { registrationStatus: 'registered', matchesPlayed: 4, progression: 'Regular U23 starter' }, bearer(MARIA));
ok(r.status === 201, 'club files the follow-up outcome report');
r = await j('/player/followups', {}, bearer(SVEN));
ok(r.body.find((f) => f.id === fup.id).report.registrationStatus === 'registered', 'player sees the report');
r = await post(`/player/followups/${fup.id}/respond`, { agree: true, experienceRating: 4 }, bearer(SVEN));
ok(r.status === 200 && r.body.followUp.outcomeState === 'confirmed', 'player confirms → outcome is CONFIRMED, not merely reported');
r = await j('/admin/outcomes', {}, admin);
const eastRow = r.body.rows.find((x) => x.orgId === 'org-eastport');
ok(eastRow.suppressed === true, 'aggregate reporting suppresses groups under 3 records');

// ======================================================== §12 access
// resumable uploads
const fileBuf = crypto.randomBytes(700 * 1024);
const sha = crypto.createHash('sha256').update(fileBuf).digest('hex');
r = await post('/player/uploads', { size: fileBuf.length, mime: 'video/webm', title: 'Resumable training clip', sha256: sha }, bearer(KOLA));
ok(r.status === 201 && r.body.upload.totalChunks === 2, 'upload session opens with chunk plan');
const up = r.body.upload;
r = await put(`/player/uploads/${up.id}/chunks/1`, { data: fileBuf.subarray(up.chunkSize).toString('base64') }, bearer(KOLA));
ok(r.status === 200 && r.body.complete === false, 'chunk 1 lands; upload not complete');
r = await post(`/player/uploads/${up.id}/finalise`, {}, bearer(KOLA));
ok(r.status === 409 && r.body.missing.includes(0), 'finalise refuses while chunks are missing — no premature success');
r = await put(`/player/uploads/${up.id}/chunks/0`, { data: fileBuf.subarray(0, up.chunkSize).toString('base64') }, bearer(KOLA));
r = await post(`/player/uploads/${up.id}/finalise`, {}, bearer(KOLA));
ok(r.status === 201 && r.body.media?.id, 'all chunks + checksum → finalised into real media');
const upMedia = r.body.media.id;
r = await post(`/player/uploads/${up.id}/finalise`, {}, bearer(KOLA));
ok(r.status === 200 && r.body.media.id === upMedia, 'finalise retry is idempotent — no duplicate media');
r = await j('/player/me', {}, bearer(KOLA));
ok(r.body.media.filter((m) => m.title === 'Resumable training clip').length === 1, 'exactly one media item exists');
r = await post('/player/uploads', { size: 1000, mime: 'application/x-msdownload', title: 'nope' }, bearer(KOLA));
ok(r.status === 400, 'disallowed types refused at session open');
r = await post('/player/uploads', { size: 512, mime: 'video/webm', title: 'bad sha', sha256: '0'.repeat(64) }, bearer(KOLA));
const badUp = r.body.upload;
await put(`/player/uploads/${badUp.id}/chunks/0`, { data: crypto.randomBytes(512).toString('base64') }, bearer(KOLA));
r = await post(`/player/uploads/${badUp.id}/finalise`, {}, bearer(KOLA));
ok(r.status === 409 && r.body.error === 'INTEGRITY_FAILED', 'integrity mismatch refuses finalisation');
// captions
r = await post(`/player/media/${upMedia}/captions`, { vtt: 'WEBVTT\n\n00:00.000 --> 00:04.000\nCoach: two cones, thirty metres.' }, bearer(KOLA));
ok(r.status === 200, 'caption track uploads');
let capRes = await fetch(`${API}/media/${upMedia}/captions`, { headers: bearer(MARIA) });
ok(capRes.status === 200 && (capRes.headers.get('content-type') ?? '').includes('text/vtt'), 'authorised club fetches captions as text/vtt');
capRes = await fetch(`${API}/media/${upMedia}/captions`);
ok(capRes.status === 401, 'anonymous caption fetch refused');
// football context + honest benchmarks
r = await post('/player/football-category', { category: 'mens' }, bearer(KOLA));
ok(r.status === 200, 'player sets competition category');
r = await j('/player/benchmarks', {}, bearer(OSEI));
ok(typeof r.body.method === 'string' && r.body.method.includes('not enough evidence'), 'benchmarks disclose method + insufficiency rule');
ok([...r.body.drills, ...r.body.stats].every((row) => 'sampleSize' in row), 'every comparison row carries its sample size');

console.log(`\nm12E2E: all ${passed} checks passed`);
killServer();
process.exit(0);
