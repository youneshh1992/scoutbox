# M23 P5.6C — defect register

Defects found while building P5.6C, in the order they were found. Every one was
reproduced by a check before being fixed, and the check remains in the suite so the
defect cannot return silently. Nothing in this register is open.

Severity: **blocking** = P5.6C cannot be declared complete; **high** = wrong or
unsafe behaviour that a user could hit; **medium** = wrong behaviour behind an
unusual path; **low** = cosmetic or test-only.

---

## C1 — Reviewer identity did not exist (G-C0)
**Severity:** blocking. **Status:** closed.
Inherited from P5.6A/P5.6B: every authoritative compliance action was taken with a
shared admin key, so the record could not say who decided. Closed by the whole of
`M23_P56C_GC0_REVIEWER_ATTRIBUTION.md`: a reviewer store, credentialed login,
server-derived identity, revocation, dual control, and a read-only shared key.
**Guarded by** `m23AgentComplianceE2E` A1–A12, B1–B5; live C1–C8.

## C2 — A consent could be honoured after it was revoked
**Severity:** high. **Status:** closed.
`consentSufficiency` checked `status === 'granted'` before it checked the revocation
row, so a revoked consent whose stored status word was still `granted` (which is
correct, because the ledger is append-only) read as sufficient, and the outcome
reported `CONSENT_MISSING` rather than `CONSENT_REVOKED` when it did fail.
**Fix:** the revocation is now tested first and reported as its own reason code.
**Guarded by** `m23AgentComplianceE2E` S5; live G2b.

## C3 — A review-verified representation blocked its own consent
**Severity:** high. **Status:** closed.
When a reviewer approved a declared entity representation, `applyReviewDecision` set
`firstActAt = now()`. The agent had not acted — a reviewer had — so every consent
obtained afterwards failed as `CONSENT_NOT_IN_ADVANCE`, making the correct sequence
(declare → review → ask → grant) impossible to complete.
**Fix:** a review-verified representation records `verifiedAt` and leaves
`firstActAt` null until the agent themselves acts.
**Guarded by** `m23AgentComplianceE2E` P9, L13, S5; live D1–E7.

## C4 — A blocked player was distinguishable from an unknown one
**Severity:** high (privacy). **Status:** closed.
The representation route checked relationship scope before visibility, so declaring
for a blocked player returned `403 REPRESENTATION_SCOPE_INSUFFICIENT` while an
unknown player returned `404 PARTY_NOT_FOUND`. Comparing the two revealed that the
player existed and was blocked.
**Fix:** visibility, block and adulthood are checked first; every case is the uniform
404.
**Guarded by** `m23AgentComplianceE2E` X6.

## C5 — The evaluated agent's own state was omitted before any representation
**Severity:** medium. **Status:** closed.
The engine's `agents` map was built from the representations present, so a context
with no representation yet carried no state for the agent who opened it, and the
outcome came back `INSUFFICIENT_DATA` with `AGENT_STATE_INVALID` instead of `CLEAR`.
**Fix:** the opener is always included in the evaluated agent set.
**Guarded by** `m23AgentComplianceE2E` K16; live B3.

## C6 — Compliance history was missing from the agency audit feed
**Severity:** medium. **Status:** closed.
`complianceAuditRows` existed but nothing merged it into `/org/agent/agency/audit`,
so an administrator saw no compliance rows and no attributed reviewer role.
**Fix:** the agent module exposes an `auditRows` hook; the feed merges and re-sorts.
**Guarded by** `m23AgentComplianceE2E` AE5; live N9–N9c.

## C7 — The policy id pattern rejected real regulator prefixes
**Severity:** medium. **Status:** closed.
`validatePolicyBody` required exactly three letters between dashes, so
`jp-fifa-2025-2` was refused as invalid input — which broke the entire runtime
publication path for FIFA versions.
**Fix:** the pattern accepts two to six letters.
**Guarded by** `m23AgentComplianceE2E` C14–C26.

## C8 — Duplicate outstanding consents with connected agents
**Severity:** medium. **Status:** closed.
When a colleague's representation was attributed under `ENG-6.5`, the same party
appeared twice in `consentsOutstanding`, so a party would have been asked twice for
one transaction.
**Fix:** outstanding consents are deduplicated by party role.
**Guarded by** `m23AgentComplianceE2E` group O.

## C9 — "In advance" was measured against the wrong act
**Severity:** high. **Status:** closed.
The first draft compared a consent against the **earliest** `firstActAt`, which made
acting for one party and then properly obtaining consent before acting for the
second read as retrospective.
**Fix:** measured against the second-earliest `firstActAt` — the act that made it
multiple representation.
**Guarded by** `m23AgentComplianceE2E` group S pure cases.

## C10 — A colleague was judged in an agent's reasons
**Severity:** medium (privacy). **Status:** closed.
Attributing a connected agent's representation also evaluated that colleague's own
licence state, so an agent could see a verdict about a colleague's standing.
**Fix:** `evaluateAgentUserIds` bounds whose state is assessed to the agent the
evaluation is for.
**Guarded by** `m23AgentComplianceE2E` group O.

