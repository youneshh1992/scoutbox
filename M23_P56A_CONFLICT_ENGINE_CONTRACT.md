# M23 P5.6A — Conflict-of-Interest Engine Contract

The pure-function contract for the engine P5.6C implements. Nothing here
is built at `669d060`. The engine is a **compliance evaluation**, not a
legal determination (mandate §170; `M23_P56A_AGENT_REGULATORY_SNAPSHOT.md`
L-1, L-4): it applies the encoded, versioned rule states and returns an
outcome with reasons; where the applicable rules are suspended, doubtful,
contradictory or missing it returns review, never a guess.

---

## 1. Inputs

```
evaluateConflict({
  transaction: {
    id, type ∈ employment_contract | transfer | loan | other_services | unknown,
    jurisdictions: [ { memberAssociation, role: engaging | releasing | individual } ],
    parties: [ { partyRole ∈ individual | engaging_entity | releasing_entity,
                 subjectKind ∈ player | coach | club, subjectId | externalRef } ],
    representations: [ { agentUserId, agencyOrgId, partyRole, agreementId | null, declaredOnly: boolean } ],
    otherServices: [ { agentUserId, partyRole, startedAt, kind } ]           // R-F17
  },
  agents: { [agentUserId]: { licenceState, nationalRegistrations: [ma], connectedAgentUserIds: [..] } },
  consents: [ { kind: dual_representation, transactionId, partyRole, grantedBy, grantedAt, policyVersion, revokedAt } ],
  interests: [ { kind ∈ agent_relationship | ownership | family, holderKind, holderId, agentUserId } ],   // R-F18, M14 declarations
  policySet: [ jurisdictionPolicies rows for every MA in transaction.jurisdictions + FIFA ],
  now
}) → ConflictResult
```

Everything the engine reads is passed in; it never touches `db`. That is
what makes it testable against §151 and replayable for a historical
decision.

## 2. Output

```
ConflictResult = {
  outcome ∈ CLEAR
          | PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED
          | PROHIBITED_CONFLICT
          | MANUAL_REGULATORY_REVIEW_REQUIRED
          | INSUFFICIENT_DATA,
  reasons: [ { code, ruleId, state, jurisdiction, agentUserId?, partyRoles?: [..] } ],
  consentsOutstanding: [ { partyRole, agentUserId, reasonCode } ],
  policyVersions: [ 'jp-fifa-1', 'jp-eng-1', ... ],
  evaluatedAt: now,
  inputHash: sha256(canonical(inputs))
}
```

The five outcomes are exclusive and ordered by severity for aggregation:
`INSUFFICIENT_DATA` > `MANUAL_REGULATORY_REVIEW_REQUIRED` >
`PROHIBITED_CONFLICT` > `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` >
`CLEAR`. When several rules fire, the most severe wins and **all** reasons
are returned. (`INSUFFICIENT_DATA` outranks `PROHIBITED_CONFLICT` so that a
prohibition is never asserted from incomplete facts; both refuse.)

## 3. Connected agents (R-F15)

Before any rule runs, each agent's `connectedAgentUserIds` is expanded and
every representation held by a connected agent is attributed to the
evaluated agent as well ("a Football Agent … shall be deemed to be acting
as a Football Agent for that Client" — FFAR 12(10), quoted in the
snapshot). Connectedness sources:

- same `agencyOrgId` with an active `agencyAffiliations` row (FFAR 12(10)
  same-agency; FA 6.5) — **default on**, L-4 to relax;
- a declared `interest` of kind `agent_relationship` or `family` between
  two agents;
- future: ownership links, when a source is encoded.

Reason code when a connection changes an outcome:
`CONNECTED_AGENT_ATTRIBUTION`.

## 4. Rule tables

Each rule has an id, a source, and a **state per jurisdiction** read from
the policy set (`in_force | suspended | doubtful | not_encoded`). The
engine applies the rule only in state `in_force`; `suspended` contributes
a reason with `state: suspended` and does **not** block; `doubtful` and
`not_encoded` yield `MANUAL_REGULATORY_REVIEW_REQUIRED`. Across the
applicable jurisdictions the **stricter** effective result wins; if one
jurisdiction's in-force rule prohibits what another's permits, the result
is `PROHIBITED_CONFLICT` in the prohibiting jurisdiction's terms and, if
the transaction genuinely spans both, `MANUAL_REGULATORY_REVIEW_REQUIRED`
with `POLICY_CONTRADICTION` (P-7).

### 4.1 Representation combinations per Transaction

Let the evaluated agent (plus connected agents) hold representation for a
set S ⊆ {individual, engaging_entity, releasing_entity}.

