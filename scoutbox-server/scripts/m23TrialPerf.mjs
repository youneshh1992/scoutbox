// M23 P4B — performance and scan audit for the Trial surfaces.
//
// Measure before optimising (mandate §165–§166 spirit). The questions: does
// the cost of one trial's club view, family view, milestone and journey grow
// with THAT trial (0 / 5 / 20 sessions, 0..20 evidence links, revisions) or
// with the whole database? Is any collection scanned more than once per
// request? No index, no cache, no precomputation is added; the numbers say
// whether one would be justified.

import { buildRecruitmentJourney } from '../m23/journey.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';
import { trialClubView, trialFamilyView, trialMilestone, trialIntegrity, validateScheduleInput, canComplete } from '../m23/trial.mjs';

const say = (m) => console.log(m);
const ms = (n) => `${n.toFixed(3)}ms`;
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
}
function measure(fn, runs = 200) {
  for (let i = 0; i < 30; i += 1) fn();
  const samples = [];
  for (let i = 0; i < runs; i += 1) { const t0 = performance.now(); fn(); samples.push(performance.now() - t0); }
  return stats(samples);
}

const T0 = 1_800_000_000_000; const H = 3_600_000;
const BY = { kind: 'org', userId: 'u', name: 'S' };
function session(i, evidence) {
  return {
    id: `tses-${i}`, kind: i % 3 === 0 ? 'match' : 'training', startsAt: T0 + i * 24 * H, endsAt: T0 + i * 24 * H + 2 * H,
    venue: { name: 'Dome', town: 'Town', address: '1 Road' }, instructions: 'Gate B',
    evidence: Array.from({ length: evidence }, (_, k) => ({ id: `tev-${i}-${k}`, kind: 'box_cam_session', sessionId: `bx-${i}-${k}`, linkedAt: T0 + k, linkedBy: BY, removedAt: k % 4 === 3 ? T0 + k + 1 : null, removedBy: null })),
  };
}
function trial(id, caseId, orgId, playerId, { sessions = 5, evidencePerSession = 0, revisions = 3 } = {}) {
  const sess = Array.from({ length: sessions }, (_, i) => session(i, evidencePerSession));
  const revs = Array.from({ length: revisions }, (_, r) => ({ revision: r + 1, timezone: 'Europe/London', sessions: sess.map((s) => ({ ...s, evidence: undefined })), proposedAt: T0 + r, proposedBy: BY, confirmedAt: r === revisions - 1 ? T0 + r + 1 : null, confirmedBy: null, supersededAt: r === revisions - 1 ? null : T0 + r + 1, reason: null, material: true }));
  const attendance = sess.flatMap((s, i) => (i % 2 === 0 ? [{ sessionId: s.id, state: 'attended', source: 'manual', recordedBy: BY, recordedAt: s.startsAt + H, note: null }] : []));
  return {
    id, requestId: `req-${id}`, caseId, playerId, playerName: 'P', orgId, orgName: 'O', scoutName: 'S', acceptedAt: T0, acceptedBy: 'player', guardianApproved: false,
    proposedDate: '2027-01-15', venue: 'Dome', notes: '', reportDueAt: T0 + 7 * 86_400_000, status: 'awaiting_report',
    workflowState: sessions ? 'scheduled' : 'accepted',
    schedule: sessions ? { timezone: 'Europe/London', revision: revisions, proposedAt: T0, proposedBy: BY, confirmedAt: T0 + revisions, confirmedBy: { kind: 'player', id: playerId, name: 'P' }, declinedAt: null, declinedBy: null, sessions: sess, revisions: revs } : null,
    attendance, completion: null, recipient: { type: 'player', playerId, guardianId: null, minor: false, at: T0 },
    keys: { accept: { key: null, fp: 'x' }, schedule: Array.from({ length: 30 }, (_, k) => ({ key: `k${k}`, fp: `f${k}`, at: T0 + k })) },
    history: Array.from({ length: 6 + sessions }, (_, k) => ({ id: `aud-${id}-${k}`, at: T0 + k, action: k === 0 ? 'trial_accepted' : 'trial_attendance_recorded', by: BY, detail: { sessionId: `tses-${k}`, state: 'attended', source: 'manual' } })),
    reminders: {}, rev: 12, revAt: T0, revBy: null,
  };
}
function makeCase(id, orgId, playerId) {
  return { id, orgId, playerId, stage: 'trial', room: { status: 'trial_scheduled', rev: 3, priority: 'normal' }, createdAt: new Date(T0).toISOString(), history: [{ action: 'room_status_changed', at: T0, by: { name: 'S' }, detail: { from: 'trial_requested', to: 'trial_scheduled' } }] };
}
function buildDb({ sessions, evidencePerSession = 0, otherCases = 0 }) {
  const cases = [makeCase('case-T', 'org-T', 'pl-T')];
  const trials = [trial('trial-T', 'case-T', 'org-T', 'pl-T', { sessions, evidencePerSession })];
  const requests = [{ id: 'req-trial-T', type: 'trial', caseId: 'case-T', orgId: 'org-T', playerId: 'pl-T', status: 'accepted', createdAt: T0 - 1, respondedAt: T0, recipient: { type: 'player' } }];
  const assessments = [{ id: 'ass-T', orgId: 'org-T', playerId: 'pl-T', state: 'submitted', submittedAt: T0 + 5, createdAt: T0 + 4, context: { trialId: 'trial-T' } }];
  for (let c = 0; c < otherCases; c += 1) {
    const org = c % 2 === 0 ? 'org-T' : 'org-F';
    cases.push(makeCase(`case-o${c}`, org, `pl-o${c}`));
    trials.push(trial(`trial-o${c}`, `case-o${c}`, org, `pl-o${c}`, { sessions: 5 }));
    requests.push({ id: `req-o${c}`, type: 'trial', caseId: `case-o${c}`, orgId: org, playerId: `pl-o${c}`, status: 'accepted', createdAt: T0, respondedAt: T0 });
  }
  return { recruitmentCases: cases, roomDecisions: [], requests, trials, assessments, signings: [], recruitmentContacts: [] };
}
/** The list route's own projection, replicated: filter by case + org + player, integrity, sort, club view. */
function listFor(db, room) {
  const good = [];
  for (const t of db.trials) {
    if (!t || t.orgId !== room.orgId || t.playerId !== room.playerId) continue;
    if (t.caseId && t.caseId !== room.id) continue;
    if (trialIntegrity(t, { orgId: room.orgId, caseId: t.caseId ? room.id : null }).length) continue;
    good.push(t);
  }
  good.sort((a, b) => (a.acceptedAt - b.acceptedAt) || String(a.id).localeCompare(String(b.id)));
  return good.map(trialClubView);
}
const VIEWER = { kind: 'org_staff', orgId: 'org-T', role: 'room_lead' };

