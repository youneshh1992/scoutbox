# Bringing the batteries across

The TypeScript server's e2e batteries (`../scoutbox/scoutbox-server/e2e/`, 56 batteries, ~81k lines) are the
specification the Gleam server has to meet. Most of them used to import the TypeScript server's own code, so they
couldn't run against another server. This plan makes every battery language-neutral at its source, so that one
file passes on both servers. Where a battery checks rules rather than HTTP behaviour, it also gives those checks a
path to the Gleam side.

## What the coupling is

46 of the 56 batteries imported TypeScript-server internals, from 104 modules. Fixtures and readback were only
about 5% of that. Most of a coupled battery was a unit test of TypeScript modules. These were pure-engine sections
before the first boot, plus stray rule assertions in the HTTP sections, and they made up about three quarters of
all internal uses. Each battery therefore holds two specifications: the server's behaviour over HTTP, and the
rules inside it. They get different treatments.

The server's test contract is also wider than its routes. It includes environment variables, the test clock, and
the development routes (`/__faults`, `/__rate-limits`). `e2e/support/CONTRACT.md` documents all of it, and
`testE2ESupport` fails when a battery uses a setting that page doesn't name.

## Principles

1. **A battery imports nothing from the server tree.** Everything it needs comes from `e2e/support/`, which is
   language-neutral or generated.
2. **Untangle at the source, keep the TypeScript server green.** Every change is made in
   `../scoutbox/scoutbox-server`, and its `npm test` and `npm run e2e` pass after each battery. The Gleam
   repository never edits a copy.
3. **One battery file, two targets.** The only file that differs between the repositories is the launcher,
   `e2e/support/server.mjs`. `sync.mjs` copies everything else byte for byte and refuses any reference outside
   `e2e/`.
4. **No check is dropped silently.** A check that leaves a battery is moved, never deleted, and the ledger records
   where it went.

## Treatment by kind

| Kind | In the TypeScript tree | On the Gleam side |
|---|---|---|
| **Rule checks** (pure-engine sections, stray rule assertions) | Move them verbatim to `scripts/rules/<domain>/<battery>.mjs`, run by `npm test`. | Generated gleeunit tests from recorded calls (see Rule cases), or hand ports. |
| **Rule as an HTTP oracle** | Replace the call with the literal it returns for that fixture. | Nothing beyond the battery. |
| **Specification tables** | Snapshotted to `e2e/support/spec/<module>.json` by `scripts/specSnapshot.mjs`. Batteries import the JSON. Tables that hold functions keep only their data. | Declared as typed Gleam values. One test per table proves it equals the snapshot. |
| **Fixture writes** | `e2e/support/sqlFixture.mjs`: plain SQL against the migrated schema. | Shared as is. |
| **Storage readback** | `e2e/support/sqlRows.mjs`: stored rows exactly as stored. | Shared as is. |
| **Repository refusal of bad fixtures** | To that repository's unit suite. Where the schema itself refuses the record, keep it as a plain-SQL insert that must throw. | Schema checks come across. Validation gets Gleam repository tests. |
| **Implementation facts** | A real contract becomes a schema check. Anything else goes to a TypeScript unit suite. | Schema checks are shared. |
| **Implementation unit tests** | To TypeScript unit suites. | Hand-written when the subsystem is ported, and recorded in `ACCEPTED`. |
| **Process contract** | Documented in `CONTRACT.md`. | Implemented as each piece is needed. A battery whose piece isn't ported stays off `BATTERIES`. |

## Rule cases

`npm run cases` (in this repository) runs each TypeScript rules suite under a module hook. The hook records every
call to a rule module (`domains/**` minus Box Cam analysis, `domain.ts`, `temporal.ts`, `roles.ts`). Each call is
attached to the assertion that follows it, and the clock is frozen. A call is kept when its arguments and result
are plain data. `dev/battery_cases/map.mjs` maps each ported TypeScript function to its Gleam counterpart, with
printers written per type. The generator writes one gleeunit test per distinct call into `test/scoutbox/battery/`,
and these files are never edited by hand. `cases:check`, part of `e2e:check`, fails when they are stale.