| S | FFAR text (12(8)–(9)) | FIFA state (snapshot R-F16) | England (6.3–6.4) | Engine result (rule id) |
|---|---|---|---|---|
| {individual} | allowed | in_force (12(1)–(7) not suspended) | allowed | `CLEAR` |
| {engaging} | allowed | — | allowed | `CLEAR` |
| {releasing} | allowed | — | allowed, exclusive (6.4) | `CLEAR` |
| {individual, engaging} | permitted **with prior written consent** of both (12(8)(a)) | **suspended** | permitted, dual, all parties' prior written consent, full particulars, legal advice, express consent (6.3(a)) | `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` where any applicable MA has the dual rule `in_force`; FIFA-only jurisdiction: `MANUAL_REGULATORY_REVIEW_REQUIRED` with `RULE_SUSPENDED` (`CONF-DUAL`) |
| {individual, releasing} | prohibited (12(9)(a)) | suspended | prohibited (6.4: releasing club exclusive) | `PROHIBITED_CONFLICT` where England (or any MA with it in force) applies; FIFA-only: `MANUAL_REGULATORY_REVIEW_REQUIRED` (`CONF-REL-IND`) |
| {engaging, releasing} | prohibited (12(9)(b)) | suspended | prohibited (6.4) | as above (`CONF-REL-ENG`) |
| {individual, engaging, releasing} | prohibited (12(9)(c)) | suspended | prohibited (6.4) | as above (`CONF-ALL`) |
| England "multiple" (individual + engaging + a further individual, e.g. coach) | not in FFAR | — | permitted with all consents (6.3(b) "multiple") | `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` in England only; elsewhere review (`CONF-MULTI`) |

Answers this table fixes for §191:

- General single-party representation rule supported by current FIFA
  source: **YES as text, currently suspended by FIFA** (R-F16); supported
  and in force in England. The engine encodes it as data with state.
- Permitted dual-representation path exists under current FIFA source:
  **YES as text (12(8)(a)), suspended**; in force in England (6.3).
