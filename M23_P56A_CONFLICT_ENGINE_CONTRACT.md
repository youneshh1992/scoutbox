# M23 P5.6A — Conflict-of-Interest Engine Contract

The pure-function contract for the engine P5.6C implements. Nothing here
is built at the P5.6A tips. The engine is a **compliance evaluation**, not
a legal determination: it applies encoded, versioned rule entries with
their **rule status**, and returns an outcome with reasons; where the
deciding rule's operative status is uncertain, missing, or the applicable
policies contradict each other, it returns review, never a guess
(`M23_P56A_AGENT_REGULATORY_SNAPSHOT.md` §0, §11; product policy P-7).

Currency closure (18 Sep 2026): the England tables below are taken from
the **FA Football Agent Regulations 2026-27** (in force 1 June 2026), not
the 2025-26 text; the FIFA tables carry `UNDER_LEGAL_REVIEW` for the
articles whose enforcement Circular 1873 suspended and whose current
status FIFA has not settled after the CJEU judgment (snapshot R-F16).

---

## 1. Inputs

```
evaluateConflict({
  transaction: {
    id, type ∈ employment_contract | transfer | loan | other_services | unknown,
    scope ∈ national | international | unknown,                                   // resolved by the jurisdiction resolver (§4.0)
    jurisdictions: [ { memberAssociation, role: engaging | releasing | individual } ],
    parties: [ { partyRole ∈ individual | engaging_entity | releasing_entity,
                 subjectKind ∈ player | coach | club, subjectId | externalRef } ],
    representations: [ { agentUserId, agencyOrgId, partyRole, agreementId | null, declaredOnly: boolean,
                         performanceBasis ∈ own_agreement | agency_party_consent } ],   // England R-E2b route
    otherServices: [ { agentUserId, partyRole, startedAt, kind } ]           // FFAR 15(3) / FA Other Services
  },
  agents: { [agentUserId]: { licenceState, nationalRegistrations: [ma], connectedAgentUserIds: [..] } },
  consents: [ { kind: dual_representation | agency_performance, transactionId, agreementId, partyRole, grantedBy, grantedAt,
                policyVersion, revokedAt, particulars: { fullParticularsProvided, legalAdviceOffered } } ],
  interests: [ { kind ∈ agent_relationship | ownership | family, holderKind, holderId, agentUserId } ],
  policySet: [ jurisdictionPolicies rows for every MA in transaction.jurisdictions + FIFA ],
  now
}) → ConflictResult
```

Everything the engine reads is passed in; it never touches `db`.

## 2. Output

```
ConflictResult = {
  outcome ∈ CLEAR
          | PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED
          | PROHIBITED_CONFLICT
          | MANUAL_REGULATORY_REVIEW_REQUIRED
          | INSUFFICIENT_DATA,
  reasons: [ { code, ruleId, ruleStatus, regulator, jurisdiction, policyVersion, agentUserId?, partyRoles?: [..] } ],
  consentsOutstanding: [ { partyRole, agentUserId, consentKind, reasonCode } ],
  policyVersions: [ 'jp-fifa-2025-1', 'jp-eng-2026-27-1', ... ],
  evaluatedAt: now,
  inputHash: sha256(canonical(inputs))
}
```

Severity order for aggregation: `INSUFFICIENT_DATA` >
`MANUAL_REGULATORY_REVIEW_REQUIRED` > `PROHIBITED_CONFLICT` >
`PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` > `CLEAR`. The most
severe wins and **all** reasons are returned.

## 3. Rule status semantics (policy layer)

Every rule entry in a `jurisdictionPolicies` version carries:

```
{ ruleId, regulator: 'FIFA' | 'FA' | …, jurisdiction: 'INT' | 'ENG' | 'USA' | …,
  effectiveFrom, effectiveTo | null, policyVersion,
  ruleStatus ∈ ACTIVE | SUSPENDED | PARTIALLY_SUSPENDED | JURISDICTION_OVERRIDE | UNDER_LEGAL_REVIEW | UNKNOWN,
  params: {...}, sourceRef: [ { source, version, effectiveDate, retrievedDate } ], note }
```

