# M23 P5.6A — Agent Regulatory Snapshot

Snapshot date: **18 September 2026**. Every rule below was read from the
governing body's own text on that date, from the sources listed in §1. The
four categories the mandate demands are kept apart throughout:

- **VERIFIED CURRENT RULE** — quoted or closely paraphrased from a primary
  source, with article number, edition and date.
- **PRODUCT POLICY** — what ScoutBox chooses to do, which may be stricter
  than the rule and is not a statement of law.
- **ARCHITECTURAL RECOMMENDATION** — how the software should be shaped so
  the rule and the policy can be enforced and re-versioned.
- **LEGAL-REVIEW ITEM** — anything ScoutBox must not decide alone.

Nothing in this document is legal advice, and no ScoutBox review replaces
specialist sports-law counsel (§5 of the mandate). Where this snapshot found
a conflict with the mandate's hypotheses (§6 A–I), the source wins and the
conflict is recorded in §4.

---

## 1. Sources read

| # | Source | Body | Jurisdiction | Edition / date | How obtained |
|---|---|---|---|---|---|
| S1 | FIFA Football Agent Regulations (FFAR) — `digitalhub.fifa.com/m/1e7b741fa0fae779/original/FIFA-Football-Agent-Regulations.pdf` | FIFA | worldwide (international dimension) | Approved by the FIFA Council 10 December 2024, **in force 1 January 2025** (art. 28); PDF metadata "FFAR 2024 Cover V2", 2024-12-11 | PDF fetched and text-extracted locally (39 pages) |
| S2 | FIFA Circular no. 1873 "FIFA Football Agent Regulations: update on implementation" — `digitalhub.fifa.com/m/76b4cdc63e42e03f/original/1873_FIFA-Football-Agent-Regulations-update-on-implementation.pdf` | FIFA | worldwide | 30 December 2023 | PDF fetched and text-extracted |
| S3 | Court of Justice of the EU, Press Release No 110/26, Judgment in Case C-209/23 *RRC Sports* — `curia.europa.eu/site/upload/docs/application/pdf/2026-07/cp260110en.pdf` | CJEU (via Regional Court, Mainz) | EU law; effect on FFAR worldwide via FIFA's own suspension | **16 July 2026** | PDF fetched and text-extracted; the full judgment text was not read (press release only) |
| S4 | FIFA news "FIFA welcomes Court of Justice of the European Union decision on FIFA Football Agent Regulations" — `inside.fifa.com/news/welcomes-court-of-justice-european-union-decision-football-agent-regulations` | FIFA | — | 16 July 2026 | web page |
| S5 | FIFA "FAQ & How to contact us" (agents) — `inside.fifa.com/transfer-system/agents/faq-agents` | FIFA | — | page states last updated 23 January 2025 | web page |
| S6 | FIFA agents hub — `inside.fifa.com/legal/football-regulatory/agents` (links: how to become licensed, education, Agents Chamber, national regulations, general secretariat decisions, representation agreement template, licensed agents directory `agents.fifa.com/directory-agents`) | FIFA | — | read 18 Sep 2026 | web page (directory page is script-rendered; its fields could not be read) |
| S7 | The FA Football Agent Regulations 2025-26 (Rules of The Association, Section 19, "6 August 2025") — `thefa.com/-/media/files/thefaportal/governance-docs/rules-of-the-association/2025-26/section-19---the-football-agent-regulations---6-august-2025.ashx` | The FA | England | **in force 1 June 2025**; suspended provisions "shaded in grey" | PDF fetched and text-extracted (shading is not visible in extracted text — see L-7) |
| S8 | The FA Football Agent Regulations Guidance 2025-26 — `thefa.com/-/media/files/thefaportal/governance-docs/agents/2025-26-forms/the-fa-football-agent-regulations-guidance-2025-26.ashx` | The FA | England | 2025-26 | PDF fetched and text-extracted |
| S9 | The FA "List of FA Registered Football Agents as of 22 May 2026" — `thefa.com/-/media/files/thefaportal/governance-docs/agents/2025-26-forms/list-of-fa-registered-football-agents-22nd-may-26.ashx` | The FA | England | 22 May 2026 | located by search; existence verified, content not read |
| S10 | U.S. Soccer "Player Agents" — `ussoccer.com/federation-services/soccer-agents` | U.S. Soccer Federation | United States | read 18 Sep 2026 (exam dates for 2026 listed) | web page |
| S11 | Secondary (not relied on for any rule, used only to locate primary texts): Lewis Silkin, LawInSport, Clifford Chance, Brick Court, Ashurst, 14 Sports Law, EU Law Live, Mondaq | — | — | 2023–2026 | search results |

**Not available:** no FIFA circular lifting or amending the Circular 1873
suspension after the CJEU judgment was found on 18 September 2026 (S4 says
only that FIFA will consult agent representatives and that a new transfer
system enters into force on 1 January 2027). The FIFA "general secretariat
decisions" page (S6) states "last updated 3 September 2025" and its list
could not be read. The FIFA Agent Platform and the licensed-agents
directory expose **no documented public API**. U.S. Soccer's own national
regulations document was not located; only S10 was read.

---

## 2. Verified current rules — FIFA (S1 unless stated)

Format per rule: rule · body · jurisdiction · source · edition · effective
· architectural consequence · legal review?

### 2.1 Who is a football agent

