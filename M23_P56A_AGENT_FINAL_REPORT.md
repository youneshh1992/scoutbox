# M23 P5.6A — ScoutBox Agent Regulatory & Architecture Contract — Final Report (currency closure)

Milestone type: regulatory snapshot + architecture contract. No Agent
application, routes, UI, Offer Workflow, Conflict Engine, representation
agreements, transactions or schema advance were built. One production
change was made under §186 (D-P56A-1, commit `a3ebc7a`). Nothing was
pushed; no PR; no deploy.

**This revision is the regulatory currency closure of 18 September
2026.** The first cut of the P5.6A documents (`c0cbe42`) used the FA
Football Agent Regulations 2025-26 as the current England basis after
they had been superseded on 1 June 2026, and described the FIFA
suspension as if its continuation were established. Both are corrected
here: the active England basis is the **FA Football Agent Regulations
2026-27 (FA Handbook section 17, in force 1 June 2026)** with the 2026-27
Guidance, and the FIFA suspended rules are classified **LEGAL STATUS
UNCERTAIN** with the engine returning manual review. Every England rule
was revalidated against the 2026-27 text; the changes and their
architectural effects are in the snapshot §3, §3.11 and §11, and in
DR-45–DR-50.

The thirteen deliverables are in the repository root:
`M23_P56A_AGENT_REGULATORY_SNAPSHOT.md`,
`M23_P56A_EXISTING_AGENT_SURFACE_AUDIT.md`, `M23_P56A_AGENT_REUSE_AUDIT.md`,
`M23_P56A_AGENT_ACTION_CLASSIFICATION.md`,
`M23_P56A_AGENT_AUTHORIZATION_CONTRACT.md`,
`M23_P56A_CONFLICT_ENGINE_CONTRACT.md`, `M23_P56A_AGENT_PRIVACY_MATRIX.md`,
`M23_P56A_AGENT_STORE_PROPOSAL.md`, `M23_P56A_AGENT_TEST_PLAN.md`,
`M23_P56A_AGENT_DECISION_REGISTER.md`, `M23_P56A_AGENT_FINAL_ARCHITECTURE.md`,
`M23_P56A_AGENT_DEFECT_REGISTER.md`, and this report.

Standing caveat: the regulatory snapshot is a good-faith reading of
primary sources as of 18 September 2026 by an engineering team, not legal
advice, and does not replace counsel. Where a source contradicted the
mandate's hypotheses, the source wins and the conflict is recorded
(snapshot §5). Where governing-body materials contradict each other, the
tension is stated (snapshot §11) and the architecture fails honest.

---

## §192 — the ninety items (updated)

1. **Starting tip** — `669d060` (M23 P5 bookkeeping closure).
2. **Final tip** — the commit that carries this revised report and the
   revised sibling documents (hash in its commit message). P5.6A commits
   in order: `a3ebc7a` (D-P56A-1 fix + regression), `c0cbe42` (first
   document set), and the currency-closure documents commit.
3. **Production code changes** — one, unchanged since `a3ebc7a`:
   `scoutbox-server/m162/trust.mjs` (D-P56A-1) with its regression in
   `scoutbox-server/scripts/m162E2E.mjs`. The currency closure changed
   documents only: `git diff a3ebc7a --stat` on the final tree lists only
   `M23_P56A_*.md` files.
4. **Regulatory sources reviewed (current)** — FFAR 2025 edition (in
   force 1 Jan 2025); FIFA Circular 1873 (30 Dec 2023); CJEU press
   release 110/26 on C-209/23 (16 Jul 2026); FIFA statement of 16 Jul
   2026; FIFA agents FAQ (last updated 23 Jan 2025); FIFA agents news
   list and hub (read 18 Sep 2026; no post-judgment circular or notice
   listed); FIFA 10 Jun 2026 transfer-framework news (no agent content);
   **FA Football Agent Regulations 2026-27, section 17, in force 1 Jun
   2026**; **FA Football Agent Regulations Guidance 2026-27**; FA
   registered-agents page and list of 18 Sep 2026; FA representation
   agreement templates (NFAR Player-Coach, Club, Tripartite, Subcontract,
   termination letter); FA criminal-record-check process; FA agents
   landing page ("come into effect from 1st June 2026"); U.S. Soccer
   agents page. Historical, not current: FA 2025-26 regulations and
   guidance (kept only to record what changed). Every current rule
   carries source, version/season, effective date and retrieved date.
