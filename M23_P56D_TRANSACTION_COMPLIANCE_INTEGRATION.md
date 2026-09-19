# M23 P5.6D — Transaction ↔ compliance integration

This is the seam P5.6D had to decide, and the decision is recorded here because
nothing in P5.6A–P5.6C fixed it.

## 1. The seam: a transaction OWNS one context and sits BESIDE it

```
agentTransactions row  ──owns──▶  complianceContexts row   (contextId)
        │                                  ▲
        │                                  │ evaluation input
        └── transactionRepresentations ─────┘  (rebuilt projection)
```

- A transaction **owns exactly one** P5.6C `complianceContexts` row, created with
  it and closed with it, and reads that context's verdict. It does not re-implement
  evaluation and it does not hold a second opinion.
- `agentTransactions` sits **beside** the context rather than inside it, because a
  transaction is a workspace with documents, notes, threads, links, a status
  machine and four party lanes, none of which belong to a compliance context.
- `transactionRepresentations` is the **truth** about who acts for whom in this
  transaction. The context's inline `representations` array is the *evaluation
  projection*: `compliance.project()` rebuilds it from the store before every
  evaluation. Two truths that could disagree were rejected as a design.

Rejected alternatives, with the reason:

| Alternative | Rejected because |
| --- | --- |
| Put the transaction inside `complianceContexts` | a context would grow a document layer, an Inbox link layer and a state machine that have nothing to do with conflict evaluation. |
| Give a transaction many contexts | "which context is authoritative right now?" has no honest answer, and staleness becomes unprovable. |
| Copy the representation into the context and let it drift | the drift is the vulnerability: a terminated agreement would keep authorising. |
| Re-implement the conflict engine for transactions | two engines, two verdicts, and a milestone later they differ. |

## 2. The snapshot

`tx.compliance` is the attached evaluation snapshot (§26):

```
{ evaluationId, contextId, evaluatedAt, outcome, reasonCodes[], policyVersions[],
  consentRequirements[], clear, blocked, pendingReason,
  partyRevision, verificationFreshness }
```

`evaluationId` is the context's own evaluation identity (`ctx-N#k`), so a snapshot
can always be traced to the evaluation that produced it. `policyVersions` names
every jurisdiction policy version in effect for that evaluation.
`verificationFreshness` is the facet layer's honest answer, not an assumption.

Sensitive internal detail is not copied into a broad projection: a party sees the
state as a **word** plus reason codes; the policy versions and the evaluation id
go to the agent and to Trust & Safety.

## 3. Compliance state → operational state

`complianceStateFrom(...)` turns the engine's answer into an operational state and
a **named** reason. There is no generic pending (§15). The eight reasons:

| `pendingReason` | Means |
| --- | --- |
| `PARTIES_NOT_CONFIRMED` | not every live party has confirmed its own participation |
| `REPRESENTATION_MISSING` | the engine is clear but nobody has authority in this transaction yet |
| `CONSENT_REQUIRED` | dual representation is permitted **with** prior written consent, and a consent is outstanding |
| `MANUAL_REVIEW` | the engine returned `MANUAL_REGULATORY_REVIEW_REQUIRED`, or a review item is open |
| `INSUFFICIENT_DATA` | a fact the rules need is missing |
| `PROVIDER_UNAVAILABLE` | a verification source could not answer; fail-honest, never fail-open |
| `JURISDICTION_UNSUPPORTED` | ScoutBox has no encoded rules for this jurisdiction |
| `FACET_NOT_VERIFIED` | a required licence facet is not verified or has gone stale |

Plus `blocked: true` for `PROHIBITED_CONFLICT`, which no reviewer can approve
past: only changed facts or changed policy produce a new evaluation (§16).

A safeguarding block is handled **before** any of this, because a block ends the
question rather than answering it (§61). A CLEAR verdict never overrides a block.

## 4. Staleness (§27)

`partyRevisionOf(...)` hashes, by name, exactly the eight things §27 lists:

parties (role, kind, id, confirmed) · the agent · representations (agent, role,
status, agreement) · consents (id, status) · facet states · policy versions ·
blocked subject ids · minor subject ids.