- **R-F1 Only a licensed natural person performs Football Agent Services.**
  "Football Agent: a natural person licensed by FIFA to perform Football
  Agent Services" (Definitions). "Only a Football Agent may perform Football
  Agent Services" (art. 11(1)). A licence "is issued to a natural person …
  is strictly personal and non-transferable" (art. 8(1)(a)–(b)). — FIFA ·
  worldwide · S1 · 2025 · in force 1 Jan 2025 · **Consequence:** the licensed
  identity is a person, never an organisation; every regulated action must
  be attributable to that person. · Legal review: NO (unambiguous).
- **R-F2 Agencies are vehicles, not licensees.** "Agency: an organisation,
  entity, firm or private company retaining, comprising, employing or
  otherwise acting as a vehicle for the business affairs of one or more
  Football Agents" (Definitions). "A Football Agent may conduct their
  business affairs through an Agency. Any employees or contractors hired by
  the Agency that are not Football Agents may not perform Football Agent
  Services or make any Approach to a potential Client … A Football Agent
  remains fully responsible for any conduct by their Agency" (art. 11(3)).
  · **Consequence:** an agency organisation carries no licence; unlicensed
  staff have no regulated action; the agent is accountable for agency
  staff — which ScoutBox must make visible in audit. · Legal review: NO.
- **R-F3 What counts as a regulated service.** "Football Agent Services:
  football-related services performed for or on behalf of a Client,
  including any negotiation, communication relating or preparatory to the
  same, or other related activity, with the purpose, objective and/or
  intention of concluding a Transaction" (Definitions). "Other Services:
  … including but not limited to, providing legal advice, financial
  planning, scouting, consultancy, management of image rights and
  negotiating commercial contracts." · **Consequence:** the action
  classification (§73 of the mandate) must treat *preparatory
  communication intended to conclude a Transaction* as regulated, and must
  not let "scouting"/"consultancy" labels escape the conflict rules where
  the regulations attach Other Services to them (see R-F13, R-F14). ·
  Legal review: YES for edge cases (what is "preparatory").
- **R-F4 Approach is defined broadly.** "Approach: (i) any physical,
  in-person contact or contact via any means of electronic communication
  with a Client; (ii) any direct or indirect contact with another person or
  organisation linked to a Client, such as a family member or friend; or
  (iii) any action when a Football Agent uses or directs another person or
  organisation to contact a Client on their behalf" (Definitions). "Only a
  Football Agent may Approach a potential Client" (art. 12(2)). ·
  **Consequence:** an in-app message from an agent or agency staff to a
  player, guardian or family member *is* an Approach; the minors gate and
  the licence gate sit in front of message send, not after. · Legal
  review: NO.
- **R-F5 Eligibility is continuous.** Art. 5 lists eligibility (no listed
  criminal convictions incl. sexual abuse and child trafficking; no
  suspension ≥ 2 years by a regulator; not an official of a club, league,
  association; no Interest in a club, academy or league; no betting
  interest; no unlicensed activity in the prior 24 months; no bankruptcy in
  5 years) and "An applicant must satisfy the eligibility requirements … at
  all times after obtaining a licence" (art. 5(2)(b)). · **Consequence:**
  licence status is not a one-time fact; see R-F7. · Legal review: NO.
- **R-F6 CPD is annual and enforced by automatic suspension.** "To maintain
  their licence, a Football Agent shall comply with the CPD requirements on
  an annual basis" (art. 9(1)); FIFA FAQ (S5): "A football agent must earn a
  minimum of 20 credits per CPD calendar year", "A CPD calendar year runs
  from 1 October to 30 September", "If a football agent fails to meet the
  CPD Requirements, their licence will automatically be provisionally
  suspended." · **Consequence:** licence status can change on a calendar
  boundary without any transaction; caches must expire (see §6). · Legal
  review: NO.
- **R-F7 Licence states.** "If a Football Agent fails to: a) meet the
  eligibility requirements at any time; b) pay the annual licence fee … c)
  comply with the CPD requirements … or d) comply with their reporting
  obligations; their licence shall automatically be provisionally
  suspended" (art. 17(1)); withdrawal after 60 days without rectification
  (art. 17(4)(b)); voluntary temporary suspension or termination (art. 10).
  · **Consequence:** the identity model must carry at least `active`,
  `provisionally_suspended`, `suspended`, `withdrawn`, `terminated`,
  plus ScoutBox's own `unverified`/`stale` states; a withdrawn licence
  requires a full new application (art. 10(2)). · Legal review: NO.

### 2.2 Representation agreements

- **R-F8 Written agreement first.** "A Football Agent may only perform
  Football Agent Services for a Client after having entered into a written
  Representation Agreement with that Client" (art. 12(1)). Minimum content:
  "a) The names of the parties b) The duration (if applicable) c) The
  amount of the service fee … d) The nature of the Football Agent Services
  … e) The parties' signatures" (art. 12(7)). · **Consequence:** no
  regulated action without a recorded agreement; the five minimum fields
  are the objective validation set. · Legal review: NO for the fields; YES
  for enforceability of any given agreement.
- **R-F9 Maximum term for Individuals: two years.** "A Representation
  Agreement concluded between an Individual and a Football Agent may not
  exceed two years. This term may be extended by a new Representation
  Agreement only. Any automatic renewal provision … shall be null and void"
  (art. 12(3)). Entity agreements have no maximum (art. 12(5)). · Legal
  review: NO.
