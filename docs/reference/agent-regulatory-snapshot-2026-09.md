# M23 P5.6A — Agent Regulatory Snapshot

Snapshot date: **18 September 2026** (currency closure; supersedes the
first cut of this document, which used the FA's 2025-26 texts as if
current). Every rule below was read from the governing body's own text on
that date, from the sources listed in §1, and every **current** rule names
its source, version/season, effective date and retrieved date. The four
categories the mandate demands are kept apart throughout:

- **VERIFIED CURRENT RULE** — quoted or closely paraphrased from a primary
  source, with article number, edition and date.
- **PRODUCT POLICY** — what ScoutBox chooses to do, which may be stricter
  than the rule and is not a statement of law.
- **ARCHITECTURAL RECOMMENDATION** — how the software should be shaped so
  the rule and the policy can be enforced and re-versioned.
- **LEGAL-REVIEW ITEM** — anything ScoutBox must not decide alone.

Each rule also carries a **rule-status classification** (§0) because a rule
can exist in a governing body's text while its enforcement is suspended,
overridden by a national regulator, or of uncertain legal status.

Nothing in this document is legal advice, and no ScoutBox review replaces
specialist sports-law counsel. Where this snapshot found a conflict with
the mandate's hypotheses (§6 A–I of the original mandate), the source wins
and the conflict is recorded in §5. Where governing-body materials conflict
with each other, the conflict is recorded in §11 and the architecture
fails honest (`MANUAL_REGULATORY_REVIEW_REQUIRED`), never to a guess.

---

## 0. Rule-status classification (used throughout)

| Classification | Meaning | Engine `ruleStatus` (policy layer) |
|---|---|---|
| **CURRENTLY OPERATIVE** | The body whose rule it is says it applies now, and no later instrument of that body suspends it | `ACTIVE` |
| **TEXT EXISTS BUT ENFORCEMENT SUSPENDED** | The rule is in the current edition's text; the same body has suspended its application/enforcement by a later instrument that has not been withdrawn | `SUSPENDED` (or `PARTIALLY_SUSPENDED` when only part of a provision is affected) |
| **OPERATIVE IN SPECIFIC JURISDICTION** | A national regulator applies its equivalent rule in its territory regardless of the FIFA-level status | `JURISDICTION_OVERRIDE` (national policy set carries `ACTIVE`; FIFA set carries its own status) |
| **LEGAL STATUS UNCERTAIN** | Governing-body materials conflict, or the instrument's own end-condition may have occurred without the body saying so | `UNDER_LEGAL_REVIEW` |
| **COUNSEL REVIEW REQUIRED** | ScoutBox cannot settle the question from the sources; counsel must | `UNDER_LEGAL_REVIEW` (blocking) or `UNKNOWN` (not encoded) |
| **ANNOUNCED, NOT YET IN FORCE** | The body has published or announced a rule with a future effective date (e.g. the 1 Jan 2027 transfer framework) | `PENDING_IMPLEMENTATION` (never applied before `effectiveFrom`; recorded so the version can be prepared) |

Source/rule **currency labels** used in §1 and on each rule (mandate §3):
`CURRENT` (in force, not suspended), `HISTORICAL` (kept only to explain
prior behaviour), `SUPERSEDED` (replaced by a later edition; never a
basis), `CURRENT_BUT_SUSPENDED` (in the current edition; enforcement
suspended by the same body), `CURRENT_WITH_PARTIAL_SUSPENSION` (some
limbs suspended), `UNCERTAIN_OPERATIVE_STATUS` (current text; enforcement
status not conclusively established). Historical and current materials
are never mixed in one rule entry.

**Rule text vs rule enforcement.** Every rule below separates "the text
exists in the current edition" (its currency label) from "the rule is
currently enforceable" (its classification and `ruleStatus`). The two
are recorded as distinct facts and stored as distinct fields.

A rule may carry more than one classification (e.g. FIFA 12(8): TEXT
EXISTS BUT ENFORCEMENT SUSPENDED **and** LEGAL STATUS UNCERTAIN **and**
OPERATIVE IN SPECIFIC JURISDICTION (England)). The engine resolves per
jurisdiction: `ACTIVE` applies; `SUSPENDED` contributes a reason and does
not block; `JURISDICTION_OVERRIDE` selects the national entry;
`UNDER_LEGAL_REVIEW`, `UNKNOWN` → `MANUAL_REGULATORY_REVIEW_REQUIRED`.

---

## 1. Sources read

All retrieved **18 September 2026** unless stated. "Current" sources are
the active basis; "historical" sources are kept only where they explain
prior behaviour and are never labelled current.

