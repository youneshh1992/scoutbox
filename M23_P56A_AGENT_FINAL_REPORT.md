# M23 P5.6A — Regulatory Currency Closure — Final Report

Milestone type: regulatory snapshot + architecture contract; currency
closure pass. No Agent application, routes, UI, Offer Workflow, Conflict
Engine, representation agreements, transactions, stores, policy tables or
schema change were built. Production code is unchanged since the one §186
fix (`a3ebc7a`). Nothing pushed; no PR; no deploy.

Closure history: `a3ebc7a` (D-P56A-1 fix + regression) → `c0cbe42` (first
thirteen-document cut, which cited the superseded FA 2025-26 texts as
current) → `021efca` (first currency-closure pass: FA 2026-27 basis, FIFA
suspension status honest, rule-status model, England conflict table,
colleague route, T&S gate) → this commit (second closure pass: source
currency labels, `PENDING_IMPLEMENTATION`, fail-closed vs manual-review
freeze, T&S attribution contract, per-jurisdiction minors table, tagged
uncertainty register, exact defect counts, this report). The closure
mandate's "expected local tip c0cbe42" therefore predates `021efca`; both
closure commits are reported below.

Standing caveat: the snapshot is a good-faith reading of primary sources
as of 18 September 2026 by an engineering team, not legal advice; it does
not replace counsel.

---

## §35 — the forty-five items

1. **Starting tip** — for the whole milestone `669d060`; for this
   closure pass `021efca` (the mandate's stated `c0cbe42` is the
   first-cut docs commit that `021efca` already corrected).
2. **Final tip** — the commit that carries this report (hash in its
   message; it follows `021efca`).
3. **Production code changed?** — **NO** in either closure pass. The
   only production change in P5.6A remains `a3ebc7a`
   (`scoutbox-server/m162/trust.mjs` + its `m162E2E` regression).
   `git diff a3ebc7a --stat` on the final tree lists only `M23_P56A_*.md`.
4. **England source correction** — the FA Football Agent Regulations
   2025-26 (Handbook section 19, in force 1 Jun 2025) and Guidance
   2025-26 are re-labelled `SUPERSEDED` / `HISTORICAL` and used only in
   the snapshot's change table (§3.11). No current England rule relies
   on them.
