# M23 P5.6E — final report

**ScoutBox Agent Cross-App Integration.** Eleven local commits, no push, no PR, no
deploy — eight implementation commits, a totals correction, and two repair-pass
commits, plus the closure commit this report is part of. 66 files,
+6,721 / −143 lines against the P5.6D tip (`6d3401b`) for the implementation phases
— of which 53 files and +4,907 lines are code and tests, the rest documentation.

*This report was re-evaluated by the final repair pass rather than preserved. Items
93, 99, 100, 102 and 104, the sceptical section and the truth block all changed; the
repair pass has its own section below and its own document,
`M23_P56E_REPAIR_REPORT.md`.*

---

## The 108 items

### The mandate's shape (1–8)

1. P5.6E is an **integration** milestone. No new domain was created, no
   foundational store was added, and no frozen contract was rewritten.
2. One pure decision layer (`m27/integration.mjs`) and one db-bound seam
   (`m27/index.mjs`) were added. Nothing else in the codebase decides an agent's
   access to another app's work.
3. Ten surfaces are declared, each with its regulated flag, its scopes, its
   adult-only flag and whether it needs a disclosure.
4. The rule order is fixed:
   `SURFACE → BASIS → SUBJECT → AGE → BLOCK → SCOPE → DISCLOSURE → SHARE → LICENCE → COMPLIANCE`.
5. `BLOCK` is applied **before** scope, disclosure, licence and compliance: safety
   outranks every convenience, and a CLEAR compliance answer never overrides it.
6. `AGE` is applied **before** `BLOCK`, so no refusal about a child can be read as
   a statement about a block.
7. The first refusal wins, so a refusal never leaks the facts later in the order.
8. Twelve deny codes, one meaning each, none an age oracle beyond the single named
   minor pathway.

### The authority (9–17)

9. `agentClientBasis` wraps `agreementGrantsAccess` — P5.6B's canonical predicate
   — and adds nothing to it.
10. It returns the **individual** it authorises, so every snapshot, notification
    and handoff match is keyed on a named agent.
11. A proposal the client has not confirmed is not a basis.
12. A disputed relationship is not a basis.
13. An `active` agreement past its `endAt` is not a basis — expiry is derived on
    every read, not waited for.
14. A colleague at the same agency is not a basis. Membership is not the mandate.
15. `REPRESENTATION_AMBIGUOUS` exists for the case of two active mandates, so the
    system states an answer rather than picking one.
16. "Not active" is reported to the **agent**, who already knows the relationship
    exists; "nothing at all" is what a third party gets. The two are different
    answers.
17. Authority is re-derived at **read** time and at **mutation** time. A mandate
    that ended one second ago closes the next read (AR5).

### The legacy closure (18–23)

18. Two things are called "representation": canonical
    `db.representationAgreements` and legacy M13 F10 `db.representations`.
19. A legacy mirror has `agentUserId: null` and can never satisfy a predicate
    asked about a named agent.
20. The legacy lane was closed as a writer: no P5.6E route writes it and no new
    path reads it for authority.
21. A legacy row still **reads** as history. Rewriting it would be a lie about
    what a club once noted.
22. A mirror does not even register as "not active" — it names nobody, so there is
    nothing to be non-active about, and it cannot tell a stranger that some
    relationship is in some state.
23. Two other legacy paths (`player.agentName`, M12 stage words) were audited and
    left alone, because neither is used as authority anywhere. Recorded, not just
    the changes.

### Contact routing (24–34)

24. Two modes: `player_only` and `both`.
25. There is **no** `agent_only` mode. §21 lists it illustratively; a message with
    no player Inbox row could not honestly be called delivered, and making it
    honest would need a second Inbox, which §20 forbids.
26. No club screen in either club app offers one, and a forged mode is read as the
    safest one rather than honoured.
27. The mode is a **request**. Whether it is honoured is decided at send, not when
    the page loaded.
28. A refused agent leg never fails the contact: the player is always a valid
    route, and the club is told which rule refused it.
29. A block refuses the **whole** send, because a family that blocked a club said
    something about the club, not about the routing.
30. `routingSnapshot` records who was validly routed, as roles and ids, and says in
    words that a later change does not rewrite it.
31. A failed routing produces no snapshot.
32. `contactIntegrity` validates the mode and the snapshot, so a corrupt row is
    named rather than mis-rendered.
33. The agent is notified through the **canonical** Agent Inbox —
    `representation_contact`, mutable category, no second inbox.
34. The agent sees the club's name, the message addressed to them both and the
    state. No case id, no assessment, no ranking, no club-private note.

### The trial projection (35–42)

35. One viewer was added to `scheduleView`: `agent`. No new store, no new Trial
    route, no second Trial workflow.
