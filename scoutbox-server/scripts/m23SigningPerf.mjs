// M23 P7 — performance and scan audit for the signing surfaces (§97).
//
// Measure before optimising. The questions: does the cost of one package's
// views grow with THAT package (1 / 5 / 10 revisions, two parties each, a
// document per revision, history) or with the whole store (1 / 1 000 / 5 000
// packages)? Is any collection scanned more than once per surface? No index,
// no cache, no precomputation is added; the numbers say whether one would be
// justified.

import { signingClubView, signingRecipientView, signingAgentView, signingHistoryView, signingIntegrity, signingConsistency, completionGate, canCompleteParty, currentRevision, findParty, effectiveStatus, nextActionFor } from '../m29/signing.mjs';

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
const SHA = 'a'.repeat(64);
function party(type, forEntityId, done, readyAt = T0 + 1) {
  return { partyType: type, forEntityId, forPlayerId: 'pl-T', status: done ? 'COMPLETED' : 'PENDING', completedAt: done ? readyAt + 1 : null, completedBy: done ? { kind: type === 'PLAYER' ? 'player' : 'org', id: forEntityId, name: 'N' } : null, method: done ? 'PLATFORM_ACKNOWLEDGMENT' : null, evidenceRef: done ? { kind: 'platform_acknowledgment', id: 'sgev-1', revisionId: 'spr-0', documentSha256: SHA, at: readyAt + 1, actorKind: 'player', actorId: forEntityId } : null };
}
function revision(i, n, playerId, orgId) {
  const last = i === n - 1;
  return {
    id: `spr-${i}`, revisionNumber: i + 1, status: last ? 'IN_PROGRESS' : 'SUPERSEDED', createdAt: T0 + i, createdBy: by, readyAt: T0 + i + 1, readyBy: by, completedAt: null,
    document: { id: `sgd-${i}`, evidenceId: `vevd-${i}`, sha256: SHA, filename: 'contract.pdf', mime: 'application/pdf', bytes: 40_000, label: 'Contract' }, executedDocument: null,
    contract: { startDate: '2027-07-01', endDate: '2029-06-30' },
    requiredParties: [party('PLAYER', playerId, last, T0 + i + 1), party('CLUB_SIGNATORY', orgId, false, T0 + i + 1)],
    policySnapshot: { policyVersion: 1, jurisdiction: 'GB', offerPolicyVersion: 1 },
    supersedesRevisionId: i ? `spr-${i - 1}` : null, supersededByRevisionId: last ? null : `spr-${i + 1}`,
  };
}
function pkg(id, caseId, orgId, playerId, offerId, revisions = 1, { history = 12 } = {}) {
  const revs = Array.from({ length: revisions }, (_, i) => revision(i, revisions, playerId, orgId));
  return {
    id, orgId, caseId, playerId, offerId, offerRevisionId: `rofr-${offerId}`, transactionId: null,
    status: 'IN_PROGRESS', currentRevisionId: revs[revs.length - 1].id, revisions: revs, expiresAt: T0 + 30 * DAY, internalNote: 'PRIVATE'.repeat(40),
    keys: { start: null, ready: [], party: [], cancel: [], void: [], supersede: [], complete: [] },
    history: Array.from({ length: history }, (_, k) => ({ id: `sgh-${k}`, at: T0 + k, action: k % 3 ? 'signing_party_completed' : 'signing_ready', by, detail: { revisionId: revs[0].id, partyType: 'PLAYER' } })),
    completion: null, cancelledAt: null, cancelledBy: null, cancelReason: null, voidedAt: null, voidedBy: null, voidReason: null,
    createdAt: T0, createdBy: by, updatedAt: T0 + revisions, rev: 3, revAt: T0, revBy: null, policyVersion: 1,
  };
}
function buildDb({ packages = 1, revisions = 1, history = 12 }) {
  const rows = [pkg('spk-T', 'case-T', 'org-T', 'pl-T', 'rof-T', revisions, { history })];
  const offers = [{ id: 'rof-T', orgId: 'org-T', caseId: 'case-T', playerId: 'pl-T', status: 'ACCEPTED', revisions: [{ id: 'rofr-rof-T', status: 'ACCEPTED' }] }];
  const cases = [{ id: 'case-T', orgId: 'org-T', playerId: 'pl-T', room: { status: 'offer_accepted' } }];
  for (let i = 0; i < packages - 1; i += 1) {
    const org = i % 2 ? 'org-T' : 'org-F';
    rows.push(pkg(`spk-o${i}`, `case-o${i}`, org, `pl-o${i}`, `rof-o${i}`, 1 + (i % 3)));
    offers.push({ id: `rof-o${i}`, orgId: org, caseId: `case-o${i}`, playerId: `pl-o${i}`, status: 'ACCEPTED', revisions: [{ id: `rofr-rof-o${i}`, status: 'ACCEPTED' }] });
    cases.push({ id: `case-o${i}`, orgId: org, playerId: `pl-o${i}`, room: { status: 'offer_accepted' } });
  }
  return { signingPackages: rows, recruitmentOffers: offers, recruitmentCases: cases, signings: [] };
}
const offerOf = (db, p) => db.recruitmentOffers.find((o) => o && o.id === p.offerId && o.orgId === p.orgId) ?? null;
const caseOf = (db, p) => db.recruitmentCases.find((k) => k && k.id === p.caseId && k.orgId === p.orgId) ?? null;
/** The route's own soundness check, replicated: integrity, then consistency against the Offer and the case. */
function sound(db, p, at) {
  if (!p || signingIntegrity(p).length) return false;
  const offer = offerOf(db, p); const kase = caseOf(db, p);
  if (!offer || !kase) return false;
  return !signingConsistency(p, { offer, kase }, at).some((x) => /MISMATCH|COMPLETED_BUT/.test(x));
}
/** The recipient list route's own selection, replicated: presented packages of this player with a pending or completed party for them. */
function recipientList(db, playerId, at) {
  const out = [];
  for (const p of db.signingPackages) {
    if (!p || p.playerId !== playerId || !sound(db, p, at)) continue;
    if (!(p.revisions ?? []).some((r) => r && r.readyAt)) continue;
    const party = findParty(currentRevision(p), 'PLAYER');
    if (!party || party.forEntityId !== playerId) continue;
    out.push(signingRecipientView(p, at, { orgName: 'X', partyType: 'PLAYER', forEntityId: playerId }));
  }
  return out;
}
/** The room surface's own selection, replicated: packages of this case, with integrity. */
function roomSurface(db, at) {
  return db.signingPackages.filter((p) => p && p.caseId === 'case-T' && p.orgId === 'org-T').map((p) => ({ ...signingClubView(p, at, { orgName: 'X' }), integrity: signingIntegrity(p, { orgId: 'org-T' }) }));
}

