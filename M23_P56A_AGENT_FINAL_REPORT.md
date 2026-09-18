# M23 P5.6A — ScoutBox Agent Regulatory & Architecture Contract — Final Report

Milestone type: regulatory snapshot + architecture contract. No Agent
application, routes, UI, Offer Workflow, Conflict Engine, representation
agreements, transactions or schema advance were built (mandate §2, §195).
One production change was made under §186 (D-P56A-1). Nothing was pushed;
no PR; no deploy.

The thirteen deliverables (§173/§187) are in the repository root:
`M23_P56A_AGENT_REGULATORY_SNAPSHOT.md`,
`M23_P56A_EXISTING_AGENT_SURFACE_AUDIT.md`, `M23_P56A_AGENT_REUSE_AUDIT.md`,
`M23_P56A_AGENT_ACTION_CLASSIFICATION.md`,
`M23_P56A_AGENT_AUTHORIZATION_CONTRACT.md`,
`M23_P56A_CONFLICT_ENGINE_CONTRACT.md`, `M23_P56A_AGENT_PRIVACY_MATRIX.md`,
`M23_P56A_AGENT_STORE_PROPOSAL.md`, `M23_P56A_AGENT_TEST_PLAN.md`,
`M23_P56A_AGENT_DECISION_REGISTER.md`, `M23_P56A_AGENT_FINAL_ARCHITECTURE.md`,
`M23_P56A_AGENT_DEFECT_REGISTER.md`, and this report.

Standing caveat (mandate §170–§171): the regulatory snapshot is a
good-faith reading of primary sources as of 18 September 2026 by an
engineering team, not legal advice. It does not replace counsel. Where a
source contradicted the mandate's hypotheses, the source wins and the
conflict is recorded (snapshot §5, hypotheses F, G, I).

---

## §192 — the ninety items