36. The agent gets the state, the sessions, the timezone, the venue **name** and
    the town.
37. Not the exact address — held for the family since P4B D-23.
38. Not the club's joining instructions.
39. Not the evidence list: no Box Cam payload has a field to arrive in.
40. Whether a report is **owed** is a state the agent may see; what it says is not.
41. `trial_coordination` is a **declared** surface with **no route**, so the answer
    to "may an agent confirm a trial?" is a decision the system states rather than
    a silence.
42. The gate is the client's `trialVisibility`, and the refusal says whose choice
    it was without quoting them.

### The opportunity share (43–52)

43. Sharing is **not** applying, and that is structural: no parameter on the route
    could start an application, no field on the record could hold one.
44. The client's own board is the gate — the same eligibility and visibility rules
    the player sees.
45. An opportunity not on the board is a **uniform** 404: not "closed", not
    "ineligible", so the route is no oracle.
46. Nothing of the club's recruitment thinking rides along with the board.
47. `clients.opportunities.share` is a `licensed_agent` permission. An agency
    administrator is refused about their **role**, and identically for a client
    the agency never represented.
48. A colleague and a foreign agency get the identical 404.
49. The note uses the **same** sanitiser and limit as the Contact domain. One
    sanitiser, one limit.
50. The author and the rev are the store's; a forged `sharedBy` or `rev` reaches
    no field.
51. A replay replays; a different payload on the same key is a named conflict; a
    fresh key for an already-shared opportunity is a named duplicate.
52. The player's card names the agent who shared, says applying is their own act,
    and has **no Apply button**.

### The transaction handoff (53–66)

53. A formal decision to progress creates **nothing**.
54. One invitation per case, stored on the case, so it is as invisible as the case.
55. `expired` is derived from the clock, not written by a job.
56. A withdrawn invitation does not block a fresh one.
57. Nine blockers, reported as codes.
58. `HANDOFF_NOT_PERMITTED` is reported first **and alone**: a viewer is told it is
    not theirs to do, not handed a checklist.
59. `handoffBlockers` does not **take** the decision's reasons, note, evidence or
    author, so no refusal it produces can leak them.
60. The readiness view and the mutation call the same function. Visibility of a
    button is not authorization.
61. The readiness view carries none of the decision's rationale, note, outcome,
    reason codes or evidence.
62. The invitation records **that** the client was represented, resolved by asking
    the server — never **who**.
63. Citing a case you were not invited to creates **no transaction at all**: the
    bind runs before the store.
64. Once an agency has answered, the invitation cannot be un-invited — withdrawing
    would not close the workspace.
65. The duplicate rule refuses the same individual, type and clubs, and
    deliberately does **not** block a loan beside a transfer or a second engaging
    club.
66. The case reference in `transaction.links` is scoped to the representing agent
    and the owning club; everyone else sees it **absent**, not redacted.

### The disclosure model (67–74)

67. Three choices on the agreement: `clubPresence`, `contactRouting`,
    `trialVisibility`.
68. All three start **off**. Confirming a relationship turns none of them on.
69. Each is its own request, its own history entry, its own rev.
70. A key present with a non-boolean value refuses the whole request, because
    coercing it would turn **off** a choice someone was turning **on**.
71. An unknown key reaches no field.
72. Turning one off takes effect at the next action and rewrites no record.
73. Off always works, including on a relationship that has already ended.
74. Nobody but the client can make the choice; another player reaching for the id
    is told it does not exist.

### Events, notifications and audit (75–81)

75. Five event names, all declared in the M18.2 registry and all in the
    emitted-events list the boot contract checks.
76. `representation_disclosure_changed` does not say **which** choice moved.
77. `contact_agent_routed` carries ids only — not the club, not the subject, not a
    word of the message.
78. `agent_opportunity_shared` carries neither the opportunity nor the client.
79. The two handoff events carry ids and a represented flag.
80. Four new notification types, each in a **mutable** category. None is smuggled
    into `compliance`, which is mandatory: a club's message and an agent's tip are
    not safety notices.
81. The club's own case timeline now records the handoff milestones — ids, time,
    the colleague, and whether the client was represented. Never the agent, never
    a fee, never the decision's reasoning.

### The clients (82–88)

82. Player: a disclosure section per active relationship, three rows, each state
    in **words**, each with its own control.
83. Player: a shared-opportunities card that is **absent** rather than empty.
84. Agent: four additions to the existing client tabs — no new destination.
85. Club (Pro): `ct-routing`, `ct-agent-party`, `ct-agent-refused`, and a named
    `<fieldset>` route chooser with exactly two options.
86. Club (Pro): a handoff section whose blockers are each their own element.
87. Grassroots: the same two surfaces from the same components, and no Agent
    destination.