## C11 — An event payload key tripped the personal-field sentinel
**Severity:** low. **Status:** closed.
`contextId` matched the M18.2 allowlist sentinel's `/…|text|…/` pattern, so
`m182E2E` refused the payload.
**Fix:** the key is `ctxId`. The sentinel was right; the name was wrong.
**Guarded by** `m182E2E`.

## C12 — Registry audit could not see conditional broadcasts
**Severity:** low. **Status:** closed.
`broadcast(cond ? 'a' : 'b', …)` hid two event names from `m182E2E`, which greps
call sites textually, so the registry reported names the source "never broadcast".
**Fix:** literal call sites for `regulatory_consent_granted` and `_declined`.
**Guarded by** `m182E2E`.

## C13 — `db.x ??= []` near a route definition
**Severity:** low. **Status:** closed.
The boot contract (§18) forbids lazy store creation within 60 lines after a route,
because a store that only exists once a route runs is a store that can be missing on
a clean boot. Five stores were initialised inline.
**Fix:** all five are created at the top of `registerCompliance`, and the migration
guarantees them.
**Guarded by** `m23BootContract` §18; `storeContract` guarantee `migration`.

## C14 — a prohibited combination was recordable as "declared, pending review"
**Severity:** high. **Status:** closed. **Found by:** the live browser suite (N1c).
The outcome severity order ranked `MANUAL_REGULATORY_REVIEW_REQUIRED` (3) and
`INSUFFICIENT_DATA` (4) **above** `PROHIBITED_CONFLICT` (2). When an agent declared
an entity with no ScoutBox agreement into a combination an ACTIVE rule prohibits, the
declared-only fact raised review, review outranked the prohibition, and the route took
the review branch: a `pending_review` representation was written, and a review item was
created that no reviewer could ever approve (`REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE`). The
agent's own screen then showed them as declared for a party they must not act for, on
an item that could never resolve. Only the HTTP path where the individual was declared
*second* was refused, which is why the server suite missed it.
**Fix:** `PROHIBITED_CONFLICT` is now the highest severity. A prohibition is a definite
answer; review and insufficient data are the absence of one, so neither can soften it.
**Guarded by** `m23AgentComplianceE2E` T3, T4, T5 (T5 asserts the severity order
directly); live N1, N1b, N1c.

## C15 — the item a reviewer was deciding vanished mid-decision
**Severity:** medium. **Status:** closed. **Found by:** the live browser suite (C6).
The Trust & Safety queue filtered server-side by status and rendered each item's
resolution form nested inside its list row. Starting a review moved it from `PENDING`
to `IN_REVIEW`, so the row left the filtered list and the form the reviewer was filling
in unmounted under them — losing the reason code, the written reason and the evidence
they had typed.
**Fix:** the console fetches the queue whole and filters in the client; the default
filter is "open work" (pending or in review); and the item being worked on renders in
its own panel above the list, so no status change can hide it.
**Guarded by** live C6, C6b, C7, C7b, C8.

---

## Test-side corrections (not product defects)

| Check | What was wrong |
|---|---|
| `E3` | The fixture's consent timestamps made a correct sequence look retrospective. |
| `P4` | The fee sweep matched `proposedFeeDisclosed`, a field name, not a fee term. Narrowed to word boundaries. |
| `B2` | Expected `REVIEWER_REVOKED` after revocation; the session is deleted, so `REVIEWER_AUTH_REQUIRED` is also correct. |
| `R16` | Expected the wrong code for resolving an already-decided item (`REVIEW_NOT_PENDING`). |
| `P15` | Asserted 200 where `appoint-root` answers 201. |
| `Z10` | Swept express's own bodyless 404 for a route that does not exist. |
| `Z12` | Matched the field name `evidenceRefs` in a validation refusal rather than actual evidence content. |
| `U14` | Was a placeholder; now asserts the uniform 404 for a minor party whose role is already filled, so neither fact leaks. |
| `#16` | Asserted every outstanding consent was stale after a version change; the individual's later decline correctly takes precedence. |
| live `A5b` | Matched the provider note case-sensitively. |
| live `D3` | Asserted the consent ledger on the context screen; it lives on the overview. |
| live `N3` | The honest sentence "Nothing is negotiated here." was not in the stripper, so the sweep flagged the very disclaimer it exists to allow. |
| live `N7b` | Used a non-existent consent id, so the uniform 404 answered before the minor check. Split into two checks: the 404 is an oracle-free refusal, and a real consent belonging to someone else is 403. |

## Deferred, with reasons

| Item | Why it is not in P5.6C |
|---|---|
| Live register integrations (FIFA, FA, USSF) | No credentials or contracts exist. The provider is honest about it: `UNAVAILABLE` never permits, and a real-looking reference goes to attributed review. |
| Minor representation pathway | Out of scope and deliberately closed; the five prerequisites are listed in `M23_P56C_MINOR_COMPLIANCE.md`. |
| Agent Transaction Room, offers, negotiation | Explicitly excluded by the mandate. No store, route, destination or wording for them exists. |
| Jurisdictions beyond FIFA / England / USA | Unsupported is a real answer; adding one is a data change under dual control. |
| A policy-authoring UI | Proposing a version is an API-level act today; the console approves and inspects. |
