# M23 P5.6E — the integration test report

*Revised by the final repair pass. Section 8 is new and records what the repair
pass ran; the counts below are the post-repair counts.*

## 1. What was written

| Suite | Kind | Checks | Negative | Ratio |
| --- | --- | --- | --- | --- |
| `scoutbox-server/scripts/m23AgentIntegrationE2E.mjs` | pure + HTTP acceptance | **535** | **281** | 53% |
| `scoutbox-server/scripts/m23P56ERepairAudit.mjs` | cross-domain adversarial audit (repair pass) | **179** | **134** | 75% |
| `e2e/m23AgentIntegrationLive.test.mjs` | four real clients, one real backend | **98** | **39** | 40% |

The acceptance suite grew from 491 to 535 across the repair pass: group **AU**
(tenant isolation for an agency on the shared `/org` router) and group **AV** (the
two new writes' rate quotas). Its negative ratio rose from 49% to **53%**, which
matches the three earlier agent-lane suites — not because the target was chased,
but because both new groups are almost entirely negative.

The repair audit is a separate instrument with a different job: it asks the repair
mandate's own questions across domain boundaries the acceptance suite does not
cross (Trust evidence, Passport writes, tombstones, the event registry, demo/dev
boundaries), and it exists so that every "no" in the final truth block is backed
by a command that ran. Its 75% negative ratio reflects that: almost every check
is an assertion that something is *not* possible.

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

### Server — 36 suites, all green

The list below is 35 names; `m23P56ERepairAudit` is the 36th, added by the repair
pass. Every one was re-run after the repair commits.

`m23AgentIntegrationE2E` · `m23ContactE2E` · `m23ContactPersistence` ·
`m23TrialE2E` · `m23TrialPersistence` · `m23DecisionE2E` ·
`m23DecisionPersistence` · `m23BootContract` · `m23E2E` · `m23Persistence` ·
`m23P4AClosureE2E` · `m23AgentE2E` · `m23AgentPersistence` ·
`m23AgentComplianceE2E` · `m23AgentCompliancePersistence` ·
`m23AgentTransactionE2E` · `m23AgentTransactionPersistence` · `connectedE2E` ·
`m12E2E` · `m13E2E` · `m14E2E` · `m141E2E` · `m15E2E` · `m16E2E` · `m161E2E` ·
`m162E2E` · `m17E2E` · `m18E2E` · `m181E2E` · `m182E2E` · `m19E2E` · `m20E2E` ·
`m21E2E` · `m22E2E` · `testTrust` · `m23P56ERepairAudit`

`apiE2E` passes (130 checks) against a separately started server — it is an
external-server suite and does not boot one itself.

One battery line failed on its first run and is reported rather than overwritten:
`m23AgentPersistence` returned 2 failures — "the server boots over a 2304 snapshot"
and "clean boot" — while five production builds were running concurrently. Its boot
timed out under the starvation. Re-run alone: **68 checks, 0 failures.**

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

Running four browser suites **concurrently** once made `m23AgentLive` fail at B16
on a timing assertion. That was originally recorded here as machine contention.
The repair pass refused to leave it at that, found the actual cause, fixed it and
re-proved it under worse conditions — see §8.2.

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

*The second bullet above — "there is no P5.6E perf suite" — was re-examined by the
repair pass's §25 review and still stands as written, but the review itself found a
defect that no perf suite would have caught: see §8.3.*

## 8. The repair pass

### 8.1 The new instrument

`scoutbox-server/scripts/m23P56ERepairAudit.mjs` — 14 groups, **179 checks, 134
negative (75%)**, green. It boots its own server and asks the repair mandate's
questions where the acceptance suite does not reach:

| Group | What it asks |
| --- | --- |
| RA | §20 Trust — is a non-active relationship ever active Trust evidence, in either lane, for all six terminal states? |
| RB | §21 Passport — can an agent write anything; is a legacy row ever the headline; does a player's revocation land? |
| RC | §5 — does a transaction draft naming a non-client grant data, authority or progression? |
| RD | §7 — does same-agency membership grant anything, for any of five agency roles across seven resources? |
| RE | §8 — is a minor concealed on every integrated surface, including counts, errors and an age oracle? |
| RF | §9 — is authority re-derived at mutation time after termination, licence lapse, block and ended affiliation? |
| RG | §17 — does any security or privacy decision rest on JS truthiness (eleven malformed disclosure values, the enum, `expectedRev`)? |
| RH | §18 — can a body supply authority: id, tenant or org-kind forgery? |
| RI / RJ | §15/§16 — does a deep link carry authority; is any refusal an existence oracle? |
| RK | §23 — does deletion leave the ids and take the person? |
| RL | §22 — can a count, a total or a cursor reveal what a projection withheld? |
| RM | §19 — the event registry against what the server actually emits, both directions, using the registry's own predicate and `assertEventRegistry({mode:'production'})` |
| RN | §24 — can demo or dev state masquerade as regulator truth? |

It found **no product defect.** Ten checks failed on first run and all ten were
the *audit's own* assertion defects — the wrong Trust reader, an internal key that
is deliberately not projected, a regex that failed across a line break, a
hand-written registry expectation that duplicated logic the registry already
exports. Each was fixed by asking the real source of truth. That is recorded here
because "the audit found nothing" means something quite different when the audit
had to be corrected ten times to be believed.

### 8.2 The contention flake: root cause, fix, repeated runs

**Root cause.** Every client shows a toast for **3,500 ms** and then removes it
from the DOM (`setTimeout(() => setToast(null), 3500)` — `scoutbox-agent/src/App.tsx:289`,
club `:440`, grassroots `:467`, admin `:155`). A test that polls `body.innerText`
every 250 ms for that toast is sampling a window that closes by itself: starve the
machine and two consecutive polls can land either side of the whole 3.5-second
lifetime. It is a test-only race on transient UI, not a product race.

**Fix, and why it is not a sleep.** `e2e/toastLog.mjs` **records** each toast as
the browser renders it rather than sampling for it. A `MutationObserver` installed
via `addInitScript` **on the context** (so registration precedes any `goto`)
appends every `.toast` element's text to an append-only `window.__toastLog`. The
assertion then reads real observable product state — a toast that actually
appeared — with the timing dependency removed rather than padded. No sleeps were
added. All four agent live suites create contexts through it.

**Repeated runs.** The original failure was four browser suites concurrently on a
4-core machine. That was reproduced, and then made worse:

| Iteration | Conditions | Result |
| --- | --- | --- |
| 1 | four suites concurrently, 4 cores | **all green** — 82 / 86 / 108 / 98 |
| 2 | four suites **plus four CPU hogs** on 4 cores | three green (82 / 86 / 108); the fourth could not start — it was blocked by E-15, not by contention |
| 3 | four suites plus CPU hogs, same again | three green (82 / 86 / 108); same blocker |
| 4 | the fourth suite twice in sequence, still starved, after E-15 was fixed | **98 / 98 both times, exit 0, 54 s each, all five ports released** |

The flake has not recurred in any run since the recorder was installed. Iterations
2 and 3 are reported as partial rather than as passes, because that is what they
were — and chasing the reason they were partial is what uncovered E-15.

### 8.3 The §25 performance and denial-of-service review

The review of the new endpoints found no hot path and no unbounded scan: the two
`filter` calls in `m27/index.mjs` are over one player's agreements and one case's
decisions. It did find **E-16**: neither of the two new writes carried a
rate-limit policy, and the handoff's invite → withdraw → invite loop was
unbounded, at two notifications and one snapshot write per turn. Fixed with the
platform's own provider and covered by group AV. See the defect register.

### 8.4 The re-run battery

Every suite listed in §5 was re-run after the repair commits, plus the two new
instruments. Results are in §5's tables, which are post-repair.