- **Unmapped functions generate nothing.** They are listed as pending in `dev/battery_cases/report.json`.
- **Some calls must be hand-ported** into `test/scoutbox/<domain>/` and recorded in `HAND_PORTED`. These are calls
  that take closures or stateful stores, and inputs Gleam's types can't hold (`NaN`, `Infinity`, `undefined`,
  wrongly typed values). Most of the hand-port backlog is of the second kind. Many of those calls reduce to "the
  type system refuses this", so a short test per function usually answers them all.
- **Vocabulary and error-code constructors are read from the Gleam source**, so their names can't drift. A record
  printer refuses a JavaScript field it has no mapping for.
- **Not birdie.** The expected values have to come from TypeScript, not from Gleam's own first run.

## Box Cam: everything but the video

Box Cam's video analysis is moving to a separate service. The Gleam port takes the rest of Box Cam: the records, the
routes and the rules over observations. Server-side video work is all in the TypeScript tree's
`domains/development/boxcam/cv/` (frame decoding, the detection, tracking and scene engine, the holdout evaluation and
the `production_cv` provider). Nothing outside `cv/` touches a frame.

- **Ported:** sessions, training (assignments, challenges, the development plan, preferences, disputes, restores),
  the At-Home Combine and the drills. That includes the rules that turn a session's stored observations into active
  time, reps and a verification state, and the streak and challenge-progress rules. Clients send observations as JSON
  batches, so these rules are pure and get rule cases like any other domain.
- **`local_test` is ported.** It is the test-only observation provider (`BOX_CAM_TEST_PROVIDER=1`), not a video
  analyser: a scripted observation stream whose results are always labelled simulated.
- **`production_cv` is a stub:** one small module whose provider health is always `unavailable`. `/cv/begin`,
  `/cv/frames`, `/cv/finalize` and `/cv/cancel` answer `503 PROVIDER_UNAVAILABLE`, a code already in the TypeScript
  contract, so a client treats it as an outage. `/box-cam/cv/ready-check` reports the provider unavailable.
  `/admin/box-cam/cv/results/:id` only reads stored `box_cam_cv_results` rows, so it is ported properly.
- **The provider registry is spec data.** `DRILLS`, `PROVIDERS`, the Combine protocols, `cv/eligibility`'s tables and
  the gate's `evaluation.json` are snapshotted to `e2e/support/spec/`. The Gleam server serves the snapshot as it is,
  so it reports `production_cv` as `configured`, as TypeScript does. A deployment sees that this server has no CV from
  the provider's health. This also settles what `/capabilities` reports for `productionHardening`.
- **Batteries:** `development/boxCamCvProvider`, `boxCamCvRobustness` and `combineProductionGate` are
  `TYPESCRIPT_ONLY` for good. `development/boxCam` and `development/combine` are not split. They call no CV route,
  and their only `cv/` coupling is two imported eligibility functions, which the spec snapshot replaces. They are
  untangled like any other battery.
- Batteries outside Box Cam that start the server with `BOX_CAM_TEST_PROVIDER=1` (`passport/trustScore`,
  `discovery/matchingAndWatchlists`, `discovery/secondLookAndNobodyMissed`, `development/hub`,
  `platform/contracts`) keep using `local_test`. They need no fixture rows.
- How the video service will hand results over isn't designed yet. That decides only where real results come from:
  Combine results in tests come from `local_test`, so nothing in the port waits on it.

## Progress

### Infrastructure and normalisation [done]

Done on `battery-untangle` in `../scoutbox`:

- `e2e/support/` holds the fixture writer, the row reader, the case plants, the launcher, the spec snapshots,
  `CONTRACT.md`, an independent `totp.mjs` and `testPort.mjs`.