How the engine treats each status when the rule would decide an outcome:

| `ruleStatus` | Engine behaviour |
|---|---|
| `ACTIVE` | applied |
| `SUSPENDED` | **not applied**; reason `RULE_SUSPENDED` attached; never blocks on its own; if *no* `ACTIVE` rule decides the same question in the applicable set, the outcome is `MANUAL_REGULATORY_REVIEW_REQUIRED` (a suspended rule is not a permission) |
| `PARTIALLY_SUSPENDED` | the `params.activeLimbs` are applied; suspended limbs as `SUSPENDED` |
| `JURISDICTION_OVERRIDE` | the national entry named in `params.overrideRuleId` is used for transactions inside that jurisdiction's scope; the FIFA entry's own status still governs international-dimension transactions |
| `UNDER_LEGAL_REVIEW` | **`MANUAL_REGULATORY_REVIEW_REQUIRED`** with reason `RULE_STATUS_UNCERTAIN` — never `CLEAR`, never `PROHIBITED_CONFLICT` |
| `UNKNOWN` | `MANUAL_REGULATORY_REVIEW_REQUIRED` with reason `POLICY_NOT_ENCODED` (or `INSUFFICIENT_DATA` when the missing thing is a parameter needed to evaluate an `ACTIVE` rule) |

Initial content (from the snapshot; every entry cites source, version,
effective date and retrieved date 18 Sep 2026):

| Version | Rule ids | `ruleStatus` |
|---|---|---|
| `jp-fifa-2025-1` (FFAR in force 1 Jan 2025) | 8(1), 11(1), 11(3), 12(1)–(7), 12(13)–(14), 13(1)–(4), 14(9), 16(2)(c), 16(3) | `ACTIVE` |
| | 12(8), 12(9), 12(10), 14(2)(6)(7)(8)(10)(11)(12)(13), 15(1)–(4), 16(2)(h)(j)(k)(4), 19, submission rule | `UNDER_LEGAL_REVIEW` (Circular 1873 suspension; end-condition unclear after CJEU 16 Jul 2026; no FIFA notice) |
| | 16(1)(b)–(c) exclusivity window | `UNDER_LEGAL_REVIEW` (CJEU: appears incompatible) |
| | 13(1) first-contract-age parameter | `ACTIVE` rule, `params.firstContractAge: UNKNOWN` per country |
| `jp-eng-2026-27-1` (FA 2026-27, in force 1 Jun 2026) | 2.1, 2.2, 2.10, 3.1, 3.3, 3.4, 4.1(a)(b), 4.3–4.7, 4.10, 4.11, 5.1–5.7, 6.1–6.7, 7.2–7.4, 7.10, 7.11, 7.14, 8.3, 8.4(f)(g), 8.5–8.8, 9.5, 9.6 | `ACTIVE` (G-covered or unambiguous) |
| | 7.13 Clearing House; reporting limbs mirroring FFAR 16(2)(h)(j)(k) | `PARTIALLY_SUSPENDED` / `UNKNOWN` pending L-7 |
| | 8.1(b)–(c), 8.2 exclusivity window | `UNDER_LEGAL_REVIEW` |
| | 6.3–6.5 relative to FFAR 12(8)–(10) | `JURISDICTION_OVERRIDE` on the FIFA entries for `scope: national` England transactions |
| `jp-usa-2024-1` | licence required; background check; SafeSport | `ACTIVE`; everything else `UNKNOWN` |

## 4. Rule tables

### 4.0 Jurisdiction resolution first

The engine receives `transaction.scope` from the resolver
(authorization contract §5.2): `national` when every party and the
transaction fall inside one MA's national scope (England: FA scope 1.1 —
a National Transaction, agreements with English clubs, agreements with
players/coaches other than those solely for a Specified International
Transaction); `international` when the FFAR "international dimension"
applies; `unknown` otherwise. `unknown` → `INSUFFICIENT_DATA`
(`SCOPE_UNRESOLVED`). Mixed cases (L-18) → `MANUAL_REGULATORY_REVIEW_REQUIRED`
(`SCOPE_MIXED`).

### 4.1 Connected agents

