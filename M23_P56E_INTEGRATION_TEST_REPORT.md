# M23 P5.6E — the integration test report

## 1. What was written

| Suite | Kind | Checks | Negative | Ratio |
| --- | --- | --- | --- | --- |
| `scoutbox-server/scripts/m23AgentIntegrationE2E.mjs` | pure + HTTP acceptance | **491** | **243** | 49% |
| `e2e/m23AgentIntegrationLive.test.mjs` | four real clients, one real backend | **98** | **39** | 40% |

The negative ratio is below the 53–61% of the three earlier agent-lane suites.
That is stated rather than corrected: the remaining checks were added because they
assert something real, and padding the count with weak negatives to reach a
percentage would make the number less informative, not more. Where a genuine
adversarial case existed it was written — groups AP, AQ, AR, AS and AT were added
for exactly that reason, and took the count from 380 to 491.

## 2. The pure half: groups A–Q

Run in-process against `m27/integration.mjs` with no server and no database.

| Group | What it pins |
| --- | --- |
| A | the ten declared surfaces, the fixed rule order, the twelve deny codes, every regulated surface mapped to a real P5.6C action |
| B | the canonical basis: what is and is not authority, ten cases |
| C | the legacy M13 F10 closure, five cases |
| S | every surface, every rule, fail-closed — twenty cases, including "the first refusal in RULE_ORDER wins, so a refusal never leaks the later facts" |
| H | contact routing: two modes, no third, the snapshot's contents, thirteen cases |
| E | the club-facing presence projection: six fields, facet by facet, six cases |
| P | the handoff preconditions: four states, nine blockers, eighteen cases |
| Q | the duplicate rule, and the three things it must **not** block |

## 3. The HTTP half

One real journey, driven end to end, then swept adversarially.

The journey: a licensed agent with a verified FIFA licence and a national
registration → a client who confirms the mandate → a club that agrees to approach
him → a contact routed to both → a trial the client attended and the club completed
→ a finalised formal decision to progress → an explicit transaction-handoff
invitation → the agency workspace that answers it.