5. **FIFA licence architecture** — personal M14 claim subtype
   `fifa_agent`; T&S human review against the FIFA directory; fail-honest
   states; `recheckAt` 30 days; no register integration pretended
   (CURRENTLY OPERATIVE rule, R-F1).
6. **Agency vs licensed individual** — the agency is a tenant and a
   vehicle; only the natural person holds the licence and performs
   regulated actions (DR-2). England 2026-27 adds a consent-gated route
   for a licensed colleague to perform under an agency-party agreement
   (R-E2b, DR-45); the performer is still one verified natural person.
7. **National-registration architecture** — claim subtype
   `national_agent_registration{ma}`; England: FIFA licence is a
   prerequisite to FA registration (2.2) and loss of the FIFA licence
   cascades to the FA registration automatically (2.10); published list
   (18 Sep 2026); Digital ID shows minors authorisation.
8. **Jurisdiction policy engine** — versioned by regulator, jurisdiction,
   effective date, policy version, with per-rule `ruleStatus ∈ ACTIVE |
   SUSPENDED | PARTIALLY_SUSPENDED | JURISDICTION_OVERRIDE |
   UNDER_LEGAL_REVIEW | UNKNOWN`; a rule may exist in text while its
   enforcement is suspended, and the two are distinct rows/states
   (DR-32). Initial versions `jp-fifa-2025-1`, `jp-eng-2026-27-1`,
   `jp-usa-2024-1`.
9. **Existing agency concepts audit** — unchanged (32 surfaces).
10. **Agent identity model** — unchanged.
11. **Agency membership model** — unchanged; affiliation now also gates
    the England colleague route.
12. **Staff-role model** — unchanged.
13. **Regulated-action classification** — + A29b (colleague performance,
    regulated, England-only, disabled pending L-9) and A29c (the
    `agency_performance` consent, client/shared action).
14. **Representation Agreement model** — + `agencyParty`,
    `agencyPerformanceConsentId`; England Obligatory Terms, Annex
    legal-advice declaration (template verified), guardian signature
    line for minors.
15. **Agreement validity rules** — unchanged in substance; verified
    against FA 2026-27 4.3–4.7 (two-year cap; one agreement per pair with
    tripartite exception; legal-advice notice + PFA/LMA + Annex on
    creation and amendment; Obligatory Terms).
16. **Agreement history/termination** — unchanged; FA 4.9 just cause
    includes minors-authorisation loss; novation form within 14 days
    (4.10).
17. **Client authority model** — unchanged.
18. **Agent verification** — unchanged.
19. **Stale/suspended licence behaviour** — unchanged (fail closed).
20. **Transaction model** — + `scope ∈ national | international |
    unknown` resolved before any conflict table is chosen (FA scope 1.1;
    FFAR 2(1)–(3)); `unknown` → `INSUFFICIENT_DATA`; mixed → review.
21. **Conflict Engine** — two tables: England 2026-27 (ACTIVE) and FIFA
    text (UNDER_LEGAL_REVIEW → manual review); `ruleStatus` semantics
    fixed (contract §3); never resolves an uncertain status itself.
22. **Single representation** — FFAR 12(8): TEXT EXISTS BUT ENFORCEMENT
    SUSPENDED (Circular 1873) + LEGAL STATUS UNCERTAIN (the circular's
    end-condition, an ECJ decision, has occurred; FIFA has not said
    whether the suspension ended; the German procedure continues) +
    OPERATIVE IN SPECIFIC JURISDICTION (England 6.3, ACTIVE). Engine:
    manual review in FIFA-only scope; England table in national scope.
23. **Dual representation** — FIFA 12(8)(a) (individual + engaging,
    advance written consent): same status as item 22. England 2026-27
    6.3(a): **dual or multiple** representation for any set of parties
    not including the releasing club, with (i) all parties' prior written
    consent in the prescribed form, (ii) full particulars incl. every
    party's proposed fee before the second agreement, (iii) reasonable
    opportunity for independent legal advice with a written PFA/LMA
    notice to players/coaches, (iv) express written consent on the
    proposed terms; AF1 at completion constitutes written consent
    (Guidance); Engaging Club may pay up to 50 % (7.11). Verified in the
    current text — **England does not inherit the FIFA matrix** (DR-47).