Before any rule runs, each agent's `connectedAgentUserIds` is expanded
and every representation held by a connected agent is attributed to the
evaluated agent. Sources: same `agencyOrgId` with an active affiliation
(FFAR 12(10) + definition; FA 6.5 + "Connected Football Agent" definition,
2026-27: same Agency, directors/shareholders/co-owners, family, repeated
cooperation or revenue sharing) — default on, L-4 to relax; declared
`agent_relationship` / `family` interests. Reason
`CONNECTED_AGENT_ATTRIBUTION`. England's colleague-performance route
(R-E2b, §4.4) does not remove attribution: two colleagues serving
different parties in one National Transaction are still one agent under
6.5 and need 6.3 consents.

### 4.2 Representation combinations — **England, National Transactions (`jp-eng-2026-27-1`, ACTIVE)**

Let S be the set of party roles the evaluated agent (plus connected
agents) serves.

| S | FA 2026-27 rule | Result |
|---|---|---|
| {individual} / {engaging} / {releasing} | 6.3 default one party | `CLEAR` |
| any S with \|S\| ≥ 2 that **does not** contain `releasing` (e.g. {individual, engaging}; {individual, engaging, individual₂}; {engaging, individual₂}) | 6.3(a) permitted dual **or multiple** representation with the four safeguards | `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` until §4.3 is satisfied for **every** other party; then `CLEAR` with `DUAL_CONSENTED` (`ENG-6.3`) |
| any S containing `releasing` with \|S\| ≥ 2 | 6.4 releasing club exclusive | `PROHIBITED_CONFLICT` (`ENG-6.4`) |
| S met only through a connected colleague | 6.5 | as above + `CONNECTED_AGENT_ATTRIBUTION` |

Required prior consents, disclosure, legal-advice and form obligations
(6.3(a)(i)–(iv), 6.2, 7.11): (i) all parties' prior written consent to the
agent serving the other party(ies), in the FA's prescribed form; (ii)
before the second agreement, full particulars of the proposed arrangement
to all parties incl. the proposed fee from each party; (iii) reasonable
opportunity for independent legal advice, and for a player/coach a
written notice to consider independent legal advice and/or PFA/LMA
advice, before consenting; (iv) express written consent by all parties on
the proposed terms in the prescribed form. Guidance: the AF1 submitted at
completion "will constitute written consent". Where any party withholds
consent the agent continues for the first party only and takes no fee
from the others (6.3(b)). In dual representation the Engaging Club may pay
up to 50 % of the fee (7.11). Every performing agent is named on the AF1
(6.2). ScoutBox records these as consent-ledger rows and does not lodge
the AF1 (L-16).

### 4.3 Consent sufficiency (both tables)

A `dual_representation` consent is sufficient only if: `revokedAt` null;
`grantedAt` precedes the first regulated act by that agent for the second
party (advance); `grantedBy` is the party itself (individual / guardian, or
a club user recorded as signatory, DR-19); `policyVersion` names a version
in which the deciding rule was `ACTIVE`; and for England
`fullParticularsProvided: true` and `legalAdviceOffered: true`. Missing →
still `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` with the missing
element as `reasonCode` (`CONSENT_NOT_IN_ADVANCE`, `PARTICULARS_MISSING`,
`LEGAL_ADVICE_NOT_OFFERED`, `SIGNATORY_REQUIRED`).

### 4.4 England agency-party performance (R-E2b; `jp-eng-2026-27-1`, ACTIVE; England only)

A representation with `performanceBasis: agency_party_consent` is
accepted as a valid representation of that party only if: the agreement
has `agencyParty: true`; an unrevoked `agency_performance` consent from
**all parties to the agreement** predates the performing agent's first
act; the performing agent is FA-registered, licence-verified and
currently affiliated to the same agency; and `transaction.scope ===
'national'` for England. Otherwise the representation is treated as
`declaredOnly` (→ review) or absent (→ the route refused it at step 6).
Reason `AGENCY_PERFORMANCE_CONSENTED` is attached so the audit shows the
basis. Outside England this basis is `UNKNOWN` → review.

### 4.5 Representation combinations — **FIFA text, international dimension (`jp-fifa-2025-1`)**

