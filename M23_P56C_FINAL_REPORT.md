# M23 P5.6C — ScoutBox Agent Conflict & Compliance Engine — final report

Eighty-three items, then a truth block, then the completion statement.

## What this phase was for

1. P5.6B gave an agent a workspace and a client-confirmed relationship. It could not
   say whether a given piece of agent work was permitted, by whom, under which rule.
2. P5.6C answers that question, and records who answered it. Nothing here negotiates,
   offers or signs anything.
3. The blocking prerequisite was G-C0: an authoritative compliance decision had no
   named author, because the Trust & Safety lane authenticated with a shared key.

## G-C0 — closed

4. `db.tsReviewers` holds reviewer identities: id, name, role, status, scrypt secret
   hash, provenance, rev, history. Migration 2306 creates the store **empty**.
5. `POST /auth/reviewer/login` mints a `ts_reviewer` session; `reviewerAuth` derives
   `req.reviewer` from the session alone.
6. A request body may carry `reviewerId`, `decidedAt` or `at`. All three are ignored,
   and the suite sends them to prove it.
7. Unknown id, wrong secret and revoked reviewer share one refusal:
   `REVIEWER_CREDENTIALS_INVALID`.
8. Two roles: `trust_safety_reviewer` decides items; `trust_safety_admin` also
   provisions reviewers and publishes policy.
9. Revocation deletes that reviewer's sessions immediately; decisions already made keep
   their name. At least one active administrator must remain.
10. The shared admin key reaches two read-only projections and no decision. Every
    `/ts/*` route refuses it with 401.
11. The Trust & Safety console states this in the UI rather than leaving it implicit,
    and has its own credentialed sign-in.
12. Production reviewers come from `TS_REVIEWER_BOOTSTRAP_*`; three dev seeds exist only
    under `DEV_LOGINS` and only when no reviewer exists.
13. Legacy shared-key actions are **not** back-filled with invented names; the reviewer
    list carries a note saying they cannot be attributed to a person.

## The policy engine

14. Encoded versions live in `m25/policyVersions.mjs` as data; `m25/policy.mjs` is pure.
15. A rule carries `ruleStatus` (operative) separately from `textStatus`. The engine
    reads status, never text.
16. Seven statuses: ACTIVE, SUSPENDED, PARTIALLY_SUSPENDED, JURISDICTION_OVERRIDE,
    PENDING_IMPLEMENTATION, UNDER_LEGAL_REVIEW, UNKNOWN.
17. Encoded today: FIFA baseline (`jp-fifa-2025-1`), England 2026/27
    (`jp-eng-2026-27-1`), USA (`jp-usa-2024-1`), plus a `PENDING_IMPLEMENTATION` FIFA
    2027 entry.
18. Anything else is unsupported, answered as `JURISDICTION_UNSUPPORTED` or a
    `POLICY_NOT_ENCODED` reason into review. Never assumed permitted.
19. Multiple overlays are normal: `INT` always applies, each national association adds
    its own; conflicts surface as `SCOPE_MIXED` or `NATIONAL_RULE_APPLIES` naming both
    rule ids.
20. `evaluatePolicy` returns a structured decision, never a boolean, with reasons that
    each carry rule id, rule status, regulator, jurisdiction and policy version.
21. No route or client contains a jurisdiction conditional. A status change is a data
    change; the suite proves it by publishing a version at runtime.
22. Publication is dual-controlled: one administrator proposes, a different one
    approves (`POLICY_DUAL_CONTROL_REQUIRED`).
23. Publication never re-verdicts: open contexts are flagged `reEvaluationPending` and
    the agent's screen says "re-evaluation needed".
24. Historical evaluation rows keep the versions and statuses they were decided under.
25. A consent naming only a superseded version is insufficient
    (`CONSENT_POLICY_VERSION_STALE`).

## The conflict engine

26. `m25/conflict.mjs` is pure and deterministic: same inputs and clock, same outcome,
    reasons and `inputHash`.
27. Five outcomes: CLEAR, PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED (alias
    PERMITTED_WITH_CONSENT), PROHIBITED_CONFLICT, MANUAL_REGULATORY_REVIEW_REQUIRED,
    INSUFFICIENT_DATA.
28. **A prohibition dominates everything.** PROHIBITED_CONFLICT is the highest severity,
    so no missing fact and no uncertain rule can soften it into a recordable state.
    This was defect C14, found by the browser suite.