1. **Starting tip** — `669d060` (M23 P5 bookkeeping closure).
2. **Final tip** — the commit that carries this report and the twelve sibling documents (its hash is in that commit's message; it follows `a3ebc7a`). Two P5.6A commits in total: `a3ebc7a` (D-P56A-1 fix + regression) and the documents commit.
3. **Production code changes** — one: `scoutbox-server/m162/trust.mjs` relationship source (D-P56A-1). Test change: `scoutbox-server/scripts/m162E2E.mjs` (+12 checks). No other server, client, schema, seed, nav or i18n change. `git diff 669d060 --stat` on the final tree lists exactly those two files plus the thirteen new Markdown files.
4. **Regulatory sources reviewed** — eleven (snapshot §1): FIFA Football Agent Regulations edition in force 1 Jan 2025 (full text extracted); FIFA Circular 1873 (30 Dec 2023 suspension); CJEU press release 110/26 on C-209/23 RRC Sports (16 Jul 2026); FIFA news of 16 Jul 2026; FIFA agents FAQ; FIFA legal portal page (script-rendered, recorded as unreadable); The FA Football Agent Regulations 2025-26 (full text extracted; suspended-provision shading lost); FA agents guidance; FA registered-list page; U.S. Soccer football-agents page; FIFA licensed-agents directory page (script-rendered). Each rule carries source, date, effective date, consequence and legal-review flag.
5. **FIFA licence architecture** — personal M14 `LICENCE` claim subtype `fifa_agent`; T&S human review against the FIFA directory; fail-honest states (`verified`, `verification_pending`, `verification_stale`, `manual_review_required`, `unverifiable`); `recheckAt` 30 days; no register integration exists or is pretended (authorization contract §3; DR-3–DR-6).
6. **Agency vs licensed individual** — the agency is a tenant and a vehicle (FFAR 11(3)); only the natural person holds the licence and performs regulated actions (DR-2). Agency membership alone authorises nothing.
7. **National-registration architecture** — a second claim subtype per member association (`national_agent_registration{ma}`), required where the applicable policy says `required` (England: FA registration on the published list, R-E1). Same review and staleness rules.
8. **Jurisdiction policy engine** — `jurisdictionPolicies` versioned data rows keyed by regulator/MA with per-rule `state ∈ in_force | suspended | doubtful | not_encoded`, dual-control publish, every evaluation naming its versions (authorization contract §5.3; DR-32).
9. **Existing agency concepts audit** — 32 surfaces classified: 17 KEEP, 12 EXTEND, 1 RENAME (copy), 6 DEPRECATE, 0 REMOVE LATER, 6 NOT AGENT PRODUCT, 1 DEFECT (surface audit §7).
10. **Agent identity model** — `db.users` + `agentProfiles` (personal, survives agency changes); declared facts separate from verification claims (store proposal §1).
11. **Agency membership model** — `agencyAffiliations` with tier and window; invariants copied from `db.verAdmins` (no self-promotion, dual control, last-admin) (store proposal §2).
12. **Staff-role model** — `licensed_agent | agency_admin | analyst | assistant | finance`; login `role` string stays cosmetic; `isLead` regex never gates a regulated action (reuse audit §3).
13. **Regulated-action classification** — 16 REGULATED_AGENT_ACTION, 19 ADMINISTRATIVE, 15 CLIENT, 4 SHARED_WORKFLOW, 9 COMPLIANCE, 5 prohibited/not built (action classification §12).
14. **Representation Agreement model** — `representationAgreements`: personal (`agentUserId`), client-confirmed, scoped, termed, jurisdictioned, versioned, with legal-advice acknowledgements, `evaluations[]`, guardian path, legacy lane for migrated `db.representations` rows (store proposal §3).
15. **Agreement validity rules** — active only after client/guardian confirmation; two-year cap for players/coaches (12(3), FA 4.3); entities open-ended (12(5)); one agreement per pair (12(4), FA 4.4); legal-advice notice on creation and amendment (12(4)(a)–(b), FA 4.5); jurisdiction declared and confirmed (DR-7, DR-10–DR-12).
16. **Agreement history/termination** — append-only history, `versions[]`, termination by either side ends access instantly and keeps history; disputes to T&S; expiry by clock (action classification §4).
17. **Client authority model** — the client's account is the root: confirm, decline, withdraw, dispute, share, block, report, staff-sharing choice (CLIENT_ACTION rows A16, A18, A22–A24, A27–A28, A60–A65).
18. **Agent verification** — item 5; verification ≠ authorization ≠ client confirmation (P-3).
19. **Stale/suspended licence behaviour** — fails closed at `recheckAt`; suspended/revoked/expired refuse every regulated action; clients see `agent_licence_inactive` on their agreement; no grace period (DR-5).
20. **Transaction model** — `agentTransactions` (parties, type, jurisdictions, terms as data, evaluations, consents) + `transactionRepresentations` (agent × party role × transaction); Transaction Room with eleven tabs and its own role table (final architecture §8).
21. **Conflict Engine** — pure, versioned, deterministic; five outcomes with severity ordering; connected-agent attribution; suspended/doubtful/not_encoded handling; Other Services presumption; Interests; `inputHash`; append-only evaluations (conflict engine contract).
22. **Single representation** — FFAR 12(8) text verified; **suspended by FIFA since 30 Dec 2023** (Circular 1873), national court to assess after the CJEU judgment; **in force in England** (FA 6.3). Encoded as data with state, applied where in force (conflict engine §4.1).
23. **Dual representation** — FIFA 12(8)(a): individual + engaging entity with prior written consent (suspended); England 6.3: dual **or multiple** with all parties' prior written consent, full particulars, legal advice, express consent (in force). Consent sufficiency rules in conflict engine §4.2.
24. **Prohibited conflicts** — releasing + individual, releasing + engaging, all parties (12(9); FA 6.4) → `PROHIBITED_CONFLICT` where in force, review where only the suspended FIFA text applies.
25. **Consent ledger** — `regulatoryConsents`: append-only, advance, attributable, versioned; kinds `dual_representation`, `guardian_approach`, `guardian_agreement`, `legal_advice_ack`, `client_staff_sharing`, `revocation` (store proposal §6).
26. **Other-services treatment** — 24-month presumption (FFAR 12(11)–(12) via R-F17) elevates to manual review, never prohibits (DR-34).
27. **Minor approach model** — guardian-first pathway; the global "agencies never see minors" rule untouched; `earliestPermittedApproachAt` from the applicable policy; verified minors authorisation; prior guardian consent; fail closed (authorization contract §7; DR-15–DR-17).
28. **Guardian consent** — existing verified-guardian ladder reused; consents as ledger rows with policy version; guardian confirms a minor's agreement; minor sees a contentless summary (action classification §3).
29. **Minor accreditation** — England: additional authorisation with DBS, three-year validity (FA 5.6–5.7); FIFA: minors CPD/accreditation (R-F21); modelled as claim subtypes with `expiresAt`.
30. **Agency minor-discovery rule** — retained globally (`domain.mjs:73`); tested by `testTrust`, `m162E2E`, `m15E2E`, `m23ContactE2E`, `m23TrialE2E`, all green on the final tree.
31. **Proposed new minor invariant** — quoted in the authorization contract §7: a licensed agent may hold a regulatory relationship with a minor only through a guardian-initiated or guardian-consented pathway with verified authorisation, permitted timing, prior consents, re-evaluation on every read/write, and fail-closed on any missing datum. A separate predicate, never a relaxation of `visibleToOrg`.
32. **England overlay** — `jp-eng-1`: registration required; agency as additional party permitted; two-year cap; 1 Sep academic-year timing; DBS authorisation; dual/multiple with consents in force; releasing club exclusive; no fee cap, client pays, conditional remuneration permitted; lodging 14 days (not automated); exclusivity window flagged doubtful (snapshot §3).
33. **U.S. overlay** — `jp-usa-1`: FIFA licence required, background check + SafeSport training recorded as requirements; every other rule `not_encoded` → review; no U.S. minors pathway until L-8 is answered (DR-44).
34. **Future jurisdiction overlays** — same policy-set shape per MA; `not_encoded` until primary sources are encoded (snapshot §10). None researched in P5.6A.
35. **Player controls** — block, report (individual agent, new `targetKind`), share/revoke, staff-sharing choice, export, confirm/decline/withdraw/dispute (action classification §9).
36. **My Agent concept** — the player's view of their confirmed agreement(s): agent identity, verification state, scope, term, staff-sharing setting; replaces `player.agentName` in P5.6E.
37. **Agent CRM** — `agencyProspects` (adults only, grants nothing) + client list; notes are agency records (store proposal §8; DR-26).
38. **Prospect vs client** — prospect = a CRM row with public data only; client = an `active` agreement; the line is client confirmation (P-8).
39. **Opportunities** — read-through of the client's own board; agent drafts, client submits (A35–A36); interest to a club is a regulated action opening a Transaction (A37).
40. **Contact integration** — `contact.channel: 'agent'` kept as club provenance, relabelled "via representative", bound to a verified counterparty in P5.6E (DR-24).
41. **Trial integration** — Trials remain club↔player/guardian objects; the client may share the family view; never `trialDetails.private` beyond what the client sees (reuse audit §15).
42. **Assessment privacy** — never exposed to any agent column, by construction and by test group L6 (matrix row 9).
43. **Decision privacy** — never exposed (matrix row 10).
44. **Passport integration** — agent client view = `recruitment` visibility; wider only via the player's M15 share; agents never own or edit (DR-22).
45. **Box Cam integration** — untouched; `orgMaySeeResults` unchanged; no agent path to Box Cam results beyond what a player shares through existing consent.
46. **Offer future boundary** — Transaction Room reserves a Terms tab; no Offer object designed (DR-38).
47. **Transaction Room** — Overview, Parties, Representation, Conflict, Consents, Opportunities, Documents, Terms, Correspondence, Timeline, Compliance; lane-scoped projections (final architecture §8).
48. **Document Vault** — M14 evidence vault reused with new subject kinds and a `parties_only` visibility level (reuse audit §11).
49. **Contract metadata** — declared by the agent, labelled declared, never merged into the Passport (A34).
50. **Fee ledger** — terms as data with the applicable rule's state; no validation (DR-31; P-5).
51. **Payment recommendation** — ScoutBox processes no money and validates no fee; if a payment product is ever considered, counsel first (L-5, L-13).
52. **Privacy matrix** — 13 columns × 16 mandated rows + 4 additional rows; six invariants (privacy matrix).
53. **Same-agency privacy** — least sharing by default; client-controlled staff visibility; connected for conflicts, separate for data; departure rules (DR-20, DR-25, DR-26).
54. **Blocks/safety** — existing block system reused; a block suspends access without rewriting the agreement ledger (DR-28); urgent report → system block.
55. **T&S** — licence/authorisation review, dispute handling, review-queue resolution with per-reviewer attribution required (DR-29; D-P56A-9 as a P5.6C prerequisite); policy publishing under dual control.
56. **Events** — seven (§135), registry entries + `EMITTED_EVENTS`, `org_private` + `payload.orgId`, none analytics-eligible (authorization contract §9).
57. **Notifications** — existing `notify()`; new types in `representation` and mandatory `compliance` categories (reuse audit §8).
58. **Audit** — `/org/audit` gains agent action sets; `safeDetail` allowlist never carries fee terms, notes or reason prose (reuse audit §9).
59. **Analytics** — none for agents in P5.6B–D; never reads club-private stores; no ranking (reuse audit §24).
60. **Anti-spam** — structured proposals only; cooldowns (30 d after decline, 90 d after guardian refusal) with enumeration-safe bodies; no bulk solicitation (authorization contract §10; P-8).
61. **Rate limiting** — five new `RATE_LIMIT_POLICY` actions; memory provider honesty retained (reuse audit §19).
62. **Tenant model** — agency-private, personal-within-agency, party-membership for shared objects, client-always-sees-own (authorization contract §11).
63. **Proposed stores** — `agentProfiles`, `agencyAffiliations`, `representationAgreements`, `agentTransactions`, `transactionRepresentations`, `regulatoryConsents`, plus `jurisdictionPolicies` (non-PII) and `agencyProspects` (store proposal). None created in P5.6A; `schemaVersion` stays 2304.
64. **Store reuse** — reused: users/sessions, orgs (extended), blocks, guardians, requests (new type), notifications, verClaims/verEvidence (extended), verEvents; not reused: `db.representations` (migrated), `recruitmentCases`, M23 contacts as Approaches (store proposal §9; reuse audit §26).
65. **Proposed API boundary** — a new module registered like every other (`register…(ctx)`), routes under `/org/agent/*` for agency users, `/player/agent/*` and `/guardian/agent/*` for clients, `/admin/agent/*` for T&S; no change to existing routes' contracts; Agent-specific error families appended to `PUBLIC_ERROR_FIELDS` (authorization contract §8).
66. **Authorization contract** — the nine-step order, per-class applicability, step-5/6/7/8 rules, concealment guarantees (authorization contract §2–§6).
67. **Domain error architecture** — thirteen mandated families + `REGULATORY_PROVIDER_UNAVAILABLE`, statuses 403/404/409/422/503, public fields listed (authorization contract §8).
68. **Idempotency** — `normaliseClientKey` / `payloadFingerprint` / `keys{}` reused verbatim on every mutation (reuse audit §20).
69. **Concurrency** — `guardRev` / `bumpRev` on agreements, transactions, ledger anchors; races enumerated with checks (test plan §155).
70. **Regulatory-provider failure** — no provider exists; when one does, failure → 503, nothing written, cached `verified` usable only until its own `recheckAt` (authorization contract §3).
71. **Account/player deletion** — agreements and consents tombstoned (ids/states/times/policy versions kept, person-shaped fields nulled) pending L-11; agent departure keeps attributed history and ends agency access (reuse audit §22).
72. **Historical compliance** — every evaluation appended with its policy versions; policy publication flags, never rewrites (conflict engine §5).
73. **Navigation** — six sections (Home, Clients, Opportunities, Transactions, Inbox, Agency), agency tabs and client tabs as mandated; `navConfig` loop gains the Agent app; club app loses the `representation` item when the platform discriminator lands (final architecture §11).
74. **P5.6B scope** — B1–B9 as listed in the final architecture §10; no minors routes; exit gate named.
75. **P5.6C scope** — policy store, evaluation, Conflict Engine, minors gate + guardian routes, attributed T&S review queue.
76. **P5.6D scope** — transactions, Transaction Room, consents, terms as data, agency invoices, `parties_only` vault, club party routes; no Offer.
77. **P5.6E scope** — Contact binding, `agentName` replacement, share flows, Case one-way link, M13 F10 write-route retirement, parity sign-off.
78. **Product-parity definition** — the fifteen-point checklist in the final architecture §12.
79. **Legal-review items** — sixteen (snapshot §8, L-1–L-16), each with what depends on it.
80. **Regulatory uncertainties** — ten (snapshot §9), each with "blocking for build?" and "needs counsel?"; the build-blocking ones are non-England minors timing and U.S. rules, both failing closed by design.
81. **Defects found** — one production defect (D-P56A-1) and ten documented items (D-P56A-2 … D-P56A-11), plus four inherited P4A Lows unchanged (defect register).
82. **Defects fixed** — D-P56A-1 (`a3ebc7a`), with a 12-check regression proven red against the unfixed source.
83. **Open Critical** — 0.
84. **Open High** — 0.
85. **Open Medium** — 0 reasonably fixable affecting existing production. D-P56A-9 (shared T&S key, pre-existing, documented in M14.1) is Medium and **not** reasonably fixable inside an architecture milestone; it is scheduled as a P5.6C prerequisite. The reader may disagree with that judgement; it is stated so it can be.
86. **Regression results** — table below; every mandated suite green on the final tree.
87. **Tree status** — clean after the documents commit (`git status --short` empty); no untracked files; no bundle recut (P5.6A produced no runtime artefact beyond `a3ebc7a`; the P5 bundle at `669d060` remains the last recovery bundle — recut is a P5.6B closure task).
88. **Push status** — **NOT PUSHED.** `origin/claude/desktop-project-migration-wyk3ec` remains at `669d060`; the two P5.6A commits are local only, per §195.
89. **PR status** — none opened.
90. **Deployment status** — none.

## Regression battery (final tree, after `a3ebc7a`)

Server suites run sequentially from `scoutbox-server`; browser suites from
the repository root. `m23DecisionPersistence` exited 1 once while `navLive`
ran concurrently in the same container and printed no failing check; run
alone three times afterwards it passed each time (48 checks). Reported
below as the stand-alone result; the concurrent failure is recorded in the
defect register under "not defects".

| Suite | Exit | Last line |
|---|---|---|
| `testTrust` | 0 | 23 trust/safeguarding tests passed |
| `m13E2E` | 0 | all 212 checks passed |
| `m162E2E` | 0 | 136 checks passed, 63 negative (46 %) — includes the D-P56A-1 section |
| `m15E2E` | 0 | 189 checks, 72 negative |
| `m17E2E` | 0 | all M17 checks passed |
| `m18E2E` | 0 | all M18 checks passed |
| `m181E2E` | 0 | all M18.1 checks passed |
| `m182E2E` | 0 | all M18.2 checks passed |
| `m18Perf`, `m181Perf`, `m182Perf` | 0 | measurements only, no SLA claimed |
| `m21E2E` | 0 | all M21 checks passed |
| `m22E2E` | 0 | production Combine eligibility: NOT ELIGIBLE — real-world validation not completed (unchanged) |
| `m22Blocker` | 0 | same blocker line (unchanged) |
| `m22Robustness` | 0 | all 48 checks passed |
| `m23E2E` | 0 | all M23 P2 checks passed |
| `m23Persistence` | 0 | 67 checks, 20 negative |
| `m23BootContract` | 0 | all boot-contract checks passed |
| `m23ContactE2E` | 0 | all M23 P3 Contact checks passed |
| `m23ContactPersistence` | 0 | all checks passed |
| `m23TrialE2E` | 0 | all M23 P4B Trial checks passed |
| `m23TrialPersistence` | 0 | all checks passed |
| `m23DecisionE2E` | 0 | all M23 P5 Decision checks passed |
| `m23DecisionPersistence` | 0 (alone ×3) | 48 checks passed, 17 negative |
| `m23P4AClosureE2E` | 0 | 337 checks, 210 negative (62 %) |
| `m20E2E` | 0 | all M20 checks passed |
| `e2e/navConfig` | 0 | navConfig: 282 checks passed |
| `e2e/navLive` | 0 | navLive: 64 checks passed — N1–N17 complete |

Box Cam CV engine: `m22/*` has no diff since `669d060`.

## §191 — final required answers

```
ScoutBox itself performs football-agent services: NO
Licensed natural person is distinct from agency organisation: YES
Agency membership alone authorizes regulated agent action: NO
Representation agreement required before regulated action where current law requires it: YES
Agent verification alone proves client authorization: NO
Agent can add a player to CRM and thereby gain private access: NO
Agent can claim representation without client/guardian confirmation and gain private ScoutBox access: NO

General minor discovery for agencies remains prohibited: YES
Dedicated lawful minor-representation pathway is architecturally possible: YES (guardian-first, jurisdiction-gated, fail-closed; England encodable now; other jurisdictions need L-6/L-8 before enablement)
Minor pathway requires guardian controls: YES
Minor pathway requires jurisdiction-aware timing: YES
Minor pathway requires relevant agent accreditation where current rule requires it: YES
Missing minor regulatory data fails closed: YES

Conflict Engine required: YES
General single-party representation rule supported by current FIFA source: YES as text (FFAR 12(8)); SUSPENDED by FIFA (Circular 1873) pending the national court after CJEU C-209/23; IN FORCE in England (FA 6.3)
Permitted dual-representation path exists under current FIFA source: YES as text (12(8)(a)); suspended by FIFA; in force in England (6.3, dual or multiple)
Permitted dual representation requires separate advance written consent where current rule requires it: YES
Releasing entity + individual can be represented by same agent in same transaction: NO
Releasing entity + engaging entity can be represented by same agent in same transaction: NO
All parties can be represented by same agent: NO

Agent app may expose private club assessments: NO
Agent app may expose private recruitment decisions: NO
Agent owns Player Passport: NO
Agent may edit Trust Score: NO
Agent may pay for higher player/agent discovery ranking: NO
Unlicensed agency staff may perform regulated agent action: NO
ScoutBox chooses an agent for the player based on commercial arrangement: NO

Jurisdiction policy must be versioned: YES
Current regulation must be re-evaluated on regulated mutation: YES
Regulatory provider failure may silently allow action: NO
Historical compliance decision preserves policy version: YES

New Agent store(s) required: YES — agentProfiles, agencyAffiliations, representationAgreements, agentTransactions, transactionRepresentations, regulatoryConsents (plus jurisdictionPolicies, non-PII, and agencyProspects)
Existing Inbox can be reused: YES (as the delivery surface, with a new request type)
Existing guardian system can be reused: YES
Existing block system can be reused: YES
Existing notifications can be reused: YES (with new types registered)
Existing audit infrastructure can be reused: YES
Existing file storage can be reused: YES (M14 evidence vault, with a parties_only visibility level; not the player media pipeline)
Existing Recruitment Case can serve as regulated transaction object: NO
```

## §193 — zero-defect gate

Open Critical: 0. Open High: 0. Open reasonably-fixable Medium affecting
existing production: 0 (judgement on D-P56A-9 stated in item 85).
Regulatory uncertainty: listed separately (snapshot §9), not counted as
software defects.

## §194

```
M23 P5.6A SCOUTBOX AGENT REGULATORY + ARCHITECTURE CONTRACT COMPLETE
LICENSED INDIVIDUAL, AGENCY, CLIENT, REPRESENTATION AND TRANSACTION BOUNDARIES FROZEN
CONFLICT-OF-INTEREST ENGINE CONTRACT FROZEN
MINOR / GUARDIAN / JURISDICTION GATES DEFINED
SCOUTBOX REMAINS INFRASTRUCTURE, NOT THE FOOTBALL AGENT
NO EXISTING PLAYER / CLUB / TRIAL / DECISION PRIVACY BOUNDARY WEAKENED
ZERO KNOWN CRITICAL DEFECTS
ZERO KNOWN HIGH DEFECTS
ZERO KNOWN REASONABLY-FIXABLE MEDIUM PRODUCTION DEFECTS
READY FOR M23 P5.6B SCOUTBOX AGENT CORE APP
```

Conditions attached to "READY" (not blockers, stated so they are not
lost): P5.6B must not enable any non-England minors pathway (L-6, L-8);
P5.6C must not ship T&S review resolution without per-reviewer
attribution (DR-29); every `jurisdictionPolicies` version must be
reviewed by counsel before it is published (DR-32); and the sixteen
legal-review items remain open until counsel answers them.

## §195 — stop

P5.6B not begun. No Agent app files, no Conflict Engine, no
representation agreements, no transactions, no Offer, no change to
agent/agency minor access in production. Not pushed. No PR. No deploy.
Returned for review.