| # | Source | Body | Jurisdiction | Version / season | Effective | Status in this snapshot | How obtained |
|---|---|---|---|---|---|---|---|
| S1 | FIFA Football Agent Regulations (FFAR) — `digitalhub.fifa.com/m/1e7b741fa0fae779/original/FIFA-Football-Agent-Regulations.pdf` | FIFA | worldwide (international dimension) | Edition approved by the FIFA Council 10 Dec 2024; PDF metadata "FFAR 2024 Cover V2" | **1 January 2025** (art. 28) | **CURRENT text** | PDF fetched and text-extracted (39 pp.) |
| S2 | FIFA Circular no. 1873 "FIFA Football Agent Regulations: update on implementation" — `digitalhub.fifa.com/m/76b4cdc63e42e03f/original/1873_FIFA-Football-Agent-Regulations-update-on-implementation.pdf` | FIFA | worldwide | 30 Dec 2023 | 30 Dec 2023 | **CURRENT instrument** (last FIFA instrument on suspension found; not withdrawn; see §11) | PDF fetched and text-extracted |
| S3 | CJEU Press Release No 110/26, judgment in Case C-209/23 *RRC Sports* — `curia.europa.eu/site/upload/docs/application/pdf/2026-07/cp260110en.pdf` | CJEU | EU law | 16 Jul 2026 | 16 Jul 2026 | CURRENT (press release; full judgment not read) | PDF fetched and text-extracted |
| S4 | FIFA news "FIFA welcomes Court of Justice of the European Union decision on FIFA Football Agent Regulations" — `inside.fifa.com/news/welcomes-court-of-justice-european-union-decision-football-agent-regulations` | FIFA | — | 16 Jul 2026 | — | CURRENT (FIFA's only post-judgment statement found; silent on the suspension) | web page |
| S5 | FIFA "FAQ & How to contact us" (agents) — `inside.fifa.com/transfer-system/agents/faq-agents` | FIFA | — | page states **last updated 23 January 2025** | — | CURRENT page, **pre-dates S3**; describes rule *text* without mentioning S2 (see §11) | web page, re-read 18 Sep 2026 |
| S6 | FIFA agents hub and "Latest agents news" — `inside.fifa.com/transfer-system/agents`, `…/agents/latest`, `…/agents/national-football-agent-regulations` | FIFA | — | news list read 18 Sep 2026: items dated 16 Jul 2026, 12 Mar 2026, 18 Dec 2025, 15 May 2025 … | — | CURRENT; **no circular, implementation notice or FAQ update after 16 Jul 2026 is listed**; the national-regulations page is script-rendered and its list could not be read | web pages |
| S6b | FIFA "Bureau of the Council approves new regulatory framework for the global football transfer system" — `inside.fifa.com/transfer-system/news/bureau-council-new-regulatory-framework-global-football-transfer-system-2027` | FIFA | — | 10 Jun 2026 | RSTP in force 1 Jan 2027 | CURRENT; contains **no** agent-regulation content | web page |
| **S7** | **The FA Football Agent Regulations 2026-27** — FA Handbook 2026-27, Rules of The Association **section 17**: `thefa.com/-/media/files/thefaportal/governance-docs/rules-of-the-association/2026-27/section-17---football-agent-regulations.ashx` (24 pp., SHA-256 `3c2aa25b…07bf8`); the same text without the Handbook page furniture at `thefa.com/-/media/files/thefaportal/governance-docs/agents/the-fa-football-agent-regulations-2026-27.ashx` (SHA-256 `b43adf99…1ebb`) | The FA | England | **2026-27** | **"These Regulations came into force on 1 June 2026."** (introduction). Introduction also states: "A number of provisions of these Regulations are temporarily suspended … (see FIFA Circular 1873, dated 30 December 2023). The suspended provisions are shaded in grey. … any provision that is not shaded in grey is effective." | **CURRENT — the active England basis** | PDFs fetched and text-extracted; grey shading is not recoverable from extracted text (L-7); the 2026-27 guidance (S8) is used to infer which provisions are *not* suspended |
| **S8** | **The FA Football Agent Regulations Guidance 2026-27** — `thefa.com/-/media/files/thefaportal/governance-docs/agents/the-fa-football-agent-regulations-guidance-2026-27.ashx` (34 pp., SHA-256 `abc83559…1222`) | The FA | England | 2026-27 | accompanies S7 | **CURRENT**. States: "These guidance notes do not, therefore, cover the suspended provisions but shall be updated in due course should there be any relevant change to the regulatory position." | PDF fetched and text-extracted |
| **S9** | The FA "List of FA Registered Football Agents — 18 September 2026" (linked from `thefa.com/football-rules-governance/policies/player-status---agents/fa-registered-football-agents`; earlier versions 28 Aug, 11 Sep 2026 located) | The FA | England | 18 Sep 2026 | — | CURRENT; page text: "Only individuals registered with The FA as agents are authorised to conduct football agent services on behalf of players, coaches and clubs in England." | page read; list content not read |
| **S9b** | FA "Representation Agreements" page and templates — `thefa.com/football-rules-governance/policies/player-status---agents/representation-agreements`: FA NFAR Standard Player-Coach, Club, Tripartite, Subcontract agreements and Notification of Termination letter (DOCX); Player-Coach template SHA-256 `ee68fae4…9fad` | The FA | England | undated DOCX; page current | — | CURRENT ("intended for use where football agent services are provided to a player registered in England or to a club in relation to a national transaction") | page read; Player-Coach DOCX fetched and text-extracted |
| **S9c** | FA "FA Registered Football Agent — Criminal Record Check Process" — `thefa.com/-/media/files/thefaportal/governance-docs/agents/fa-registered-football-agent---criminal-record-check-process.ashx` (SHA-256 `56ae4d7b…1173`) | The FA | England | undated | — | CURRENT (minors authorisation material; procedure via First Advantage / KnowYourPeople, enhanced DBS) | PDF fetched and text-extracted |
| S9d | FA agent regulations landing page — `thefa.com/football-rules-governance/policies/player-status---agents/fa-football-agent-regulations` | The FA | England | — | — | CURRENT: "The FA Football Agent Regulations have been updated ahead of the 2026/27 season and come into effect from 1st June 2026." Forms linked: AF1 (July 2025 version), AF2, AF-NR, Annual Return, CH1 | web page |
| S10 | U.S. Soccer "Player Agents" — `ussoccer.com/federation-services/soccer-agents` | U.S. Soccer | United States | read 18 Sep 2026 | — | CURRENT (thin) | web page |
| S11 | Secondary (never relied on for a rule; used to locate primary texts and to check whether any FIFA instrument after S3 exists): 14 Sports Law (Aug 2026), Macfarlanes, White & Case, Concurrences, Lagom, Inside World Football (17 Jul 2026), Lewis Silkin, LawInSport, Mondaq | — | — | 2023–2026 | — | contextual only | search results |
| **H1 (historical)** | The FA Football Agent Regulations 2025-26 (Rules of The Association section 19, "6 August 2025"), in force 1 June 2025 – 31 May 2026 | The FA | England | 2025-26 | superseded 1 Jun 2026 | **HISTORICAL — NOT CURRENT**; used only in §3.11 to record what changed | PDF text kept from the first cut |
| **H2 (historical)** | The FA Football Agent Regulations Guidance 2025-26 | The FA | England | 2025-26 | superseded | HISTORICAL — NOT CURRENT | as above |

**Currency labels per source (mandate §3):** S1 `CURRENT` (text) — with
arts. 12(8)–(10), 14, 15, 16(2)(h)(j)(k)(4), 19 and the submission rule
`UNCERTAIN_OPERATIVE_STATUS` (see R-F16) and all other articles
`CURRENT`; S2 `CURRENT` instrument, whose own end-condition is
`UNCERTAIN_OPERATIVE_STATUS`; S3, S4, S6, S6b `CURRENT`; S5 `CURRENT`
page whose content is `HISTORICAL` as to enforcement status (pre-dates
S3 and S2 silent); S7 `CURRENT_WITH_PARTIAL_SUSPENSION` (grey-shaded
limbs); S8, S9, S9b, S9c, S9d `CURRENT`; S10 `CURRENT` (thin); S11
contextual only; H1, H2 `SUPERSEDED` (1 June 2026) and used only as
`HISTORICAL` context in §3.11. Announced but not in force: the FIFA
transfer framework of 1 January 2027 (S6b) — `PENDING_IMPLEMENTATION`,
no agent-regulation content published.

**Not available on 18 September 2026:** any FIFA circular, implementation
notice, General Secretariat decision or FAQ update issued after the CJEU
judgment that lifts, confirms, narrows or replaces the Circular 1873
suspension (S6 news list ends at 16 Jul 2026 for agent items; S4 is silent
on the suspension; S5 was last updated before the judgment). The FIFA
Agent Platform and the licensed-agents directory expose **no documented
public API**. U.S. Soccer's national regulations text was not located.

---

## 2. Verified current rules — FIFA (S1 unless stated)

Format per rule: rule · body · jurisdiction · source · edition · effective
· retrieved 18 Sep 2026 · **status** · architectural consequence · legal
review?

### 2.1 Who is a football agent

- **R-F1 Only a licensed natural person performs Football Agent Services.**
  "Football Agent: a natural person licensed by FIFA to perform Football
  Agent Services" (Definitions). "Only a Football Agent may perform Football
  Agent Services" (art. 11(1)). A licence "is issued to a natural person …
  is strictly personal and non-transferable" (art. 8(1)(a)–(b)). — FIFA ·
  worldwide · S1 · 2025 · in force 1 Jan 2025 · **CURRENTLY OPERATIVE**
  (not among the S2 suspended provisions; S3: the licence requirement "may
  be justified"). · **Consequence:** the licensed identity is a person,
  never an organisation; every regulated action must be attributable to
  that person. · Legal review: NO.
- **R-F2 Agencies are vehicles, not licensees.** "Agency: an organisation,
  entity, firm or private company retaining, comprising, employing or
  otherwise acting as a vehicle for the business affairs of one or more
  Football Agents" (Definitions). "A Football Agent may conduct their
  business affairs through an Agency. Any employees or contractors hired by
  the Agency that are not Football Agents may not perform Football Agent
  Services or make any Approach to a potential Client … A Football Agent
  remains fully responsible for any conduct by their Agency" (art. 11(3)).
  · **CURRENTLY OPERATIVE.** · **Consequence:** an agency organisation
  carries no licence; unlicensed staff have no regulated action; the agent
  is accountable for agency staff. England adds a *licensed-colleague*
  performance route (R-E2b). · Legal review: NO.
- **R-F3 What counts as a regulated service.** "Football Agent Services:
  football-related services performed for or on behalf of a Client,
  including any negotiation, communication relating or preparatory to the
  same, or other related activity, with the purpose, objective and/or
  intention of concluding a Transaction" (Definitions). "Other Services: …
  including but not limited to, providing legal advice, financial planning,
  scouting, consultancy, management of image rights and negotiating
  commercial contracts." · **CURRENTLY OPERATIVE.** · **Consequence:**
  preparatory communication intended to conclude a Transaction is
  regulated; "scouting"/"consultancy" labels do not escape the conflict
  rules where Other Services are attached (R-F13, R-F14). · Legal review:
  YES for edge cases (L-14).
- **R-F4 Approach is defined broadly.** "Approach: (i) any physical,
  in-person contact or contact via any means of electronic communication
  with a Client; (ii) any direct or indirect contact with another person or
  organisation linked to a Client, such as a family member or friend; or
  (iii) any action when a Football Agent uses or directs another person or
  organisation to contact a Client on their behalf" (Definitions). "Only a
  Football Agent may Approach a potential Client" (art. 12(2)). ·
  **CURRENTLY OPERATIVE.** · **Consequence:** an in-app message from an
  agent or agency staff to a player, guardian or family member *is* an
  Approach; the minors gate and the licence gate sit before message send. ·
  Legal review: NO.
- **R-F5 Eligibility is continuous.** Art. 5 eligibility (no listed criminal
  convictions incl. sexual abuse and child trafficking; no suspension ≥ 2
  years; not an official; no Interest in a club, academy or league; no
  betting interest; no unlicensed activity in the prior 24 months; no
  bankruptcy in 5 years) and "at all times after obtaining a licence" (art.
  5(2)(b)). · **CURRENTLY OPERATIVE.** · Legal review: NO.
- **R-F6 CPD is annual and enforced by automatic suspension.** Art. 9(1);
  S5: 20 credits per CPD year (1 Oct–30 Sep); failure → automatic
  provisional suspension. · **CURRENTLY OPERATIVE.** · **Consequence:**
  licence status can change on a calendar boundary; caches must expire. ·
  Legal review: NO.
- **R-F7 Licence states.** Art. 17(1) automatic provisional suspension
  (eligibility, fee, CPD, reporting); withdrawal after 60 days (17(4)(b));
  voluntary suspension/termination (art. 10). · **CURRENTLY OPERATIVE**
  (the reporting limb interacts with the suspended reporting duties,
  R-F25). · **Consequence:** states `active`, `provisionally_suspended`,
  `suspended`, `withdrawn`, `terminated` plus ScoutBox's `unverified` /
  `stale`. · Legal review: NO.

### 2.2 Representation agreements

- **R-F8 Written agreement first.** Art. 12(1); minimum content art. 12(7)
  (names, duration if applicable, service fee, nature of services,
  signatures). · **CURRENTLY OPERATIVE.** · Legal review: NO for the
  fields; YES for enforceability (L-3).
- **R-F9 Maximum term for Individuals: two years** (art. 12(3)); entity
  agreements have no maximum (12(5)); automatic renewal void. ·
  **CURRENTLY OPERATIVE.** · Legal review: NO.
- **R-F10 One agreement per agent–Individual pair; legal-advice notice and
  acknowledgement, again on amendment** (art. 12(4)). · **CURRENTLY
  OPERATIVE.** · Legal review: NO.
- **R-F11 Autonomy clauses void; termination for just cause** incl.
  licence withdrawal/suspension (art. 12(13)–(14)). · **CURRENTLY
  OPERATIVE.** · Legal review: YES (consequences of termination).
- **R-F12 Exclusive-agreement approach window.** Art. 16(1)(b)–(c): no
  Approach to / agreement with a Client bound by an exclusive agreement
  with another agent "except in the final two months". S3: this rule
  "appears, in any event, to be incompatible with the prohibition on
  cartels". Not listed in S2. · **TEXT EXISTS; LEGAL STATUS UNCERTAIN;
  COUNSEL REVIEW REQUIRED** (in the FIFA text and still in the FA 2026-27
  text, R-E10; found incompatible by the CJEU; final ruling with the
  national court). · **Consequence:** never a hard block; manual review
  (DR-33). · Legal review: **YES** (L-2).

### 2.3 Multiple representation and conflicts

- **R-F13 Default: one party per Transaction; one permitted exception.** "A
  Football Agent may only perform Football Agent Services and Other
  Services for one party in a Transaction, subject to the sole exception in
  this article. a) Permitted dual representation: a Football Agent may
  perform Football Agent Services and Other Services for an Individual and
  an Engaging Entity in the same Transaction, provided that prior explicit
  written consent is given by both Clients" (art. 12(8)). · **TEXT EXISTS
  BUT ENFORCEMENT SUSPENDED** (S2: "The prohibition of double
  representation (article 12 paragraphs 8-10)") **+ LEGAL STATUS
  UNCERTAIN** (§11) **+ OPERATIVE IN SPECIFIC JURISDICTION** (England,
  R-E7, with a *broader* permitted set). · **Consequence:** the Conflict
  Engine encodes the text with `ruleStatus` per jurisdiction; FIFA-only
  jurisdictions → `UNDER_LEGAL_REVIEW` → `MANUAL_REGULATORY_REVIEW_REQUIRED`.
  · Legal review: **YES** (L-1).
- **R-F14 Prohibited combinations.** Art. 12(9): "a) a Releasing Entity and
  Individual; or b) a Releasing Entity and Engaging Entity; or c) all
  parties". Same status as R-F13. England's 6.4 is in force (R-E7). ·
  Legal review: YES (L-1).