- `scripts/e2eBoundary.mjs` enforces the boundary with two lists. `NOT_YET_NEUTRAL` may only shrink, and
  `TYPESCRIPT_ONLY` is permanent.
- One codemod moved every server start onto the launcher.
- `sync.mjs` uses the same boundary check as the TypeScript tree.

### Untangling [in progress: 48 of 53 neutral]

**Untangling is cheap.** A heavy battery takes a few minutes, not the half session first estimated. It doesn't
have to wait for its domain's port: `contracts`, `dates`, `productionHardening` and `sessionsAndPorts` were done
early. What costs time:

- **Readback semantics.** Repository reads hid things that raw rows show: tombstone rows (`deleted_at` set), and
  vacuous checks over collections that didn't exist. Check what a rewritten readback actually reads.
- **Fixture rows.** Copy them from what the repository wrote in a probe run.
- **Rule oracles in HTTP sections.** These are slower to replace than moving whole sections.

Every untangled battery is mutation-checked at least once. One mutation that wasn't caught turned out to be a gap
in the original battery, so check the original before blaming the rewrite.

### Porting, domain by domain [in progress: 44 batteries pass unchanged]

Port order is domain by domain, with the cross-domain batteries last. The `platform/*` batteries reach into most
of the product, so they aren't one slice.

| Area | Batteries passing | State |
|---|---|---|
| Platform (staff, safeguarding, players and guardians, store guarantees, messaging, notifications, delivery, connected mode, sessions and ports) | 9 | done |
| Verification | 2 | **ported**: the first domain with every ledger row closed |
| Recruitment: Rooms, Offers, decisions, lifecycle, trials, contacts, signings, analytics, the journey | 19 | done |
| Discovery: Second Look and Nobody Missed, exposure, calibration and coverage, matching and watchlists | 3 | done |
| Agents: core, core persistence, transactions, transactions persistence, compliance, compliance persistence, adversarial, cross-app, cross-app adversarial | 9 | done |
| Scouting: club workflows | 1 | **ported** |
| Development: Box Cam, the Combine, the hub | 0 | next |
| Passport: the Passport, the Trust Score | 1 | `passport/passport` passes; `trustScore` waits on Box Cam |
| Cross-domain: `api`, `contracts`, `dates`, `productionHardening` | 0 | last |

#### Port order

Work down this list. Mark each item `[**done**]` when it is done, and commit the mark with that work. Notes here
are for surprising facts or points that later work depends on, not implementation detail.

1. **Finish recruitment.** Untangle each battery first.
   1. `recruitment/analytics` [**done**]. `journey` section I waits on it, and `lifecycle` and
      `journeyAdversarial` use its funnels. A read-only domain can be compared whole by booting both servers on
      copies of a database a TypeScript battery left behind in the temp directory: that exercised every family
      here, which the seed does not.
   2. `recruitment/lifecycle` and `recruitment/decisions` [**done**: both pass; their rule cases are still pending
      (decisions 120, lifecycle 2,927)]. A plain case's routes answer the whole stored case record, Room, budget and
      handoff included. Under load, two lifecycle acts on one rev both committed: the Room acts re-check the rev
      inside their unit.
   3. `recruitment/journeyPersistence` [**done**: it passed on first run, since its routes were all in]. A journey
      finds a legacy signing by player and club, not through the case's `links_signing_id`: a legacy signed case
      planted without its link still passes, in the original battery too.
   4. `recruitment/journeyAdversarial` [**done**; its rule cases are pending (30)]. A journey counts only the
      assessments of its own case: one in the context of another case's Trial is that case's. B3 and G6 assumed
      the single thread's race winner and now accept either. P4 passes only because a restart empties the
      in-memory event replay first: the player's own ledger frames name `recruitment_room_created`.
      `/org/players/:id/morelike` has only its guards (501 past them).