29. England, as encoded: one party CLEAR; individual + engaging entity permitted with
    both consents; individual + releasing entity prohibited; engaging + releasing not
    permitted by any rule; consents on record make it CLEAR with `DUAL_CONSENTED`.
30. An uncertain FIFA rule goes to attributed review, never to the FIFA text and never
    to "permitted".
31. A suspended or not-yet-in-force rule yields `NO_ACTIVE_RULE_DECIDES`; the absence of
    an in-force rule is reported, not read as permission.
32. Connected agents are attributed under `ENG-6.5`; outstanding consents are
    deduplicated by party role.
33. A colleague is never judged in an agent's reasons: `evaluateAgentUserIds` bounds
    whose state is assessed.
34. `other_services` carries a presumption of agent services, raising review.
35. Declared interests appear as `INTEREST_DECLARED`.
36. `CLEAR` is described as a platform result under named versions, never as
    "compliant", "approved" or "legally valid".

## Consent

37. A consent row names agent, agency, context, party role, subject, disclosures, policy
    versions and rule ids, with server timestamps.
38. It can only be created where an ACTIVE rule makes consent the deciding question.
39. The ledger is append-only: a revocation is a new row; the granted row is never
    edited, which a persistence check asserts byte for byte.
40. The individual answers in the player app. A club is bound only by its recorded
    verification administrator — its signatory. The agent can never answer for a party.
41. Granting requires two acknowledgements (particulars received, legal advice offered);
    declining requires neither.
42. Consent must be given in advance, measured against the second-earliest `firstActAt`
    among the agent's representations.
43. A representation confirmed by review records no act by the agent, so a later consent
    is still in advance. This was defect C3.
44. Revocation re-evaluates the context on the same request and names the reason
    `CONSENT_REVOKED`, not merely missing. This was defect C2.
45. Revocation stops future acts, undoes nothing already done, and erases nothing. Both
    surfaces say so in those words.
46. Races answer `CONSENT_VERSION_CONFLICT` with the current status; idempotency keys
    replay rather than duplicate.
47. A revoked consent cannot be re-granted; a fresh ask is required.

## Verification facets and the provider

48. Four facets: FIFA licence, national registration, domestic authorisation, minors
    authorisation — each with its own state, provenance and re-check window.
49. `createVerificationProvider` returns the honest `none` provider in production and a
    clearly-labelled local synthetic provider under a development flag.
50. Six states. `UNAVAILABLE` answers 503 and writes nothing: an outage never reads as a
    pass.
51. A facet going STALE notifies the agent once, in the mandatory `compliance` category.
52. A real-looking reference goes to attributed review rather than being accepted.

## Contexts and the regulated act

53. A compliance context is the minimal record an evaluation needs, and says in its own
    projection that it is not a Transaction Room.
54. Declaring a representation runs the full pipeline at mutation time, every time:
    visibility and blocks, agreement, scope, facet gate, conflict, consent, review.
55. A refusal records **nothing**, and the suites check the store afterwards.
56. Visibility and blocks are checked before scope, so a blocked player is
    indistinguishable from an unknown one. This was defect C4.
57. Party changes, review decisions, consent answers and account deletions all
    re-evaluate. An earlier clearance never authorises a later act.
58. A context is personal to the agent who opened it; a colleague gets 404.
59. Closing a context cancels its open review items rather than orphaning them.

## Attributed review

60. Four kinds: verification facet, representation dispute, declared representation,
    conflict evaluation.
61. An approval must cite at least one evidence reference.
62. A reviewer cannot approve past an ACTIVE prohibition
    (`REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE`).
63. An uncertain rule status is a policy question, not a review one
    (`REVIEW_REQUIRES_POLICY_VERSION`).
64. A decided item is never edited: reconsideration creates a new review that
    supersedes it, and the original decision is retained.
65. A reviewer sees exactly the item's need, and no personal data beyond it.
66. The agency sees the reviewer as an attributed role, never by name, and never with
    the reason text or evidence.

## Minors

67. No minor pathway is enabled in any jurisdiction
    (`MINOR_PATHWAY_PRODUCTION_ENABLED` is false for ENG, INT and USA).
68. General discovery of minors stays prohibited: no global browse, no mass search, no
    bulk approach, no route taking a minor as a subject.
69. Naming a minor as a party is the uniform 404 — even when the party role is already
    filled, so neither fact leaks.