- **R-F15 Connected agents are one agent for conflict purposes.** Art.
  12(10) and the "Connected Football Agent" definition (same Agency,
  directors/shareholders/co-owners, close family, repeated cooperation or
  revenue sharing). Same status as R-F13 (12(10) is inside the suspended
  range); England's 6.5 and definition are in force (R-E7). ·
  **Consequence:** the engine evaluates the agent **and** connected agents;
  same agency is connected by definition. · Legal review: YES (L-4).
- **R-F16 Suspension status of R-F13–R-F15 (the governing facts).**
  1. S2 (30 Dec 2023): the Bureau of the FIFA Council "approved the
     worldwide temporary suspension of the FFAR rules affected by the
     above-mentioned German court decision, **until the European Court of
     Justice renders a final decision in the pending procedures concerning
     the FFAR**", and "recommend[s] all the member associations to
     temporarily suspend the equivalent provisions … unless they conflict
     with mandatory provisions of the law applicable in their territory."
     Suspended: art. 15(1)–(4), 14(6)(8)(11), 14(2)(10), 14(7)(12),
     **12(8)–(10)**, 16(2)(h)(j)(k)(4), 19, and the submission rule
     (4(2), 16(2)(b), 3(2)(c)(d), 20, 21).
  2. S3 (16 Jul 2026): the CJEU has rendered its decision in C-209/23; the
     licence, fee cap, ban on multiple representation, client-pays and pro
     rata rules "may be justified", subject to the national court's
     assessment; the exclusivity window appears incompatible; GDPR
     precludes publication of sanctions and detailed transaction data.
  3. S4 (16 Jul 2026): FIFA "welcomes" the decision, will "invite agent
     representatives to a meeting in the coming weeks with the aim of
     reaching a consensual solution", and refers to "the new transfer
     system set to enter into force on 1 January 2027". **It does not say
     the suspension is lifted, maintained or modified.**
  4. S5 (last updated 23 Jan 2025): describes dual representation,
     prohibited combinations and fee caps as rules, with no mention of S2.
  5. S7/S8 (The FA, in force 1 Jun 2026, i.e. after S5 and before S3):
     still shade the equivalent FA provisions as suspended "see FIFA
     Circular 1873" and say guidance "shall be updated in due course should
     there be any relevant change to the regulatory position". No FA
     update after 16 Jul 2026 was found.
  6. S6: no FIFA instrument after S3 on agents is listed.
  · **Classification: TEXT EXISTS BUT ENFORCEMENT SUSPENDED (last express
  governing-body instrument) + LEGAL STATUS UNCERTAIN (the instrument's
  own end-condition — a CJEU decision — has occurred, but the pending
  German procedure is not finally decided and FIFA has issued nothing) →
  COUNSEL REVIEW REQUIRED.** ScoutBox does **not** infer that the
  suspension continues merely because S2 remains online, and does **not**
  infer that S3 lifted it. · **Consequence:** `jp-fifa-2025-1` carries
  `ruleStatus: UNDER_LEGAL_REVIEW` for 12(8)–(10), 14, 15, 16(2)(h)(j)(k)(4),
  19; the engine returns `MANUAL_REGULATORY_REVIEW_REQUIRED` wherever those
  rules would decide an outcome and no national `ACTIVE` entry applies. ·
  Legal review: **YES — L-1, the single most consequential open item.**
- **R-F17 Other Services presumption (24 months)** (art. 15(3)); inside the
  suspended art. 15(1)–(4). · **TEXT EXISTS BUT ENFORCEMENT SUSPENDED +
  LEGAL STATUS UNCERTAIN.** · **Consequence:** record Other Services with
  dates; review, never prohibit (DR-34). · Legal review: YES.
- **R-F18 Interests** (arts. 5(1)(a)(v), 11(4), 18(2)(i)). · **CURRENTLY
  OPERATIVE.** · Legal review: YES (verification is impossible for
  ScoutBox; declaration only).
- **R-F19 Disclosure of conflicts** (art. 16(2)(c), 16(3)(c)(i)). ·
  **CURRENTLY OPERATIVE.** · Legal review: NO.

### 2.4 Minors

- **R-F20 Approach timing and guardian consent.** "An Approach (and/or any
  subsequent execution of a Representation Agreement) to a minor or their
  legal guardian … may only be made no more than six months before the
  minor reaches the age where they may sign their first professional
  contract in accordance with the law applicable in the country or
  territory where the minor will be employed. This Approach may only be
  made once prior written consent has been obtained from the minor's legal
  guardian" (art. 13(1)). · **CURRENTLY OPERATIVE** (not in S2); **but its
  parameter (the first-contract age) is COUNSEL REVIEW REQUIRED per
  country**, and England applies its own calendar formula (R-E4,
  JURISDICTION_OVERRIDE). · **Consequence:** `earliestPermittedApproachAt`
  needs a per-jurisdiction parameter; England's rule is never generalised
  into the FIFA/global policy; where the parameter is not encoded the
  result is `INSUFFICIENT_DATA` → refusal. · Legal review: **YES** (L-6).
- **R-F21 Minors accreditation** (art. 13(2); S5 CPD course + assessment,
  valid three years). · **CURRENTLY OPERATIVE.** · Legal review: NO on the
  FIFA fact; YES on national additions.
- **R-F22 Enforceability with minors** (art. 13(3)–(4); no fee unless a
  professional contract, art. 14(9)). · **CURRENTLY OPERATIVE** (14(9) is
  not among the suspended paragraphs). · Legal review: YES (enforceability).
- **R-F23 Undue advantages to family** (art. 16(3)(b)(ii)). · **CURRENTLY
  OPERATIVE.** · Legal review: NO.

### 2.5 Fees

- **R-F24 Fee framework.** Art. 14 (client pays 14(2); USD 200,000
  exception 14(3); invoice basis 14(4); instalments 14(6); pro rata 14(7);
  dual: Engaging Entity up to 50 % 14(10); Clearing House 14(13)); art. 15
  cap (5 %/3 %, 10 %/6 % dual, 10 % releasing). S2 suspends 15(1)–(4),
  14(2)(6)(7)(8)(10)(11)(12)(13). S3: cap, client-pays, pro rata "may be
  justified" (national court). · **TEXT EXISTS BUT ENFORCEMENT SUSPENDED +
  LEGAL STATUS UNCERTAIN**; England: no cap provision, client pays,
  conditional remuneration includable (R-E9, JURISDICTION_OVERRIDE with its
  own partial suspension, L-7). · **Consequence:** no percentage or payer
  rule hard-coded; ledger records terms + `ruleStatus`. · Legal review:
  **YES** (L-5).