| S | FFAR text (12(8)–(9)) | `ruleStatus` | Result |
|---|---|---|---|
| single party | 12(8) default | ACTIVE (12(1)–(7) side) | `CLEAR` |
| {individual, engaging} | 12(8)(a) permitted with prior explicit written consent of both | `UNDER_LEGAL_REVIEW` | `MANUAL_REGULATORY_REVIEW_REQUIRED` (`RULE_STATUS_UNCERTAIN`, `FIFA-12.8`) — **not** `CLEAR`, **not** consent-required |
| {individual, releasing} / {engaging, releasing} / all three | 12(9)(a)–(c) prohibited | `UNDER_LEGAL_REVIEW` | `MANUAL_REGULATORY_REVIEW_REQUIRED` (`RULE_STATUS_UNCERTAIN`, `FIFA-12.9`) — **not** `PROHIBITED_CONFLICT` |
| any other multiple set | not permitted by 12(8) text | `UNDER_LEGAL_REVIEW` | review |
| via connected agent | 12(10) | `UNDER_LEGAL_REVIEW` | review + `CONNECTED_AGENT_ATTRIBUTION` |

When a FIFA `jp-fifa` version is later published with these rules
`ACTIVE` (or `SUSPENDED` with an express FIFA statement), the table
becomes: {individual, engaging} → consent-required/CLEAR; releasing
combinations → `PROHIBITED_CONFLICT`; other multiples → `PROHIBITED_CONFLICT`
— a data change under C7, not code.

Answers this fixes for §191 (unchanged in substance, corrected in
status): single-party rule supported by current FIFA source — **YES as
text; operative status not conclusively established**; dual path exists
under current FIFA source — **YES as text; same status**; advance
written consent required where the rule requires it — **YES**; releasing
+ individual, releasing + engaging, all parties — **NO** where an `ACTIVE`
rule governs (England now; FIFA when settled), **review** where the FIFA
status is uncertain.

### 4.6 Other Services presumption (FFAR 15(3), `UNDER_LEGAL_REVIEW`; FA: Other Services counted inside 6.3–6.5, ACTIVE)

FIFA: reason `OTHER_SERVICES_PRESUMPTION`, `MANUAL_REGULATORY_REVIEW_REQUIRED`.
England: Other Services for another party in the same National
Transaction are themselves within 6.3–6.5, so they enter S directly.

### 4.7 Interests (FFAR 11(4), 18(2)(i) ACTIVE; FA 3.5, 8.6 ACTIVE)

A declared `interest` linking a club user on one side to the agent →
`INTEREST_DECLARED`, review. Ineligible-person interests: not encodable →
`UNKNOWN`.

### 4.8 Exclusive-agreement approach window (FFAR 16(1)(b)–(c); FA 8.1(b)–(c), 8.2) — `UNDER_LEGAL_REVIEW`

Proposal-time rule: another agent's active exclusive agreement in
ScoutBox expiring within two months → `MANUAL_REGULATORY_REVIEW_REQUIRED`
(`EXCLUSIVITY_WINDOW_DOUBTFUL`), never a block, other agent's identity
never disclosed.

### 4.9 One agreement per pair (FFAR 12(4) ACTIVE; FA 4.4 ACTIVE)

409 `REPRESENTATION_ALREADY_EXISTS`; England tripartite exception modelled
as a `transactionRepresentations` row.

### 4.10 Minors (FFAR 13 ACTIVE with unknown parameter; FA 5.1–5.7 ACTIVE)

Handled by the minors gate before the engine; the engine adds
`MINOR_PARTY` and requires a `guardian_agreement` consent; missing →
`INSUFFICIENT_DATA`. England's calendar formula lives only in
`jp-eng-2026-27-1`; a FIFA-formula jurisdiction without an encoded
first-contract age → `INSUFFICIENT_DATA`.

### 4.11 Missing facts