Then: groups D, T/U/V/W/X (the five ways authority ends), G, H/I/J, K/L/M, N/O, E,
P/Q/R, §36 scoping, body forgery (#30–#32), AD/AF, AI/AG, AJ/AK/AL/AM (client
artefacts read from disk), AN/AO, #37, AC, AA, Z, **AP** (every new route by
actor, by id and by verb), **AQ** (the five new events against the registry),
**AR** (authority re-derived at read time; the notification categories), **AS**
(§22 history, the write contracts, the verbs that do not exist) and **AT** (the
club's audit trail), closing with a refusal-hygiene sweep over all 39 distinct
refusals the suite provoked.

### The hygiene sweep

| Check | Result |
| --- | --- |
| HY1 | 39 distinct refusals collected |
| HY2 | none carries a stack trace or a file path |
| HY3 | every refusal that reached a handler names itself with a code |
| HY4 | not one is a 5xx |
| HY5 | no refusal names a person, an agency or an email |
| HY6 | not one mentions an offer, a fee, a commission or a signing |

HY3 deliberately excludes the bare 404 of a route that does not exist. Several of
this milestone's strongest guarantees are of that kind — there is no agent
trial-confirm route, no Trust-Score write, no Passport write — and there is
nothing for them to name because nothing is there.

## 4. The live half: six journeys, four clients

| Journey | Client | What it proves |
| --- | --- | --- |
| A | player, 390 wide | three disclosure choices, all off, each its own control; two turned on, one request each |
| B | Pro club | the route chooser has exactly two options and no third; the sent record says it reached both |
| C | agent | the club's message in the canonical Inbox and on the client's Contacts tab; no case id, no assessment, no note |
| D | agent + player | the trial's name/town/state but not its address, instructions or evidence; a share that reaches the client's own phone with no Apply button |
| E | Pro club | the handoff unavailable with its reasons as named elements, then invited, saying plainly it is not an offer and never who the agent is |
| F | agent + club | the invitation with the club and its deadline; the workspace opened citing it; the club seeing it was taken up and nothing inside |
| N1–N9 | all four | no agent-only route in either club app, no agent named while presence is off, §22 history, 390/360, a11y, French, no Offer control, no foreign-agency visibility, no page errors |

## 5. The regression battery

### Server — 26 suites, all green

`m23AgentIntegrationE2E` · `m23ContactE2E` · `m23ContactPersistence` ·
`m23TrialE2E` · `m23TrialPersistence` · `m23DecisionE2E` ·
`m23DecisionPersistence` · `m23BootContract` · `m23E2E` · `m23Persistence` ·
`m23P4AClosureE2E` · `m23AgentE2E` · `m23AgentPersistence` ·
`m23AgentComplianceE2E` · `m23AgentCompliancePersistence` ·
`m23AgentTransactionE2E` · `m23AgentTransactionPersistence` · `connectedE2E` ·
`m12E2E` · `m13E2E` · `m14E2E` · `m141E2E` · `m15E2E` · `m16E2E` · `m161E2E` ·
`m162E2E` · `m17E2E` · `m18E2E` · `m181E2E` · `m182E2E` · `m19E2E` · `m20E2E` ·
`m21E2E` · `m22E2E` · `testTrust`

`apiE2E` passes (130 checks) against a separately started server — it is an
external-server suite and does not boot one itself.

### Performance and load — all green

`m23Perf` · `m23ContactPerf` · `m23TrialPerf` · `m23DecisionPerf` · `m17Perf` ·
`m18Perf` · `m181Perf` · `m182Perf` · `m19Perf` · `m20Perf` · `m21Perf` ·
`m22Perf` · `m22Robustness` · `m22Holdout` · `m22Blocker` · `m13Load` ·
`m18FlakeProbe`

`m22Perf` and `m22Holdout` rewrite `m22/perf.json` and `m22/holdout.json` with
machine-specific timings. Those artefacts were **reverted rather than
re-recorded**: this machine ran without `--expose-gc`, so re-committing them would
replace a controlled measurement with a less controlled one, and the numbers are
not part of P5.6E.

### Browser — all green

| Suite | Checks |
| --- | --- |
| `m23AgentIntegrationLive` (new) | 98 |
| `m23ContactLive` | 82 |
| `m23AgentLive` | 82 |
| `m23AgentComplianceLive` | 86 |
| `m23AgentTransactionLive` | 108 |
| `m23DecisionLive` | 86 |
| `m23TrialLive` | 122 |
| `m23Live` | 39 |
| `navLive` | 64 |
| `navConfig` | 359 |

One honest note: running four browser suites **concurrently** made
`m23AgentLive` fail once at B16 on a timing assertion. Re-run alone it passed all
82 checks. The cause was Chromium contention on this machine, not a regression;
it is recorded here rather than left as a green tick that hides a flake.

### Typechecks and builds — 5 / 5 and 5 / 5

`scoutbox-agent`, `scoutbox-club`, `scoutbox-grassroots`, `scoutbox-admin` and
`scoutbox-player` all typecheck clean and build clean.

### Demos

`buildDemos` rebuilt all five bundles; `demoFreshness`, `demoHostOrdering`,
`m23AgentDemoSpotcheck`, `uiSpotcheck`, `crosstab` and `demoOffline` all pass.

## 6. Schema

`SCHEMA_VERSION` is **2307**, unchanged. P5.6E adds no migration, because it adds
no store: the disclosure and the shares live on the agreement, the handoff lives
on the recruitment case. `m23BootContract` passes, so every production-read store
still exists after both a clean boot and an upgrade.

## 7. What is not covered, stated plainly

- There is no P5.6E **persistence** suite of its own. The three records it writes
  are fields on stores whose persistence is already covered by
  `m23AgentPersistence` and `m23Persistence`, and `m23BootContract` covers the
  boot contract. A new suite would have re-run their assertions under a new name.
- There is no P5.6E **perf** suite. The milestone adds four projections over
  existing stores and two small writes; nothing here is a new hot path, and
  `m23Perf` and `m23ContactPerf` cover the routes it projects from.
- The **grassroots** handoff and routing surfaces are asserted by reading the
  built artefact (AL1, AL2) and by the shared `orgRouter` being one router, plus a
  real grassroots browser session in N1. A full grassroots journey through a
  grassroots-owned case was not driven; the server code path is identical, and
  that is stated rather than implied.