- Separate advance written consent required where the rule requires it:
  **YES** (12(8)(a) "prior written consent"; FA 6.3 "prior written
  consent … express consent").
- Releasing entity + individual same agent: **NO** where the rule is in
  force (12(9)(a); FA 6.4).
- Releasing + engaging: **NO** (12(9)(b); FA 6.4).
- All parties: **NO** (12(9)(c); FA 6.4).

### 4.2 Consent sufficiency (for the dual path)

A `dual_representation` consent is sufficient only if: `revokedAt` null;
`grantedAt < ` the first regulated act in the transaction by that agent
for the second party (advance, not retroactive); `grantedBy` is the party
itself (individual/guardian, or a club user recorded as the club's
authorised signatory — DR-19); `policyVersion` matches a version whose
dual rule was `in_force` at `grantedAt`; and, for England, the consent
record carries `fullParticularsProvided: true` and
`legalAdviceOffered: true` (6.3 particulars). Missing → still
`PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` with the missing
element as `reasonCode`.

### 4.3 Other Services presumption (R-F17)

If the agent provided `otherServices` to a party within 24 months before
or after the transaction, add reason `OTHER_SERVICES_PRESUMPTION` and
elevate a `CLEAR` to `MANUAL_REGULATORY_REVIEW_REQUIRED`. Never
prohibits; the presumption is rebuttable and that is counsel's matter.

### 4.4 Interests (R-F18)

A declared `interest` linking a **club user** on one side to the agent
(M14 `agent_relationship` declarations) → `INTEREST_DECLARED`,
`MANUAL_REGULATORY_REVIEW_REQUIRED`. An interest of an *ineligible
person* is not encodable yet (no source of who is ineligible) →
`not_encoded`.

### 4.5 Exclusive-agreement approach window (R-F12, R-E10)

Not a transaction rule; belongs to proposals (A14). The CJEU found it
"appears … incompatible with the prohibition on cartels"; state
`doubtful` in the FIFA set, `in_force`-but-flagged in England. Proposal
evaluation therefore returns `MANUAL_REGULATORY_REVIEW_REQUIRED` with
`EXCLUSIVITY_WINDOW_DOUBTFUL` when the client has an active exclusive
agreement with another agent expiring within two months, and **never**
`PROHIBITED_CONFLICT`. ScoutBox knows about another agent's agreement
only if that agreement is in ScoutBox; the reason must not disclose the
other agent's identity (code only).

### 4.6 One agreement per pair (R-F10, FA 4.4)

Proposal-time rule: an active or proposed agreement between the same
`agentUserId` and the same client → 409 `REPRESENTATION_ALREADY_EXISTS`;
England's tripartite-at-transaction exception is modelled as a
`transactionRepresentations` row, not a second agreement.

### 4.7 Minors (R-F20–R-F22, R-E4–R-E6)

Handled by the minors gate in the authorization contract §7, before the
engine. The engine adds `MINOR_PARTY` as a reason whenever an individual
party is a regulatory minor and requires a `guardian_agreement` consent
on the agreement in play; missing → `INSUFFICIENT_DATA`.

### 4.8 Missing facts

| Missing | Result |
|---|---|
| a representation with `declaredOnly: true` (entity client with no ScoutBox agreement) | `MANUAL_REGULATORY_REVIEW_REQUIRED` `REPRESENTATION_UNVERIFIED` (DR-18) |
| transaction `type: unknown` | `INSUFFICIENT_DATA` |
| no policy row for an applicable MA | `INSUFFICIENT_DATA` `POLICY_NOT_ENCODED` |
| agent `licenceState !== verified` | not the engine's job; the route refused at step 5 already; if reached, `INSUFFICIENT_DATA` `AGENT_STATE_INVALID` (defence in depth) |
| party with `subjectKind: player` whose id resolves to nothing (deleted) | `INSUFFICIENT_DATA` `PARTY_REMOVED` |

## 5. Determinism, replay, history

- Pure: same inputs → same output; `inputHash` proves it.
- Every evaluation is appended to `agentTransactions.evaluations[]` (or
  `representationAgreements.evaluations[]` for proposal rules) with
  `policyVersions`; a later re-evaluation never overwrites an earlier one
  (§191 "historical compliance decision preserves policy version").
- Re-evaluation triggers: transaction open; party added/removed;
  representation added/removed; consent granted/revoked; agreement state
  change for any represented party; policy version published (a
  background sweep marks affected transactions `re_evaluation_pending` and
  the next mutation re-runs; reads show the last result and the pending
  flag, never a silently updated verdict).
- Event `conflict_evaluated` on every run.

## 6. What the engine never does

- Never disclose the other side's agents or agreements in a reason
  (codes only).
- Never rank or score agents.
- Never treat T&S resolution of a review as changing the *rule*; a
  resolution is a recorded decision on one transaction under one policy
  version, with per-reviewer attribution (DR-29).
- Never "learn" or soften a state because a provider is down: a missing
  policy row is `INSUFFICIENT_DATA`, full stop.
- Never evaluate a Club Recruitment Case, an assessment or a decision;
  those are outside its inputs by construction.

## 7. Illustrative evaluations (become P5.6C tests, group E/F/G)

| Case | Inputs | Expected |
|---|---|---|
| E1 | England employment contract; agent represents individual only | `CLEAR`, `jp-eng`, `jp-fifa` |
| E2 | England; agent represents individual + engaging club; no consents | `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED`, `consentsOutstanding` both roles |
| E3 | E2 + both consents in advance with particulars + legal advice | `CLEAR` with reason `DUAL_CONSENTED` |
| E4 | E2 + consent dated **after** the agent's first act for the club | still consent required (`CONSENT_NOT_IN_ADVANCE`) |
| E5 | England; agent represents releasing club + individual | `PROHIBITED_CONFLICT` (`CONF-REL-IND`) |
| E6 | Jurisdiction with only FIFA encoded; individual + engaging | `MANUAL_REGULATORY_REVIEW_REQUIRED` (`RULE_SUSPENDED`) |
| E7 | Jurisdiction with no policy row | `INSUFFICIENT_DATA` |
| E8 | Agent A represents individual; colleague B at the same agency represents engaging club; no consents; England | `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` with `CONNECTED_AGENT_ATTRIBUTION` |
| E9 | E8 but B represents the releasing club | `PROHIBITED_CONFLICT` with `CONNECTED_AGENT_ATTRIBUTION` |
| E10 | Agent provided Other Services to the engaging club 10 months earlier; represents individual | `MANUAL_REGULATORY_REVIEW_REQUIRED` (`OTHER_SERVICES_PRESUMPTION`) |
| E11 | Club user declared `agent_relationship` with the agent | review (`INTEREST_DECLARED`) |
| E12 | Individual party is 17; England; no guardian agreement consent | `INSUFFICIENT_DATA` (`MINOR_PARTY`) |
| E13 | Transaction spans England (engaging) and an MA where dual is `not_encoded` | review (`POLICY_NOT_ENCODED`) |
| E14 | Consent revoked before evaluation | consent required again |
| E15 | Same inputs twice | identical `inputHash` and output |