88. Admin: unchanged. T&S reads; the admin key is not a session on any new route.

### Schema and stores (89–92)

89. `SCHEMA_VERSION` stays **2307**. No migration.
90. No new durable store. The disclosure and shares live on the agreement; the
    handoff lives on the recruitment case.
91. `m23BootContract` passes: every production-read store exists after a clean boot
    and after an upgrade.
92. §18 of the boot contract holds — no `db.x ??=` within 60 lines of a route.

### Defects (93–99)

93. **Thirteen** defects found — eleven in the implementation phases and two more
    in the repair pass (E-15, E-16). Ten in P5.6E's own new code, three
    pre-existing.
94. **Four** were caught by pre-existing P5.6C/P5.6D assertions rather than by
    reading the code, which is the argument for the whole battery.
95. Two were cross-party privacy leaks that single-party tests cannot see: E-6 (a
    club's case id reaching the player, T&S and a releasing club) and E-8 (a club
    learning which jurisdictions an agent works in).
96. One inverted a person's intention: E-11, a truthy string silently turning a
    privacy choice off.
97. One made the feature a no-op from the agent's side while looking correct from
    the club's: E-4.
98. Three were undeclared error codes answering 500 for what were plain 4xx
    refusals: E-10, E-12, E-13.
99. Every one is fixed at the **root** with a regression that would catch it again.
    One further behaviour (A2, a draft naming an adult non-client) was examined and
    deliberately **not** changed, with the reasoning and mitigations recorded. A1 is
    no longer in that category: a fix for it was written, tested, shown to break six
    frozen suites, and rejected on that evidence — see the repair pass below.

### Tests (100–104)

100. `m23AgentIntegrationE2E`: **535** checks, **281** negative (53%), pure half
     plus HTTP half, groups A–AV.
101. `m23AgentIntegrationLive`: **98** checks, **39** negative (40%), six journeys
     across four real clients and one real backend.
102. Server battery: **36** suites green, plus **15** perf and load suites, plus
     `apiE2E` (130 checks) against a live server.
103. Browser battery: **7** live suites green — 98, 82, 82, 86, 108, 86, 122, 39,
     64 checks — plus `navConfig` (359) and six demo suites.
104. Typechecks 5 / 5, builds 5 / 5, demos rebuilt and spotchecked. (The player app
     is an Expo project: it builds with `expo export --platform web`, not with an
     `npm run build` script it does not have.)

### Prohibitions honoured (105–108)

105. No Offer Workflow. No Offer lifecycle state written. No signing state
     written. No `db.signings`. Swept for in copy as well as code.
106. No general minor discovery: every surface is `adultOnly`, and the minor
     pathway is refused before anything else is asked.
107. No second Inbox, no second Trial workflow, no second transaction workflow, no
     duplicated Agent store.
108. Not pushed. No PR. Not deployed. Working tree clean.

---

## What a reader should be sceptical about

Stated because a report that only lists successes is not a report.

- **No grassroots-owned case** was driven end to end through a real grassroots
  browser session. The `orgRouter` code path is identical and the built artefact is
  asserted, but that is inference from shared code, not observation of a journey.
  **This is the one item on this list the repair pass did not close.**
- **A2 remains an accepted behaviour, not a fix.** A licensed agent can send one
  factual "you have been named; confirm or ignore" notification to an adult they do
  not represent. Narrowing it means changing P5.6D's frozen party model and
  breaking its own AD5 assertion, so it is documented with its mitigations rather
  than quietly altered.
- **An agency org still reaches club list surfaces, scoped to itself.** A gate was
  built and rejected on evidence (below). What is now asserted is that the data is
  isolated — fifteen checks — not that the surfaces are absent.

Two items that *were* on this list before the repair pass, and are no longer:

- ~~The negative ratio is 49%~~ → it is **53%** after groups AU and AV, which
  matches the earlier agent-lane suites. The groups were added because they assert
  something real; the ratio moved as a side effect.
- ~~One flake was observed and recorded rather than fixed~~ → it was root-caused
  (a 3,500 ms toast lifetime sampled every 250 ms), fixed by recording toasts
  instead of sampling for them, and re-proved under deliberate CPU starvation.

---

## The repair pass

Run after the eight implementation commits, under the instruction *repair
everything that needs repairing before moving to the next step*. Three commits:
`0564912`, `66582f3`, and this documentation commit.

