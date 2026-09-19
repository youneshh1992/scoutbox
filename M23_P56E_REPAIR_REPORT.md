# M23 P5.6E — the repair, adversarial audit and closure report

**Mandate:** *repair everything that needs repairing before moving to the next
step.* Not "the feature appears complete, so proceed", but: every known defect that
materially affects security, privacy, authorization, data integrity, reliability or
core user behaviour has either been repaired at the root, or proven not to be a
defect with executable evidence.

Three commits: `0564912`, `66582f3`, and this one. No push, no pull request, no
deploy.

---

## The 62 items

### What the pass was asked to close (1–4)

1. The mandate named **four** known observations requiring explicit closure: the
   `m23AgentLive` concurrency flake, an agency org reaching club list surfaces, a
   P5.6D transaction draft naming an adult non-client, and the standing assumption
   that more inherited cross-domain defects might exist.
2. All four now have a disposition backed by a command that ran. Two were repaired,
   one was attempted-and-rejected on evidence, one was searched for and not found.
3. The pass also found **two defects the mandate did not name** — E-15 and E-16 —
   both in P5.6E's own work, and repaired both.
4. Nothing was repaired to make a count look better. The two defects fixed were
   found by asking what happens under contention and what happens under repetition,
   which are the questions the mandate asks.

### Observation 1 — the Chromium flake (5–13)

5. Originally recorded as "Chromium contention on this machine, not a regression".
   That was accepted as an explanation and is now rejected as one: *contention* was
   the trigger, not the cause.
6. **Root cause.** Every ScoutBox client renders a toast and removes it after
   **3,500 ms**: `setTimeout(() => setToast(null), 3500)` at
   `scoutbox-agent/src/App.tsx:289`, `scoutbox-club/src/App.tsx:440`,
   `scoutbox-grassroots/src/App.tsx:467`, `scoutbox-admin/src/App.tsx:155`.
7. The failing assertion (B16) polled `body.innerText` every 250 ms for that toast.
   That is sampling a window which closes by itself; starve four Chromium instances
   on four cores and two consecutive polls can land either side of the whole
   3.5-second lifetime.
8. So the test failed on a toast that really did render. It is a **test-only race on
   transient UI**, not a product race — and no product change was made.
9. **The fix records instead of samples.** `e2e/toastLog.mjs` installs a
   `MutationObserver` that appends every `.toast` element's text to an append-only
   `window.__toastLog`.
10. It is installed with `addInitScript` **on the browser context, not the page**,
    so registration precedes any `goto` and there is no window in which navigation
    could outrun it.
11. **No sleeps were added, and no timeout was lengthened.** The assertion still
    reads real observable product state — a toast element that appeared in the DOM —
    with the timing dependency removed rather than padded.
12. All four agent live suites now create contexts through `toastRecordingContexts`
    (7, 6, 6 and 4 call sites). Two genuinely ambiguous assertions use a
    `waitTextOrToast` helper: durable text **or** a recorded toast, whichever the UI
    legitimately offers.
13. **Repeated-run result.** The original failing pattern — four browser suites
    concurrently on four cores — was run three times, twice with four CPU hogs
    added, and the previously flaky journey passed every time: `m23AgentLive`
    **82 / 82** in every iteration. The flake has not recurred since the recorder
    was installed.

### Observation 2 — an agency org on club list surfaces (14–24)

14. The honest version of this finding: `/org` is **one** Express router with 357
    routes, and an agency organisation is an `org`, so an agency session reaches
    club recruitment *list* surfaces and is answered about **itself**.
15. A fix was not deferred. It was **built**: `scoutbox-server/m27/orgKind.mjs`, a
    fail-closed middleware with a 16-prefix allowlist of what an agency org may
    reach, refusing everything else `403 ORG_KIND_NOT_PERMITTED`, mounted as
    `app.use('/org', orgAuth, orgKindGate, orgRouter)`.
16. It passed all four agent-lane live suites.
17. It then broke **six frozen suites**: `m23ContactE2E` (R6, R6b), `m23TrialE2E`
    (W3 plus a hard error in `reviewed()`), `m23DecisionE2E` (W4), `m17E2E`,
    `m18E2E` ([34]) and `m19E2E` (A27).