70. Client-supplied date of birth and guardian flags are ignored.
71. England's timing rule is encoded; FIFA's is deliberately unresolved and reported as
    not fully encoded.
72. The agent sees only their own readiness, evaluated against no subject, above a
    notice that the pathway is not enabled.
73. The five prerequisites for ever opening such a pathway are written down in
    `M23_P56C_MINOR_COMPLIANCE.md`; none is met.

## Clients

74. Agent app: a seventh destination, Conflicts & compliance, with a strict
    `#/compliance/<ctxId>` deep link; the fourth facet is first-class on the profile.
75. Admin app: an Agents group with reviewer sign-in, the review queue, dual-controlled
    policy publication, reviewer identities and the attributed decision record.
76. Player app: an Agent consent card, absent for under-18s.
77. Club app: the consent lane on the verification console, because that is where the
    signatory authority lives; a non-signatory reads the ask instead of finding a
    button that fails.
78. EN and FR throughout, demo mirrors for each surface, refusals rendered from the
    server's codes.
79. The console renders the item being decided in its own panel, so a status change
    cannot unmount a half-filled decision form. This was defect C15.

## Verification

80. New suites: `m23AgentComplianceE2E` 345 checks (193 negative, 56%),
    `m23AgentCompliancePersistence` 83 checks (23 integrity),
    `m23AgentComplianceLive` 86 checks (25 negative) across four real surfaces with
    zero page errors.
81. Regression battery green: 13 server suites, `m23AgentE2E`, `m23AgentPersistence`,
    `navConfig` (346), `m23AgentLive` (82), `m23ContactLive`, and an extended
    `m23AgentDemoSpotcheck` that now drives the compliance screen, a context journey and
    the whole Trust & Safety console in the demo artifacts.
82. Five apps typecheck and build; demo artifacts rebuilt.
83. Fifteen defects recorded and closed in
    `M23_P56C_AGENT_COMPLIANCE_DEFECT_REGISTER.md`, two of them (C14, C15) found only
    because the browser journeys reached states the server suite's call order did not.

---

## Truth block

**What is real.** The reviewer identity, the policy versions with their operative
statuses, the conflict engine's verdicts, the consent ledger, the review lane with its
override limits, the four facets, the minors gate, and every refusal code listed in the
authorization matrix. All of it runs on the server, is enforced on every request, and
survives a restart. The migration advanced the schema exactly once, to 2306.

**What is honest scaffolding.** The verification provider. No FIFA, FA or U.S. Soccer
register integration exists. In production every real reference goes to attributed
review; the synthetic provider exists only under a development flag and says so
wherever its provenance is shown.

**What is encoded, not authoritative.** The rules themselves. ScoutBox applies what it
has encoded, with the status it has recorded, on the date recorded. That is a platform
result, not legal advice, and no governing body has approved any of it. Three
jurisdictions are encoded; everything else is unsupported, which is a real answer and
not a permission.

**What is deliberately absent.** No Transaction Room. No offer workflow. No autonomous
negotiation. No fee, commission or contract term anywhere in the model, the routes or
the UI. No minor representation pathway in any jurisdiction. No live register
integration. No pay-to-clear: no subscription or payment state is read anywhere in the
compliance path.

**What is not proven.** That the encoded rules match a regulator's current position —
that is the responsibility of the administrators who publish a version, which is why
publication is attributed and dual-controlled. Performance at scale, which has no
measurement in this phase. And anything about the two jurisdictions that are
`UNKNOWN`-heavy (USA multiple representation and minors), which are honestly unencoded.

**Residual privacy risks**, stated in full in `M23_P56C_PRIVACY_VERIFICATION.md`: an
agent sees the parties they themselves named; a consent ask necessarily reveals that an
ask was made; review latency is observable; and reviewer names are visible inside
Trust & Safety by design.

---

## Completion

**P5.6C is COMPLETE**, on the mandate's own gate:

- G-C0 is closed — the gate that explicitly blocked completion.
- Every refusal path, engine outcome and consent state is covered by a check, and all
  three new suites pass.
- The regression battery, five typechecks, five builds and the demo artifacts are green.
- Fifteen defects are closed, none open, and the two the browser suite found are
  guarded in both layers.
- Nothing outside the mandate was built: no Transaction Room, no offers, no negotiation,
  no minor pathway.

Work stops here. P5.6D was not started.
