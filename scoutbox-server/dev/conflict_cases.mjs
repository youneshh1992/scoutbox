// Writes test/fixtures/conflict_cases.json: what the TypeScript conflict engine (domains/agents/compliance/
// conflict.mjs) answers for many random inputs over the seeded policy versions, so
// test/scoutbox/agents/conflict_test.gleam can check the ported engine against every one: the outcome, every reason
// with its fields, the outstanding consents, the policy versions and (where no consent is involved) the input hash.
// A case may move some rules to another status first, on both sides, so every branch of the deciding rules is
// reached. Regenerate with `node dev/conflict_cases.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS = path.join(HERE, '../../../scoutbox/scoutbox-server');
const { evaluateConflict } = await import(path.join(TS, 'domains/agents/compliance/conflict.mjs'));
const { applicablePolicySet } = await import(path.join(TS, 'domains/agents/compliance/policy.mjs'));
const { seededPolicyRecords } = await import(path.join(TS, 'repositories/compliancePolicies.mjs'));

let seed = 20261117;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const some = (max, make) => Array.from({ length: Math.floor(rand() * (max + 1)) }, (_, i) => make(i));

const NOW = Date.UTC(2026, 10, 16, 12);
const ROLES = ['individual', 'engaging_entity', 'releasing_entity'];
const AGENTS = ['usr-a', 'usr-b', 'usr-c'];
const STATUSES = ['ACTIVE', 'SUSPENDED', 'PARTIALLY_SUSPENDED', 'JURISDICTION_OVERRIDE', 'PENDING_IMPLEMENTATION',
  'UNDER_LEGAL_REVIEW', 'UNKNOWN'];
const DECIDING = ['FIFA-12.8', 'FIFA-12.9', 'FIFA-12.10', 'ENG-6.3', 'ENG-6.4', 'ENG-6.5'];
const JURISDICTIONS = [['ENG'], ['ENG'], ['ENG'], ['ENG'], ['INT'], ['INT'], ['USA'], ['ENG', 'USA'], ['ENG', 'INT'], ['FRA'], []];
const CONTEXT = 'ctx-1';

const cases = [];
for (let i = 0; i < 1500; i++) {
  const statuses = rand() < 0.5 ? some(3, () => [pick(DECIDING), pick(STATUSES)]) : [];
  const policies = seededPolicyRecords(NOW).map((p) => {
    for (const [ruleId, st] of statuses) if (p.rules[ruleId]) p.rules[ruleId].ruleStatus = st;
    return p;
  });
  // A fifth of the cases are one agent acting for two parties, where consent decides.
  const dual = rand() < 0.2;
  const jurisdictions = dual ? pick([['ENG'], ['INT']]) : pick(JURISDICTIONS);
  const set = applicablePolicySet(policies, jurisdictions, NOW);
  const parties = (dual ? (k) => [0, 1].map(k) : (k) => some(3, k))((k) => {
    const partyRole = ROLES[k];
    const player = partyRole === 'individual';
    return {
      partyRole,
      subjectKind: player ? 'player' : 'club',
      subjectId: player ? 'pl-1' : `org-${k}`,
      removed: !dual && rand() < 0.04,
      isMinor: !dual && player && rand() < 0.06,
    };
  });
  const representations = (dual ? (f) => [0, 1].map(f) : (f) => some(4, f))((k) => ({
    agentUserId: dual ? 'usr-a' : pick(AGENTS),
    partyRole: dual ? ROLES[k] : pick(ROLES),
    agreementId: rand() < 0.5 ? `rep-${Math.floor(rand() * 9)}` : null,
    declaredOnly: !dual && rand() < 0.1,
    status: dual ? 'verified' : pick(['declared', 'verified', 'verified', 'withdrawn']),
    firstActAt: rand() < 0.8 ? NOW - Math.floor(rand() * 1e9) : null,
    ...(!dual && rand() < 0.2 ? { viaColleague: true } : {}),
  }));
  const evaluated = dual || rand() < 0.85 ? ['usr-a'] : [];
  const agents = {};
  for (const id of AGENTS)
    if (rand() < 0.95)
      agents[id] = {
        licenceState: dual || rand() < 0.85 ? 'VERIFIED' : pick(['STALE', 'NO_AFFILIATION']),
        connectedAgentUserIds: AGENTS.filter((x) => x !== id && rand() < 0.4),
      };
  const consents = dual || rand() < 0.5
    ? (dual ? (f) => [0, 1, 0, 1].slice(0, 2 + Math.floor(rand() * 3)).map(f) : (f) => some(6, f))((k) => {
        const kind = dual ? 'dual_representation' : pick(['dual_representation', 'dual_representation', 'guardian_agreement']);
        const status = dual && rand() < 0.8 ? 'granted' : pick(['granted', 'granted', 'granted', 'declined', 'requested', 'revoked']);
        return {
          kind,
          status,
          revokedAt: rand() < 0.05 ? NOW - 5 : null,
          grantedAt: status === 'granted' ? NOW - Math.floor(rand() * (dual ? 1.6e9 : 3e9)) : null,
          contextId: rand() < 0.95 ? CONTEXT : 'ctx-other',
          agentUserId: dual ? 'usr-a' : pick(AGENTS),
          partyRole: dual ? ROLES[k] : pick(ROLES),
          subject: { id: rand() < 0.8 ? 'pl-1' : 'pl-2' },
          grantedBy: { signatory: rand() < 0.95 },
          policyVersions: rand() < 0.9 ? [pick(['jp-eng-2026-27-1', 'jp-eng-2026-27-1', 'jp-fifa-2025-1'])] : [],
          particulars: { fullParticularsProvided: rand() < 0.92, legalAdviceOffered: rand() < 0.85 },
        };
      })
    : [];
  const input = {
    transaction: {
      id: CONTEXT,
      type: pick(['employment_contract', 'transfer', 'loan', 'other_services']),
      jurisdictions: jurisdictions.map((ma) => ({ memberAssociation: ma })),
      parties,
      representations,
      otherServices: [],
      evaluateAgentUserIds: evaluated,
    },
    agents,
    consents,
    interests: [],
    policySet: set.policies,
    missingPolicies: set.missing,
    now: NOW,
  };
  const r = evaluateConflict(input);
  cases.push({
    statuses,
    input: { ...input, policySet: undefined, missingPolicies: undefined },
    jurisdictions,
    outcome: r.outcome,
    reasons: r.reasons.map((x) => ({
      code: x.code,
      ruleId: x.ruleId,
      ruleStatus: x.ruleStatus,
      regulator: x.regulator,
      jurisdiction: x.jurisdiction,
      policyVersion: x.policyVersion,
      overrideRuleId: x.overrideRuleId ?? null,
      agentUserId: x.agentUserId ?? null,
      partyRole: x.partyRole ?? null,
      state: x.state ?? null,
      partyRoles: x.partyRoles ?? null,
      jurisdictions: x.jurisdictions ?? null,
      viaConnectedAgent: x.viaConnectedAgent === true,
    })),
    consentsOutstanding: r.consentsOutstanding,
    policyVersions: r.policyVersions,
    missing: set.missing,
    inputHash: consents.length ? null : r.inputHash,
  });
}

const out = path.join(HERE, '../test/fixtures/conflict_cases.json');
fs.writeFileSync(out, `${JSON.stringify(cases)}\n`);
const counts = {};
for (const c of cases) counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
const codes = {};
for (const c of cases) for (const r of c.reasons) codes[r.code] = (codes[r.code] ?? 0) + 1;
console.log(`conflict cases: wrote ${cases.length}`, counts);
console.log(codes);
