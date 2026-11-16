// Writes test/fixtures/trust_cases.json: what the TypeScript Trust Score (domains/passport/trust/shared.mjs)
// computes for many random inputs, so test/scoutbox/trust_rules_test.gleam can check the ported calculator against
// every one: the self and club projections and the snapshot (without its instant). Keys repeat on purpose, so a
// source counted twice is caught. Regenerate with `node dev/trust_cases.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { calculateTrustScore, safeTrustProjection, trustSnapshot } = await import(
  path.join(HERE, '../../../scoutbox/scoutbox-server/domains/passport/trust/shared.mjs')
);

let seed = 20261116;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const some = (max, make) => Array.from({ length: Math.floor(rand() * (max + 1)) }, (_, i) => make(i));
const key = (p) => `${p}:${Math.floor(rand() * 4)}`;

const HISTORY = ['authoritative_registry', 'verified_club_confirmed', 'verified_coach_confirmed', 'scoutbox_reviewed',
  'historical_migration', 'system_recorded', 'guardian_submitted', 'player_submitted', 'box_cam_observed'];
const EVIDENCE = [...HISTORY, 'unheard_of'];
const STATES = ['verified', 'partially_verified', 'unable_to_verify', 'invalidated', null];
const COMBINE = ['combine_verified', 'partially_measured', 'ready'];

const cases = [];
for (let i = 0; i < 600; i++) {
  const input = {
    isAdult: rand() < 0.7,
    identity: pick([null, 'authoritative', 'organisation_attested', 'scoutbox_document_review']),
    history: some(5, () => ({ key: key('h'), provenance: pick(HISTORY), current: rand() < 0.5 })),
    relationships: some(6, () => ({ key: key('r'), kind: pick(['club', 'coach', 'agency']), verified: rand() < 0.7 })),
    evidence: some(9, () => ({ key: key('e'), provenance: pick(EVIDENCE), recordedAt: Math.floor(rand() * 1e12) })),
    boxSessions: some(8, () => ({ key: key('b'), verificationState: pick(STATES), simulated: rand() < 0.3, endedAt: 1 })),
    combine: some(6, () => ({
      key: key('c'),
      protocolId: pick(['box_touch_60', 'sprint_10m', 'jump']),
      protocolVersion: pick([1, 2]),
      combineState: pick(COMBINE),
      simulated: rand() < 0.3,
    })),
    references: some(4, () => ({ key: key('ref'), verified: rand() < 0.6 })),
    assessments: some(4, () => ({ key: key('a'), verifiedSource: rand() < 0.6 })),
    allowSimulated: rand() < 0.3,
  };
  const profile = calculateTrustScore({
    playerContext: { isAdult: input.isAdult },
    identity: input.identity ? { assurance: input.identity } : null,
    historyRows: input.history,
    relationships: input.relationships,
    evidenceItems: input.evidence,
    boxCamSessions: input.boxSessions,
    combineAttempts: input.combine,
    references: input.references,
    assessments: input.assessments,
    allowSimulatedEvidence: input.allowSimulated,
  });
  const { at: _, ...snapshot } = trustSnapshot(profile);
  cases.push({
    input,
    self: JSON.stringify(safeTrustProjection(profile, 'self')),
    club: JSON.stringify(safeTrustProjection(profile, 'pro_club')),
    snapshot: { score: snapshot.score, band: snapshot.band, policyVersion: snapshot.policyVersion, hash: snapshot.hash,
      levels: Object.fromEntries(Object.entries(snapshot.components).map(([k, c]) => [k, c.level])) },
  });
}
const out = path.join(HERE, '..', 'test', 'fixtures', 'trust_cases.json');
fs.writeFileSync(out, `${JSON.stringify(cases)}\n`);
console.log(`trust_cases: wrote ${cases.length} cases to ${path.relative(process.cwd(), out)}`);