- **R-F10 One agreement per agent–Individual pair at a time; legal-advice
  notice.** "A Football Agent may only execute one Representation Agreement
  with the same Individual at any one time. Before entering into … or
  before amending … the Football Agent shall: a) inform the Individual in
  writing that they should consider taking independent legal advice … and
  b) obtain the Individual's written confirmation that they have either
  obtained or decided not to take such independent legal advice" (art.
  12(4)). · **Consequence:** overlap check per (agent, individual);
  legal-advice notice and acknowledgement are two dated facts on the
  agreement record, required again on amendment. · Legal review: NO.
- **R-F11 Autonomy clauses void; termination for just cause.** Clauses
  limiting or penalising an Individual's autonomous negotiation are void
  (art. 12(13)). Either party may terminate for just cause, which includes
  "the withdrawal or suspension of a Football Agent licence" (art. 12(14)).
  · **Consequence:** the agreement record must not be architected as
  "exclusive control"; termination with a reason is a first-class event. ·
  Legal review: YES (consequences of termination without just cause).
- **R-F12 The exclusive-agreement approach window is now legally
  doubtful.** Art. 16(1)(b)–(c): an agent may "not Approach a Client that
  is bound by an exclusive Representation Agreement with another Football
  Agent, except in the final two months". S3 (CJEU, 16 July 2026): "The
  rule prohibiting agents from approaching or concluding representation
  agreements with a client who is already bound by an exclusive
  representation agreement outside of a two-month window preceding the
  expiry of the contract appears, in any event, to be incompatible with the
  prohibition on cartels." · **Consequence:** ScoutBox must NOT encode the
  two-month window as a hard block; at most as a versioned, jurisdiction-
  scoped policy flag defaulting to *manual review*. · Legal review: **YES**.

### 2.3 Multiple representation and conflicts

- **R-F13 Default: one party per Transaction; one permitted exception.** "A
  Football Agent may only perform Football Agent Services and Other
  Services for one party in a Transaction, subject to the sole exception in
  this article. a) Permitted dual representation: a Football Agent may
  perform Football Agent Services and Other Services for an Individual and
  an Engaging Entity in the same Transaction, provided that prior explicit
  written consent is given by both Clients" (art. 12(8)). · **Consequence:**
  the Conflict Engine's baseline. · Legal review: YES as to enforceability
  in the EU (see R-F16), NO as to content.
- **R-F14 Prohibited combinations.** "A Football Agent may, in particular,
  not perform Football Agent Services or Other Services in the same
  Transaction for: a) a Releasing Entity and Individual; or b) a Releasing
  Entity and Engaging Entity; or c) all parties within the same
  Transaction" (art. 12(9)). Note the words *and Other Services*: relabelling
  the work as consultancy or scouting does not lift the prohibition. ·
  Legal review: same as R-F13.
- **R-F15 Connected agents are one agent for conflict purposes.** "A
  Football Agent and a Connected Football Agent may not perform Football
  Agent Services or Other Services for different Clients in the same
  Transaction, except in accordance with paragraph 8" (art. 12(10)).
  "Connected Football Agent" covers the same Agency (employment, directors,
  shareholders, co-owners), close family, and repeated cooperation or
  revenue sharing (Definitions). · **Consequence:** the engine must
  evaluate the agent **and their connected agents** — same agency is
  connected by definition, so an internal "Chinese wall" does not cure a
  same-agency conflict under the FIFA text (see L-4). · Legal review: YES.
- **R-F16 Suspension status of R-F13–R-F15.** Circular 1873 (S2, 30 Dec
  2023) lists among the provisions temporarily suspended worldwide "The
  prohibition of double representation (article 12 paragraphs 8-10)",
  "until the European Court of Justice renders a final decision in the
  pending procedures concerning the FFAR", and "recommend[s] all the member
  associations to temporarily suspend the equivalent provisions". The CJEU
  delivered its judgment on 16 July 2026 (S3): "it is ultimately for the
  court before which the dispute was brought to assess whether the
  contested FIFA rules are contrary to the prohibition on cartels or whether
  they may be considered to be justified"; limits on multiple representation
  are obstacles to the freedom to provide services whose justification is
  for the national court. No FIFA instrument lifting the suspension was
  found by 18 September 2026 (S4 announces consultation only). ·
  **Consequence:** the Conflict Engine must be **policy-versioned** with a
  `suspended` flag per rule and per jurisdiction; England's own rule (R-E7)
  is in force regardless. · Legal review: **YES — status changes with the
  Mainz court and any FIFA circular.**
- **R-F17 Other Services presumption (24 months).** "Where a Football Agent
  or a Connected Football Agent, in the 24 months prior to or following a
  Transaction, performs Other Services for a Client involved in that
  Transaction, it shall be presumed that the Other Services formed part of
  the Football Agent Services" (art. 15(3)); listed as suspended with art.
  15(1)–(4) by S2. · **Consequence:** record Other Services engagements with
  dates so the presumption can be evaluated when in force. · Legal review:
  YES.
- **R-F18 Interests.** Clients, ineligible persons and holders of
  registration rights (RSTP 18bis/18ter) "may not have an Interest in any
  affairs of a Football Agent or their Agency" (art. 11(4)); applicants may
  "not hold, either personally or through their Agency, any Interest in a
  club, academy, league or Single-Entity League" (art. 5(1)(a)(v)); clients
  may not "Permit a Football Agent or their Agency to have an Interest in
  them" (art. 18(2)(i)). "Interest" includes beneficial ownership and any
  position of material influence (Definitions). · **Consequence:** an
  *interest declaration* record with a placeholder in the engine; ScoutBox
  cannot verify ownership and must say so. · Legal review: YES.