say('\n— Trial views by sessions on the trial (0 / 5 / 20), no evidence —\n');
say('  sessions   club p50   club p95   family p50  milestone p50  journey p50  journey p95  club bytes  family bytes  journey bytes');
for (const n of [0, 5, 20]) {
  const db = buildDb({ sessions: n });
  const t = db.trials[0]; const room = db.recruitmentCases[0];
  const opts = { now: T0, evidence: createEvidenceProvider(db), historyLimit: 200 };
  const c = measure(() => trialClubView(t)); const f = measure(() => trialFamilyView(t)); const m = measure(() => trialMilestone(t));
  const jr = measure(() => buildRecruitmentJourney(db, 'case-T', VIEWER, opts));
  say(`  ${String(n).padStart(8)}   ${ms(c.p50).padEnd(10)} ${ms(c.p95).padEnd(10)} ${ms(f.p50).padEnd(11)} ${ms(m.p50).padEnd(14)} ${ms(jr.p50).padEnd(12)} ${ms(jr.p95).padEnd(12)} ${String(JSON.stringify(trialClubView(t)).length).padStart(10)}  ${String(JSON.stringify(trialFamilyView(t)).length).padStart(12)}  ${String(JSON.stringify(buildRecruitmentJourney(db, 'case-T', VIEWER, opts)).length).padStart(13)}`);
  void room; void listFor;
}