24. **Prohibited conflicts** — England 6.4 (releasing club exclusive,
    ACTIVE) → `PROHIBITED_CONFLICT`; FIFA 12(9) → manual review while
    UNDER_LEGAL_REVIEW, never a block by assumption (DR-46).
25. **Consent ledger** — + `agency_performance`.
26. **Other-services treatment** — FIFA 15(3) presumption →
    review; England: Other Services are inside 6.3–6.5 and enter the
    party set directly.
27. **Minor approach model** — unchanged in structure; England's exact
    current rule (FA 2026-27 reg. 5.1 (a)–(c), guidance table 2025–2027)
    recorded and versioned in `jp-eng-2026-27-1` only; FIFA 13(1) keeps
    its own formula with an `UNKNOWN` parameter per country (DR-48).
28. **Guardian consent** — unchanged; FA 5.1 requires prior written
    guardian consent before any Approach (direct or indirect) and any
    agreement; guardian co-signs (5.6; template has the line).
29. **Minor accreditation** — England additional authorisation (5.2–5.5,
    2026-27 numbering): enhanced DBS within three months of submission,
    course may be required, valid three years, automatic suspension on
    lapse, self-report; FIFA minors CPD (13(2)).
30. **Agency minor-discovery rule** — retained globally; suites green.
31. **Proposed new minor invariant** — unchanged wording; plus DR-49: no
    production minors pathway outside a jurisdiction whose rules are
    encoded from primary sources and legally reviewed; the FIFA rule
    alone never suffices.
32. **England overlay (`jp-eng-2026-27-1`)** — registration on FIFA
    licence; agency may be a party and colleague performance with all
    parties' consent (new); two-year cap; Annex; Obligatory Terms; minors
    1 Sep academic-year rule; DBS authorisation; dual/multiple with four
    safeguards; releasing club exclusive; connected agents; no fee cap;
    client pays with USD 200,000 exception; conditional remuneration in
    the fee base; 14-day proof of payment (new); 14-day lodging and
    disclosure incl. pre-registration arrangements (new limb); 6-year
    message/call record retention and no disappearing messages (new);
    HMRC settlement notices (new); no loans/gifts to clubs, no engaging
    non-registered persons (new); exclusivity window UNDER_LEGAL_REVIEW;
    Clearing House and FFAR-mirroring reporting limbs PARTIALLY_SUSPENDED
    / UNKNOWN pending L-7.
33. **U.S. overlay** — unchanged (licence, background check, SafeSport
    ACTIVE; all else UNKNOWN; no U.S. minors pathway).
34. **Future jurisdiction overlays** — unchanged framework; every rule
    UNKNOWN until encoded and reviewed.
35–51. **Player controls, My Agent, CRM, prospect vs client,
    opportunities, Contact, Trial, assessment privacy, decision privacy,
    Passport, Box Cam, Offer boundary, Transaction Room, Document Vault,
    contract metadata, fee ledger, payment recommendation** — unchanged
    from the first cut. Fee ledger now records the applicable
    `ruleStatus` (FIFA 14/15 UNDER_LEGAL_REVIEW; FA 7.x ACTIVE limbs) per
    term.
52. **Privacy matrix** — unchanged (no privacy boundary moved).
53. **Same-agency privacy** — unchanged for data; for conflicts, same
    agency is Connected under FA 6.5 (ACTIVE) and FFAR 12(10)
    (UNDER_LEGAL_REVIEW); the colleague route does not remove attribution.
54. **Blocks/safety** — unchanged.
55. **T&S** — D-P56A-9 (shared reviewer identity) remains **Medium, not
    downgraded**. Frozen gate (DR-29): P5.6B may proceed only while no
    regulated approval/rejection depends on anonymous reviewer identity
    (true of P5.6B's scope: verification review outcomes are advisory
    facts re-checked at every step; the client's confirmation is the
    root of private access); per-reviewer T&S identity must be
    implemented and audited before any P5.6C conflict/compliance decision
    is production-capable (gate G-C0).
56–62. **Events, notifications, audit, analytics, anti-spam, rate
    limiting, tenant model** — unchanged.
63. **Proposed stores** — unchanged list; `jurisdictionPolicies` rows
    carry `ruleStatus` and `sourceRef` with retrieved dates;
    `representationAgreements` carries `agencyParty` and the
    performance-consent id.
64. **Store reuse** — unchanged.
65. **Proposed API boundary** — unchanged; + reason codes
    `RULE_STATUS_UNCERTAIN`, `SCOPE_UNRESOLVED`, `SCOPE_MIXED`,
    `AGENCY_PERFORMANCE_CONSENTED`, `ROUTE_DISABLED_PENDING_REVIEW`.