### 2.6 Reporting, publication, jurisdiction, transition

- **R-F25 Reporting to the FIFA Platform** (art. 16(2)(j)(k)); S2 suspends
  16(2)(h)(j)(k)(4) and the submission rule. · **TEXT EXISTS BUT
  ENFORCEMENT SUSPENDED + LEGAL STATUS UNCERTAIN.** · **Consequence:** no
  automatic regulatory reporting (L-16); records kept so an agent can
  report. · Legal review: YES.
- **R-F26 Publication is constrained by the GDPR.** Art. 19 suspended (S2);
  S3: GDPR precludes publishing sanctions and detailed transaction data. ·
  **SUSPENDED + (for sanctions/transaction detail) CURRENTLY PRECLUDED by
  EU law per S3.** · **Consequence:** ScoutBox publishes no client lists,
  sanctions or transaction details. · Legal review: YES.
- **R-F27 Scope and national regulations.** Art. 2(1)–(3): FFAR applies to
  agreements "with an international dimension" and international
  transfers; otherwise the national regulations of where the Client is
  registered/domiciled at signing apply; art. 3 requires national
  regulations incorporating arts. 11–21 and permits stricter measures. ·
  **CURRENTLY OPERATIVE.** · **Consequence:** domestic vs international
  jurisdiction must be resolved per transaction (§9 item "domestic vs
  international"). · Legal review: YES for edge cases.
- **R-F28 Clients' duties** (art. 18(1)(c), 18(2)(a)(d)). · **CURRENTLY
  OPERATIVE.** · Legal review: NO.
- **R-F29 FIFA representation agreement template exists** (S6); mandatory
  status unknown. · **COUNSEL REVIEW REQUIRED** (L-12).
- **R-F30 Licensed agents directory** (`agents.fifa.com/directory-agents`;
  script-rendered; no API). · **Consequence:** no live automated FIFA
  verification can be assumed.

---

## 3. Verified current rules — England (S7, S8, S9, S9b, S9c; 2026-27)

Active basis: **The FA Football Agent Regulations 2026-27 (section 17),
in force 1 June 2026, retrieved 18 September 2026**, with the 2026-27
Guidance. The 2025-26 texts (H1, H2) are historical only. Regulation
numbers below are the **2026-27** numbers (the minors section was
renumbered; see §3.11).

Suspension inside the FA text: the FA shades suspended provisions grey
and says the unshaded text is effective; shading is not recoverable from
the extracted text (L-7). The 2026-27 Guidance "do[es] not … cover the
suspended provisions", so a provision the Guidance covers is **inferred
not suspended**; this inference is marked "(G-covered)" and is not a
substitute for the shaded PDF (L-7 stays open).

- **R-E1 Registration (FIFA licence prerequisite).** "Before carrying out
  any conduct or activity that falls within the scope of these Regulations
  …, a Football Agent must first register with The Association to become
  an FA Registered Football Agent" (2.1); "To register with The
  Association, a Football Agent must (i) hold a FIFA Licence; and (ii)
  complete in full and submit … the relevant registration documentation"
  (2.2); S8: "To register as an 'FA Registered Football Agent' an
  individual must first be a FIFA Licensed Football Agent." The FA
  publishes the registered list (2.3; S9, 18 Sep 2026). Registration is
  indefinite subject to suspension/withdrawal (2.5). "Upon an FA Registered
  Football Agent's FIFA Licence being suspended or withdrawn that person's
  registration with The Association shall be automatically and
  immediately suspended or withdrawn" (2.10). Digital ID with name,
  registration number and minors authorisation, presented on request (2.8;
  S8). No registration fee (S8). — The FA · England · S7 · 2026-27 · 1 Jun
  2026 · retrieved 18 Sep 2026 · **CURRENTLY OPERATIVE** (G-covered 2.1,
  2.2, 2.8, 2.9, 2.10). · **Consequence:** England = FIFA licence **plus**
  national registration, two separate verification facets; loss of the
  FIFA licence cascades to the FA registration automatically. · Legal
  review: NO.
- **R-E2 Agency in England; only registered natural persons act.** "Only
  an FA Registered Football Agent may perform Football Agent Services"
  (3.1). "An FA Registered Football Agent may conduct their business
  affairs through an Agency. In such circumstances, the FA Registered
  Football Agent must ensure that any employees, contractors, agents or
  other representatives of the Agency … that are not FA Registered
  Football Agents do not: a) perform Football Agent Services … b) make any
  Approach … or c) enter into a Representation Agreement" (3.3). "An FA
  Registered Football Agent is fully responsible for any conduct by their
  Agency" (3.4). · **CURRENTLY OPERATIVE** (G-covered 3.3, 3.4). · Legal
  review: NO.