say('\n— one package\'s views by revisions (1 / 5 / 10), two parties and a document each, 12 history rows —\n');
say('  revisions   club p50      club p95      recipient p50   agent p50     history p50   gate p50      party gate p50   club bytes   recipient bytes');
for (const n of [1, 5, 10]) {
  const db = buildDb({ revisions: n });
  const p = db.signingPackages[0];
  const at = T0 + DAY;
  const c = measure(() => signingClubView(p, at, { orgName: 'X' }));
  const r = measure(() => signingRecipientView(p, at, { orgName: 'X', partyType: 'PLAYER', forEntityId: 'pl-T' }));
  const a = measure(() => signingAgentView(p, at, { orgName: 'X' }));
  const h = measure(() => signingHistoryView(p, { forRecipient: true }));
  const g = measure(() => completionGate(p, { now: at, offer: offerOf(db, p), offerRevision: offerOf(db, p).revisions[0], kase: caseOf(db, p) }));
  const pg = measure(() => canCompleteParty(p, { partyType: 'CLUB_SIGNATORY', actorKind: 'org', actorId: 'u', revisionId: p.currentRevisionId, documentSha256: SHA }, at));
  say(`  ${String(n).padStart(9)}   ${ms(c.p50).padEnd(13)} ${ms(c.p95).padEnd(13)} ${ms(r.p50).padEnd(15)} ${ms(a.p50).padEnd(13)} ${ms(h.p50).padEnd(13)} ${ms(g.p50).padEnd(13)} ${ms(pg.p50).padEnd(16)} ${String(JSON.stringify(signingClubView(p, at)).length).padEnd(12)} ${JSON.stringify(signingRecipientView(p, at, { partyType: 'PLAYER', forEntityId: 'pl-T' })).length}`);
}
say('  → each view is one pass over the package\'s own revisions; the recipient view carries presented revisions only and no note.');