- **R-F19 Disclosure of conflicts is an obligation.** Agents must "avoid
  conflicts of interest" (art. 16(2)(c)) and may not conceal "a conflict of
  interest (even if such conflict would otherwise be permitted)" (art.
  16(3)(c)(i)). · Legal review: NO.

### 2.4 Minors

- **R-F20 Approach timing and guardian consent.** "An Approach (and/or any
  subsequent execution of a Representation Agreement) to a minor or their
  legal guardian in relation to any Football Agent Services may only be made
  no more than six months before the minor reaches the age where they may
  sign their first professional contract in accordance with the law
  applicable in the country or territory where the minor will be employed.
  This Approach may only be made once prior written consent has been
  obtained from the minor's legal guardian" (art. 13(1)). · **Consequence:**
  `earliestPermittedApproachAt` is derived from a jurisdiction-specific
  first-professional-contract age, never from a universal constant; prior
  written guardian consent is a precondition of the *first* contact. ·
  Legal review: **YES** (the applicable age per country; which country's
  law when the employing territory is not yet known).
- **R-F21 Minors accreditation.** "A Football Agent that wishes to represent
  a minor or represent a club in a Transaction involving a minor shall first
  successfully complete the designated CPD course on minors and comply with
  any requirement to represent a minor established by the law applicable in
  the country or territory of the member association where the minor will
  be employed" (art. 13(2)); FAQ (S5): the agent "must then pass an
  assessment … to gain the relevant accreditation". · **Consequence:** a
  per-agent `minorsAccreditation` fact with provenance and date; national
  overlays add their own (R-E4, R-U2). · Legal review: NO on the FIFA fact;
  YES on national additions.
- **R-F22 Enforceability with minors.** A minor's Representation Agreement
  is enforceable only if it meets art. 12(7), the agent complied with art.
  13(1)–(2), and it "is signed by the minor and their legal guardian as
  provided by the law applicable" (art. 13(3)). Violations of art. 13(1):
  "at a minimum, … a fine and a suspension of a Football Agent licence of up
  to two years" (art. 13(4)). "A Football Agent may not receive a service
  fee when engaged to perform Football Agent Services relating to a minor
  unless the relevant player is signing their first or subsequent
  professional contract" (art. 14(9)). · Legal review: YES (enforceability).
- **R-F23 Undue advantages to family.** Agents may not "Offer or pay any
  undue personal, pecuniary or other advantage … to an Individual (or any
  family member or legal guardian or friend of that Individual) in relation
  to a Representation Agreement" (art. 16(3)(b)(ii)). · Legal review: NO.

### 2.5 Fees

- **R-F24 Fee framework and its suspension.** Art. 14: client pays (14(2)),
  exception when the Individual's annual Remuneration is below USD 200,000
  (14(3)), invoice basis (14(4)), fee only under an agreement in force at the
  time of the services (14(5)), instalments (14(6)), pro rata (14(7)), dual
  representation: the Engaging Entity may pay up to 50 % (14(10)), Clearing
  House (14(13)). Art. 15 cap: 5 %/3 % for Individual or Engaging Entity,
  10 %/6 % for permitted dual, 10 % of transfer compensation for a Releasing
  Entity. **S2 suspends worldwide:** "the service fee cap (article 15
  paragraphs 1-4)", "the rules concerning service fee payments (article 14
  paragraphs 6, 8 and 11)", "the client pays rule (article 14 paragraphs 2
  and 10)", "the rules regarding the timing of service fee payments
  (article 14 paragraphs 7 and 12)", "the rule that service fee payments
  must be made via the FIFA Clearing House (article 14 paragraph 13)". S3:
  the cap and the client-pays and pro-rata rules are for the national court
  to assess; FIFA (S4) says the court "confirmed that key FFAR elements can
  be justified". · **Consequence:** ScoutBox must not hard-code any
  percentage or payer rule; a fee ledger records what was agreed and the
  policy version in force; England applies no cap (R-E9). · Legal review:
  **YES, and jurisdiction by jurisdiction.**

### 2.6 Reporting, publication, jurisdiction, transition

- **R-F25 Reporting to the FIFA Platform.** Within 14 days: representation
  agreements and their amendment/termination, other-services agreements,
  fee payments, cooperation/revenue-sharing arrangements between agents,
  eligibility-affecting information, settlements (art. 16(2)(j)); Agency
  ownership, agent count and employee names within 14 days of the first
  Transaction involving the Agency (art. 16(2)(k)). S2 suspends "the
  reporting obligations (article 16 paragraphs 2 h), j), k) and 4)" and
  "the submission rule (article 4 paragraph 2; article 16 paragraph 2 b);
  article 3 paragraphs 2 c) and d); article 20; and article 21)". ·
  **Consequence:** ScoutBox may *help* an agent keep these records; it must
  not claim to file them and must not build automatic regulatory reporting
  (mandate §5). · Legal review: YES.
- **R-F26 Publication is constrained by the GDPR.** Art. 19 (FIFA shall
  make available agents' names, clients, exclusivity, expiry, services,
  sanctions, transactions and fee amounts) is suspended by S2; S3: "the
  GDPR precludes the disclosure and publication, by a federation such as
  FIFA, of any sanction imposed on agents or their clients and of detailed
  information on all transactions involving agents." · **Consequence:**
  ScoutBox must not publish agents' client lists, sanctions or transaction
  details; the neutral agent directory (mandate §44) may show only what the
  agent chooses and what a public regulator list shows. · Legal review:
  YES.