### What it found

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | The contention flake | **Root-caused and fixed.** `e2e/toastLog.mjs` records each toast via a `MutationObserver` installed on the browser *context*, so a 3.5-second toast cannot be missed by a 250 ms poll. No sleeps added. Four suites converted. |
| 2 | An agency org on club list surfaces | **A gate was written, tested, and rejected.** `m27/orgKind.mjs` (16-prefix fail-closed allowlist) passed the agent lane and broke six frozen suites — including `m23TrialE2E` W3, "an agency may invite an adult (the wall is about minors)". Reverted in full; the behaviour is instead **proven safe** by new group AU. |
| 3 | E-15: a green live suite that never exited | **Fixed.** `process.on('exit', cleanup)` cannot fire while the backend, the browser and four static servers hold the event loop. The suite hung for ever holding five ports, which silently cost two iterations of the contention battery. Now closes the browser and exits, as its three siblings do. |
| 4 | E-16: two new writes with no rate quota | **Fixed.** `opportunity_share` (60/h, actor) and `transaction_handoff` (30/h, org) on the platform's own M18.1 provider. The invite → withdraw → invite loop was unbounded at two notifications per turn; both halves now draw on one budget. Group AV proves it. |
| 5 | A2, the draft naming an adult non-client | **Not changed**, with reasons and mitigations — see above. |
| 6 | The adversarial audit, 14 groups, 179 checks | **No product defect found.** Ten of its own assertions were wrong and were corrected against the real interfaces. |

### What it deliberately did not do

- It did not weaken a test to make behaviour pass. The one place a test changed its
  claim (AV3b2) it was made *more* direct, not less.
- It did not redesign frozen architecture. The one attempt to change a frozen
  product shape was abandoned the moment six suites said it was a change and not a
  repair.
- It added no migration, no store and no route. `SCHEMA_VERSION` is still 2307.

## The truth block

- Every number in this report came from a command run in this session. The check
  counts are the suites' own printed totals.
- `SCHEMA_VERSION` is 2307 and no migration was added. Verified by reading the
  constant and by `m23BootContract` passing.
- The thirteen defects were all reproduced before being fixed. E-14's pre-existence
  was proven by stashing every P5.6E change and re-running the failing suite; E-15's
  by two blocked battery iterations and a process still alive 13 minutes after
  reporting success; E-16's by 15 unrefused invite/withdraw cycles.
- **One** accepted behaviour (A2) was not fixed, and is documented with its
  reasoning and mitigations. A1 was not gated because a gate for it was built,
  tested and rejected on evidence — that is a decision, not a deferral.
- `m22/perf.json` and `m22/holdout.json` were modified by running those suites and
  then **reverted**, because this machine ran without `--expose-gc` and
  re-recording would have replaced a controlled measurement with a worse one.
- Three live assertions were corrected against what the real interfaces do. Each
  correction is named in the phase-5 commit message, and each made the assertion
  stronger.
- P5.6E was **not pushed**, no pull request was opened, and nothing was deployed.
  The P5.6D backup-push authorization was consumed by `6d3401b` and is not
  reusable.

## Commits

| Commit | Phase |
| --- | --- |
| `2907f68` | audit: the representation seam, read out of the code |
| `cb34c80` | server: one integration authorization layer, the legacy lane closed |
| `5053c7c` | server: Contact routing, Inbox participation, Trial projection |
| `5738e0f` | server: the opportunity share, and the P5 decision → transaction handoff |
| `6b365e6` | clients: the four surfaces that changed, and the one that did not |
| `a87dbe6` | tests: the integration acceptance suite, and five defects it found |
| `5fb8d1b` | tests: six live browser journeys through the real clients |
| `aabd071` | docs: thirteen documents and this report |
| `eba439c` | docs: correct this report's own totals |
| `0564912` | repair: the Chromium flake root-caused; the org-kind gate built and rejected; the adversarial audit |
| `66582f3` | repair: E-15 the suite that never exited, E-16 the two writes with no quota |
| *(this commit)* | repair closure: the defect register, the test report, this report, and `M23_P56E_REPAIR_REPORT.md` |

The full account of the repair pass — 62 items and a 41-statement truth block — is
in **`M23_P56E_REPAIR_REPORT.md`**.

## Document names

This milestone's documents carry `INTEGRATION` names where the mandate referred to
them generically. The mapping, so no document is thought missing:

| Mandate's name | This repository's file |
| --- | --- |
| `CROSS_APP_ARCHITECTURE` | `M23_P56E_INTEGRATION_MODEL.md` |
| `AUTHORIZATION_PRIVACY_MATRIX` | `M23_P56E_INTEGRATION_AUTH_MATRIX.md` + `M23_P56E_INTEGRATION_PRIVACY_MATRIX.md` |
| `TEST_REPORT` | `M23_P56E_INTEGRATION_TEST_REPORT.md` |
| `AGENT_INTEGRATION_DEFECT_REGISTER` | `M23_P56E_INTEGRATION_DEFECT_REGISTER.md` |