2. **Discovery, alongside recruitment.** `decisions`, `lifecycle` and `journey` section H5 all call
   `/org/second-look`, so recruitment can't close without it.
   1. `discovery/secondLookAndNobodyMissed` [**done**]. Nobody Missed reads the stored match facts, which the store
      re-derives inside every unit just before COMMIT (`store.with_before_commit`), as the TypeScript keeper does:
      matching and the watchlists can use them as they are.
   2. `discovery/exposureCalibrationAndCoverage` [**done**: the insight domain, bar its sweep]. The type → category
      table for notifications was only partly ported, so types such as `evidence_request`, `calibration` and
      `recruitment_room` escaped their category's mute. It is now whole, and its test requires equality with the
      snapshot.
   3. `discovery/matchingAndWatchlists` [**done**; with it `recruitment/journey`, whose Z1 was all that waited].
      It never read a Box Cam result: its output is the same without `BOX_CAM_TEST_PROVIDER`, so no fixture rows
      were needed. The match engine is one set of modules (`discovery/matching/`), which Nobody Missed now shares.
      The org audit feed gained its brief and watchlist sources. Pending: the event registry's rules and `ageOn`
      (11 cases, with `dates`).
3. **Agents**: the other 8 batteries. `journeyAdversarial` and `operations` also call `/org/agent`.
   1. `agents/corePersistence` [**done**]. The agent sweep (expiry and stale-facet notices) runs at boot and with the
      periodic sweeps; a marker that changes no row sends nothing, so a lost race is never a crash.
   2. The agent core's rule cases [**done**: 182 generated; 15 pending have no Gleam counterpart (`newFacets`,
      `normaliseScope`, `termMonthsOf`, `tiersOf`: Gleam refuses or types what TypeScript cleans)].
   3. `agents/transactions` and `agents/transactionsPersistence` [**done**: the persistence battery passed on first
      run; the main battery's OL2 waited on `POST /org/opportunities`, ported ahead of item 4 with the board]. The workspace needed a slice of the
      compliance ledger: reviewer sign-in and the `/ts` session, the review queue and the decision on a declared
      binding, and regulatory consents (request, both parties' answers, lists). Decisions on facets, disputes and
      conflict evaluations answer 501. A compliance context now carries its bindings, and the engine attributes a
      colleague's verified binding in the same transaction. The transaction row keeps only `rev_by_label`: the
      schema has no column for a person.
   4. `agents/compliance` [**done**]. The reviewer lane, the agent's own contexts, the review lifecycle with every
      kind of decision, and dual-control policy versions are in; its 115 rule cases are pending. A block hides a
      player from an agency's compliance context as it does from everything else (`orgCanSee`). Bodies are now read
      in the order their keys were sent (`platform/key_order`): a policy version's rules keep that order, which is an
      API shape to change after the port (docs/known-issues.md).
   5. `agents/compliancePersistence` [**done**; its 2 rule cases are pending with compliance's]. The dev reviewers
      are seeded at any boot that finds the reviewer table empty with dev logins on, not only by the demo seed, so a
      fixture database has them too (`agents/dev_reviewers`). `/ts/compliance/policies` leaves out a rule's
      `overrides` and its own `effectiveFrom`, on both servers: the battery compares whole seeded rules from the
      stored rows instead, decoding each parameter by its type in the snapshot's `RULE_PARAMS`.
   6. `agents/adversarial`, `crossApp`, `crossAppAdversarial` [**done**; their rule cases are pending (adversarial 85,
      crossApp 96, crossAppAdversarial 2)]. A fixture can now plant a password: `support/password.mjs` writes the stored
      form, `testE2ESupport` proves the TypeScript server verifies it, and `CONTRACT.md` names the stored forms. The
      failed-login budget locks once more than 20 wrong guesses are in the window, as TypeScript's `peek` does (this
      server locked at 20). A regulated integration surface asks the compliance engine (`clear_to_declare`; until
      now it always read "not clear"), which changes routed contacts too. The club's Passport read
      (`/org/players/:id/football-passport`) has only the player, the viewer and the representation in force: the
      rest waits for the Passport port. `/player/applications` isn't ported, so crossApp's G8 passes vacuously here.
      The agent contract gives a field's own code only to a field the request declares (`declaredCodes`): an unknown
      `clientKey` is `AGENT_INPUT_INVALID`.
4. `scouting/clubWorkflows` [**done**: the scouting domain is ported]. Every section's responses match the TypeScript
   server's, notifications included. The `feedback` and `applications` live events reach no stream on either server
   (the registry calls them org-private but names no org), and a list is accepted as a drawing (docs/known-issues.md).
   Uploading moved out to its own battery, `platform/uploads` (26 checks), which stays off `BATTERIES` with the upload
   subsystem; a move to another battery needs no reviewer's verdict in the ledger. A save refused after the TypeScript
   server minted a new role's id still burns that id there, so id numbers drift between the servers; no battery reads
   them. Signing follow-ups (`operations/follow_ups`) run at boot, every sweep and on `/admin/sweep`; the rest of the
   TypeScript sweep (application reminders, trial-feedback escalation, the completed-trial assessment reminder,
   upload clean-up) is marked `Not ported yet:` there, for `operations/clubOperations`. The benchmarks' position
   groups come from the newly snapshotted `PROGRAMME_TRACKS` (`spec/grassrootsJourney.json`).
5. **Box Cam** (see "Box Cam: everything but the video"). Untangle `development/boxCam` and `development/combine`
   first, then port sessions, training and the Combine with the `production_cv` stub, then `development/hub`.
   `passport/trustScore` reads Combine results, so this goes before the Passport.
6. **Passport.** `passport/passport`, then `trustScore`. `passport/passport` needs no Box Cam, so it goes first.
   1. Untangle `passport/passport` [**done**]. A table whose entries hold functions is snapshotted from a data-only
      export beside it (`GAP_RULE_TABLE` beside `GAP_RULES`). The public share link's limiter is now the shared
      `passport_share_read` (30 a minute), which `RATE_LIMIT_POLICY` had listed but nothing used.
   2. The engine (`passport/passport_rules`) [**done**: 68 rule cases]. The recorder seeds randomness as it freezes
      the clock, so a rule called with a random value records the same each run; a rule whose result is random is
      listed in `RANDOM` and ported by hand.
   3. The routes, on the engine, with `passport/sources` reading the stores [**done**: `passport/passport` passes,
      and 42 Passport requests answer exactly as TypeScript's do]. A Passport preference that moves the primary
      position writes the `position_changed` source change Second Look reads; nothing here wrote one before.
   4. A Room's Passport is the club's whole projection, and a snapshot records its revision [**done**]. Box Cam's
      sections (development activity, Combine results) are a player's with none until Box Cam is ported.
7. `operations/clubOperations`.
8. **The cross-domain batteries:** `platform/api`, `contracts`, `dates` and `productionHardening`.
9. **A performance sweep, after every battery passes.** Don't let it hold up the port. The server calls
   `list.length`, `list.unique`, `list.contains` and friends on lists all over, including on hot paths and inside
   loops, where each is a linear walk. Add a small library that does these operations in the fastest way possible
   (sets and dicts for membership and de-duplication, a length taken once), and move the hot call sites onto it.
   Measure before and after with `dev/perf.mjs`.

Throughout the port, map the `dates` rule cases (2,253 pending) as the date rules are ported, since every domain
uses them.

Patterns established on the way. New domains should reuse them, and `CLAUDE.md` holds the rules:

- **Effects after COMMIT** (`store.emit`) for pushes, mail, live events and webhooks.
- **Lost races are values.** An act re-checks inside its unit and answers `store.stale`, and
  `http.rerun_on_stale` re-runs the route. Any act that two requests can race needs this. The BEAM's concurrency
  exposes races the TypeScript server's single thread hid.
- **Slow work goes before the unit.** Password hashing and outbound HTTP must run outside the unit, because a unit
  holds the only writer.
- **The request clock** (`clock.request_ms`) is read only where the TypeScript server reads
  `SCOUTBOX_TEST_CLOCK`.
- **Rules are proved against TypeScript** with `dev/*_cases.mjs` (trust, conflict, transactions, zones, scrypt).
  Whole responses are compared with `dev/shape_diff.mjs`, and for heavy acts the stored rows are compared with a
  probe run on both servers.
- **Port TypeScript bugs as they behave,** and note them. Examples: `uncorroborated_claims` never fires, a
  journey's history never names anyone, a snapshot's `passportVersion` is always null, and the journey evidence
  funnel never counts a case's current status as "history only".
- **Query strings are read as Express's `qs` reads them:** `source[x]=…` is an object under `source`, so a shape
  refuses it as not text (`http.query_input`).
- **Field order a client doesn't rely on may be relaxed in the test.** A decoded JSON object here has no order, so
  where the TypeScript server names the first of several unknown fields as sent, this one names the first
  alphabetically. Where that order means nothing to a client (a refusal naming one of several forged fields, say),
  relax the check in the TypeScript battery to accept any of them, and sync. Where a client may reasonably rely on
  the order for a UI feature, stop and ask before changing the test. Done so far: `agents/compliance` K14 and T7.
- **Port only as far as the battery reaches.** Mark the rest `Not ported yet:`. There are 120 such markers, and the
  next battery in a domain usually starts by clearing some.

Measured trade-offs to keep in mind:

- **Scrypt** is pure Gleam and about 12 times slower than Node: 467 ms per hash, about 13 sign-ins a second at
  most, but it doesn't block other work. If that matters, use a NIF or PBKDF2, on both servers together.
- **SSE** fan-out is about 8 times faster than TypeScript at 1,000 streams, but uses about twice the memory per
  stream.
- **Reads** go through a patched esqlite (`vendor/esqlite.patch`): a query's rows in one NIF call on a normal
  scheduler, with a statement cache. The one-client directory is within 7% of TypeScript, and it runs at 4.6 times
  TypeScript's throughput at 32 clients. Stock esqlite was 1.9 times slower for one client and stopped scaling
  past one reader. Details: the evaluation's "Read speed, and the decision".

Open questions:

- **Reviewer verdicts** in `ACCEPTED` are missing for the moves to TypeScript unit suites made while untangling
  `sessionsAndPorts` and `contracts`.
- **The process contract** still lacks `SCOUTBOX_TRUST_PROXY` and the dev mail transport's full-text copy
  (`/admin/outbox`).

### The ledger [done]

`scripts/e2eLedger.mjs` in the TypeScript tree reconciles every battery's checks against a frozen baseline
(`3c843bb2`): baseline = battery + rules suite + moved − added. It counts helpers built on `ok`/`neg` too.
`dev/ledger.mjs` here writes `scoutbox-server/LEDGER.md`, and `e2e:check` keeps it current.

**A domain is ported when** every battery in it passes unchanged on Gleam, no recorded call is pending, every
hand-port is done, and every move to a TypeScript unit suite has an accepted verdict. The ledger can't prove that
a battery passes; `npm run e2e` does.

## Estimate

Untangling the remaining 6 batteries is about **1–2 sessions** in all, and can run ahead of the port. The real
cost is the port itself. The rule-case backlog is mostly mapping work that grows with the ported rules: about
6,700 cases pending (2,242 of them in `dates`) and about 460 hand-port calls, by `LEDGER.md`.

## Risks

- **A literal pasted in for an oracle is right only for that fixture.** Keep the rule's coverage in the rules
  suite, and take policy values from `spec/`.
- **Rewriting a check can weaken it.** Mutation-check every battery once.
- **A shared snapshot spreads one mistake to both servers.** That is no worse than today.
- **The recorder misses rules that read state.** A module whose calls mostly can't be recorded is probably not a
  pure rule.

## Out of scope

Uploads and outbound providers other than webhooks (their batteries stay off `BATTERIES` until the subsystem is
ported), and the UI e2e suites in `../scoutbox/e2e/`.