18. The decisive one is `m23TrialE2E` **W3: "an agency may invite an adult (the wall
    is about minors)"**. An agency running club tooling on adults inside its own org
    is deliberate, tested, frozen P4B/M19 product shape.
19. So the gate was not a repair. It was a silent product change that broke explicit
    contracts — which the mandate forbids.
20. **It was reverted in full**: `m27/orgKind.mjs` deleted, the mount restored to
    `app.use('/org', orgAuth, orgRouter)`, and all six suites re-verified green.
21. Seven assertions that had been rewritten to meet the gate's 403 were reverted
    with it. One improvement was kept because it is true either way: `#36b`/`#35b`
    now prove "no such route" with a **club** token as well as an agency one.
22. **What was done instead** — the mandate's own stated alternative: prove the
    behaviour safe. New group **AU** in `m23AgentIntegrationE2E`.
23. AU asserts: nine club list surfaces carry none of `case-`, `pl-adeyemi`,
    `Kola`, `org-eastport`, `Eastport`, `Maria Keane` and answer stably; five named
    club resources are refused **byte-identically** to `case-never-existed`; an
    agency cannot open a case on the minor `pl-guni`; and `total === items.length`
    on every list, so a count cannot report what a projection withheld.
24. The residual observation is therefore no longer "an agency might see a club's
    data" — that is asserted false in fifteen places — but "an agency org has club
    tooling it has no use for", which is a product-shape question, not a defect.

### Observation 3 — a draft naming an adult non-client (25–30)

25. P5.6D's frozen contract separates **naming** a party from **representing** one.
    `resolveParty` admits any adult, visible, unblocked player; the separate
    `POST …/representations` binding requires the agent's own active agreement with
    that exact client.
26. So a licensed agent can send one factual "you have been named; confirm or
    ignore" notification to an adult they do not represent.
27. Group **RC** of the repair audit re-tested the consequences from scratch: the
    draft discloses **no PII** about the named person to the agent, creates **no
    client-list entry**, opens **no client surface**, permits **no binding**, allows
    **no progression**, and its notification names neither a fee nor an agency.
28. Narrowing it would mean changing P5.6D's frozen party model and breaking its own
    AD5 assertion.
29. It is therefore **recorded as a known property of a frozen contract**, with its
    mitigations re-proved, and named as a candidate for a future milestone — not
    quietly altered inside an integration milestone.
30. This is the one item in this report that is accepted rather than closed, and it
    is stated as such.

### Observation 4 — the search for inherited cross-domain defects (31–38)

31. A new instrument was written for this: `scoutbox-server/scripts/m23P56ERepairAudit.mjs`
    — **14 groups, 179 checks, 134 negative (75%)**, green.
32. It boots its own server and asks the mandate's questions across boundaries the
    acceptance suite does not cross: §20 Trust, §21 Passport, §5 non-client drafts,
    §7 same-agency privacy, §8 minor concealment, §9 stale authority, §17 coercion,
    §18 forgery, §15/§16 deep links and error privacy, §23 tombstones, §22 counts,
    §19 the event registry, §24 demo/dev boundaries.
33. Its strongest assertions are **state-change** assertions rather than snapshots:
    for Trust, the *same* player's `components.relationships.detail.distinct` before
    and after a confirm and before and after a dispute, so the only thing that
    changed is the relationship's status.
34. **It found no product defect.**
35. It did find **ten defects in its own assertions**, every one of which was fixed
    by asking the real source of truth rather than by weakening the check: the wrong
    Trust reader (`/org/players/:id/trust-profile` does not exist; the club reads
    `GET /org/trust-summaries`, components come from `GET /admin/trust/:playerId`);
    an internal `rel:agency` key that is deliberately not projected; a regex that
    failed across a line break; a hand-written registry expectation that duplicated
    logic the registry already exports; and a compound claim about the agent's own
    profile payload.
36. The registry group now **imports `isRegistered` and runs
    `assertEventRegistry({ mode: 'production' })`** rather than re-deriving what
    "declared" means — because re-deriving it was exactly what produced six false
    positives (`players`, `orgs`, `opportunities`, `campaigns`, `friendlies`,
    `policy_version_published` are declared through the `ping()` helper and direct
    assignment, not the array literal).
37. That is recorded because "the audit found nothing" means something different
    when the audit had to be corrected ten times before it could be believed.