| Missing | Result |
|---|---|
| `declaredOnly` representation | review `REPRESENTATION_UNVERIFIED` |
| `type: unknown` or `scope: unknown` | `INSUFFICIENT_DATA` |
| no policy row for an applicable MA | `INSUFFICIENT_DATA` `POLICY_NOT_ENCODED` |
| deciding rule `UNDER_LEGAL_REVIEW` | review `RULE_STATUS_UNCERTAIN` |
| contradictory `ACTIVE` rules across applicable MAs | review `POLICY_CONTRADICTION` |
| agent `licenceState !== verified` | `INSUFFICIENT_DATA` `AGENT_STATE_INVALID` (defence in depth) |
| deleted party | `INSUFFICIENT_DATA` `PARTY_REMOVED` |

## 5. Determinism, replay, history

Pure; `inputHash`; append-only `evaluations[]` with `policyVersions` and
each reason's `ruleStatus` at evaluation time; re-evaluation on open,
party change, representation change, consent grant/revoke, agreement
state change, and policy publication (records flagged
`re_evaluation_pending`, never silently re-verdicted); `conflict_evaluated`
event per run.

## 6. What the engine never does

Never discloses the other side's agents or agreements; never ranks
agents; never treats a T&S review resolution as a rule change; never
softens a status because a source is offline; never evaluates a club
Case, assessment or decision; **never resolves an `UNDER_LEGAL_REVIEW`
rule by choosing the stricter or looser reading itself**.

## 7. Illustrative evaluations (P5.6C tests, groups E/F/G)

| Case | Inputs | Expected |
|---|---|---|
| E1 | England national employment contract; agent represents individual only | `CLEAR` (`jp-eng-2026-27-1`) |
| E2 | England national; individual + engaging club; no consents | `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED`, both roles outstanding |
| E3 | E2 + both consents in advance with particulars + legal advice | `CLEAR`, `DUAL_CONSENTED` |
| E4 | E2 + consent dated after the agent's first act for the club | still required (`CONSENT_NOT_IN_ADVANCE`) |
| E5 | England national; releasing club + individual | `PROHIBITED_CONFLICT` (`ENG-6.4`) |
| E5b | England national; individual + engaging + a second individual (coach), all consents | `CLEAR` (multiple representation, `ENG-6.3`) |
| E5c | England national; engaging + releasing | `PROHIBITED_CONFLICT` (`ENG-6.4`) |
| E6 | International dimension; individual + engaging; FIFA-only set | `MANUAL_REGULATORY_REVIEW_REQUIRED` (`RULE_STATUS_UNCERTAIN`, `FIFA-12.8`) |
| E6b | International dimension; releasing + individual | `MANUAL_REGULATORY_REVIEW_REQUIRED` (`RULE_STATUS_UNCERTAIN`, `FIFA-12.9`) — not `PROHIBITED_CONFLICT` |
| E7 | MA with no policy row | `INSUFFICIENT_DATA` |
| E8 | England; A represents individual; colleague B at the same agency represents engaging club; no consents | consent required + `CONNECTED_AGENT_ATTRIBUTION` |
| E9 | E8 but B represents the releasing club | `PROHIBITED_CONFLICT` + attribution |
| E9b | England; agreement with agency as party; colleague B performs under `agency_performance` consent; single party | `CLEAR` with `AGENCY_PERFORMANCE_CONSENTED` |
| E9c | E9b without the consent | representation treated as absent/declared → review or step-6 refusal |
| E9d | E9b but international dimension | review (`UNKNOWN` basis outside England) |
| E10 | International; Other Services to engaging club 10 months earlier | review (`OTHER_SERVICES_PRESUMPTION`) |
| E11 | Club user declared `agent_relationship` with the agent | review (`INTEREST_DECLARED`) |
| E12 | Individual party is 17; England; no guardian agreement consent | `INSUFFICIENT_DATA` (`MINOR_PARTY`) |
| E13 | Transaction spans England (engaging) and an MA where dual is `UNKNOWN` | review (`POLICY_NOT_ENCODED` / `SCOPE_MIXED`) |
| E14 | Consent revoked before evaluation | consent required again |
| E15 | Same inputs twice | identical `inputHash` and output |
| E16 | `jp-fifa-2025-2` published with 12(8)–(10) `ACTIVE`; E6 re-run | consent-required; E6b → `PROHIBITED_CONFLICT`; earlier evaluation rows untouched |