5. **Current FA ruleset** — **The FA Football Agent Regulations 2026-27**
   (FA Handbook 2026-27, Rules of The Association section 17; "These
   Regulations came into force on 1 June 2026"; also published
   stand-alone under `governance-docs/agents/the-fa-football-agent-regulations-2026-27`),
   **The FA Football Agent Regulations Guidance 2026-27**, the FA
   representation-agreement templates (NFAR Player-Coach, Club,
   Tripartite, Subcontract, termination letter), the FA criminal-record-
   check process, the FA registered-agents page and list of 18 Sep 2026,
   and the FA agents landing page ("come into effect from 1st June
   2026"). All retrieved 18 Sep 2026; PDF hashes in the snapshot §1.
6. **Current FIFA source set** — FFAR edition in force 1 Jan 2025
   (text `CURRENT`); Circular 1873 (30 Dec 2023, `CURRENT` instrument);
   CJEU press release 110/26 (16 Jul 2026); FIFA statement of 16 Jul
   2026; FIFA agents FAQ (last updated 23 Jan 2025); FIFA agents hub,
   latest-news list and national-regulations page (read 18 Sep 2026; the
   national-regulations list is script-rendered and unreadable); FIFA
   10 Jun 2026 transfer-framework announcement (no agent content;
   `PENDING_IMPLEMENTATION` 1 Jan 2027). U.S. Soccer agents page re-read
   18 Sep 2026 (licence enforced from 1 Jan 2024; background check +
   SafeSport; unchanged).
7. **Circular 1873 status analysis** — the Bureau approved a "worldwide
   temporary suspension … until the European Court of Justice renders a
   final decision in the pending procedures concerning the FFAR" and
   recommended member associations suspend equivalents. Suspended:
   15(1)–(4); 14(6)(8)(11); 14(2)(10); 14(7)(12); **12(8)–(10)**;
   16(2)(h)(j)(k)(4); 19; the submission rule. The circular has not been
   withdrawn. Its own end-condition (an ECJ decision) has occurred, but
   the ECJ referred proportionality back to the national court, so "the
   pending procedures" are not finished and FIFA has said nothing.
   Classification: `CURRENT_BUT_SUSPENDED` as the last express
   instrument, with `UNCERTAIN_OPERATIVE_STATUS` overall.
8. **July 2026 CJEU analysis** — C-209/23 *RRC Sports*, 16 Jul 2026:
   licence, fee cap, ban on multiple representation, client-pays and pro
   rata rules "may be justified" subject to the national court's
   assessment; the exclusive-agreement approach window "appears … to be
   incompatible with the prohibition on cartels"; GDPR precludes
   publication of sanctions and detailed transaction data. FIFA's same-day
   statement welcomes the decision, announces consultation with agent
   representatives and a new transfer system on 1 Jan 2027, and is silent
   on the suspension. The judgment did not itself reinstate anything.
9. **Post-CJEU implementation notice search result** — **NOT FOUND.**
   Searched: FIFA agents news list (last agent item 16 Jul 2026), FIFA
   agents hub, FIFA FAQ (pre-dates the judgment), FIFA national-
   regulations page, FIFA 10 Jun 2026 framework news, web search for a
   2026 circular / implementation notice / General Secretariat decision.
   Nothing lifting, partially lifting, resuming articles, timetabling or
   replacing Circular 1873 exists in any primary source read. Secondary
   commentary (August 2026) reads the suspension as continuing; that is
   opinion and is not relied on.
10. **FIFA rule-text vs enforcement distinction** — recorded as two
    separate facts on every rule: the currency label of the text
    (`CURRENT` / `SUPERSEDED` / …) and the enforcement classification
    (CURRENTLY OPERATIVE / TEXT EXISTS BUT ENFORCEMENT SUSPENDED /
    OPERATIVE IN SPECIFIC JURISDICTION / LEGAL STATUS UNCERTAIN / COUNSEL
    REVIEW REQUIRED / ANNOUNCED, NOT YET IN FORCE), stored as `ruleStatus`
    on distinct policy rows (snapshot §0).
11. **England multiple-representation result** — FA 2026-27 reg. 6.3:
    one party per National Transaction, save that the agent may act for
    **more than one party (permitted dual or multiple representation)**
    provided (i) all parties' prior written consent in the prescribed
    form, (ii) full particulars incl. every party's proposed fee before
    the second agreement, (iii) reasonable opportunity for independent
    legal advice with a written PFA/LMA notice to players/coaches before
    consent, (iv) express written consent on the proposed terms; 6.3(b):
    without a party's consent the agent continues for the first party
    only and takes no fee from the others; 6.4: a Releasing Club's agent
    may act for no other party; 6.5: Connected Football Agents (same
    Agency, ownership, family, repeated cooperation/revenue sharing)
    treated as one; 6.2/6.6: AF1 at completion incl. self-represented
    transactions; Guidance: AF1 submission constitutes written consent;
    7.11: Engaging Club may pay up to 50 % in dual representation. Status
    `ACTIVE` (Guidance-covered, therefore not shaded).
12. **FIFA multiple-representation result** — FFAR 12(8)–(10) text
    `CURRENT`; enforcement `UNCERTAIN_OPERATIVE_STATUS` (item 7–9);
    engine `UNDER_LEGAL_REVIEW` → `MANUAL_REGULATORY_REVIEW_REQUIRED` for
    any international-dimension / FIFA-only decision, never `CLEAR` and
    never `PROHIBITED_CONFLICT` by assumption (DR-46).
13. **Conflict-matrix differences** — England permits any party set not
    containing the releasing club (individual + engaging; individual +
    engaging + a second individual; etc.) with four safeguards; the FIFA
    text permits individual + engaging only. Both keep releasing-club
    combinations prohibited and attribute connected agents. The engine
    carries two tables and picks by resolved scope; mixed → review
    (DR-47).
14. **Policy status model** — `ruleStatus ∈ ACTIVE | SUSPENDED |
    PARTIALLY_SUSPENDED | JURISDICTION_OVERRIDE | PENDING_IMPLEMENTATION |
    UNDER_LEGAL_REVIEW | UNKNOWN`; engine treatment fixed per status
    (conflict engine contract §3); fail-closed vs manual-review frozen
    (§3a; DR-52).
15. **Jurisdiction policy changes** — rows versioned by regulator,
    jurisdiction, policy version, `effectiveFrom`, `effectiveTo`, rule
    id, `ruleStatus`, source version and `retrievedAt`; historical
    evaluations preserve version and status at the time. Initial
    versions `jp-fifa-2025-1`, `jp-eng-2026-27-1`, `jp-usa-2024-1`
    (contents in the authorization contract §5.3). Architecture only; no
    table created.
16. **Minor timing — FIFA** — FFAR 13(1): no more than six months before
    the age at which the minor may sign a first professional contract
    under the employing country's law; prior written guardian consent
    before the Approach. Rule `ACTIVE`; the age parameter `UNKNOWN` for
    every country → `INSUFFICIENT_DATA` → refused.
17. **Minor timing — England** — FA 2026-27 reg. 5.1: not before 1
    September in the Academic Year (1 Sep–31 Aug) in which the Minor
    reaches 16, for (a) any Approach re services, (b) any Approach re an
    agreement, (c) any agreement, directly or indirectly; prior written
    guardian consent; guidance table: minors reaching 16 between 1 Sep
    2026 and 31 Aug 2027 → from 1 Sep 2026. Versioned in
    `jp-eng-2026-27-1` only; not derived from FIFA; never generalised.
18. **Non-England minor policy** — frozen: no production
    minor-representation pathway in any jurisdiction until its approach
    timing, guardian rules, accreditation rules and national-registration
    rules are encoded from primary sources and reviewed; FIFA's general
    rules alone are insufficient (DR-49). Today: none enabled anywhere;
    England is encodable.
19. **Guardian consent** — FIFA and England both require prior written
    guardian consent **before** the approach and before any agreement;
    consent obtained after a prohibited approach cures nothing (FA 5.7
    sanction; FFAR 13(4)). Existing verified-guardian ladder reused;
    consents are ledger rows with policy versions.
20. **Agent minor accreditation** — FIFA: designated minors CPD course +
    assessment, three-year accreditation (13(2); FAQ). England:
    additional authorisation to deal with Minors — suitability incl. an
    enhanced DBS issued within three months of submission, possible
    minors course, valid three years, automatic suspension on lapse, duty
    to self-report (5.2–5.5); shown on the Digital ID. U.S.: background
    check + SafeSport for all agents; minors specifics unknown.
21. **Connected-agent / same-agency result** — England 6.5 + definition
    `ACTIVE`; FIFA 12(10) + definition `UNDER_LEGAL_REVIEW`. Different
    licensed individuals at one agency are **not** conflict-free; the
    engine attributes connected agents by default; no source recognises
    an information barrier as a cure (L-4). The new FA 2026-27 route
    letting a licensed colleague perform under an agency-party agreement
    with all parties' written consent (3.3 Guidance, 4.1(b)) is modelled,
    England-only, consent-gated, disabled until L-9 (DR-45); it does not
    remove attribution.
22. **Representation agreements** — FIFA 12(1)–(7), (13)–(14) `ACTIVE`;
    FA 4.1–4.12 `ACTIVE`: two-year cap for players/coaches with extension
    by new agreement only and automatic renewal void; club agreements
    without maximum and multiple club agreements for different
    Transactions; one agreement per pair with the tripartite exception;
    legal-advice + PFA/LMA notice and written confirmation in an Annex on
    creation and amendment; Obligatory Terms of the Standard
    Representation Agreement; five minimum contents; autonomy clauses
    void; just cause incl. minors-authorisation loss; novation form and
    assignment/sub-contract lodging within 14 days; agreements solely for
    a Specified International Transaction fall under FFAR 12.7 not the
    Obligatory Terms. ScoutBox records terms and externally executed
    evidence; it generates no globally "valid" contract (L-3, L-12, L-17).
23. **FIFA licence vs national registration** — frozen as three
    facets: FIFA licence, national registration, domestic authorisation;
    an agent may be FIFA-licensed yet unauthorised for a domestic
    activity; England registration requires a FIFA licence (2.2) and is
    automatically suspended/withdrawn with it (2.10); the licence holder
    is a natural person only (FFAR 8(1), 11(1); FA 2.2, 3.1), re-confirmed
    (DR-53).
24. **Fee-rule status** — FIFA 14 (client pays, timing, pro rata,
    instalments, 50 % dual, Clearing House) and 15 (caps):
    `UNCERTAIN_OPERATIVE_STATUS`. England reg. 7: no cap provision;
    client pays (7.2) with the USD 200,000 engaging-club exception (7.3);
    fee on Remuneration incl. conditional elements, not performance-
    linked (7.4); invoice basis; pro rata for long contracts; no fee for
    minors absent a professional contract (7.10); 50 % dual (7.11); proof
    of payment within 14 days (7.14) — all Guidance-covered → `ACTIVE`;
    Clearing House (7.13) not covered → likely shaded, `PARTIALLY_SUSPENDED`
    / `UNKNOWN` (L-7). No fee enforcement in P5.6B; ledger records terms
    + `ruleStatus` (DR-31).
25. **T&S reviewer-identity issue** — D-P56A-9 remains **Medium, open,
    not downgraded**; not fixed in this closure.
26. **P5.6B gate** — may proceed: no P5.6B regulated approval/rejection
    depends on anonymous reviewer identity (P5.6B ships no conflict
    review, override, dispute resolution or minor approval; the client's
    confirmation is the private-access root); interim rule: agent-licence
    reviews refuse without a declared reviewer. P5.6B is never
    production-authoritative for regulatory conflict adjudication.
27. **P5.6C gate (G-C0, frozen)** — per-reviewer T&S identity implemented
    and audited, recording reviewer user id, role, timestamp, policy
    version, action, reason, evidence (authorization contract §14),
    before conflict review, regulatory override, licence adjudication,
    representation dispute resolution, minor compliance approval or
    manual-review resolution is production-capable.
28. **Trust fix regression** — `m162E2E` re-run alone on the final tree:
    exit 0, "all M16.2 checks passed", including the D-P56A-1 section
    (proposed does not count; confirmed counts once; withdrawn and
    disputed stop counting; key is `agencyOrgId`). `a3ebc7a` retained; no
    Trust semantics widened.
29. **Regulatory uncertainties** — 19 (snapshot §9, U-1 … U-19), each
    tagged `KNOWN` / `UNCERTAIN` / `COUNSEL_REQUIRED` / `BLOCKS_BUILD` /
    `BLOCKS_PRODUCTION_ONLY`; none is `BLOCKS_BUILD`.
30. **Legal-review items** — 18 (snapshot §8, L-1 … L-18).
31. **Defects** — D-P56A-1 closed (`a3ebc7a`); D-P56A-2 … D-P56A-11
    documented; four inherited P4A Lows; the stale-source documentation
    error corrected (DR-50).
32. **Critical open** — 0.
33. **High open** — 0.
34. **Medium blocking P5.6B** — 0.
35. **Medium prerequisite before P5.6C** — 1 (D-P56A-9).
36. **Regression results** — table below; every suite green, run
    sequentially with no concurrent browser suite (the earlier
    concurrent-run artefact on `m23DecisionPersistence` is recorded in
    the defect register and did not recur here; that suite is not in the
    §28 set and was green ×3 alone on the same production tree).
37. **navConfig / navLive** — 282 and 64 checks, exit 0.
38. **Schema version** — unchanged at 2304 (`X-ScoutBox-Schema: 2304`
    per `m23BootContract`, green).
39. **New stores** — none created.
40. **Agent app directory created?** — **NO** (`scoutbox-agent` does not
    exist).
41. **Tree status** — clean after the documents commit.
42. **Ahead/behind** — ahead of `origin/claude/desktop-project-migration-wyk3ec`
    by four commits (`a3ebc7a`, `c0cbe42`, `021efca`, this commit),
    behind by zero.
43. **Push status** — NOT PUSHED; origin unchanged at `669d060`.
44. **PR status** — none.
45. **Deployment status** — none.

## Regression (§28 set; documentation-only change; production tree unchanged since `a3ebc7a`)

| Suite | Exit | Last line |
|---|---|---|
| `m162E2E` (M16.2 Trust, incl. D-P56A-1 section) | 0 | all M16.2 checks passed |
| `m23ContactE2E` | 0 | all M23 P3 Contact checks passed |
| `m23TrialE2E` | 0 | all M23 P4B Trial checks passed |
| `m23DecisionE2E` | 0 | all M23 P5 Decision checks passed |
| `m23E2E` | 0 | all M23 P2 checks passed |
| `m23BootContract` | 0 | all M23 boot-contract checks passed |
| `e2e/navConfig` | 0 | navConfig: 282 checks passed |
| `e2e/navLive` | 0 | navLive: 64 checks passed — N1–N17 complete |

Box Cam `m22/*` has no diff since `669d060`. Repo consistency scan on
the final tree: no P5.6A document labels 2025-26 material as current;
no retired policy ids or state vocabulary remain.

## §31 — final current-rule answers

```
FA active ruleset used: 2026/27 — YES
FA 2026/27 effective 1 June 2026 confirmed: YES ("These Regulations came into force on 1 June 2026."; FA page: "come into effect from 1st June 2026")
Superseded FA 2025/26 treated as current: NO
Current FA Guidance 2026/27 reviewed: YES
England current multiple-representation rule verified: YES
England conflict matrix differs materially from standard FIFA FAQ matrix: YES
Current FIFA FAQ reviewed: YES
FIFA Circular 1873 reviewed: YES
July 2026 CJEU development reviewed: YES
Later FIFA implementation/suspension notice found: NO
Current FIFA operative status of suspended double-representation rule conclusively established: NO
If not conclusively established, policy result is MANUAL_REGULATORY_REVIEW_REQUIRED: YES
Rule text status and rule enforcement status are represented separately: YES
Jurisdiction policy supports ACTIVE/SUSPENDED/PARTIAL/UNKNOWN states: YES (plus JURISDICTION_OVERRIDE, PENDING_IMPLEMENTATION, UNDER_LEGAL_REVIEW)
Non-England minor pathway permitted without jurisdiction encoding: NO
General agency minor discovery remains prohibited: YES
Licensed-individual lawful minor pathway remains architecture-only: YES
Shared T&S reviewer identity issue remains Medium if unfixed: YES (unfixed; Medium)
Per-reviewer T&S identity required before P5.6C production compliance decisions: YES
```

## §32 — final architectural answers

```
ScoutBox itself performs football-agent services: NO
Agency organisation itself holds FIFA licence: NO
Agency membership alone authorises regulated football-agent action: NO
FIFA licence alone proves authority for specific client: NO
Representation agreement alone bypasses conflict checks: NO
CRM prospect status gives private Player access: NO
Imported client claim proves representation: NO
Conflict check performed hours earlier is sufficient without mutation-time recheck: NO
Regulatory-provider failure silently permits action: NO
Jurisdiction uncertainty silently permits action: NO
Minor guardian consent may be obtained after prohibited approach: NO
Club-private assessment visible to agent: NO
Internal recruitment decision visible to agent: NO
Agent owns player Passport: NO
Agent may edit Trust Score: NO
Paid ranking changes agent discovery order: NO
Unlicensed assistant may submit regulated action for licensed agent: NO

Existing Inbox reusable: YES (as the delivery surface, with a new request type)
Existing guardian infrastructure reusable: YES
Existing block infrastructure reusable: YES
Existing notification infrastructure reusable: YES (with new types registered)
Existing audit infrastructure reusable: YES
Recruitment Case can serve as regulated transaction object: NO
```

## §34 — final defect counts

```
Open Critical production defects: 0
Open High production defects: 0
Open Medium blocking P5.6B: 0
Open Medium prerequisite before P5.6C: 1 (D-P56A-9 shared T&S reviewer identity)
Open Low: 13 (D-P56A-2, -3, -4, -5, -6, -7, -8, -10, -11; P4A-D6, P4A-D7, P4A-D8, P4A-D11)
Regulatory uncertainties: 19 (U-1 … U-19)
Legal-review items: 18 (L-1 … L-18)
```

## §36 — final truth block

```
Current FA England policy basis is 2026/27: YES
Superseded FA 2025/26 treated as current: NO
FA 2026/27 effective date verified: YES
Current FIFA FAQ reviewed: YES
Circular 1873 reviewed: YES
July 2026 CJEU development reviewed: YES
Post-CJEU FIFA implementation notice found: NO
FIFA suspension operative status represented honestly: YES
Rule text and enforcement status separated: YES
England-specific conflict matrix supported: YES
Jurisdiction-specific conflict matrices supported: YES
Uncertain regulatory state fails to manual review: YES

General agency minor discovery remains blocked: YES
Minor representation path implemented in production: NO
Non-England minor path enabled without encoded jurisdiction rules: NO
Guardian controls preserved: YES
Current agent/minor authorisation requirements represented: YES

Licensed natural person remains distinct from agency: YES
Agency membership alone authorises regulated action: NO
Verification alone proves client authority: NO
Representation agreement bypasses conflict engine: NO
Unlicensed staff may perform regulated action: NO
ScoutBox acts as football agent: NO

Private club assessment exposed to Agent: NO
Private recruitment decision exposed to Agent: NO
Trust Score manipulation introduced: NO
Paid Agent ranking introduced: NO

T&S shared-key reviewer identity issue hidden: NO
T&S per-reviewer identity prerequisite before P5.6C compliance adjudication: YES

Open Critical production defects: 0
Open High production defects: 0
Open reasonably-fixable Medium defects blocking P5.6B: 0

Schema advanced: NO
Agent stores created: NO
ScoutBox Agent app created: NO
Conflict Engine implemented: NO
Offer Workflow implemented: NO

Tree clean: YES
Push performed: NO
PR created: NO
Deployment performed: NO
```

## §37

```
M23 P5.6A REGULATORY CURRENCY CLOSURE COMPLETE
CURRENT 2026/27 ENGLAND RULES ARE THE ACTIVE ENGLAND POLICY BASIS
FIFA RULE-TEXT AND ENFORCEMENT STATUS ARE REPRESENTED SEPARATELY
JURISDICTION POLICY ENGINE SUPPORTS ACTIVE, SUSPENDED, OVERRIDDEN AND UNCERTAIN RULE STATES
CONFLICT ENGINE REMAINS JURISDICTION-AWARE AND FAIL-HONEST
MINOR PATHWAYS REMAIN JURISDICTION-GATED
SCOUTBOX REMAINS INFRASTRUCTURE, NOT THE FOOTBALL AGENT
NO EXISTING PRIVACY OR SAFEGUARDING BOUNDARY WEAKENED
ZERO KNOWN CRITICAL PRODUCTION DEFECTS
ZERO KNOWN HIGH PRODUCTION DEFECTS
ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS BLOCKING P5.6B
P5.6A ARCHITECTURE FROZEN
READY FOR M23 P5.6B SCOUTBOX AGENT CORE APP
```

Conditions carried forward (not P5.6B blockers): G-C0 before P5.6C;
L-1 (FIFA status), L-7 (FA shading), L-9 (colleague route) re-checked
before P5.6C enables anything beyond England's national scope; no
non-England minors pathway (L-6, L-8); every `jurisdictionPolicies`
version counsel-reviewed before publication (DR-32); one open Medium
(D-P56A-9) is a P5.6C prerequisite, not hidden.

## §38 — stop

P5.6B not begun. No Agent app files, no Conflict Engine, no
representation agreements, no transactions, no Offer, no change to
agent/agency minor access in production. Not pushed. No PR. No deploy.
Returned for review.