38. The assumption is therefore closed as **searched and not found**, with the
    search itself in the repository as a runnable suite — not closed as "we did not
    look".

### E-15 — a green suite that never exited (39–46)

39. Found by chasing why two iterations of the contention battery were missing a
    suite. The answer was not contention.
40. `e2e/m23AgentIntegrationLive.test.mjs` printed **98 checks passed** and
    **"all M23 P5.6E live journeys passed"** — and then hung for ever.
41. Cause: its only teardown was `process.on('exit', cleanup)`, and that hook can
    never fire, because the spawned backend, the Chromium instance and four static
    file servers all keep the event loop alive. Node never reaches `exit`.
42. Observed consequences, all three real: it held `:4040`, `:8740`, `:8840`,
    `:9040`, `:9140` indefinitely; **two whole iterations of the four-suite battery
    could not run it**, each dying in its own port preflight and blaming a "stale
    process" that was the previous run of itself, still alive 13 minutes after
    reporting success; and the green run never recorded an exit line.
43. In CI this is a job that hangs until its timeout *after the tests have passed*.
44. **Fix:** `await browser.close(); process.exit(0);` — exactly what the three
    sibling agent live suites do. `process.exit` runs the `exit` handler, so the
    cleanup that was written all along finally executes.
45. **Verification:** two consecutive runs under CPU starvation, each **98 checks,
    0 failures, exit 0, 54 s**, with all five ports confirmed free afterwards.
46. No new test was added for it: the regression **is** the exit code. A suite that
    does not exit now fails its own battery line.
46b. This defect class was **already documented in this repository**. The comment
    ending `e2e/m23Live.test.mjs` reads: *"without this the process prints its
    summary and then hangs forever — success to a human reading the tail, a timeout
    to a harness. This is the m22E2E D1 defect, and every other Live suite ends the
    same way."* Every other live suite does. `m23AgentIntegrationLive` was the one
    that did not, so this was an omission against a stated convention rather than a
    new discovery — and the endings of all nine sibling live suites were checked one
    by one after the fix.

### E-16 — two writes that reach a person, with no quota (47–56)

47. Found by the §25 performance and denial-of-service review, which also confirmed
    there is no new hot path and no unbounded scan in the new endpoints (the two
    `filter` calls are over one player's agreements and one case's decisions).
48. Neither write P5.6E adds carried a rate-limit policy. The catalogue holds **48**
    policies and every comparable write in the codebase draws on one of them —
    `contact_send`, `trial_invite`, `decision_finalize`, `transaction_write` and
    `agent_representation_request` among them. These two writes were simply never
    added to it.
49. `POST /org/agent/clients/:id/opportunities/:oppId/share` notifies the client.
    `MAX_OPPORTUNITY_SHARES = 200` bounds how many rows one relationship keeps; it
    bounds neither the rate nor the number of relationships.
50. `POST /org/rooms/:id/transaction-handoff` notifies **the player and the agent** —
    two notifications and one `persistNow()` per call — and `handoffBlockers` refuses
    only when an existing handoff is `invited` or `accepted`. A **withdrawn** one
    does not block, deliberately, so a club can re-invite after taking its own
    invitation back.
51. That makes invite → withdraw → invite an unbounded loop. Measured before the
    fix: 15 cycles ran with no refusal, and nothing would have stopped the 10,000th.
52. **Fix:** the platform's own M18.1 provider — already present in this module's
    context and simply never used — not a second mechanism.
    `opportunity_share` 60/h scope `actor`; `transaction_handoff` 30/h scope `org`.
53. Charged **after authorization**, so a refused caller cannot spend the budget of
    the club or agent it is impersonating, and a 429 never becomes a softer, more
    informative answer than the real refusal.
54. **Both halves of each loop draw on one budget.** Withdrawing is charged as well
    as sharing and inviting, because the loop — not the single act — is what the
    quota exists to close.
55. The share charge sits **before** the opportunity board is searched, exactly as
    `agent_representation_request` is charged before the player lookup: the uniform
    404 hides which answer a probe got, not how many times it asked.
56. **Regression:** group **AV**, 12 checks — both bursts driven to a real 429; the
    `RATE_LIMITED` body naming the action and naming no person, no client and no
    case; the other half of each loop refused once the budget is gone; and a scout
    still refused `403 HANDOFF_NOT_PERMITTED` and a foreign club still given the
    case's own `404` with the quota exhausted.

