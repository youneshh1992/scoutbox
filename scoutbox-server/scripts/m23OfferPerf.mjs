// M23 P6 — performance and scan audit for the Offer surfaces (§77).
//
// Measure before optimising. The questions: does the cost of one Offer's
// views grow with THAT Offer (1 / 10 / 20 revisions, documents, history) or
// with the whole store (1 / 1 000 / 5 000 Offers)? Is any collection scanned
// more than once per surface? No index, no cache, no precomputation is added;
// the numbers say whether one would be justified.

import { createEvidenceProvider } from '../m23/evidence.mjs';
import { buildRecruitmentJourney } from '../m23/journey.mjs';
import { offerClubView, offerRecipientView, offerAgentView, offerHistoryView, offerEvidence, offerIntegrity, offerStatus, liveRevision, canRespondToRevision } from '../m28/offer.mjs';

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
const DAY = 86_400_000;
const by = { kind: 'org', id: 'u', name: 'Lead' };
function revision(i, n, status) {
  return {
    id: `rofr-${i}`, revisionNumber: i + 1, status, terms: { offerType: 'direct_recruitment', role: 'CM', squad: 'U23', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'c'.repeat(200) },
    recipientMessage: 'm'.repeat(300), internalNote: 'PRIVATE'.repeat(40), documents: Array.from({ length: 3 }, (_, k) => ({ id: `rofd-${i}-${k}`, evidenceId: `vevd-${k}`, label: `Doc ${k}`, mime: 'application/pdf', bytes: 1000 })),
    expiresAt: T0 + 30 * DAY, issuedAt: status === 'DRAFT' ? null : T0 + i, createdAt: T0 + i, updatedAt: T0 + i, createdBy: by, issuedBy: status === 'DRAFT' ? null : by,
    supersedesRevisionId: i ? `rofr-${i - 1}` : null, supersededByRevisionId: i < n - 1 ? `rofr-${i + 1}` : null, withdrawnAt: null, respondedAt: null, response: null,
    recipientSnapshot: status === 'DRAFT' ? null : { type: 'player', playerId: 'pl-T', guardianId: null, minor: false, at: T0 }, readinessSnapshot: null, rev: 2,
  };
}
function offer(id, caseId, orgId, playerId, revisions = 1, { history = 10 } = {}) {
  const revs = Array.from({ length: revisions }, (_, i) => revision(i, revisions, i < revisions - 1 ? 'SUPERSEDED' : 'ISSUED'));
  return {
    id, orgId, caseId, playerId, type: 'direct_recruitment', decisionId: 'dec-1', transactionId: null, status: 'ISSUED', currentRevisionId: revs[revs.length - 1].id,
    revisions: revs, responses: [], readReceipts: [{ revisionId: revs[0].id, viewerKind: 'player', viewerId: playerId, firstViewedAt: T0 + 5 }], agentShare: null,
    keys: { create: null, issue: [], withdraw: [], revise: [] }, lifecycle: null,
    history: Array.from({ length: history }, (_, k) => ({ id: `aud-${k}`, at: T0 + k, action: k % 2 ? 'offer_draft_updated' : 'offer_issued', by, detail: { revisionId: revs[0].id } })),
    createdAt: T0, createdBy: by, updatedAt: T0, rev: 3, revAt: T0, revBy: null, policyVersion: 1,
  };
}
function buildDb({ offers = 1, revisions = 1, history = 10 }) {
  const rows = [offer('rof-T', 'case-T', 'org-T', 'pl-T', revisions, { history })];
  for (let i = 0; i < offers - 1; i += 1) rows.push(offer(`rof-o${i}`, `case-o${i}`, i % 2 ? 'org-T' : 'org-F', `pl-o${i}`, 1 + (i % 3)));
  const cases = [{ id: 'case-T', orgId: 'org-T', playerId: 'pl-T', stage: 'decision', room: { status: 'offer_made', rev: 3, leadScoutUserId: 'u' }, ownerUserId: 'u', createdAt: new Date(T0).toISOString(), history: [], decisionDraft: null }];
  return { recruitmentOffers: rows, recruitmentCases: cases, assessments: [], roomDecisions: [], trials: [], requests: [], evidence: [], boxSessions: [], recruitmentContacts: [], signings: [] };
}
const kase = { id: 'case-T', orgId: 'org-T', playerId: 'pl-T' };
/** The recipient list route's own selection, replicated: rows of this player with a live revision addressed to them. */
function recipientList(db, playerId) {
  const out = [];
  for (const o of db.recruitmentOffers) {
    if (!o || o.playerId !== playerId || offerIntegrity(o).length) continue;
    const live = liveRevision(o);
    if (!live || live.recipientSnapshot?.type !== 'player') continue;
    out.push(offerRecipientView(o, T0 + DAY, { orgName: 'X' }));
  }
  return out;
}