It uses the conflict engine's own canonical `inputHashOf`, so the transaction and
the engine can never disagree about what "the same inputs" means.

`snapshotStaleness(tx, currentPartyRevision)` returns the **reason** it is stale,
or null:

| Reason | When |
| --- | --- |
| `NO_SNAPSHOT` | no evaluation has been recorded. The absence of an evaluation is never a clearance. |
| `INPUTS_CHANGED` | the party revision moved — a party, the agent, a representation, a consent, a facet, a policy version, a block or the minor state changed |
| `POLICY_REPUBLISHED` | a policy version the snapshot cited was superseded and re-evaluation is required |
| `TOO_OLD` | beyond the configured maximum age |

A stale snapshot **authorises no mutation**. The projection reports the current
answer, not the snapshot's: `clear` is `snapshot.clear && !stale`, and
`snapshotClear` carries what the snapshot itself said (defect D9 — a stale
snapshot was reporting `clear: true` and the UI believed it).

## 5. Mutation-time recheck (§28)

Every material mutation re-runs steps 7–14 of the authorization order. Nothing
trusts old page state, an old snapshot, an old consent, an old licence or an old
role. Specifically proven:

| Scenario | Result |
| --- | --- |
| a party changes, then the old clearance is used | `TRANSACTION_COMPLIANCE_STALE` (#11) |
| a consent is revoked between load and mutation | refused; the revocation is in the ledger and the reason is named as revoked, not missing (#12) |
| the agent's licence goes stale between load and mutation | refused with the facet reason (#13) |
| the representation terminates between load and mutation | refused; the binding is no longer effective (#14) |
| the player disputes the agent mid-workflow | access suspended; nothing in the transaction resolves it (#15) |
| the club signatory role is removed mid-workflow | `SIGNATORY_REQUIRED` (#16) |
| the transaction is cancelled while a document upload is in flight | `TRANSACTION_NOT_LIVE` (#17) |
| two status transitions race | one authoritative result; the loser gets 409 (#18) |

## 6. Consent integration (§29/§30)

The P5.6C `regulatoryConsents` ledger is reused. **No second consent store
exists.** The transaction:

- shows which parties are required, and each one's state — requested, granted,
  declined, revoked, stale/superseded;
- lets the agent request a consent (which writes into the ledger, once, with the
  transaction's own subject reference);
- lets each party answer on its own surface — the individual in the player app,
  the club on its verification console, and only a signatory for a club;
- never treats a granted consent as permanent: a revocation takes effect on the
  next evaluation and on the next mutation, and the grant and the revocation both
  stay in the record.

Consent privacy: each party sees its own consent and the *roles* a consent is
required from. One party's acknowledgements and evidence are not shown to another.

## 7. Review integration

When a declaration needs an attributed decision, the transaction creates a P5.6C
`regulatoryReviews` item and records the `reviewId` on the binding, which stays
`declaredOnly` and ineffective meanwhile. When a named reviewer decides, the
P5.6C module calls back through `transactionHooks.representationReviewed`, and the
transaction re-evaluates and re-derives its status. The reviewer is attributed by
name in the compliance record and appears in the agency audit as the role
"Trust & Safety (attributed)" — never by name, and never with the evidence or
reason text.

A reviewer cannot invent an item, cannot approve past an active prohibition, and
has no action on a transaction at all.

## 8. Jurisdiction (§57/§58)

The policy set is derived from the parties' canonical association data and the
transaction's own jurisdictions, resolved against `jurisdictionPolicies` effective
at the moment of evaluation. A client-supplied jurisdiction is not trusted: an
unsupported value is `JURISDICTION_UNSUPPORTED` 422 at creation, and there is no
silent allow. Where a jurisdiction cannot be resolved the transaction may exist as
a draft, and regulated progression stays blocked or manual-review.

## 9. Minor gate (§59/§60)

A minor individual produces the `MINOR_PATHWAY_DISABLED` gate before the engine is
consulted: the transaction fails closed and cannot progress. The guardian remains
a distinct party role and a distinct consent actor in the architecture, so the
pathway can be enabled later without redesign — and the agent is never substituted
for the guardian. General minor discovery remains blocked and no P5.6C rule was
weakened.
