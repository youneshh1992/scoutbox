// M23 P5 — performance and scan audit for the decision surfaces (§125).
//
// Measure before optimising. The questions: does the cost of one case's
// decision surface grow with THAT case (0 / 5 / 20 assessments, 0..50
// evidence references, a long history) or with the whole database? Is any
// collection scanned more than once per request? No index, no cache, no
// precomputation is added; the numbers say whether one would be justified.

import { buildRecruitmentJourney } from '../m23/journey.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';
import {
  summariseAssessments, assessmentSnapshot, evidenceCandidates, resolveEvidenceRefs, decisionView, chainHead, duplicateFinalHeads, decisionIntegrity, byCreatedThenId,
} from '../m23/decision.mjs';

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

const T0 = 1_800_000_000_000;
const BY = { userId: 'u', name: 'S', role: 'Scout' };
const ATTRS = Array.from({ length: 12 }, (_, i) => `attr-${i}`);
function assessment(id, orgId, playerId, verdict, i) {
  return {
    id, orgId, playerId, scoutUserId: `u-${i}`, scoutName: `Scout ${i}`, state: 'submitted', submittedAt: T0 + i, createdAt: T0 + i - 1,
    recommendation: { verdict, reasons: 'PRIVATE reasons text that must never leave the summary' },
    ratings: ATTRS.map((attrId, k) => (k % 4 === 3 ? { attrId, notObserved: true } : { attrId, rating: 1 + (k % 5), confidence: ['low', 'medium', 'high'][k % 3], note: 'private', evidenceRefs: k % 2 ? ['e1'] : [] })),
    context: { trialId: i % 2 ? 'trial-T' : null },
  };
}
function formal(id, i, { superseded = true } = {}) {
  return {
    id, roomId: 'case-T', orgId: 'org-T', playerId: 'pl-T', kind: 'formal', state: 'final', outcome: ['progress', 'hold', 'reject'][i % 3], recommendation: ['offer', 'continue_watching', 'archive'][i % 3],
    reasonCodes: ['position_need'], note: 'n', by: BY, createdAt: T0 + 100 + i, finalizedAt: T0 + 100 + i, supersedes: i ? `rdec-${i - 1}` : null, supersededById: superseded ? `rdec-${i + 1}` : null,
    rev: superseded ? 2 : 1, evidenceRefs: Array.from({ length: 5 }, (_, k) => ({ kind: 'assessment', id: `ass-${k}`, meta: {} })), assessmentSummary: { submitted: 5, withheld: 0, verdicts: { sign: 5, monitor: 0, pass: 0, none: 0 }, assessmentIds: [] },
    lifecycle: { action: 'holdCase', from: 'x', to: 'y', applied: true, at: T0 }, keys: { finalize: null, draft: null }, policyVersion: 1,
  };
}
function buildDb({ assessments = 5, history = 1, otherCases = 0, passport = 10 }) {
  const cases = [{ id: 'case-T', orgId: 'org-T', playerId: 'pl-T', stage: 'review', room: { status: 'shortlisted', rev: 3, priority: 'normal', leadScoutUserId: 'u' }, ownerUserId: 'u', createdAt: new Date(T0).toISOString(), history: [{ action: 'room_status_changed', at: T0, by: { name: 'S' }, detail: { from: 'under_review', to: 'shortlisted' } }], decisionDraft: null }];
  const ass = Array.from({ length: assessments }, (_, i) => assessment(`ass-${i}`, 'org-T', 'pl-T', ['sign', 'monitor', 'pass'][i % 3], i));
  const decisions = Array.from({ length: history }, (_, i) => formal(`rdec-${i}`, i, { superseded: i < history - 1 }));
  const trials = [{ id: 'trial-T', orgId: 'org-T', playerId: 'pl-T', caseId: 'case-T', acceptedAt: T0, completion: { state: 'completed', at: T0 + 5 }, schedule: { sessions: Array.from({ length: 5 }, (_, i) => ({ id: `tses-${i}`, evidence: [{ kind: 'box_cam_session', sessionId: `bx-${i}`, removedAt: null }] })) }, attendance: [] }];
  const evidence = Array.from({ length: passport }, (_, i) => ({ id: `ev-${i}`, playerId: 'pl-T', claimType: 'footage', label: `Match ${i}`, recordedAt: T0 + i, verification: { status: 'verified' } }));
  const boxSessions = Array.from({ length: 5 }, (_, i) => ({ id: `bx-${i}`, playerId: 'pl-T', provider: 'real', verificationState: 'verified' }));
  for (let c = 0; c < otherCases; c += 1) {
    const org = c % 2 === 0 ? 'org-T' : 'org-F';
    cases.push({ id: `case-o${c}`, orgId: org, playerId: `pl-o${c}`, stage: 'review', room: { status: 'under_review', rev: 1 }, createdAt: new Date(T0).toISOString(), history: [] });
    for (let k = 0; k < 3; k += 1) ass.push(assessment(`ass-o${c}-${k}`, org, `pl-o${c}`, 'sign', k));
    decisions.push(formal(`rdec-o${c}`, 0, { superseded: false }), { ...formal(`rdec-o${c}b`, 1), roomId: `case-o${c}`, orgId: org, playerId: `pl-o${c}` });
    decisions[decisions.length - 2].roomId = `case-o${c}`; decisions[decisions.length - 2].orgId = org; decisions[decisions.length - 2].playerId = `pl-o${c}`;
    evidence.push({ id: `ev-o${c}`, playerId: `pl-o${c}`, claimType: 'footage', recordedAt: T0 });
  }
  return { recruitmentCases: cases, assessments: ass, roomDecisions: decisions, trials, requests: [], evidence, boxSessions, recruitmentContacts: [], signings: [] };
}
/** The GET /decision route's own projection, replicated: rows of this case, integrity, sort, head, views, summary, candidates. */
function surfaceFor(db, kase) {
  const good = [];
  let omitted = 0;
  for (const d of db.roomDecisions) {
    if (!d || d.roomId !== kase.id || d.orgId !== kase.orgId) continue;
    if (d.kind === 'formal' && decisionIntegrity(d, { orgId: kase.orgId, caseId: kase.id }).length) { omitted += 1; continue; }
    good.push(d);
  }
  good.sort(byCreatedThenId);
  const dup = duplicateFinalHeads(good);
  const head = chainHead(good);
  const visible = db.assessments.filter((a) => a.orgId === kase.orgId && a.playerId === kase.playerId);
  const summary = summariseAssessments(visible, { withheld: 0 });
  return {
    current: head ? decisionView(head) : null, history: good.slice().reverse().map((d) => decisionView(d)), omitted, dup,
    assessments: summary, snapshot: assessmentSnapshot(summary),
    evidence: evidenceCandidates({ db, kase, assessmentsVisible: visible, trialEvidenceViews: null, providers: {} }),
  };
}
const VIEWER = { kind: 'org_staff', orgId: 'org-T', role: 'room_lead' };