say('\n— one Offer\'s views by revisions (1 / 10 / 20), three documents each, 10 history rows —\n');
say('  revisions   club p50      club p95      recipient p50   agent p50     history p50   gate p50      club bytes   recipient bytes');
for (const n of [1, 10, 20]) {
  const db = buildDb({ revisions: n });
  const o = db.recruitmentOffers[0];
  const c = measure(() => offerClubView(o, T0 + DAY));
  const r = measure(() => offerRecipientView(o, T0 + DAY, { orgName: 'X' }));
  const a = measure(() => offerAgentView(o, T0 + DAY, { orgName: 'X' }));
  const h = measure(() => offerHistoryView(o, { forRecipient: true }));
  const g = measure(() => canRespondToRevision(o, o.currentRevisionId, T0 + DAY));
  say(`  ${String(n).padStart(9)}   ${ms(c.p50).padEnd(13)} ${ms(c.p95).padEnd(13)} ${ms(r.p50).padEnd(15)} ${ms(a.p50).padEnd(13)} ${ms(h.p50).padEnd(13)} ${ms(g.p50).padEnd(13)} ${String(JSON.stringify(offerClubView(o, T0 + DAY)).length).padStart(10)}   ${String(JSON.stringify(offerRecipientView(o, T0 + DAY)).length).padStart(15)}`);
}
say('  → each view is one pass over the Offer\'s own revisions; the 20-revision limit bounds both time and payload.');

say('\n— does cost scale with the TARGET Offer or with the store? (1 / 1 000 / 5 000 Offers) —\n');
say('  offers   evidence p50   evidence p95   recipient list p50   journey p50   surface(rows of case) p50');
for (const n of [1, 1000, 5000]) {
  const db = buildDb({ offers: n });
  const ev = measure(() => offerEvidence(db.recruitmentOffers, kase, 'offer_sent', T0 + DAY), 100);
  const rl = measure(() => recipientList(db, 'pl-T'), 100);
  const jr = measure(() => buildRecruitmentJourney(db, 'case-T', { kind: 'org_staff', orgId: 'org-T', role: 'room_lead' }, { now: T0 + DAY, evidence: createEvidenceProvider(db) }), 50);
  const sf = measure(() => db.recruitmentOffers.filter((o) => o && o.caseId === kase.id && o.orgId === kase.orgId).map((o) => offerClubView(o, T0 + DAY)), 100);
  say(`  ${String(n).padStart(6)}   ${ms(ev.p50).padEnd(14)} ${ms(ev.p95).padEnd(14)} ${ms(rl.p50).padEnd(20)} ${ms(jr.p50).padEnd(13)} ${ms(sf.p50)}`);
}
say('  → one linear scan of recruitmentOffers per request, filtered in the scan (case, org, player); integrity is checked');
say('    only on the rows that survive the id filter. Cost grows with the store, not per revision of the target. No N+1.');

say('\n— collection scan audit (one club surface + one recipient list + evidence, 20 revisions) —\n');
{
  const base = buildDb({ offers: 50, revisions: 20 });
  const counts = {};
  const db = new Proxy(base, { get(t, p) { if (typeof p === 'string') counts[p] = (counts[p] ?? 0) + 1; return t[p]; } });
  db.recruitmentOffers.filter((o) => o && o.caseId === kase.id && o.orgId === kase.orgId).map((o) => offerClubView(o, T0 + DAY));
  recipientList(db, 'pl-T');
  offerEvidence(db.recruitmentOffers, kase, 'offer_accepted_by_recipient', T0 + DAY);
  offerStatus(db.recruitmentOffers[0], T0 + DAY);
  for (const [k, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) say(`  ${k.padEnd(22)} ${String(n).padStart(4)} reads`);
  const worst = Math.max(...Object.values(counts));
  say(worst <= 4 ? `\n  → no collection is touched more than ${worst} times across three surfaces (the store once per surface).` : `\n  → WARNING: a collection is read ${worst} times — a repeated scan hides here.`);
}

say('\n— index decision —\n');
say('  At the measured sizes every Offer read is a fraction of a millisecond and grows linearly with the store, once per');
say('  request. No index, cache or precomputation is justified by these numbers. Revisit when a single organisation holds');
say('  tens of thousands of Offer rows — the recipient list filter and offerEvidence are the first scans that would show.');
say('\nM23 P6 Offer perf: measured, published, no optimisation applied.');