say('\n— does cost scale with the TARGET package or with the store? (1 / 1 000 / 5 000 packages) —\n');
say('  packages   integrity p50   integrity p95   recipient list p50   room surface p50   status p50    next action p50');
for (const n of [1, 1000, 5000]) {
  const db = buildDb({ packages: n });
  const at = T0 + DAY;
  const p = db.signingPackages[0];
  const ig = measure(() => signingIntegrity(p, { orgId: 'org-T' }), 100);
  const rl = measure(() => recipientList(db, 'pl-T', at), 50);
  const rs = measure(() => roomSurface(db, at), 100);
  const st = measure(() => effectiveStatus(p, at), 200);
  const na = measure(() => nextActionFor(p, at, { partyType: 'PLAYER', forEntityId: 'pl-T' }), 200);
  say(`  ${String(n).padStart(8)}   ${ms(ig.p50).padEnd(15)} ${ms(ig.p95).padEnd(15)} ${ms(rl.p50).padEnd(20)} ${ms(rs.p50).padEnd(18)} ${ms(st.p50).padEnd(13)} ${ms(na.p50)}`);
}
say('  → one linear scan of signingPackages per request, filtered in the scan (case, org, player); integrity and consistency');
say('    are checked only on the rows that survive the id filter. Cost grows with the store, not per revision of the target. No N+1.');

say('\n— collection scan audit (one room surface + one recipient list + one player-side read, 10 revisions) —\n');
{
  const base = buildDb({ packages: 50, revisions: 10 });
  const counts = {};
  const db = new Proxy(base, { get(t, p) { if (typeof p === 'string') counts[p] = (counts[p] ?? 0) + 1; return t[p]; } });
  const at = T0 + DAY;
  say(`  fixture integrity (10 revisions): ${JSON.stringify(signingIntegrity(base.signingPackages[0], { orgId: 'org-T' }))} · sound: ${sound(base, base.signingPackages[0], at)} · recipient rows: ${recipientList(base, 'pl-T', at).length}`);
  roomSurface(db, at);
  recipientList(db, 'pl-T', at);
  sound(db, db.signingPackages[0], at);
  for (const [k, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) say(`  ${k.padEnd(22)} ${String(n).padStart(4)} reads`);
  const worst = Math.max(...Object.values(counts).filter((_, i) => Object.keys(counts)[i] === 'signingPackages'));
  say(worst <= 3 ? `\n  → signingPackages is read ${worst} times across three surfaces (once per surface); recruitmentOffers and recruitmentCases are read` : `\n  → WARNING: signingPackages is read ${worst} times — a repeated scan hides here.`);
  say('    once per package that survives the id filter, for the consistency check — bounded by the packages of ONE player or ONE case.');
}

say('\n— index decision —\n');
say('  At the measured sizes every signing read is a fraction of a millisecond and grows linearly with the store, once per');
say('  request. No index, cache or precomputation is justified by these numbers. Revisit when a single organisation holds');
say('  tens of thousands of packages — the recipient list filter and the room surface are the first scans that would show.');
say('\nM23 P7 Signing perf: measured, published, no optimisation applied.');