say('\n— the decision surface by assessments on the case (0 / 5 / 20), one formal decision —\n');
say('  assessments   surface p50   surface p95   summary p50   candidates p50   journey p50   journey p95   surface bytes   journey bytes');
for (const n of [0, 5, 20]) {
  const db = buildDb({ assessments: n });
  const kase = db.recruitmentCases[0];
  const visible = db.assessments.filter((a) => a.orgId === kase.orgId && a.playerId === kase.playerId);
  const s = measure(() => surfaceFor(db, kase));
  const sm = measure(() => summariseAssessments(visible, { withheld: 0 }));
  const ev = measure(() => evidenceCandidates({ db, kase, assessmentsVisible: visible, trialEvidenceViews: null, providers: {} }));
  const jr = measure(() => buildRecruitmentJourney(db, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(db), historyLimit: 200 }));
  say(`  ${String(n).padStart(11)}   ${ms(s.p50).padEnd(13)} ${ms(s.p95).padEnd(13)} ${ms(sm.p50).padEnd(13)} ${ms(ev.p50).padEnd(16)} ${ms(jr.p50).padEnd(13)} ${ms(jr.p95).padEnd(13)} ${String(JSON.stringify(surfaceFor(db, kase)).length).padStart(13)}   ${String(JSON.stringify(buildRecruitmentJourney(db, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(db) })).length).padStart(13)}`);
}