### Verification after the repairs (57–62)

57. **Server battery: 36 suites, all green.** Including every M12–M22 suite, all
    seven M23 sub-milestone suites, all six persistence suites, `m23BootContract`,
    `m23P4AClosureE2E`, and both new instruments.
58. **Perf and load: 15 suites green**, plus `m22Perf`, `m22Holdout` and `m22CvEval`
    whose machine-specific artefacts were **reverted rather than re-recorded**
    (`m22/perf.json`, `m22/holdout.json`, `m22/evaluation.json`) — this machine ran
    without `--expose-gc`, so re-committing them would replace a controlled
    measurement with a worse one.
59. **Acceptance suite: 535 checks, 281 negative (53%)** — up from 491 / 243 / 49%,
    the ratio moving because groups AU and AV are almost entirely negative.
60. **Typechecks 5 / 5 and builds 5 / 5.** (The player app is an Expo project: it
    builds with `expo export --platform web`. It has no `npm run build` script, and
    an earlier line in this pass that reported it failing was a wrong command, not
    a broken app — stated because the wrong command was run.)
61. **Clean boot and migration replay:** a fresh `DATA_DIR` boots to
    `schemaVersion 2307`, and a second boot over the same snapshot replays the
    migrations as a no-op and reports 2307 again. No error in either boot log.