- **R-F27 Scope and national regulations.** FFAR applies to Representation
  Agreements "with an international dimension" and conduct connected to an
  international transfer (art. 2(1)–(2)); otherwise "the national football
  agent regulations of where the Client is registered or domiciled at the
  time the Representation Agreement is signed shall apply" (art. 2(3)).
  National regulations "shall incorporate articles 11 to 21 … by reference"
  and "may introduce … stricter measures" (art. 3(2)–(3)). Recognition of
  national-law licensing systems (art. 24). Disputes with an international
  dimension go to the Agents Chamber of the Football Tribunal (art. 20). ·
  **Consequence:** at least two policy sets can apply to one Transaction
  (FIFA + one or more national); a domestic/international flag must be
  preserved. · Legal review: YES for edge cases.
- **R-F28 Clients' duties.** Clients "shall satisfy themselves that a
  Football Agent is appropriately licensed by FIFA prior to signing" (art.
  18(1)(c)); clubs may not "interfere in, or influence, the freedom of an
  Individual to select a Football Agent" (art. 18(2)(d)) nor engage an
  unlicensed person (art. 18(2)(a)). · **Consequence:** ScoutBox must never
  steer a player toward an agent on a club's or its own account (mandate
  §43, §45, §97). · Legal review: NO.
- **R-F29 FIFA representation agreement template exists** (S6 lists "FIFA
  Representation Agreement template"); its mandatory-use status could not be
  read from the page. · Legal review: YES before any template is offered.
- **R-F30 Licensed agents directory.** S6 links "Licensed Agents Directory"
  at `agents.fifa.com/directory-agents`; the page is script-rendered and
  its fields, search parameters and data currency could not be read; no API
  is documented anywhere read. · **Consequence:** no live automated FIFA
  verification can be assumed (mandate §148); see §6.

---

## 3. Verified current rules — England (S7, S8, S9)

- **R-E1 Registration.** "Before carrying out any conduct or activity that
  falls within the scope of these Regulations …, a Football Agent must first
  register with The Association to become an FA Registered Football Agent"
  (reg. 2.1); "To register …, a Football Agent must (i) hold a FIFA Licence;
  and (ii) complete … the relevant registration documentation" (reg. 2.2);
  The FA "shall publish such FA Registered Football Agent's name" (reg.
  2.3) — S9 is that list (22 May 2026). Registration is indefinite (2.5) and
  "Upon an FA Registered Football Agent's FIFA Licence being suspended or
  withdrawn that person's registration with The Association shall be
  automatically and immediately suspended or withdrawn" (2.10). A Digital
  ID showing name, registration number and minors authorisation must be
  presented on request (2.8; S8). · **Consequence:** England = FIFA licence
  **plus** national registration; the two have separate states. · Legal
  review: NO.
- **R-E2 Agency in England.** Reg. 3.3 mirrors FFAR 11(3). S8: "Only a
  natural person 'FA Registered Football Agent' can perform football agent
  services under a representation agreement … The Agent's Agency can in
  addition also be a party to the representation agreement but cannot
  perform football agent services"; under the previous Intermediaries
  Regulations an agency company could register and contract alone — "This
  is not permitted under the current FA Agent Regulations." Novation to
  another agent is recorded on a CH1 form within 14 days (reg. 4.10; S8).
  Assignment or sub-contracting between two FA Registered Football Agents
  is permitted with lodging (reg. 4.11). · **Consequence:** the individual
  agent is always a party; the agency may be an additional party; change of
  agent is a recorded novation, not an edit. · Legal review: YES (the
  legal party question, mandate §122).
- **R-E3 Representation agreements.** Two-year maximum for players/coaches
  (4.3); one agreement with the same player/coach at a time, with a
  tripartite exception at the time of a National Transaction (4.4 +
  guidance); legal-advice notice must also offer PFA/LMA advice and be
  evidenced in an annex (4.5); Obligatory Terms of the Standard
  Representation Agreement are mandatory (4.7); three FA templates exist
  (player/coach–agent, club–agent, tripartite); autonomy clauses void
  (4.8); just cause includes withdrawal/suspension/expiry of the FA minors
  authorisation (4.9(c)); agreements must be lodged with The FA within 14
  days or by registration of the Transaction (8.3(g)). · **Consequence:**
  an England overlay adds Obligatory Terms, PFA/LMA wording, lodging
  deadlines, novation forms. · Legal review: YES (template use).
- **R-E4 Minors — timing.** "An Approach to a Minor or their legal guardian
  … shall not be made before 1 September in the Academic Year in which the
  Minor reaches the age of 16. Subject to the foregoing, such an Approach
  … may only be made once prior written consent has been obtained from the
  Minor's legal guardian" (5.1); the same for entering any agreement (5.2);
  "Academic Year" means 1 September to 31 August (definitions); "Minor"
  means a Player or Coach under the age of 18 (definitions). Guidance table
  2025–2027: a minor turning 16 between 1 Sep 2025 and 31 Aug 2026 may be
  approached from 1 Sep 2025. · **Consequence:** England's
  `earliestPermittedApproachAt` = 1 September of the academic year of the
  16th birthday — a date rule, not an age-in-months rule; it differs from
  the FIFA six-month formulation and must be its own policy entry. · Legal
  review: NO on the date; YES on interaction with FIFA 13(1) for
  international cases.
- **R-E5 Minors — additional authorisation.** Before approaching,
  representing, or entering any agreement with a Minor, or representing a
  club in a Transaction involving a Minor, the agent "must obtain additional
  authorisation to deal with Minors from The Association" (5.3), including
  a criminal record check "(including … a valid and current FA Registered
  Football Agent DBS check (or equivalent))" (5.4); S8: an enhanced check
  issued within the prior three months; FIFA's minors requirement must also
  be met; "FA authorisation to work with Minors is valid for three years"
  (5.5, S8); automatic suspension if requirements lapse (5.5), duty to
  self-report (5.6). · **Consequence:** a jurisdiction-scoped
  `minorsAuthorisation` fact with an expiry, separate from the FIFA minors
  accreditation. · Legal review: NO.