66. **Authorization contract** — step 6 gains the England-only colleague
    route (consent-gated, disabled pending L-9); step 7 output carries
    `ruleStatus` per reason and `policyVersions`.
67. **Domain error architecture** — unchanged families.
68–69. **Idempotency, concurrency** — unchanged.
70. **Regulatory-provider failure** — unchanged (fail closed).
71. **Account/player deletion** — unchanged; FA 8.7 six-year retention is
    a new input to L-11.
72. **Historical compliance** — every evaluation preserves policy
    versions and each reason's `ruleStatus` at evaluation time.
73. **Navigation** — unchanged.
74. **P5.6B scope** — unchanged plus: `agencyParty` and the
    `agency_performance` consent are recorded but the colleague route is
    disabled; no conflict decisions; no T&S approvals of regulated acts.
75. **P5.6C scope** — entry gate G-C0 (per-reviewer T&S identity
    implemented and audited); England-only minors routes; L-1, L-7, L-9
    re-checked before enabling anything beyond England.
76–78. **P5.6D, P5.6E, parity** — unchanged.
79. **Legal-review items** — eighteen (L-1–L-16 plus L-17 e-signature /
    electronic filing sufficiency and L-18 domestic vs international
    resolution); L-9 re-scoped to the 2026-27 colleague route.
80. **Regulatory uncertainties** — updated register (snapshot §9)
    separating: FIFA suspended-rule operative status; England
    multiple-representation regime (verified, in force); non-England
    minor approach timing; domestic vs international transaction
    jurisdiction; fee/payment rules; same-agency / connected-agent
    attribution; electronic signature / regulatory filing sufficiency;
    plus exclusivity window, publication, U.S. rules, FIFA template.
81. **Defects found** — one production defect (D-P56A-1, closed), ten
    documented items (D-P56A-2 … D-P56A-11), four inherited P4A Lows; the
    stale-source error in the first document cut is recorded in the
    defect register as a documentation correction (DR-50), not a
    software defect.
82. **Defects fixed** — D-P56A-1 (`a3ebc7a`).
83. **Open Critical** — 0.
84. **Open High** — 0.
85. **Open Medium** — reasonably fixable and blocking P5.6B: 0. **Open
    Medium prerequisite before P5.6C: D-P56A-9 (shared T&S reviewer
    identity), not fixed, not downgraded.** ScoutBox does not claim zero
    Medium globally.
86. **Regression results** — table below (targeted set for a
    documentation-only change, per §16 of the closure mandate; the full
    battery on `a3ebc7a` is in the first-cut table and the production
    tree is unchanged since).
87. **Tree status** — clean after the documents commit; no untracked
    files; no bundle recut.
88. **Push status** — **NOT PUSHED.** Origin remains at `669d060`.
89. **PR status** — none.
90. **Deployment status** — none.

## Regression (final tree; production code unchanged since `a3ebc7a`)

| Suite | Exit | Last line |
|---|---|---|
| `testTrust` | 0 | 23 trust/safeguarding tests passed |
| `m162E2E` (incl. the D-P56A-1 section) | 0 | all M16.2 checks passed |
| `m23ContactE2E` | 0 | all M23 P3 Contact checks passed |
| `m23TrialE2E` | 0 | all M23 P4B Trial checks passed |
| `m23DecisionE2E` | 0 | all M23 P5 Decision checks passed |
| `e2e/navConfig` | 0 | navConfig: 282 checks passed |
| `e2e/navLive` | 0 | navLive: 64 checks passed — N1–N17 complete |

Run sequentially on the final tree (server suites from
`scoutbox-server`, browser suites from the repository root). Box Cam
`m22/*` has no diff since `669d060`.

Repo consistency checks run on the final tree: no P5.6A document labels
the FA 2025-26 material as current; no document uses the retired
`jp-fifa-1` / `jp-eng-1` version ids or the retired `in_force / doubtful /
not_encoded` state vocabulary as the engine's status enum; old England
regulation numbers for the minors section (5.3–5.8) appear only in the
historical change table.

## §191 — final required answers (unchanged where the source did not change)

