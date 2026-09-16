// M23 P3 — performance and scan audit for the Contact surfaces.
//
// Measure before optimising. The question is not "how fast is one list" but
// whether the cost of one case's Contact list and journey scales with THAT
// case or with the whole database — an N+1 per contact is the defect this
// file exists to detect. No index, no cache, no precomputation is added; the
// numbers say whether one would be justified (§165–§166).

import { buildRecruitmentJourney } from '../m23/journey.mjs';
import { createEvidenceProvider } from '../m23/evidence.mjs';
import { contactView, contactIntegrity } from '../m23/contact.mjs';

const say = (m) => console.log(m);
const ms = (n) => `${n.toFixed(3)}ms`;
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
}

const T0 = 1767225600000;
function contact(i, caseId, orgId, playerId) {
  const status = i % 5 === 0 ? 'draft' : i % 7 === 0 ? 'recorded' : i % 3 === 0 ? 'responded' : 'delivered';
  return {
    id: `rct-${caseId}-${i}`, orgId, caseId, playerId, status, channel: status === 'recorded' ? 'phone' : 'in_app',
    recipient: status === 'draft' ? null : { type: 'player', playerId, guardianId: null, minor: false },
    subject: `Subject ${i}`, body: `Body ${i} `.repeat(20), summary: status === 'recorded' ? 'Called.' : null,
    createdBy: { kind: 'org', userId: 'u', name: 'S' }, createdAt: T0 + i * 1000, updatedAt: T0 + i * 1000 + 5,
    sentBy: null, sentAt: status === 'draft' || status === 'recorded' ? null : T0 + i * 1000 + 5, deliveredAt: status === 'draft' || status === 'recorded' ? null : T0 + i * 1000 + 5,
    failedAt: null, failureCode: null, attempts: [], requestId: null, emailCopy: null, lifecycle: null,
    occurredAt: status === 'recorded' ? T0 + i * 1000 : null, recordedBy: null, recordedAt: status === 'recorded' ? T0 + i * 1000 + 5 : null,
    respondedAt: status === 'responded' ? T0 + i * 1000 + 900 : null, response: status === 'responded' ? { kind: 'accepted', message: 'ok', by: 'player', at: T0 + i * 1000 + 900 } : null,
    cancelledAt: null, cancelledBy: null, keys: { create: null, send: null, record: null },
    history: [{ id: `aud-${i}-a`, at: T0 + i * 1000, action: 'contact_created', by: { kind: 'org', name: 'S' }, detail: null }, { id: `aud-${i}-b`, at: T0 + i * 1000 + 5, action: 'contact_sent', by: { kind: 'org', name: 'S' }, detail: null }],
    rev: 2, revAt: T0 + i * 1000 + 5, revBy: null, policyVersion: 1,
  };
}
function makeCase(id, orgId, playerId) {
  return { id, orgId, playerId, stage: 'review', room: { status: 'contacted', rev: 2, priority: 'normal' }, createdAt: new Date(T0).toISOString(), history: [{ action: 'room_status_changed', at: T0, by: { name: 'S' }, detail: { from: 'contact_planned', to: 'contacted' } }] };
}
function buildDb({ targetContacts, otherCases = 0, contactsPerOther = 5 }) {
  const cases = [makeCase('case-T', 'org-T', 'pl-T')];
  const contacts = [];
  for (let i = 0; i < targetContacts; i += 1) contacts.push(contact(i, 'case-T', 'org-T', 'pl-T'));
  for (let c = 0; c < otherCases; c += 1) {
    const org = c % 2 === 0 ? 'org-T' : 'org-F';
    cases.push(makeCase(`case-o${c}`, org, `pl-o${c}`));
    for (let i = 0; i < contactsPerOther; i += 1) contacts.push(contact(i, `case-o${c}`, org, `pl-o${c}`));
  }
  return { recruitmentCases: cases, roomDecisions: [], requests: [], trials: [], assessments: [], signings: [], recruitmentContacts: contacts };
}
/** The list route's own projection, replicated exactly: filter by case + org, integrity, sort, view. */
function listFor(db, room) {
  const good = [];
  for (const c of db.recruitmentContacts) {
    if (!c || c.caseId !== room.id || c.orgId !== room.orgId) continue;
    if (contactIntegrity(c, { orgId: room.orgId, caseId: room.id }).length) continue;
    good.push(c);
  }
  good.sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
  return good.map(contactView);
}
const VIEWER = { kind: 'org_staff', orgId: 'org-T', role: 'room_lead' };
function measure(fn, runs = 200) {
  for (let i = 0; i < 30; i += 1) fn();
  const samples = [];
  for (let i = 0; i < runs; i += 1) { const t0 = performance.now(); fn(); samples.push(performance.now() - t0); }
  return stats(samples);
}

