# M23 P5.6D — ScoutBox Agent Transaction Workspace — final report

1. **Starting tip:** `3d2cdd0` (local and remote feature branch, 0/0, clean tree).
2. **Final local tip:** the documentation commit that carries these nine files, which is the tip of `claude/desktop-project-migration-wyk3ec` and is named exactly in the delivery message and in `git log -1`. It cannot state its own hash here, because writing the hash into the file it commits would change it. Its parent — the last code commit — is `9b4c746`. Seven commits sit above the remote tip: `39c7b49` (P5.6C documents relocated to the repository root), the five P5.6D code commits `f5d6757`, `23023f7`, `91438e4`, `020cca0`, `9b4c746`, and this documentation commit.
3. **Starting schema:** 2306.
4. **Final schema:** 2307.
5. **Migration:** one step, `m260_001_transaction_stores`, 2306 → 2307. It creates three empty containers, backfills nothing and reinterprets no existing record as a transaction. Replay adds no record and changes no store.
6. **New stores (3):** `agentTransactions`, `transactionRepresentations`, `transactionDocuments` — all three migration-guaranteed and in `PRODUCTION_REQUIRED_STORES`.
7. **Reused stores:** `representationAgreements`, `regulatoryConsents`, `complianceContexts` and its evaluations, `jurisdictionPolicies`, `regulatoryReviews`, the canonical Inbox (`channels`/`messages`), the canonical evidence/upload path, the canonical audit and event registry, notification preferences, the rate limiter, the rev/idempotency helpers. No store was created where a reference into an existing one served.
8. **Transaction entity:** `agentTransactions` (the frozen P5.6A §4 name). `parties[]` is the single truth; `playerId`, `engagingOrgId` and `releasingOrgId` are derived on projection so they cannot drift. No speculative field, and no fee, commission, salary or escrow field anywhere.
9. **Transaction types:** the four frozen `CONTEXT_TYPES`, **imported** from the P5.6C conflict engine rather than copied — `employment_contract`, `transfer`, `loan`, `other_services`. `renewal` was not frozen and is deferred. `"offer"` is rejected as a type.
10. **Party model:** three frozen roles (`individual`, `engaging_entity`, `releasing_entity`), by canonical id, with the subject kind enforced (a player cannot be an entity, a club cannot be the individual), one party per role, and a releasing entity permitted only for `transfer` and `loan`.
11. **Party history:** no party is deleted or overwritten. `removed`/`removedAt`/`removedBy` tombstone the row; every add, confirmation and removal appends to the party's own history and the transaction's; a change recomputes the party revision and makes the attached snapshot stale by definition.
12. **Status model:** ten explicit states — `DRAFT`, `PARTIES_CONFIRMED`, `COMPLIANCE_PENDING`, `COMPLIANCE_BLOCKED`, `READY`, `ACTIVE`, `ON_HOLD`, `CANCELLED`, `CLOSED`, `ARCHIVED`. No freeform string. `CLOSED` was chosen over `COMPLETED` to avoid implying a concluded transfer (§21).
13. **State transition map:** two authoritative maps in `m26/transaction.mjs` — `ACTOR_TRANSITIONS` (what a licensed agent may request) and `COMPLIANCE_TRANSITIONS` (what an evaluation may move). No actor transition reaches `READY`, `COMPLIANCE_PENDING` or `COMPLIANCE_BLOCKED`; the compliance layer never cancels, closes, archives or activates. Full tables in `M23_P56D_TRANSACTION_STATE_MACHINE.md`.
14. **Representation bindings:** `transactionRepresentations` binds `(transaction, agent, party role)` with an `agreementId` **reference**; scope and status are read through it at action time, never copied. Where no ScoutBox agreement exists the binding is `declaredOnly`, not effective, and carries a `reviewId` — and answers 422, not 201 (defect D7).
15. **Compliance snapshot:** `evaluationId`, `contextId`, `evaluatedAt`, `outcome`, `reasonCodes`, `policyVersions`, `consentRequirements`, `clear`/`blocked`/`pendingReason`, `partyRevision`, `verificationFreshness`.
16. **Stale compliance handling:** `partyRevisionOf` hashes exactly the eight inputs §27 names, using the conflict engine's own canonical hash. `snapshotStaleness` returns `NO_SNAPSHOT`, `INPUTS_CHANGED`, `POLICY_REPUBLISHED` or `TOO_OLD`. A stale snapshot authorises no mutation, and `clear` is the **current** answer with `snapshotClear` beside it (defect D9).
17. **Consent integration:** the P5.6C `regulatoryConsents` ledger, reused. No second consent store. The workspace shows the required parties and each one's state — requested, granted, declined, revoked, superseded — and each party answers on its own surface.
18. **Document model:** `transactionDocuments` holds classification and provenance; the bytes stay in the canonical evidence store behind a re-authorised reference. Nine document types, versioned by supersession, nothing overwritten, no digital signing.
19. **Document visibility:** nine explicit classes, resolved from **roles and side**. Writing is narrower than reading; nobody may write `T_AND_S_ONLY`; an unknown class fails closed.
20. **Private notes:** the same classes minus `T_AND_S_ONLY`, scoped at write time, capped, `audit_only` in every timeline. No global note bucket.
21. **Messages:** the canonical Inbox is referenced, not duplicated. A link records that a conversation exists and who shared it; reading it still passes the Inbox's own authorisation, and `readable` on the projection is the Inbox's answer.
22. **Timeline:** append-only, built from `history[]`, six audiences (`all_parties`, `agent_only`, `player_and_agent`, `club_side`, `per_document`, `audit_only`). Actor as a **role**, detail allowlisted to ids, roles, codes and states.
23. **Player view:** "My transactions" in the player app — the clubs, the agency, which representation acts, the compliance state as a word, the documents shared with them, their own consent, their own timeline, and one action: confirming their own participation, with the copy saying what that does not do.
24. **Agent view:** a real `Transactions` destination — list with counts, a status filter and a create form; detail with six tabs (Overview, Parties, Compliance, Documents, Messages, Timeline), `allowedTransitions` from the server, and the offer boundary stated with its blockers.
25. **Engaging Club view:** a Transactions tab on the club verification console. Its own side, named as the club signing; confirmation gated on the recorded signatory; its own private note; shared documents; its own slice of the history.
26. **Releasing Club view:** the same surface as a genuinely different party role. Named as the club releasing, its own private lane, and demonstrably not the engaging club's view — proven in both directions in the browser.
27. **Same-agency privacy:** `AGENT_PRIVATE` does not admit `agency_admin_observer`. An agency administrator can see the transaction exists and cannot read the representing agent's private file (P5.6A DR-26).
28. **Club-private data boundary:** no projection reads `recruitmentCases`, assessments, Recruitment Room discussion, the P5 decision row, the Director Dashboard, Second Look or Nobody Missed. There is no field for them to arrive in.
29. **Player-private data boundary:** being a party grants no Passport, Box Cam, medical, private development or account data. Each remains an explicit separate grant.
30. **Agent-private data boundary:** no other client, internal note, unrelated agreement or agency-wide confidential item is reachable from a transaction.
31. **Opportunities link:** `linkedOpportunityId`, by reference. The opportunity's own history is not mutated.
32. **Trial link:** `linkedTrialId`, by reference. No trial assessment is exposed and no trial state semantics change.
33. **Contact/Inbox link:** `linkedThreads[]`, by reference, authorised by the Inbox. No message duplicated.
34. **P5 decision boundary:** not linked. A club's internal decision is not exposed and cannot open a transaction by itself; any pathway would be an explicit shared action, which P5.6D does not implement.
35. **Offer boundary:** `offerBoundary.canStartOfferWorkflow` plus named `blockers[]`, computed from status, party confirmation, current-and-clear compliance, active consents and effective representation. No offer record, no offer state, no offer route, and no recruitment case moved to `offer_made`.
36. **Signing boundary:** no `db.signings` writer. No player contract status mutation. `signedAt` is set by nothing in P5.6D.
37. **Fee / payment boundary:** no fee, commission, salary, escrow or clearing-house field, route or computation. Deferred entirely; working particulars carry a summary and a party scope, never an amount.
38. **Jurisdiction handling:** derived from canonical party/association data and resolved against `jurisdictionPolicies` effective at evaluation time. A client-supplied jurisdiction is not trusted.
39. **Unsupported jurisdiction:** `JURISDICTION_UNSUPPORTED` 422 at creation and as a gate on progression. No silent allow. Where it cannot be resolved, a draft may exist and regulated progression stays blocked or manual-review.
40. **Minors:** the `MINOR_PATHWAY_DISABLED` gate fails closed before the engine is consulted. General minor discovery remains blocked; no broad minor pathway was enabled; P5.6C was not weakened.
41. **Guardian architecture:** the guardian remains a distinct party role and a distinct consent actor, so the pathway can be enabled later without redesign. The agent is never substituted for the guardian.
42. **Blocks:** a safeguarding block ends the question before compliance answers it. A CLEAR verdict never overrides a block; writes stop with `TRANSACTION_PARTY_UNAVAILABLE` while reads stay coherent (defect D3).
43. **Creation authorization:** the licensed individual only (`transactions.write` → `licensed_agent`). An analyst, assistant, finance user, agency administrator, club user and player token are each refused, and a licensed agent with no profile is `AGENT_VERIFICATION_REQUIRED`.
44. **Mutation authorization:** the eighteen-step order in `M23_P56D_TRANSACTION_AUTH_MATRIX.md` §1, every step, every time, no shortcut.
45. **Club signatory authority:** binding the club needs the recorded verification administrator; `SIGNATORY_REQUIRED` 403 otherwise, whatever the screen showed. An agent can never act for a club.
46. **Player authority:** the individual's own acts are the individual's (or a lawful guardian's where enabled). An agent's scope never substitutes, and a guardian-managed account cannot answer someone else's consent.
47. **Mutation-time compliance:** representation, scope, licence facets, policy set, conflict, consents, blocks and the minor gate are all re-resolved at action time. Old page state, old snapshot, old consent, old licence and old role are all refused.
48. **rev:** `rev` + `expectedRev` + 409 `TRANSACTION_VERSION_CONFLICT` on the transaction and on every mutable transaction-owned record, using the canonical helpers — with a role, not a name, in the conflict body (defect D2).
49. **Idempotency:** persistent client keys with a payload fingerprint on create, party change, status transition, representation bind/withdraw, document metadata, consent request and hold/cancel/close. A key reused with a changed payload is `TRANSACTION_IDEMPOTENCY_CONFLICT` 409; the key is checked **before** the transition check (defect D5).
50. **Concurrency:** two party changes, two status transitions, a compliance change mid-mutation, a consent revoked mid-mutation, a reviewer decision mid-mutation and a cancellation during a document write all produce one authoritative result; the loser gets 409.
51. **Tombstones:** on account removal the transaction keeps its shape and loses the person — the party row is tombstoned, actor labels are emptied, that person's documents leave, representations naming them are withdrawn, and nothing is resurrected into a list.
52. **Retention:** no blanket permanent retention invented. The existing retention architecture applies; longer-term retention of regulated transaction records is flagged for legal review.
53. **Events:** nine canonical registry events — `agent_transaction_created`, `_party_changed`, `_compliance_updated`, `_status_changed`, `_document_added`, `_message_linked`, `_held`, `_cancelled`, `_closed` — `org_private`, ids only (`orgId`, `txId`, plus a role/outcome/status/docId where needed), never replayed, never analytics-eligible.
54. **Notifications:** canonical categories. A new non-mandatory `transaction_updates` carries workspace traffic (`agent_transaction`, `agent_transaction_action`); `agent_transaction_compliance` goes to the **mandatory** `compliance` category, so a regulatory change cannot be muted. No note, fee, document label or party name rides on a notification.
55. **Audit:** every material mutation appends actor-as-role, party role, old and new state, the compliance snapshot reference, the timestamp and a reason code where one applies, with a detail allowlist. The agency audit shows a reviewer as "Trust & Safety (attributed)", never by name and never with the evidence text.
56. **Analytics:** process metrics only — transaction durations, median time in compliance pending, median consent wait, cancellation and hold reason counts, stale snapshot count — and the panel says nobody is ranked. No agent, club or player is named in them.
57. **EN/FR:** full parity. Agent catalogue 636/636, club catalogue 2127/2127, and every status, party role, compliance state, consent state, document type, visibility class, action, error and empty/loading state has both halves. Verified in the browser with no English fallback leaking through.
58. **Accessibility:** every control labelled; the six tabs a labelled tablist with exactly one selected; every control keyboard-reachable; every compliance and workflow state rendered as a **word** beside any colour; refusals and statuses in alert/status roles; no hover-only action; destructive transitions require a reason code through a form.
59. **1440:** verified, no horizontal overflow.
60. **1280:** verified, no horizontal overflow, including the club console projection.
61. **390:** verified on the agent list and workspace and on the player card.
62. **360:** verified on the agent list and workspace.
63. **Demo:** synthetic only, six examples — clear adult (`READY`), consent-required (`COMPLIANCE_PENDING`), manual-review, blocked (`COMPLIANCE_BLOCKED`), on-hold, cancelled — plus two synthetic club-side transactions and four Trust & Safety rows. No real person, and nothing implying a minor pathway is open. Covered by `m23AgentDemoSpotcheck`.
64. **Agent browser journey:** sign-in → Transactions → open an England transfer → DRAFT with nobody confirmed and no offer readiness → bind the individual → re-evaluate to clear → ACTIVE → file an AGENT_PRIVATE document → read its reference → timeline → cancel with a reason → archive → no action remains.
65. **Player browser journey:** Kola at 390px on the real player app — both clubs, the agency, the state, no fee, no club recruitment data, confirms his own participation, and the card records when.
66. **Club browser journeys:** Eastport's signatory (engaging) and Harbour's signatory (releasing), in separate contexts, each confirming its own side and filing its own private note — and neither able to read the other's.
67. **Persistence:** passed. 63 checks, 28 negative. Transaction, parties and confirmations, party history, compliance refs and party revision, document metadata and version chain, notes, linked threads, terms versions, `rev`, `revMeta` and idempotency keys all survive a restart.
68. **Clean boot:** passed. One new step at 2307, three empty containers, all production-required, replay-protected.
69. **Upgrade from 2306:** passed. Exactly the one step runs over a real 2306 snapshot; the recruitment case, the compliance context, the agreement and the player are untouched, and nothing becomes a transaction.
70. **`m23AgentTransactionE2E`:** 404 checks, 215 negative/security/safeguarding (53%). Groups A–AI plus all thirty numbered adversarial cases. Green.
71. **Agent regressions:** `m23AgentE2E`, `m23AgentPersistence`, `m23AgentLive`, `m23AgentDemoSpotcheck`, `m23AgentComplianceE2E`, `m23AgentCompliancePersistence`, `m23AgentComplianceLive` — all green.
72. **ScoutBox regressions:** `m162E2E`, `m17E2E`, `m18E2E`, `m181E2E`, `m182E2E`, `m22Blocker`, `m22E2E`, `m23E2E`, `m23ContactE2E`, `m23TrialE2E`, `m23DecisionE2E`, `m23BootContract`, `m23Persistence`, `navConfig`, `navLive`, plus `m162Live`, `m17Live`, `m18Live`, `m181Live`, `m182Live`, `m182DemoSpotcheck` — all green. Six assertions that pinned facts P5.6D legitimately changed were made relative to the claim; each is listed in the test report §8.
73. **Builds / typechecks:** `tsc --noEmit` clean and a production build for `scoutbox-agent`, `scoutbox-admin`, `scoutbox-club`, `scoutbox-grassroots` (Vite) and `scoutbox-player` (Expo web). Demos rebuilt.
74. **Defects found:** 14 (`D2`–`D15`; no `D1` was issued — see the register).
75. **Defects fixed:** 14.
76. **Open Critical:** 0.
77. **Open High:** 0.
78. **Open Medium:** 0.
79. **Open Low:** 0.
80. **Agent Transaction Room implemented:** yes — as a permissioned multi-party workspace, not a negotiation room.
81. **Offer Workflow status:** not implemented. A computed readiness boolean and its blockers only. P6 owns Offer.
82. **`db.signings` writer status:** none added.
83. **Tree status:** clean.
84. **Ahead / behind remote:** 7 ahead, 0 behind `origin/claude/desktop-project-migration-wyk3ec` — 1 P5.6C documentation commit, 5 P5.6D code commits and this documentation commit. `origin/main` is `b2eca8e`, unchanged by this work.
85. **Push status:** not pushed.
86. **PR status:** none created.
87. **Deployment status:** none performed.

---

## §101 — Final truth block

```
Starting tip: 3d2cdd0
Remote starting tip: 3d2cdd0

Agent Transaction Workspace implemented: YES
Transaction is distinct from Recruitment Case: YES
Transaction is distinct from Offer: YES
Transaction is distinct from Signing: YES

Canonical transaction store implemented: YES
Party model implemented: YES
Party history preserved: YES
Party changes trigger compliance re-evaluation: YES

Transaction state machine implemented: YES
Ad hoc status writes possible: NO
Cancelled transaction history erased: NO

Representation binding implemented: YES
Active representation alone grants universal authority: NO
Mutation-time representation recheck implemented: YES

Compliance snapshot attached: YES
Stale compliance snapshot authorizes mutation: NO
Current conflict/consent/licence rechecked at mutation: YES

Consent ledger reused: YES
Consent duplicated in new store unnecessarily: NO
Revoked consent authorizes future action: NO

Document model implemented: YES
Private document leakage across parties: NO
T&S evidence exposed broadly: NO

Canonical Inbox reused: YES
Separate duplicate chat backend created: NO
ScoutBox autonomously negotiates: NO

Player transaction view implemented: YES
Agent transaction view implemented: YES
Engaging Club view implemented: YES
Releasing Club view implemented: YES

Agent can see private club assessment: NO
Agent can see P5 internal decision: NO
Club can see unrelated Player private Passport data: NO
Club can see Agent-private notes: NO
Player can see club-private notes: NO

Unsupported jurisdiction silently allowed: NO
General minor discovery enabled: NO
Minor transaction pathway broadly enabled: NO

Offer Workflow implemented: NO
offer_made writer added: NO
offer_accepted writer added: NO
offer_declined writer added: NO
db.signings writer added: NO

EN/FR parity: YES
390 verified: YES
360 verified: YES
Accessibility verified: YES
Persistence passed: YES
Clean boot passed: YES
Upgrade from 2306 passed: YES

Open Critical affecting P5.6D: 0
Open High affecting P5.6D: 0
Open reasonably-fixable Medium affecting P5.6D: 0

Tree clean: YES
P5.6D pushed: NO
PR created: NO
Deployment performed: NO
```

---

## §102 — Conclusion

```
M23 P5.6D SCOUTBOX AGENT TRANSACTION WORKSPACE COMPLETE
CANONICAL MULTI-PARTY TRANSACTION INFRASTRUCTURE IS OPERATIONAL
TRANSACTION REMAINS DISTINCT FROM CLUB RECRUITMENT CASE, OFFER AND SIGNING
PARTY CHANGES INVALIDATE STALE COMPLIANCE
REPRESENTATION AUTHORITY IS RECHECKED AT MUTATION TIME
CONFLICT / CONSENT / LICENCE / POLICY STATE IS RECHECKED AT MUTATION TIME
PRIVATE PLAYER / AGENT / ENGAGING CLUB / RELEASING CLUB DATA REMAINS SEGMENTED
TRANSACTION DOCUMENTS HAVE EXPLICIT VISIBILITY
CANONICAL INBOX IS REUSED
SCOUTBOX DOES NOT AUTONOMOUSLY NEGOTIATE
GENERAL MINOR DISCOVERY REMAINS BLOCKED
NO OFFER WORKFLOW HAS BEEN IMPLEMENTED
NO SIGNING WRITER HAS BEEN IMPLEMENTED
ZERO KNOWN CRITICAL DEFECTS
ZERO KNOWN HIGH DEFECTS
ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS AFFECTING P5.6D
READY FOR M23 P5.6E AGENT CROSS-APP INTEGRATION
```

## Documents

`M23_P56D_TRANSACTION_MODEL.md` · `M23_P56D_TRANSACTION_AUTH_MATRIX.md` ·
`M23_P56D_TRANSACTION_PRIVACY_MATRIX.md` · `M23_P56D_TRANSACTION_STATE_MACHINE.md` ·
`M23_P56D_TRANSACTION_DOCUMENT_MODEL.md` ·
`M23_P56D_TRANSACTION_COMPLIANCE_INTEGRATION.md` ·
`M23_P56D_TRANSACTION_TEST_REPORT.md` ·
`M23_P56D_AGENT_TRANSACTION_DEFECT_REGISTER.md` · this report.

No frozen P5.6A/P5.6B/P5.6C document was rewritten. No contradiction with a
frozen contract was found; the one gap — how a transaction relates to a
compliance context — was unspecified rather than contradicted, and the decision
is recorded in `M23_P56D_TRANSACTION_COMPLIANCE_INTEGRATION.md` §1.