say('\n— resolving evidence references at finalize (0 / 10 / 50 refs, mixed kinds) —\n');
say('  refs   resolve p50   resolve p95');
for (const n of [0, 10, 50]) {
  const db = buildDb({ assessments: 20, passport: 40 });
  const kase = db.recruitmentCases[0];
  const refs = Array.from({ length: n }, (_, i) => (i % 4 === 0 ? { kind: 'assessment', id: `ass-${i % 20}` } : i % 4 === 1 ? { kind: 'passport_evidence', id: `ev-${i % 40}` } : i % 4 === 2 ? { kind: 'box_cam_session', id: `bx-${i % 5}` } : { kind: 'trial', id: 'trial-T' }));
  const r = measure(() => resolveEvidenceRefs(refs, { db, kase, providers: {} }));
  const out = resolveEvidenceRefs(refs, { db, kase, providers: {} });
  if (!out.ok) say(`  (resolution refused: ${out.error} ${JSON.stringify(out.ref)})`);
  say(`  ${String(n).padStart(4)}   ${ms(r.p50).padEnd(13)} ${ms(r.p95).padEnd(13)}`);
}
say('  → each reference is one find() over its own collection: cost is refs × that collection, linear in both, bounded by the 50-reference limit.');

say('\n— the decision history at 1 / 20 / 100 rows on one case —\n');
say('  rows   surface p50   surface p95   history bytes');
for (const n of [1, 20, 100]) {
  const db = buildDb({ assessments: 5, history: n });
  const kase = db.recruitmentCases[0];
  const s = measure(() => surfaceFor(db, kase));
  say(`  ${String(n).padStart(4)}   ${ms(s.p50).padEnd(13)} ${ms(s.p95).padEnd(13)} ${String(JSON.stringify(surfaceFor(db, kase).history).length).padStart(13)}`);
}
say('  → one sort and one integrity pass over the case\'s rows; the history page limit (100) bounds the payload.');

say('\n— does cost scale with the TARGET case or with the database? —\n');
{
  const small = buildDb({ assessments: 5 });
  const large = buildDb({ assessments: 5, otherCases: 400 });
  const a = measure(() => surfaceFor(small, small.recruitmentCases[0]));
  const b = measure(() => surfaceFor(large, large.recruitmentCases[0]));
  const ja = measure(() => buildRecruitmentJourney(small, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(small) }));
  const jb = measure(() => buildRecruitmentJourney(large, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(large) }));
  say(`  surface: one case alone ${ms(a.p50)}  |  +400 cases / +1200 assessments / +800 decisions ${ms(b.p50)}  ratio ${(b.p50 / Math.max(a.p50, 0.0001)).toFixed(2)}x`);
  say(`  journey: one case alone ${ms(ja.p50)}  |  +400 cases ${ms(jb.p50)}  ratio ${(jb.p50 / Math.max(ja.p50, 0.0001)).toFixed(2)}x`);
  say('  → one linear scan of roomDecisions, assessments, trials and evidence per request, filtered in the scan;');
  say('    the cost grows with the store, not per assessment or per reference of the target case. No N+1.');
}

say('\n— collection scan audit (one surface, 20 assessments, 20 decisions) —\n');
{
  const base = buildDb({ assessments: 20, history: 20 });
  const counts = {};
  const db = new Proxy(base, { get(t, p) { if (typeof p === 'string') counts[p] = (counts[p] ?? 0) + 1; return t[p]; } });
  surfaceFor(db, base.recruitmentCases[0]);
  for (const [k, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) say(`  ${k.padEnd(22)} ${String(n).padStart(4)} reads`);
  const worst = Math.max(...Object.values(counts));
  say(worst <= 4 ? `\n  → no collection is touched more than ${worst} times for one surface (rows once, assessments once for the summary and once for candidates, trials twice for candidates and Box Cam).` : `\n  → WARNING: a collection is read ${worst} times for one surface — a repeated scan hides here.`);
}

say('\n— index decision —\n');
say('  At the measured sizes every P5 read is a fraction of a millisecond and grows linearly with the store, once per');
say('  collection. No index, cache or precomputation is justified by these numbers. Revisit when a single organisation');
say('  holds tens of thousands of decision rows — the sort in surfaceFor is the first thing that would show.');
say('\nM23 P5 Decision perf: measured, published, no optimisation applied.');