```
ScoutBox itself performs football-agent services: NO
Licensed natural person is distinct from agency organisation: YES
Agency membership alone authorizes regulated agent action: NO
Representation agreement required before regulated action where current law requires it: YES
Agent verification alone proves client authorization: NO
Agent can add a player to CRM and thereby gain private access: NO
Agent can claim representation without client/guardian confirmation and gain private ScoutBox access: NO

General minor discovery for agencies remains prohibited: YES
Dedicated lawful minor-representation pathway is architecturally possible: YES (guardian-first, jurisdiction-gated, fail-closed; England encodable from the 2026-27 text; no other jurisdiction enabled)
Minor pathway requires guardian controls: YES
Minor pathway requires jurisdiction-aware timing: YES
Minor pathway requires relevant agent accreditation where current rule requires it: YES
Missing minor regulatory data fails closed: YES

Conflict Engine required: YES
General single-party representation rule supported by current FIFA source: YES as text (FFAR 12(8)); its current operative status is NOT conclusively established (Circular 1873 suspension; CJEU 16 Jul 2026; no FIFA notice) → UNDER_LEGAL_REVIEW; CURRENTLY OPERATIVE in England (FA 2026-27 reg. 6.3)
Permitted dual-representation path exists under current FIFA source: YES as text (12(8)(a)); same status; England 6.3 permits dual OR multiple with four safeguards
Permitted dual representation requires separate advance written consent where current rule requires it: YES
Releasing entity + individual can be represented by same agent in same transaction: NO where an ACTIVE rule governs (England 6.4 now); manual review where only the uncertain FIFA rule applies
Releasing entity + engaging entity can be represented by same agent in same transaction: NO (same qualification)
All parties can be represented by same agent: NO (same qualification)

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
Existing Inbox can be reused: YES
Existing guardian system can be reused: YES
Existing block system can be reused: YES
Existing notifications can be reused: YES
Existing audit infrastructure can be reused: YES
Existing file storage can be reused: YES
Existing Recruitment Case can serve as regulated transaction object: NO
```

## §17 — final regulatory answers (currency closure)

```
FA active ruleset used: 2026/27 — YES
Superseded FA 2025/26 treated as current: NO
England multiple representation current rule verified: YES (FA 2026-27 reg. 6.3–6.5 + Guidance, retrieved 18 Sep 2026)
England conflict matrix differs from FIFA matrix: YES
FIFA current FAQ reviewed: YES (last updated 23 Jan 2025; pre-dates the judgment)
Circular 1873 reviewed: YES
July 2026 CJEU development reviewed: YES (press release 110/26 + FIFA statement 16 Jul 2026)
Post-CJEU FIFA implementation notice found: NO
FIFA suspended-rule CURRENT operative status conclusively established: NO
If NO, policy returns manual regulatory review: YES
Non-England minor path allowed without jurisdiction encoding: NO
T&S anonymous reviewer issue remains Medium: YES
T&S per-reviewer identity required before P5.6C production compliance actions: YES
```

## §18 — defect gate

```
Open Critical production defects: 0
Open High production defects: 0
Open reasonably-fixable Medium production defects blocking P5.6B: 0
Open Medium prerequisite before P5.6C: D-P56A-9 shared T&S reviewer identity (not fixed)
```

## §19

```
M23 P5.6A REGULATORY CURRENCY CLOSURE COMPLETE
CURRENT 2026/27 ENGLAND RULES ARE THE ACTIVE ENGLAND POLICY BASIS
FIFA RULE / SUSPENSION STATUS IS REPRESENTED HONESTLY
JURISDICTION POLICY ENGINE CAN REPRESENT ACTIVE, SUSPENDED AND OVERRIDDEN RULES
CONFLICT ENGINE REMAINS FAIL-HONEST
MINOR PATHWAYS REMAIN JURISDICTION-GATED
P5.6A ARCHITECTURE FROZEN
READY FOR P5.6B AGENT CORE APP
```

Conditions carried into P5.6B/C (not blockers for P5.6B): G-C0
(per-reviewer T&S identity) before P5.6C; L-1 (FIFA status), L-7 (FA
shading), L-9 (colleague route) re-checked before P5.6C enables anything
beyond England's national scope; no non-England minors pathway (L-6,
L-8); every `jurisdictionPolicies` version counsel-reviewed before
publication (DR-32).

## §20 — stop

P5.6B not begun. No Agent app files, no Conflict Engine, no
representation agreements, no transactions, no Offer, no change to
agent/agency minor access in production. Not pushed. No PR. No deploy.
Returned for review.