- **R-E2b (NEW in 2026-27) Licensed colleague may perform under an
  agency-party agreement with all parties' written consent.** 3.3
  Guidance: "the relevant Representation Agreement must be entered into by
  the FA Registered Football Agent and may, in addition, be entered into
  by their Agency. **Where an Agency is party to a Representation
  Agreement, and provided that all parties to the Representation Agreement
  have provided written consent, any other FA Registered Football Agent
  employed by the Agency may perform Football Agent Services in respect of
  that Representation Agreement.** If the FA Registered Football Agent
  leaves that Agency, the consequences shall be a matter for the Agency,
  the FA Registered Football Agent and their clients to determine …" 4.1:
  an agent may perform services "a) after having entered into a
  Representation Agreement …; or b) if employed by an Agency, after an FA
  Registered Agent who conducts their business affairs through the same
  Agency has entered into a Representation Agreement …, provided that: (i)
  the Agency is also party to the Representation Agreement; and (ii) all
  parties to the Representation Agreement have provided written consent."
  4.1 Guidance: the contracting agent must ensure services are "carried
  out only by FA Registered Football Agents"; S8 (6.2): every performing
  agent must be detailed on the AF1 "including in instances where a
  different Agent from the same Agency is the party to the corresponding
  Representation Agreement." Under H2 (2025-26) the opposite was stated
  ("only the FA Registered Football Agent which enters into the
  Representation Agreement is permitted to conduct Football Agent
  Services"). · **CURRENTLY OPERATIVE — OPERATIVE IN SPECIFIC JURISDICTION
  (England; National Transactions)** (G-covered 3.3, 4.1). · **Consequence
  (architecture change):** the agreement record needs `agencyParty:
  boolean` and a consent kind `agency_performance` (all parties, written,
  in advance); the authorization step "verify representation scope" must
  accept, for an England-governed agreement only, a performing agent who
  is (i) FA-registered and licence-verified, (ii) currently affiliated to
  the same agency, when (iii) the agency is a party and (iv) the
  `agency_performance` consent is in force; every performing agent is
  recorded on the transaction (AF1 duty). Outside England this route is
  `UNKNOWN` → refused (`REPRESENTATION_REQUIRED`). The licensed-person
  principle (R-F1) is untouched: the performer is still a licensed natural
  person, individually verified. · Legal review: **YES** (L-9 updated:
  interplay with FFAR 11(3)/12 for international-dimension agreements;
  which parties' consent — S7 says "all parties to the Representation
  Agreement").
- **R-E3 Representation agreements.** Two-year maximum for players/coaches,
  extension by new agreement only, automatic renewal void (4.3; club
  agreements have no maximum, 4.3 Guidance); one agreement with the same
  player/coach at a time, tripartite exception "at the time of a National
  Transaction" in permitted dual representation (4.4 + Guidance); before
  entering **or amending**, written notice to consider independent legal
  advice and PFA/LMA advice, and written confirmation evidenced in an Annex
  in the prescribed form (4.5 + Guidance; S9b template carries the
  "Statement on independent legal advice" and the Annex "Legal advice
  declaration" with a guardian signature line for a minor); multiple club
  agreements only for different Transactions (4.6); entire agreement with
  all Obligatory Terms of the Standard Representation Agreement plus names,
  duration, fee, nature of services, signatures (4.7; three FA templates;
  an agreement with a player at a non-FA club need not use the Obligatory
  Terms but must meet FFAR 12.7); autonomy clauses void (4.8); just cause
  includes withdrawal/suspension/expiry of minors authorisation (4.9);
  novation recorded in the prescribed form within 14 days (4.10);
  assignment/sub-contracting between registered agents with lodging (4.11;
  S9b Subcontract template); non-compliant terms unenforceable (4.12). ·
  **CURRENTLY OPERATIVE** (G-covered 4.1, 4.2, 4.7, 4.10, 4.11). ·
  **Consequence:** England overlay = Obligatory Terms, PFA/LMA wording,
  Annex, lodging, novation and sub-contract forms; the template
  distinguishes exclusive / non-exclusive by tick-box (non-exclusive by
  default). · Legal review: YES on template use (L-12).
- **R-E4 Minors — timing (exact current England rule, versioned
  `jp-eng-2026-27`).** "An FA Registered Football Agent may not, **before 1
  September in the Academic Year in which the Minor reaches the age of
  16**: a) make an Approach to a Minor or their legal guardian (whether
  directly or indirectly) in relation to any Football Agent Services or
  Other Services; b) make an Approach to a Minor or their legal guardian
  (whether directly or indirectly) in relation to entering into a
  Representation Agreement; or c) enter into any agreement with a Minor or
  their legal guardian (whether a Representation Agreement or an agreement
  other than a Representation Agreement, including but not limited to
  agreements relating to Other Services). Subject to the foregoing, such an
  Approach to or agreement with a Minor may only be made once prior written
  consent has been obtained from the Minor's legal guardian." (5.1). 5.1
  Guidance table, "for the purposes of the years 2025 to 2027": minor
  reaching 16 between 1 Sep 2024–31 Aug 2025 → from 1 Sep 2024; 1 Sep
  2025–31 Aug 2026 → from 1 Sep 2025; **1 Sep 2026–31 Aug 2027 → from 1
  Sep 2026**. "Academic Year" means 1 September to 31 August inclusive;
  "Minor" means a Player or Coach under the age of 18 (Appendix I). S8:
  "An Agent cannot approach a Minor (or their legal guardian) until 1
  September in the Academic Year in which the Minor turns 16 years old."
  Sanction: at minimum a fine and up to two years' registration suspension
  (5.7). — The FA · England · S7 · 2026-27 · 1 Jun 2026 · retrieved 18 Sep
  2026 · **CURRENTLY OPERATIVE — OPERATIVE IN SPECIFIC JURISDICTION**
  (G-covered 5.1). The formula is **unchanged in substance** from 2025-26
  (the two former paragraphs 5.1/5.2 were merged into one 5.1 with limbs
  a–c and the "directly or indirectly" wording added). · **Consequence:**
  England's `earliestPermittedApproachAt = 1 September of the Academic
  Year (1 Sep–31 Aug) in which the minor turns 16`, encoded in
  `jp-eng-2026-27` only; **never generalised into the FIFA/global entry**
  (which keeps the six-months-before-first-contract-age formula with an
  unencoded parameter, R-F20). Guardian prior written consent precedes any
  Approach (limbs a and b) and any agreement (limb c); "indirect" approach
  is covered, so a message routed via the family is an Approach. · Legal
  review: NO on the date; YES on interaction with FFAR 13(1) for
  international-dimension cases (L-6).
- **R-E5 Minors — additional authorisation.** Before an Approach to,
  representation of, or any agreement with a Minor, or representing a club
  in a Transaction involving a Minor, "they must obtain additional
  authorisation to deal with Minors from The Association" (5.2); suitability
  incl. criminal record checks "in the United Kingdom and/or overseas
  (including presentation … of a valid and current FA Registered Football
  Agent DBS check (or equivalent))" (5.3); S8: enhanced criminal record
  check issued within three months prior to submission; a DBS obtained for
  another football role is not accepted (5.3 Guidance); The FA may require
  a minors course under the FA CPD Requirements; valid **three years**
  (5.4); automatic suspension/withdrawal if requirements lapse (5.4); duty
  to self-report (5.5); Legacy Additional Authorisations expire within
  three years (transitional, 13.x). S9c describes the DBS application
  route. · **CURRENTLY OPERATIVE** (G-covered 5.3). · **Consequence:** a
  jurisdiction-scoped `minorsAuthorisation{ma: ENG}` facet with `expiresAt`
  (≤ 3 years), separate from the FIFA minors accreditation; the Digital ID
  shows it. · Legal review: NO.
- **R-E6 Minors — enforceability and fee.** A minor's agreement is
  enforceable only if it meets 4.7, the agent complied with 5.1 and 5.2,
  and "the Representation Agreement is signed by the Minor and their legal
  guardian in such form as may be prescribed" (5.6); no service fee for a
  Minor unless entering a first or subsequent professional contract that
  comes into force (7.10; Guidance: a Scholarship Agreement or PGA Contract
  is not a professional contract; Playing Contracts at 18, or 17 if not in
  full-time education). · **CURRENTLY OPERATIVE** (G-covered 7.10). · Legal
  review: YES (enforceability, L-3).
- **R-E7 Multiple representation in England — verified 2026-27 text, in
  force.** "An FA Registered Football Agent may only perform Football
  Agent Services and Other Services for one party in a National
  Transaction, save that: a) An FA Registered Football Agent may perform
  Football Agent Services and Other Services for more than one party in
  the same National Transaction (**permitted dual or multiple
  representation**), provided that: (i) The FA Registered Football Agent
  obtains all parties' prior written consent to them providing services to
  any other party to the National Transaction … in the form prescribed by
  The Association …; (ii) Once the FA Registered Football Agent and the
  other party(ies) have agreed terms, but prior to them entering into a
  Representation Agreement, the FA Registered Football Agent must inform
  all parties in the form prescribed … of the full particulars of the
  proposed arrangements including, without limitation, the proposed fee
  (if any) to be paid by all parties …; (iii) All parties are given the
  reasonable opportunity to take independent legal advice, meaning that, in
  the case of a Player or Coach, the FA Registered Football Agent must
  inform the Player or Coach in writing that they should consider taking:
  (i) independent legal advice; and (ii) in addition or as an alternative,
  advice from the PFA or LMA …, prior to providing written consent …; and
  (iv) Having been given such opportunity, all parties provide their
  express written consent for the FA Registered Football Agent to enter
  into a Representation Agreement with the other party(ies) on the proposed
  terms in the form prescribed …" (6.3(a)). Without a party's consent the
  agent may continue for the first party only and take no remuneration from
  the others (6.3(b)). "When acting for a Releasing Club, an FA Registered
  Football Agent may not perform Football Agent Services or Other Services
  for any other party (e.g. the Player/Coach and/or the Engaging Club) in
  the same National Transaction" (6.4). "An FA Registered Football Agent
  and a Connected Football Agent may not perform Football Agent Services or
  Other Services for different players, coaches or Clubs in the same
  National Transaction, except in accordance with Regulation 6.3" (6.5).
  Self-representation must be stated in the contract (6.6); no
  conditioning a Transaction on a specific agent (6.7); no concealment of
  roles or sham agreements (6.1). S8 (6.3): "'Dual' or 'Multiple'
  representation (i.e. where the Agent represents either two or more than
  two parties in a transaction respectively) is currently permitted under
  the new FA Agent Regulations, provided that the following safeguards …
  are complied with … Completion and submission of the AF1 Form at the
  completion of a Transaction will constitute written consent to the
  arrangement." Dual fee split: the Engaging Club may pay up to 50 % under
  6.3 (7.11). — The FA · England · S7/S8 · 2026-27 · 1 Jun 2026 · retrieved
  18 Sep 2026 · **CURRENTLY OPERATIVE — OPERATIVE IN SPECIFIC JURISDICTION
  (England, National Transactions)** (G-covered 6.2, 6.3). · **Consequence
  (confirmed):** England's conflict matrix is **genuinely different** from
  the FIFA text: any combination of parties other than one involving a
  Releasing Club is permitted with the four safeguards, including
  individual + engaging + a further individual; the releasing-club
  exclusivity (6.4) and connected-agent attribution (6.5) are in force.
  The engine must carry an England table, not inherit FIFA's
  "individual + engaging only" table (§11 of the conflict engine
  contract). For a Transaction with an international dimension, FFAR's
  status governs and is uncertain → review. · Legal review: YES (L-1
  interplay; L-4).
- **R-E8 Disclosure, lodging and forms.** Agents Form (AF1, "July 2025
  version" per S9d) at completion of every Transaction incl. self-
  represented ones (6.2, 6.6); lodge within 14 days of execution,
  amendment or termination (or by registration of the Transaction) every
  Representation Agreement, other agreements, fee payments, cooperation
  arrangements, eligibility-affecting information and settlements (8.3(g));
  disclose within 14 days any contractual or customary arrangement with a
  player, coach, club or club official, **or within 14 days of registering
  where it pre-dates registration** (8.5, new limb b); conflict-of-interest
  disclosure form within 14 days (8.6); notify FIFA-licence suspension
  within 14 days (8.3(d)); Annual Return of all payments (8.5; Annual Return
  form). **New in 2026-27:** agents must keep electronic communications and
  telephone records relating to Football Agent Services, retained "for no
  less than 6 years", must not use disappearing-message functions, and
  must not alter or destroy them (8.7); must notify HMRC settlement
  agreements within 14 days (8.8); must not loan or gift money to a club or
  club official (8.4(f)); must not engage a non-registered person in
  Football Agent Services (8.4(g), with a carve-out for a minor's
  non-registered parent/guardian); clubs must ensure agents acting in
  club-official-type roles (recruitment, scouting, analysis) comply (9.6).
  · **CURRENTLY OPERATIVE** (G-covered 8.3, 8.4, 8.5, 8.6, 9.5, 9.6);
  reporting limbs that mirror suspended FFAR 16(2)(h)(j)(k) may be shaded
  (L-7). · **Consequence:** ScoutBox keeps records so agents can lodge;
  it does not file (L-16); the six-year retention duty is a data-retention
  input for L-11; the Transaction record names every performing agent. ·
  Legal review: YES (which limbs are shaded).
- **R-E9 Fees in England.** Reg. 7 contains **no percentage cap provision**
  (the only "percentage" in the text is the prohibition on fees linked to a
  future registration event, 7.8); client pays (7.2) with the USD 200,000
  exception under which the Engaging Club may pay on the player's behalf
  subject to conditions (7.3, G-covered); fee calculated on Remuneration
  incl. conditional elements, not varying with performance events (7.4,
  G-covered; S8: conditional remuneration may be included); invoice basis
  (7.5); pro rata for longer contracts (7.7); no fee for minors (7.10,
  G-covered); dual 50 % (7.11); Clearing House (7.13, **not G-covered —
  likely shaded**); proof of payment to The FA **within 14 days** (7.14,
  G-covered; was 7 days / "as directed" in 2025-26). · **PARTIALLY
  SUSPENDED / COUNSEL REVIEW REQUIRED for the shaded limbs** (L-7); the
  G-covered limbs are **CURRENTLY OPERATIVE**. · **Consequence:** ledger
  records terms and `ruleStatus`; no validation. · Legal review: **YES**
  (L-5, L-7).
- **R-E10 Exclusive-agreement approach window in England.** 8.1(b)–(c) and
  8.2 (no Approach/agreement with a client bound by another agent's
  exclusive agreement "except in the final two months"; a new agreement
  signed in that window commences only on expiry); mirrored for clients at
  9.x. Present in the 2026-27 text; not G-covered under 8.1; after S3 its
  legal status is doubtful. · **TEXT EXISTS; LEGAL STATUS UNCERTAIN;
  COUNSEL REVIEW REQUIRED** (L-2). · **Consequence:** manual review, never
  a hard block (DR-33).
- **R-E11 National vs international scope.** Scope 1.1: the FA regulations
  govern conduct connected to a National Transaction, agreements with
  Clubs, agreements with players/coaches "save where that Representation
  Agreement solely governs Football Agent Services related to a Specified
  International Transaction", approaches, and minors approaches;
  "National Transaction" = employment/unemployment/registration/transfer
  of a player or coach with a Club (Appendix I); "Specified International
  Transaction" = a transfer to a club not affiliated to The FA or not in an
  FA-authorised competition. · **CURRENTLY OPERATIVE** (G-covered 1.1). ·
  **Consequence:** the jurisdiction resolver must classify each
  Transaction as England-national (FA set governs) or international
  dimension (FFAR governs, status uncertain) before choosing a conflict
  table (§9, "domestic vs international"). · Legal review: YES for mixed
  cases.

### 3.11 What changed from 2025-26 to 2026-27 (H1 → S7), for the record

| Area | 2025-26 (historical) | 2026-27 (current) | Architectural effect |
|---|---|---|---|
| Handbook section | 19 | 17 | citation only |
| In force | 1 Jun 2025 | 1 Jun 2026 | policy version `jp-eng-2026-27` |
| Agency-party agreements | only the contracting agent may perform services (H2) | any FA Registered agent employed by the agency may perform, if the agency is a party and all parties consent in writing (3.3 Guidance, 4.1(b)) | **new consent kind, new scope rule (R-E2b)** |
| Minors timing | 5.1 (Approach) + 5.2 (agreement), same date | merged 5.1 (a)–(c), "directly or indirectly"; date unchanged | numbering; `jp-eng-2026-27` records the same formula |
| Minors authorisation etc. | 5.3–5.8 | 5.2–5.7 | numbering |
| Proof of fee payment | 7 days / as directed | 14 days (7.14) | ledger note only |
| Agent prohibitions | — | 8.4(f) loans/gifts to clubs; 8.4(g) engaging non-registered persons | compliance checklist |
| Record keeping | — | 8.7: keep messages and call records ≥ 6 years; no disappearing messages | retention input (L-11) |
| Tax settlements | — | 8.8: notify HMRC settlements within 14 days | compliance checklist |
| Disclosure timing | 14 days of arrangement | + 14 days of registration for pre-existing arrangements (8.5(b)) | compliance checklist |
| Clubs | 9.6 club officials and manager | + agents acting in club-official-type roles (recruitment, scouting, analysis) | club-side integration note |
| Dual/multiple representation (6.3–6.5) | as now | **unchanged** | none |
| Fee regime (7.x) | as now | unchanged apart from 7.14 | none |
| Exclusivity window (8.1(b)–(c)) | as now | unchanged | none |

---

## 4. Verified current rules — United States (S10)

- **R-U1 FIFA licence required; FFAR enforced from 1 January 2024.** S10
  (retrieved 18 Sep 2026): "Effective January 1, 2024, U.S. Soccer enforces
  the new FIFA Football Agent Regulations (FFAR), which require that any
  individual acting as a Football Agent within U.S. Soccer's jurisdiction
  be licensed by FIFA." · **CURRENTLY OPERATIVE** (licence). · Legal
  review: NO.
- **R-U2 Background check and SafeSport training** required for all agents
  operating in the United States; U.S. Soccer may deny, suspend or revoke
  permission. · **CURRENTLY OPERATIVE** as stated; scope **COUNSEL REVIEW
  REQUIRED**. · Legal review: YES.
- **R-U3 Not found.** No U.S. Soccer national regulations text, no minors
  approach date, no first-professional-contract age. · **UNKNOWN →
  COUNSEL REVIEW REQUIRED — blocking for any U.S. minors pathway** (L-8).

---

## 5. The mandate's hypotheses (§6 A–I) against the current sources

| # | Hypothesis | Verified? | Source | Status / note |
|---|---|---|---|---|
| A | Only a FIFA-licensed natural person may perform regulated services | **YES** | FFAR Def., 8(1), 11(1); FA 2.2, 3.1 | CURRENTLY OPERATIVE everywhere read |
| B | Written representation agreement before services | **YES** | 12(1), 12(7); FA 4.1 | England 2026-27 adds the agency-party colleague route (R-E2b) |
| C | Maximum duration for player/coach agreements | **YES — two years** | 12(3); FA 4.3 | entity agreements none |
| D | One agreement between the same agent and Individual at a time | **YES** | 12(4); FA 4.4 | England tripartite exception at Transaction time |
| E | Independent-legal-advice notice and acknowledgement | **YES** | 12(4)(a)–(b); FA 4.5 + Annex | required again on amendment |
| F | Single-party representation is the general rule | **YES as FFAR text; TEXT EXISTS BUT ENFORCEMENT SUSPENDED by S2; LEGAL STATUS UNCERTAIN after S3; CURRENTLY OPERATIVE in England (6.3, 2026-27)** | 12(8); S2; S3; S4; FA 6.3 | **conflict recorded** — the hypothesis is wrong if read as "currently enforced by FIFA worldwide" |
| G | Dual representation narrowly limited to individual + engaging entity with advance written consent | **YES for the FFAR text (suspended/uncertain); NO for England — dual *or multiple*, any combination not involving the releasing club, with four safeguards (6.3(a), 2026-27)** | 12(8)(a); FA 6.3 | **conflict recorded**; England has its own matrix |
| H | Releasing-entity combinations prohibited | **YES** | 12(9) (suspended/uncertain); FA 6.4 (in force) | |
| I | Minors: timing, guardian consent, accreditation | **YES** | 13(1)–(3), 14(9); FA 5.1–5.7 (2026-27) | formulas differ; England's is a calendar rule; not generalised |

---

## 6. Product policy (ScoutBox's choices; not law)

- **P-1** ScoutBox is infrastructure. It never holds a licence, never
  performs or offers Football Agent Services, never negotiates, and never
  chooses an agent for anyone.
- **P-2** Regulated actions are attributable to one licensed natural person
  with an active, verified licence at the moment of the action. No shared
  agency login, no proxy. (England's R-E2b route still names one licensed
  performer per act.)
- **P-3** Verification ≠ authorization ≠ client confirmation. Stricter than
  the regulations, by choice.
- **P-4** "Agencies never see minors" stays for discovery, search, scouting
  and analytics. The only minor pathway is the guardian-authorised
  representation pathway, gated by jurisdiction timing, guardian consent,
  the agent's minors accreditation/authorisation, and national permission,
  each failing closed; **no production minor pathway outside a
  jurisdiction whose rules have been encoded from primary sources and
  legally reviewed** (today: none enabled; England encodable).
- **P-5** No fee percentage, payer rule or cap is hard-coded; ScoutBox
  processes no money.
- **P-6** No publication of client lists, sanctions or transaction details;
  neutral directory; no paid ranking.
- **P-7** Where the operative status of a rule is uncertain, or applicable
  policies conflict, the engine returns `MANUAL_REGULATORY_REVIEW_REQUIRED`;
  ScoutBox does not silently choose the stricter or the looser reading. A
  national `ACTIVE` rule is applied in its territory; where a national rule
  is stricter than an `ACTIVE` FIFA rule, the stricter applies.
- **P-8** No bulk solicitation; no import equals representation; prospect ≠
  client.

## 7. Architectural recommendations

- **A-1** Versioned jurisdiction policy layer keyed by `{ regulator,
  jurisdiction (memberAssociation), effectiveFrom, effectiveTo,
  policyVersion }` with per-rule `ruleStatus ∈ ACTIVE | SUSPENDED |
  PARTIALLY_SUSPENDED | JURISDICTION_OVERRIDE | UNDER_LEGAL_REVIEW |
  UNKNOWN`, `sourceRef` (source id, version/season, effective date,
  retrieved date) and `params`. Initial versions: `jp-fifa-2025-1`
  (FFAR 2025 text + S2 + S3 statuses), `jp-eng-2026-27-1` (S7/S8),
  `jp-usa-2024-1` (S10, mostly `UNKNOWN`).
- **A-2** Fail-honest licence/registration/accreditation verification with
  `recheckAt`; no register integration pretended.
- **A-3** Conflict Engine with per-jurisdiction tables (FIFA text table;
  England 2026-27 table), connected-agent attribution, and
  `MANUAL_REGULATORY_REVIEW_REQUIRED` for any `UNDER_LEGAL_REVIEW` /
  `UNKNOWN` deciding rule.
- **A-4** Minors gate: `earliestPermittedApproachAt` from the applicable
  policy entry only; England calendar rule in `jp-eng`; FIFA formula with
  unencoded parameter → `INSUFFICIENT_DATA`; guardian consent ledger;
  jurisdiction-scoped accreditation facets.
- **A-5** Append-only regulatory records with policy versions and
  `ruleStatus` at evaluation time preserved.
- **A-6 (new)** Agreement records carry `agencyParty` and, for England,
  the `agency_performance` consent; the scope check has an England-only
  colleague route (R-E2b); performing agents are recorded per act.

## 8. Legal-review items (register)

| ID | Item | Why | Blocking for P5.6B build? | Blocking for P5.6C? |
|---|---|---|---|---|
| L-1 | **Current operative status** of FFAR 12(8)–(10), 14, 15, 16(2)(h)(j)(k)(4), 19: Circular 1873 says "until the ECJ renders a final decision"; the ECJ has; FIFA has issued nothing; the German procedure continues | §11 | NO | **YES** — FIFA-only outcome tables stay `UNDER_LEGAL_REVIEW` until counsel/FIFA say otherwise |
| L-2 | Exclusive-agreement window (FFAR 16(1)(b)–(c); FA 8.1(b)–(c), 8.2) | S3 | NO | YES — manual review only |
| L-3 | Enforceability of recorded/templated agreements, e-signature sufficiency, minors' agreements | mandate | NO | NO |
| L-4 | Same-agency Chinese walls vs Connected Football Agent (FFAR 12(10); FA 6.5 + definition) | | NO | YES — connected by default |
| L-5 | Fee rules per jurisdiction | R-F24, R-E9 | NO | NO (ledger), YES before validation |
| L-6 | Non-England minors timing parameter; which country's law when employment undecided | R-F20 | NO | **YES for any non-England minors pathway** |
| L-7 | Exact set of shaded (suspended) FA 2026-27 provisions; the G-covered inference is not proof | S7 intro | NO | YES for England fee/reporting encoding |
| L-8 | U.S. national regulations text, minors timing, scope of background check/SafeSport | R-U3 | NO | **YES for any U.S. pathway** |
| L-9 | Agency as party and the 2026-27 colleague-performance route (R-E2b): which parties' consent, form, interaction with FFAR 11(3)/12 for international-dimension agreements, effect of the contracting agent leaving | R-E2b | NO (model it; England-only; consent-gated) | YES before enabling the route in production |
| L-10 | Assignment / sub-contracting / novation across jurisdictions | FA 4.10–4.11 | NO | NO (not built) |
| L-11 | Erasure vs retention (GDPR; FA 8.7 six-year retention; FIFA duties) | FA 8.7 | NO | NO |
| L-12 | Generating FA/FIFA forms or templates | R-E8, R-F29 | NO | NO |
| L-13 | Competition-law posture of the directory and subscription pricing | | NO | NO |
| L-14 | "Preparatory communication" boundary | R-F3 | NO | YES for boundary cases |
| L-15 | Employment-law / tax consequences of recorded terms | | NO | NO |
| L-16 | Automatic regulatory reporting (FIFA Platform; FA lodging; AF1) | | NO (not built) | NO (not built) |
| L-17 (new) | Electronic signature / electronic lodging sufficiency for FA "form prescribed by The Association" consents and Annexes | R-E3, R-E7 | NO (record externally executed evidence) | NO |
| L-18 (new) | Domestic vs international jurisdiction resolution for mixed transactions (FA scope 1.1; FFAR 2(1)–(3)) | R-E11, R-F27 | NO | YES for the resolver's default |

## 9. Regulatory uncertainty register (§190, updated; tags per mandate §18)

Tags: `KNOWN` (settled from a current primary source), `UNCERTAIN`
(sources conflict or are silent), `COUNSEL_REQUIRED`, `BLOCKS_BUILD`
(architecture/contract cannot be finished without it), `BLOCKS_PRODUCTION_ONLY`
(may be built behind a disabled route/flag; may not be enabled in
production until resolved).

| # | Issue | Tags | What is known | What is uncertain | Jurisdiction | Engine posture |
|---|---|---|---|---|---|---|
| U-1 | **Current FIFA double/multiple-representation enforcement status** (12(8)–(10)) | `UNCERTAIN`, `COUNSEL_REQUIRED`, `BLOCKS_PRODUCTION_ONLY` (FIFA-only conflict outcomes) | Text current (S1); suspended by S2 "until the ECJ renders a final decision"; ECJ decided 16 Jul 2026 (S3); FIFA statement silent (S4); no later instrument (S6); FA 2026-27 still shades equivalents | Whether the suspension ended by its own terms, continues pending the German court, or is replaced by the 2027 framework | FIFA / MAs relying on S2 | `UNDER_LEGAL_REVIEW` → manual review |
| U-2 | **Relationship between the current FIFA FAQ and Circular 1873** | `UNCERTAIN`, `COUNSEL_REQUIRED` | FAQ (23 Jan 2025) describes 12(8)–(9), 14, 15 as rules without mentioning S2; S2 suspends them | Which document FIFA regards as operative guidance | FIFA | §11: neither is treated as proof; review |
| U-3 | **Impact / implementation status after the July 2026 CJEU judgment** | `UNCERTAIN`, `COUNSEL_REQUIRED`, `BLOCKS_PRODUCTION_ONLY` | Judgment content (S3); FIFA "welcomes", will consult agents, 2027 system (S4); no implementation notice found | Timetable, scope, and whether any article "resumed" | FIFA | `UNDER_LEGAL_REVIEW`; a notice becomes a new `jp-fifa` version |
| U-4 | **Current England multiple-representation rules** | `KNOWN` | FA 2026-27 6.3–6.5 + Guidance, in force 1 Jun 2026, G-covered; AF1 = written consent; 7.11 50 % | None on content | England (National Transactions) | `ACTIVE` (`jp-eng-2026-27-1`) |
| U-5 | **FIFA vs England conflict matrix** | `KNOWN` (difference), `COUNSEL_REQUIRED` (interplay for international-dimension cases, L-1/L-18) | England permits dual **or multiple** (any set without the releasing club) with four safeguards; FIFA text permits individual + engaging only | Which table governs a transaction with both an English national element and an international dimension | England + FIFA | separate tables; `JURISDICTION_OVERRIDE` in national scope; mixed → review |
| U-6 | **Non-England minor timing** | `UNCERTAIN`, `COUNSEL_REQUIRED`, `BLOCKS_PRODUCTION_ONLY` (any non-England minors pathway) | FIFA 13(1) formula with a per-country first-contract-age parameter; England's calendar rule encoded separately | The parameter per country; which country when employment is undecided; U.S. rules | all MAs except England | `UNKNOWN` param → `INSUFFICIENT_DATA` → refused |
| U-7 | **Domestic vs international jurisdiction** | `KNOWN` (definitions), `UNCERTAIN` (mixed cases), `COUNSEL_REQUIRED` (L-18) | FA scope 1.1, "National Transaction", "Specified International Transaction"; FFAR 2(1)–(3) | Foreign client + English club; loans; FA-affiliated parties in Specified International Transactions | England + FIFA | resolver: `national` / `international` / `unknown`; `unknown` → `INSUFFICIENT_DATA`; mixed → review |
| U-8 | **Connected-agent attribution** | `KNOWN` (England, FA 6.5 + definition, ACTIVE), `UNCERTAIN` (FIFA 12(10), U-1) | Same agency, ownership, family, repeated cooperation/revenue sharing are "connected" | FIFA enforcement status | all | attributed by default |
| U-9 | **Same-agency conflicts / information barriers** | `UNCERTAIN`, `COUNSEL_REQUIRED` (L-4, L-9) | No FA or FIFA text recognises an information barrier as curing connectedness; FA 2026-27 R-E2b lets colleagues perform under one agreement with consent | Whether any wall can cure; how R-E2b interacts with 6.5 when colleagues serve different parties | all | connected by default; R-E2b England-only, consent-gated, disabled pending L-9 |
| U-10 | **Fee caps** | `UNCERTAIN` (FIFA 15, U-1), `KNOWN` (England: no cap provision in reg. 7) | as stated | FIFA reinstatement | FIFA + England | recorded, never validated |
| U-11 | **Client-pays** | `UNCERTAIN` (FIFA 14(2)), `KNOWN` (England 7.2–7.3 ACTIVE, G-covered) | as stated | FIFA status | FIFA + England | recorded |
| U-12 | **Payment timing / pro rata / instalments** | `UNCERTAIN` (FIFA 14(6)(7)(12)), `KNOWN` (England 7.4–7.7, 7.14 14-day proof, G-covered) | as stated | FIFA status; which FA limbs are shaded (L-7) | FIFA + England | recorded |
| U-13 | **Clearing-house rules** | `UNCERTAIN` (FIFA 14(13); FA 7.13 not G-covered, likely shaded) | text exists in both | operative status | FIFA + England | recorded; no payment channel built |
| U-14 | **Electronic-signature sufficiency** | `UNCERTAIN`, `COUNSEL_REQUIRED` (L-17, L-3) | FA prescribes forms/Annexes; FIFA requires written agreements; ScoutBox has no e-signature | Whether in-app confirmations satisfy "written" / "in the form prescribed" | England + FIFA | client confirmation is ScoutBox's own access root; externally executed evidence recorded |
| U-15 | **Regulatory filing / submission sufficiency** | `UNCERTAIN`, `COUNSEL_REQUIRED` (L-12, L-16) | FA lodging (8.3(g)), AF1, CH1, Annual Return; FIFA Platform (suspended limbs) | Whether ScoutBox may generate or lodge anything | England + FIFA | never files; keeps records |
| U-16 | Exclusive-agreement window | `UNCERTAIN`, `COUNSEL_REQUIRED` (L-2) | S3 doubt; text remains in FFAR 16(1)(b)–(c) and FA 8.1(b)–(c), 8.2 | final national ruling; FIFA/FA response | FIFA + England | `UNDER_LEGAL_REVIEW`; never block |
| U-17 | Publication (19) | `KNOWN` (GDPR limit per S3), `UNCERTAIN` (what FIFA publishes) | as stated | | FIFA | ScoutBox publishes nothing |
| U-18 | U.S. national rules | `UNCERTAIN`, `COUNSEL_REQUIRED`, `BLOCKS_PRODUCTION_ONLY` (any U.S. pathway) | licence; background check; SafeSport | regulations text; minors | United States | `UNKNOWN` |
| U-19 | FIFA template mandatory? | `UNCERTAIN`, `COUNSEL_REQUIRED` (L-12) | template exists | mandatory anywhere? | FIFA | not offered |

Nothing in this register is `BLOCKS_BUILD` for P5.6B: the architecture
and contracts are complete with these items represented as statuses.
Items tagged `BLOCKS_PRODUCTION_ONLY` gate the enabling of specific
routes in P5.6C/D, not the build.

## 12. Minors — per-jurisdiction current rules (mandate §12; never derived across jurisdictions)

| Field | FIFA (FFAR 2025, `jp-fifa-2025-1`) | England (FA 2026-27, `jp-eng-2026-27-1`) | United States (`jp-usa-2024-1`) |
|---|---|---|---|
| Earliest lawful approach timing | "no more than six months before the minor reaches the age where they may sign their first professional contract in accordance with the law applicable in the country or territory where the minor will be employed" (13(1)) — **ACTIVE rule, parameter UNKNOWN per country** | not before **1 September in the Academic Year (1 Sep–31 Aug) in which the Minor reaches 16** (5.1(a)–(c); guidance table 2025–2027) — **ACTIVE** | **UNKNOWN** (no primary text found) |
| How first-professional-contract age is determined | by the employing country's law (13(1)); not encoded for any country | not used: England applies a calendar rule; FA Rule C: Playing Contracts at 18, or 17 if not in full-time education (7.10 Guidance context) | UNKNOWN |
| Guardian-consent requirement | "prior written consent … from the minor's legal guardian" (13(1)) | "prior written consent … from the Minor's legal guardian" (5.1) | UNKNOWN |
| Must consent precede the approach? | YES ("This Approach may only be made once prior written consent has been obtained") | YES (applies to Approaches direct or indirect and to any agreement; 5.1) | UNKNOWN |
| Agent accreditation / CPD / minors authorisation | designated CPD course on minors + assessment, accreditation valid three years (13(2); S5) | additional authorisation to deal with Minors: suitability incl. enhanced DBS (within three months of submission), possible minors course, valid three years, automatic suspension on lapse, self-report (5.2–5.5); Digital ID shows it | background check + SafeSport training required for all agents (S10); minors-specific rules UNKNOWN |
| National registration requirement | via the applicable MA's national regulations (3, 13(2)) | FA registration on a FIFA licence (2.1–2.2); loss of FIFA licence cascades (2.10) | FIFA licence enforced by U.S. Soccer; permission may be denied/suspended/revoked (S10) |
| Required agreement form | written; signed by the minor and legal guardian "as provided by the law applicable" (13(3)); FIFA template exists (mandatory status unknown) | Standard Representation Agreement Obligatory Terms + Annex; signed by the Minor **and** legal guardian in the prescribed form (5.6; S9b template has both lines) | UNKNOWN |
| Additional domestic safeguards | no fee unless first/subsequent professional contract (14(9)); sanction ≥ fine + up to two years' suspension (13(4)) | no fee unless a professional contract comes into force; Scholarship/PGA is not one (7.10); sanction ≥ fine + up to two years' registration suspension (5.7); non-registered parent/guardian carve-out (8.4(g)); club duties (9.x) | UNKNOWN |
| Production pathway status in ScoutBox | **none** (parameter unencoded → `INSUFFICIENT_DATA`) | **encodable; not implemented; not enabled** (architecture only) | **none** |

## 10. Future jurisdiction overlays (framework only)

Unchanged in substance: each MA overlay is a policy set of the same shape
with `ruleStatus` per rule and `sourceRef` per entry; until encoded from
primary sources and reviewed, every rule is `UNKNOWN` →
`MANUAL_REGULATORY_REVIEW_REQUIRED`, and no minors pathway is enabled.
None was researched in P5.6A.

## 11. Reconciling the FIFA FAQ with Circular 1873 (the tension, stated)

**The tension.** S5 (FIFA FAQ, last updated 23 Jan 2025) describes as
rules: dual representation of an individual and an engaging entity with
advance written consent (the engaging entity may pay up to 50 %); the
prohibition of releasing entity + individual, releasing entity + engaging
entity, and all parties; the fee caps; client pays. S2 (Circular 1873, 30
Dec 2023) ordered the worldwide temporary suspension of exactly those
provisions (12(8)–(10), 14, 15) "until the European Court of Justice
renders a final decision in the pending procedures". S5 never mentions S2.
S3 (16 Jul 2026) is the ECJ's decision in one of those procedures, but it
refers the proportionality assessment back to the national court, so "the
pending procedures" are not finished. S4 (FIFA, same day) does not say
whether the suspension continues. The FA's 2026-27 text (in force 1 Jun
2026) still shades its equivalents as suspended by reference to S2.
Secondary commentary in August 2026 (S11) reads the suspension as
continuing; that is opinion, not an instrument.

**What ScoutBox concludes.** (a) The FFAR text is current (S1). (b) The
last express FIFA instrument on enforcement is S2, and it has not been
withdrawn. (c) S2's own end-condition may or may not have occurred; FIFA
has not said. (d) Therefore the **current operative status of FFAR
12(8)–(10), 14, 15, 16(2)(h)(j)(k)(4) and 19 is not conclusively
established** on 18 September 2026. (e) England's equivalents in 6.3–6.5
and reg. 7 (unshaded limbs) are operative in England by the FA's own
current text, independent of (d).

**What ScoutBox does architecturally while (d) holds.** The FIFA policy
entry carries `ruleStatus: UNDER_LEGAL_REVIEW` for those articles with
`sourceRef` = {S1, S2, S3, S4, S5} and a note quoting the tension. The
Conflict Engine, for any transaction where one of those FIFA rules would
decide the outcome and no national `ACTIVE` entry applies, returns
`MANUAL_REGULATORY_REVIEW_REQUIRED` with reason `RULE_STATUS_UNCERTAIN`
and the rule ids. It does **not** return `CLEAR` (which would assume the
suspension continues and the rule is unenforced) and does **not** return
`PROHIBITED_CONFLICT` (which would assume the rule is back in force).
Transactions inside England's national scope use `jp-eng-2026-27`, where
6.3–6.5 are `ACTIVE`, and are evaluated normally. A FIFA circular, FAQ
update or General Secretariat notice that settles the question becomes a
new `jp-fifa` version published under dual control with counsel review
(C7); nothing changes by code.