- **R-E6 Minors — enforceability and sanction.** Agreement enforceable
  only if signed by the Minor and the legal guardian in the FA's prescribed
  form (5.7); violation of 5.1/5.2 sanctioned by at least a fine and up to
  two years' registration suspension (5.8). No fee for minors unless a
  professional contract (7.10). · Legal review: YES (enforceability).
- **R-E7 Multiple representation in England (in force).** "An FA Registered
  Football Agent may only perform Football Agent Services and Other
  Services for one party in a National Transaction, save that: a) … for
  more than one party in the same National Transaction (permitted dual or
  multiple representation), provided that: (i) … all parties' prior written
  consent … (ii) … inform all parties … of the full particulars of the
  proposed arrangements including … the proposed fee … (iii) All parties are
  given the reasonable opportunity to take independent legal advice … (iv)
  … all parties provide their express written consent" (6.3(a)); without a
  party's consent the agent may continue for the first party only (6.3(b)).
  "When acting for a Releasing Club, an FA Registered Football Agent may not
  perform Football Agent Services or Other Services for any other party"
  (6.4). Connected agents (6.5). No conditioning a Transaction on a specific
  agent (6.7). S8: "Completion and submission of the AF1 Form at the
  completion of a Transaction will constitute written consent to the
  arrangement." · **Consequence:** England is *broader* than FIFA (multiple
  representation, not only individual + engaging) but keeps the releasing-
  club prohibition; the engine needs per-jurisdiction outcome tables. ·
  Legal review: YES (interplay with the suspended FIFA rule for
  international transactions).
- **R-E8 Lodging and forms.** Representation agreements with players/coaches
  lodged within 14 days (8.3(g)(i)); Agents Form (AF1) at completion of every
  Transaction, including self-represented ones (6.2, 6.6; S8). · Legal
  review: NO (facts), YES (whether ScoutBox may generate forms).