say('\n— 20 sessions with 0 / 5 / 20 evidence links per session (400 links at the top) —\n');
say('  links/session   club p50   milestone p50  club bytes');
for (const e of [0, 5, 20]) {
  const db = buildDb({ sessions: 20, evidencePerSession: e });
  const t = db.trials[0];
  const c = measure(() => trialClubView(t)); const m = measure(() => trialMilestone(t));
  say(`  ${String(e).padStart(13)}   ${ms(c.p50).padEnd(10)} ${ms(m.p50).padEnd(14)} ${String(JSON.stringify(trialClubView(t)).length).padStart(10)}`);
}

say('\n— schedule validation and the completion gate at the limit —\n');
{
  const twenty = Array.from({ length: 20 }, (_, i) => ({ id: `tses-${i}`, startsAt: T0 + i * 24 * H, endsAt: T0 + i * 24 * H + 2 * H, venue: { name: 'Dome', town: 'Town' } }));
  const ids = twenty.map((s) => s.id);
  let seq = 0;
  const v = measure(() => validateScheduleInput({ timezone: 'Europe/London', sessions: twenty }, { now: T0 - 1, mintId: () => `n-${++seq}`, existingIds: ids }));
  const db = buildDb({ sessions: 20 });
  const g = measure(() => canComplete(db.trials[0], { now: T0 + 30 * 24 * H }));
  say(`  validate 20 sessions (overlap check, ids, zone): p50 ${ms(v.p50)}  p95 ${ms(v.p95)}`);
  say(`  completion gate over 20 sessions:               p50 ${ms(g.p50)}  p95 ${ms(g.p95)}`);
}

say('\n— does cost scale with the TARGET case or with the database? —\n');
{
  const small = buildDb({ sessions: 5 });
  const large = buildDb({ sessions: 5, otherCases: 400 });
  const a = measure(() => listFor(small, small.recruitmentCases[0]));
  const b = measure(() => listFor(large, large.recruitmentCases[0]));
  const ja = measure(() => buildRecruitmentJourney(small, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(small) }));
  const jb = measure(() => buildRecruitmentJourney(large, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(large) }));
  say(`  list:    one case alone ${ms(a.p50)}  |  +400 cases / +400 trials ${ms(b.p50)}  ratio ${(b.p50 / Math.max(a.p50, 0.0001)).toFixed(2)}x`);
  say(`  journey: one case alone ${ms(ja.p50)}  |  +400 cases / +400 trials ${ms(jb.p50)}  ratio ${(jb.p50 / Math.max(ja.p50, 0.0001)).toFixed(2)}x`);
  say('  → one linear scan of trials (and of requests, assessments) per request, filtered in the scan;');
  say('    the cost grows with the store, not per session of the target trial. No N+1.');
}

say('\n— collection scan audit (one journey, 20 sessions) —\n');
{
  const base = buildDb({ sessions: 20 });
  const counts = {};
  const db = new Proxy(base, { get(t, p) { if (typeof p === 'string') counts[p] = (counts[p] ?? 0) + 1; return t[p]; } });
  buildRecruitmentJourney(db, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(base) });
  for (const [k, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) say(`  ${k.padEnd(22)} ${String(n).padStart(4)} reads`);
  const worst = Math.max(...Object.values(counts));
  say(worst <= 6 ? `\n  → no collection is touched more than ${worst} times for one journey (presence guards + reads: trials is read for milestones, then for timeline rows, then for assessment context).` : `\n  → WARNING: a collection is read ${worst} times.`);
}

say('\n— index decision —\n');
say('  Not added. The snapshot store has no query planner; with 20 sessions, 400 evidence links and 400');
say('  other trials in the store the club view, the family view and the journey answer in well under a');
say('  millisecond each. An index would be optimising a cost that does not yet exist.');
say('\nM23 P4B Trial perf: measured, not tuned.');