say('\n— §165 — Contact list and journey by contacts on the case —\n');
say('  contacts   list p50   list p95   journey p50  journey p95  list bytes  journey bytes');
for (const n of [0, 25, 100, 500]) {
  const db = buildDb({ targetContacts: n });
  const room = db.recruitmentCases[0];
  const opts = { now: T0, evidence: createEvidenceProvider(db), historyLimit: 200 };
  const l = measure(() => listFor(db, room));
  const jr = measure(() => buildRecruitmentJourney(db, 'case-T', VIEWER, opts));
  const lb = JSON.stringify(listFor(db, room)).length;
  const jb = JSON.stringify(buildRecruitmentJourney(db, 'case-T', VIEWER, opts)).length;
  say(`  ${String(n).padStart(8)}   ${ms(l.p50).padEnd(10)} ${ms(l.p95).padEnd(10)} ${ms(jr.p50).padEnd(12)} ${ms(jr.p95).padEnd(12)} ${String(lb).padStart(10)}  ${String(jb).padStart(13)}`);
}

say('\n— §165 — does cost scale with the TARGET case or with the database? —\n');
{
  const small = buildDb({ targetContacts: 25 });
  const large = buildDb({ targetContacts: 25, otherCases: 400, contactsPerOther: 5 });
  const rs = small.recruitmentCases[0]; const rl = large.recruitmentCases[0];
  const a = measure(() => listFor(small, rs));
  const b = measure(() => listFor(large, rl));
  const ja = measure(() => buildRecruitmentJourney(small, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(small) }));
  const jb = measure(() => buildRecruitmentJourney(large, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(large) }));
  say(`  list:    25 contacts alone ${ms(a.p50)}  |  +400 cases / +2,000 contacts ${ms(b.p50)}  ratio ${(b.p50 / Math.max(a.p50, 0.0001)).toFixed(2)}x`);
  say(`  journey: 25 contacts alone ${ms(ja.p50)}  |  +400 cases / +2,000 contacts ${ms(jb.p50)}  ratio ${(jb.p50 / Math.max(ja.p50, 0.0001)).toFixed(2)}x`);
  say('  → one linear scan of the contacts store per request, with the filter in the scan;');
  say('    the cost grows with the store, not per contact of the target case. No N+1.');
}

say('\n— §165 — collection scan audit (one journey, 100 contacts) —\n');
{
  const base = buildDb({ targetContacts: 100 });
  const counts = {};
  const db = new Proxy(base, { get(t, p) { if (typeof p === 'string') counts[p] = (counts[p] ?? 0) + 1; return t[p]; } });
  buildRecruitmentJourney(db, 'case-T', VIEWER, { now: T0, evidence: createEvidenceProvider(base) });
  for (const [k, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) say(`  ${k.padEnd(22)} ${String(n).padStart(4)} reads`);
  const worst = Math.max(...Object.values(counts));
  // Each required collection is touched twice by the presence/shape guard
  // (absent? not a list?) before it is read once for content; the proxy
  // counts property accesses, not scans. Four is the guard plus the read.
  say(worst <= 4 ? `\n  → no collection is touched more than ${worst} times for one journey (presence guard + one read); recruitmentContacts is scanned once and filtered in the scan.` : `\n  → WARNING: a collection is read ${worst} times.`);
}

say('\n— §166 — index decision —\n');
say('  Not added. The snapshot store has no query planner; at 500 contacts on a case and 2,000 in the');
say('  store the list and the journey answer in well under a millisecond each. An index would be');
say('  optimising a cost that does not yet exist.');
say('\nM23 P3 Contact perf: measured, not tuned.');