- **R-E9 Fees in England.** Reg. 7 has **no service fee cap provision** in the
  2025-26 text; client pays (7.2) with the USD 200,000 exception (7.3);
  invoice basis (7.5); conditional payments (bonuses) may be included in
  the fee base in England (S8: "An Agent representing a Player or Coach can
  now receive a percentage of a Player/Coach's conditional remuneration") —
  a difference from FFAR 15(2)(a); Clearing House (7.13). The introduction
  states "A number of provisions of these Regulations are temporarily
  suspended … shaded in grey" and the shading is not recoverable from the
  extracted text (see L-7). Secondary sources (S11) report a 30 November
  2023 FA arbitration award that the cap and pro-rata rules would breach
  the Competition Act 1998; not read at first hand. · Legal review:
  **YES.**
- **R-E10 Exclusive-agreement approach window in England.** Present at reg.
  8 (lines mirroring FFAR 16(1)(b)–(c)); after S3 its status is doubtful. ·
  Legal review: YES.

---

## 4. Verified current rules — United States (S10)

- **R-U1 FIFA licence required; FFAR enforced from 1 January 2024.** S10:
  "Effective January 1, 2024, U.S. Soccer enforces the new FIFA Football
  Agent Regulations (FFAR), which require that any individual acting as a
  Football Agent within U.S. Soccer's jurisdiction be licensed by FIFA."
  · Legal review: NO.
- **R-U2 Background check and SafeSport training.** S10: "U.S. Soccer
  requires all agents operating within the United States to undergo a
  criminal background check and complete the U.S. Center for SafeSport's
  Training … especially critical for agents who represent minors"; U.S.
  Soccer "reserves the right to deny, suspend, or revoke an agent's
  permission to operate". · **Consequence:** a U.S. overlay carries two
  facts (background check, SafeSport training) with dates and a U.S. Soccer
  permission state. · Legal review: YES (whether these are conditions
  precedent to every action or only to minors work; the page does not say).
- **R-U3 Not found.** A U.S. Soccer national football-agent regulations
  text, a U.S. minors approach date, and the "age at which a minor may sign
  a first professional contract" for the United States (which depends on
  league rules and state law on minors' contracts) were not located. ·
  Legal review: **YES — blocking for any U.S. minors pathway.**

---

## 5. The mandate's hypotheses (§6 A–I) against the sources

| # | Hypothesis | Verified? | Source | Note |
|---|---|---|---|---|
| A | Only a FIFA-licensed natural person may perform regulated services | **YES** | FFAR Def., art. 8(1), 11(1) | exact |
| B | Written representation agreement before services | **YES** | art. 12(1), 12(7) | exact |
| C | Maximum duration for player/coach agreements | **YES — two years** | art. 12(3); FA 4.3 | entity agreements have none (12(5)) |
| D | Only one agreement between the same agent and Individual at a time | **YES** | art. 12(4); FA 4.4 | England allows a tripartite agreement at Transaction time alongside it |
| E | Independent-legal-advice notice and acknowledgement | **YES** | art. 12(4)(a)–(b); FA 4.5 adds PFA/LMA | required again on amendment |
| F | Single-party representation is the general rule | **YES as written; SUSPENDED by FIFA since 30 Dec 2023; national court to assess after 16 Jul 2026; IN FORCE in England (6.3)** | art. 12(8); S2; S3; FA 6.3 | the prompt's assumption is right about the text and wrong if read as "currently enforced by FIFA worldwide" — **conflict recorded** |
| G | Dual representation narrowly limited to individual + engaging entity with advance written consent | **YES for FIFA (12(8)(a)); England is broader — dual *or multiple* with all parties' consent (6.3(a))** | art. 12(8)(a); FA 6.3 | **conflict recorded**: not "narrow" everywhere |
| H | Releasing-entity combinations prohibited | **YES** — releasing + individual, releasing + engaging, all parties (12(9)); England: releasing club may act for no other party (6.4) | art. 12(9); FA 6.4 | FIFA text suspended per S2; England in force |
| I | Minors: timing, guardian consent, accreditation | **YES** | art. 13(1)–(3), 14(9); FA 5.1–5.7 | timing formula differs: FIFA "six months before first-professional-contract age per employing country"; England "1 September of the academic year of the 16th birthday" |

Additional facts the mandate did not hypothesise and the sources establish:
Connected Football Agents (R-F15); the 24-month Other Services presumption
(R-F17); the CJEU's doubt about the exclusive-agreement approach window
(R-F12); the GDPR limit on publication (R-F26); England's national
registration, DBS-backed minors authorisation with three-year validity,
Obligatory Terms and lodging (R-E1–R-E8); England's absence of a fee cap and
inclusion of conditional remuneration (R-E9); U.S. background check and
SafeSport training (R-U2).

---

## 6. Product policy (ScoutBox's choices; not law)

- **P-1** ScoutBox is infrastructure. It never holds a licence, never
  performs or offers Football Agent Services, never negotiates, and never
  chooses an agent for anyone. Copy, roles and pricing are audited against
  this (mandate §1, §43, §97).
- **P-2** Regulated actions are attributable to one licensed natural person
  with an active, verified licence at the moment of the action. No shared
  agency login, no "submit as Agent X" proxy (mandate §10, §76).
- **P-3** Verification ≠ authorization ≠ client confirmation. A verified
  licence grants nothing about a specific player; a recorded agreement grants
  nothing until the client (or guardian) has confirmed it in ScoutBox
  (mandate §12, §145). Stricter than the regulations, by choice.
- **P-4** "Agencies never see minors" stays for discovery, search, scouting
  and analytics. The only minor pathway is the guardian-authorised
  representation pathway, gated by jurisdiction timing, guardian consent,
  the agent's minors accreditation/authorisation, and national permission,
  each failing closed (mandate §46–§53).
- **P-5** No fee percentage, payer rule or cap is hard-coded. The fee ledger
  records agreed terms and the policy version; ScoutBox processes no money
  (mandate §93–§96).
- **P-6** No publication of client lists, sanctions or transaction details
  by ScoutBox (R-F26). The neutral directory shows regulator-published facts
  (FIFA directory entry, FA registered list entry) and the agent's own
  chosen profile only; no paid ranking (mandate §44–§45).
- **P-7** Where a FIFA rule is suspended and a national rule is in force,
  the stricter applicable rule is applied to that jurisdiction's
  transactions, and any conflict between applicable policies yields
  `MANUAL_REGULATORY_REVIEW_REQUIRED` (mandate §126).
- **P-8** No bulk solicitation feature; no import equals representation;
  prospect ≠ client (mandate §82, §143, §144).

## 7. Architectural recommendations (derived; detailed in the sibling documents)

- **A-1** A versioned jurisdiction policy layer keyed by
  `{ regulator, memberAssociation, effectiveFrom, effectiveTo, policyVersion }`
  carrying per-rule `state ∈ in_force | suspended | doubtful | not_encoded`,
  so Circular 1873, the CJEU judgment and future circulars are data, not
  code (`M23_P56A_AGENT_AUTHORIZATION_CONTRACT.md` §3).
- **A-2** A licence/accreditation verification abstraction with fail-honest
  states (`verified`, `verification_pending`, `verification_stale`,
  `manual_review_required`, `unverifiable`) and `recheckAt`, because no
  FIFA or FA API exists (R-F30, §148 of the mandate).
- **A-3** A Conflict Engine evaluating the licensed individual **and
  connected agents** per Transaction, returning the five mandated outcomes
  with reasons and policy version (`M23_P56A_CONFLICT_ENGINE_CONTRACT.md`).
- **A-4** Minors gate computing `earliestPermittedApproachAt` from the
  applicable policy set (FIFA formula needs the employing country's
  first-professional-contract age; England's is a calendar rule), requiring
  prior guardian consent recorded server-side before any Approach, and the
  agent's minors accreditation plus national authorisation.
- **A-5** Append-only regulatory records (agreements, consents, evaluations)
  with the policy version preserved on each.

## 8. Legal-review items (register)

| ID | Item | Why | Blocking for P5.6B build? | Blocking for P5.6C? |
|---|---|---|---|---|
| L-1 | Status of FFAR art. 12(8)–(10), 14, 15, 16(2)(h)(j)(k)(4), 19 after the CJEU judgment; whether/when FIFA lifts Circular 1873 | S2 + S3 + S4 leave it to the Mainz court and FIFA | NO (identity, agreements, clients do not depend on it) | **YES** for the engine's default outcome tables outside England |
| L-2 | The exclusive-agreement two-month approach window (FFAR 16(1)(b)–(c); FA equivalent) | CJEU: "appears … incompatible with the prohibition on cartels" | NO | YES — must default to manual review, never a hard block |
| L-3 | Enforceability of representation agreements recorded or templated in ScoutBox, electronic-signature sufficiency, minors' agreements | mandate §5, §22, §65 | NO (record externally signed evidence only) | NO |
| L-4 | Same-agency "Chinese walls": FFAR treats same-agency agents as Connected (12(10)); England 6.5 likewise | mandate §102 | NO | YES — engine must treat same agency as connected unless counsel says otherwise |
| L-5 | Fee rules per jurisdiction (cap, client pays, conditional remuneration in England, Clearing House) | R-F24, R-E9 | NO (ledger only) | NO (ledger only), YES before any fee validation |
| L-6 | Which country's law fixes the minor's first-professional-contract age when the employing territory is unknown at approach time (FFAR 13(1)) | R-F20 | NO | **YES for any non-England minors pathway** |
| L-7 | Exact set of suspended FA provisions (grey shading not recoverable from the PDF text) | R-E9 | NO | YES for England fee/reporting encoding |
| L-8 | U.S. national regulations text, U.S. minors timing, whether background check/SafeSport are preconditions for all actions | R-U3 | NO | **YES for any U.S. pathway** |
| L-9 | Legal party to the agreement: individual, agency, or both (England allows the agency as an additional party) | R-E2, mandate §122 | NO (model both, individual mandatory) | NO |
| L-10 | Co-agents / assignment / sub-contracting (FA 4.11) and novation (FA 4.10) across jurisdictions | mandate §123 | NO | NO (not built until verified) |
| L-11 | Right to erasure vs regulatory retention of agreements/consents (GDPR; FIFA 14-day and multi-year record duties) | mandate §157 | NO | NO |
| L-12 | Whether ScoutBox may generate FA/FIFA forms or templates (AF1, CH1, Standard Representation Agreement) | R-E8, R-F29 | NO | NO |
| L-13 | Competition-law posture of a neutral agent directory and of subscription pricing for agents | mandate §44, §97 | NO | NO |
| L-14 | Interpretation of "preparatory communication" (what in-app messages are regulated) | R-F3 | NO | YES for the action classification's boundary cases |
| L-15 | Employment-law, tax and transfer-compensation consequences of any recorded terms | mandate §5 | NO | NO |
| L-16 | Automatic regulatory reporting (FIFA Platform, FA lodging) | R-F25, R-E8 | NO (not built) | NO (not built) |

## 9. Regulatory uncertainty register (§190)

| Rule | What is known | What is uncertain | Jurisdiction | Blocking for build? | Needs counsel? |
|---|---|---|---|---|---|
| Multiple representation (FFAR 12(8)–(10)) | Text (S1); suspended worldwide by S2; CJEU 16 Jul 2026 refers justification to the national court (S3) | Whether FIFA reinstates, amends or replaces it; timing | FIFA / all except where national rule is in force | P5.6B no; P5.6C engine defaults yes | YES |
| Fee cap, client pays, pro rata, Clearing House (14, 15) | Text (S1); suspended (S2); England has no cap (S7) | Reinstatement; national variants | FIFA + each MA | No (ledger only) | YES |
| Exclusive-agreement approach window (16(1)(b)–(c)) | CJEU: appears incompatible with Art. 101 TFEU (S3) | Final national ruling; FIFA response | FIFA + England | No | YES |
| Publication (19) | Suspended (S2); GDPR precludes publishing sanctions and transaction details (S3) | What FIFA will still publish (names) | FIFA | No | YES |
| Minor approach timing (13(1)) | Six months before the first-professional-contract age of the employing country; England fixed at 1 Sep of the academic year of the 16th birthday | The age in each other country; which country when employment is undecided | FIFA, all MAs except England | England no; others yes | YES |
| U.S. national rules | FIFA licence enforced from 1 Jan 2024; background check + SafeSport training required (S10) | The U.S. Soccer regulations text; minors timing; scope of the two requirements | United States | Yes for U.S. minors | YES |
| FA suspended provisions | Some provisions are shaded as suspended (S7 intro) | Which exactly (shading lost in extraction) | England | No; yes for fee/reporting encoding | YES |
| Agency as party | England: agency may be an additional party, individual mandatory (S8) | Other jurisdictions | all | No | YES |
| Co-agent / assignment | England permits assignment between registered agents with lodging (S7 4.11) | FIFA and others | all | No (not built) | YES |
| FIFA template mandatory? | A template exists (S6) | Whether use is mandatory anywhere | FIFA | No | YES |

## 10. Future jurisdiction overlays (framework only)

FFAR art. 3 requires every member association to have national regulations
incorporating arts. 11–21 and permits stricter measures; art. 2(3) chooses
the national set by where the Client is registered or domiciled at signing.
Therefore an overlay for France (FFF), Germany (DFB), Italy (FIGC), Spain
(RFEF) or any other association is the same shape as England's: a policy
set with `{ memberAssociation, effectiveFrom, policyVersion }`, entries for
national registration, minors timing formula and accreditation, multiple-
representation table, fee posture, lodging duties, and per-rule `state`.
France's national-law licensing (art. 24 recognition) and any national
minors law are examples of entries that must be encoded from primary
sources before that overlay is switched on; until then the resolver
returns `not_encoded` → `MANUAL_REGULATORY_REVIEW_REQUIRED` (mandate §19,
§126). None of these overlays was researched in P5.6A.