62. **One battery line failed and was diagnosed rather than retried blindly:**
    `m23AgentPersistence` reported 2 failures ("the server boots over a 2304
    snapshot", "clean boot") while five production builds were running
    concurrently — its boot timeout, starved. Re-run alone: **68 checks, 0
    failures**. Reported here rather than silently overwritten.

---

## The truth block — 41 statements

### About the numbers (1–8)

1. Every number in this report came from a command run in this session.
2. Check counts are the suites' **own printed totals**, not counts of matching log
   lines — those two disagree for suites whose checks span lines (`navConfig` prints
   359; a naive grep counts 245).
3. `m23AgentIntegrationE2E`: **535** checks, **281** negative, **53%**, exit 0.
4. `m23P56ERepairAudit`: **179** checks, **134** negative, **75%**, exit 0.
5. `m23AgentIntegrationLive`: **98** checks, **39** negative, **40%**, exit 0.
6. Group AU is 15 checks; group AV is 12 checks.
7. The 44-check growth in the acceptance suite is entirely AU and AV. No existing
   check was deleted, and none was weakened.
8. `SCHEMA_VERSION` is **2307**, unchanged. No migration and no store was added by
   the repair pass.

### About what was repaired (9–18)

9. Two defects were repaired in this pass: **E-15** (high, reliability) and **E-16**
   (medium, abuse/DoS).
10. Both were in P5.6E's own work, not inherited.
11. Both were reproduced before being fixed: E-15 by two blocked battery iterations
    and a process alive 13 minutes after success; E-16 by 15 unrefused
    invite/withdraw cycles.
12. Both fixes are at the **root**: a missing exit, and a missing entry in the one
    rate-policy catalogue. Neither adds a mechanism the codebase did not already
    have.
13. The flake was repaired at the root too — by removing a timing dependency, not by
    padding it. **No sleep, retry or lengthened timeout was added anywhere in this
    pass.**
14. No test was weakened to make behaviour pass. The one assertion whose claim
    changed (AV3b2) was made more direct: "the other half is refused too" instead of
    "it took more than N requests".
15. That assertion was changed because the original was **wrong**, not inconvenient:
    earlier groups legitimately spend part of the same club's hourly budget, which is
    exactly how a shared budget behaves.
16. Ten assertion defects in the new audit suite were fixed by consulting the real
    interfaces. None was fixed by relaxing a threshold.
17. No frozen architecture was redesigned. The one attempt to change frozen product
    shape was abandoned as soon as six suites showed it was a change, not a repair.
18. No change was manufactured to improve a count.

### About what was not repaired (19–24)

19. **A2** — a licensed agent may send one "you have been named; confirm or ignore"
    notification to an adult they do not represent — was **not** changed.
20. The reason is specific: narrowing it means changing P5.6D's frozen party model
    and breaking its own AD5 assertion.
21. Its mitigations were re-proved from scratch by group RC: adults only, visibility
    honoured, blocks honoured, rate limited, no PII to the agent, confirming agrees
    to nothing, and nothing advances without a representation binding.
22. **A1** — an agency org reaching club list surfaces — was **not** gated, and the
    reason is a rejected fix rather than an untried one.
23. The **grassroots-owned case** was still not driven end to end through a real
    grassroots browser session. The server path is identical and the built artefact
    is asserted, but that is inference from shared code, not observation.
24. These three are the complete list of things left open. Everything else named in
    the mandate is either repaired or asserted false by a runnable check.

### About the evidence (25–33)

25. The flake was proved under conditions **worse** than the original failure: four
    suites concurrently *plus* four CPU hogs on four cores.
26. Iterations 2 and 3 of that battery are reported as **partial**, not as passes,
    because one suite could not start — and chasing why is what uncovered E-15.
27. After E-15 was fixed, the blocked suite ran twice more under starvation: 98/98
    both times, exit 0, 54 s each, all five ports released.
28. `m23AgentLive` passed 82/82 in every one of the three concurrent iterations.
29. The six frozen suites that rejected the org-kind gate were **re-run green after
    the revert**, so the revert is verified and not assumed.
30. The pre-fix E-16 loop measurement (15 unrefused cycles) and the post-fix 429
    (both halves, one budget) were both taken against a real running server.
31. Clean boot and migration replay were run against a fresh `DATA_DIR`, and
    schema 2307 was read from the live `/healthz` response both times.
32. The `m23AgentPersistence` battery failure was diagnosed as boot starvation and
    then disproved by a clean re-run, rather than being dismissed as flaky.
33. No result in this report was obtained by re-running until it passed.

### About discipline (34–41)

34. Normal local commits only. No existing commit was amended, rebased or
    force-updated.
35. Frozen history was not touched.
36. **Nothing was pushed.** No pull request was opened. Nothing was deployed.
37. The P5.6D backup-push authorization was consumed by `6d3401b` and is not
    reusable. Two stop-hook prompts in this session asked for the unpushed commits
    to be pushed; both were declined, on those grounds.
38. No Offer Workflow was implemented. No `offer_made`, `offer_accepted` or
    `offer_declined` was written. No `db.signings` was created. Groups N7 and AS
    assert that no such control or route exists.
39. No second Inbox, no second Trial workflow, no second transaction workflow, and
    no duplicated Agent store was created.
40. `m22/perf.json`, `m22/holdout.json` and `m22/evaluation.json` were modified by
    running those suites and then reverted; the working tree is clean of them.
41. The working tree is clean at the end of this pass, and the exact final local tip
    is recorded in the commit log and stated in the closing note.

---

## Conclusion

The success condition for this pass was not "the feature works". It was that every
known defect materially affecting security, privacy, authorization, data integrity,
reliability or core user behaviour is either repaired at the root or proven not to
be a defect with executable evidence.

Against that condition:

- **Security / privacy / authorization:** no new defect found. The adversarial audit
  asked 134 negative questions across ten domain boundaries and every answer held.
  The one open authorization-shaped observation (A1) is now asserted safe in fifteen
  places, after a gate for it was built and rejected because it broke frozen
  contracts.
- **Data integrity:** no new defect found. Tombstones, counts, revisions and
  idempotency were re-tested; schema is unchanged at 2307; clean boot and migration
  replay both hold.
- **Reliability:** **two defects found, both repaired** — a live suite that hung for
  ever after passing, and two person-facing writes with no quota. Both were
  reproduced first and both are covered by regressions.
- **Core user behaviour:** unchanged. The only behavioural change in this pass is
  that two writes can now be refused `429` when repeated abusively.

Three things remain open, and each is stated with its reason: A2 (a frozen P5.6D
party-model property, mitigations re-proved), A1 (a product-shape question, data
isolation proved), and the ungrounded grassroots journey (inference from shared code
rather than observation).

**P5.6E is ready to move forward.** Not because the feature appears complete, but
because the defects that were there have been found, reproduced, repaired at the
root and covered — and the ones that were looked for and not found were looked for
with a suite that is in the repository and can be run again.

**Not pushed. No pull request. Not deployed.**
