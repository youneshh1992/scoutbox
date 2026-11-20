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
  wrongly typed values). Dates, byte buffers and Maps are recorded as tagged data (`$date`, `$bytes`, `$map`). Most of the hand-port backlog is of the second kind. Many of those calls reduce to "the
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

### Untangling [done: 53 of 53 neutral]

**Untangling is cheap.** A heavy battery takes a few minutes, not the half session first estimated. It doesn't
have to wait for its domain's port: `contracts`, `dates`, `productionHardening` and `sessionsAndPorts` were done
early. What costs time:

- **Readback semantics.** Repository reads hid things that raw rows show: tombstone rows (`deleted_at` set), and
  vacuous checks over collections that didn't exist. Check what a rewritten readback actually reads.
- **Fixture rows.** Copy them from what the repository wrote in a probe run.
- **Rule oracles in HTTP sections.** These are slower to replace than moving whole sections.

Every untangled battery is mutation-checked at least once. One mutation that wasn't caught turned out to be a gap
in the original battery, so check the original before blaming the rewrite.

### Porting, domain by domain [in progress: 53 batteries pass unchanged]

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
| Development: Box Cam, the Combine, the hub | 3 | `development/boxCam`, `combine` and `hub` pass, with the `production_cv` stub |
| Passport: the Passport, the Trust Score | 2 | **ported** |
| Operations: club operations | 1 | **ported** |
| Cross-domain: `api`, `contracts`, `dates`, `productionHardening` | 4 | done |

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
   1. Untangle `development/boxCam` and `development/combine` [**done**: their pure sections are rules suites (40 and
      20 checks, 62 rule cases pending)]. The CV eligibility checks moved whole with the rest, so no `cv/` table was
      snapshotted. Combine's check 27 reads the protocol from `GET /org/combine/protocols`.
   2. Box Cam's engine, sessions and training [**done**: `development/boxCam` passes, with its 40 rule cases, and
      the 39 responses of one probe flow match TypeScript's exactly]. The drill and provider registry is declared in
      Gleam and checked against the new `spec/development/boxcam` snapshot. The Passport's development activity, its
      Box Cam milestones and completed challenges, and a Room's development section are real now. A dispute's budget
      is five a day per player, from training.mjs's own window, not the `box_dispute` entry of `RATE_LIMIT_POLICY`
      (five an hour), which nothing uses. Cancelling a session reads the nonce but never compares it, on both
      servers. The clip, the development plan and the club's drill list are `Not ported yet:`.
   3. The Combine [**done**: `development/combine` passes, with its 22 rule cases, and the 57 responses of one probe
      flow match TypeScript's, notifications included]. The protocol registry is declared in Gleam and checked against
      the new `spec/development/boxcam/combineShared` snapshot; the copy recorded from a running server is gone. An
      attempt is measured inside its bound session's completion, through either complete route. A request's state and
      its completed protocols are worked out at read time, as in TypeScript: an invalidated session reopens a completed
      request in every view while its stored state stays `completed`. `production_cv` certifies nothing for the
      Combine (no protocol has passed real-world validation). The Passport, a Room and a Room's snapshots now carry
      the player's real results, and the Passport's revision their `cmb=` entries.
   4. The `production_cv` stub [**done**: `development/cv_stub`]. Each provider-session route runs the TypeScript
      route's own checks first (budget, refused client fields, body, session, nonce; `begin` also its state checks),
      and 25 of those answers match TypeScript's exactly; then it answers `503 provider_unavailable`. The policy it
      checks against (frame limits, candidate protocols, refused fields, versions, the Combine-disabled reason) is
      the new `spec/development/boxcam/cv/` snapshot. Finalizing a session whose result is already stored answers
      503 too, rather than that result: no result can be stored here.
   5. Untangle `development/hub` [**done**: its §1–§8 and one stray engine check are a rules suite (91 checks, with
      their numbered cases), 71 rule cases and 44 hand-port calls pending]. The battery scans payloads for forbidden
      field names itself, over the snapshotted `FORBIDDEN_FIELD_NAMES` (`spec/development/hub/shared`). Its §17 also
      asks for a `production_cv` Combine attempt and expects the 422 `REAL_WORLD_VALIDATION_NOT_COMPLETED`, which the
      Combine already answers.
   6. Port the hub [**done**: `development/hub_rules`, `hub` (its tables) and `hub_routes`, mounted on the player,
      guardian and organisation routers; the organisation audit feed gains the plans' lifecycle]. All 233 checks pass,
      and a probe of 90 requests compares whole responses: 89 match TypeScript, the one left a tie between a Box Cam
      session's end and its Combine attempt's completion, which this server stamps with one clock reading. 63 rule
      cases are generated; `planAccess` is hand-ported (`test/scoutbox/development/hub_access_test.gleam`);
      `parseDate`, `scanPayloadForForbiddenFields` and `buildTimeline` are closed. Left: `planSummary`,
      `buildGoalSnapshots` and `assertEventRegistry` (live events, not ported) as cases, and 23 hand-port calls
      (`resolveEvidenceLink`, `recordBelongsToPlayer` and `canAssign` read the database here; the battery checks them
      over HTTP). `/capabilities` now reports `production_cv` as `configured`, as decided above; it said
      `not_configured` before, which the hub battery's G6 caught.
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
   5. `passport/trustScore` [**done**: untangled (U1–U13 and the stray `agreementInForce` check are a rules suite of
      80 checks; the policy is snapshotted to `spec/passport/trust`), and it passes with its 65 rule cases]. Simulated
      evidence counts while `BOX_CAM_TEST_PROVIDER` is on, as in TypeScript; here it never did, so every Trust Score
      read (the routes, a Room, Second Look, Nobody Missed, the watchlists and the match facts' drain) now takes
      `allow_simulated`, and the match facts' policy key ends `|sim1` then. A profile's `simulatedEvidenceIncluded`
      says whether simulated evidence was allowed, not whether any was counted, on both servers. The engine reads its
      weights and identity values from the declared policy tables, which one test proves equal to the snapshot.
      `trustChangeReasons` and the public projection are used by no route on either server.
7. `operations/clubOperations`.
   1. Untangle it [**done**: its unit fixtures are a rules suite (32 checks; 26 rule cases and 7 hand-port calls
      pending), and its MFA codes come from `support/totp.mjs`]. `NOT_YET_NEUTRAL` is now empty. The battery still
      starts its own servers through the launcher: a restore into a second data directory, and a SIGKILL restart.
   2. Port it, one commit per slice, in the battery's order. Each section builds on the state the earlier ones
      leave, and a missing route crashes the battery rather than failing a check, so progress is how far it gets
      before its first failure. Every table is already migrated. The battery goes on `BATTERIES` only when all 241
      checks pass.
      1. Imports and integrations: CSV imports and their commit and reversal, identity reviews, prospects, API keys
         and `/api/v1/export/*`, and the webhooks' list, rotation and deliveries, plus `/org/connectors`
         (`integrations/imports.mjs`, `repositories/integrations.mjs`). Creating a webhook and its signed sending
         and retries are in already. [**done**: the battery's first 58 checks pass, up to onboarding, and 87
         requests answer as TypeScript's do, ids included.] A mapping to null doesn't leave its column out: a column
         named like a field falls back to that field, as JavaScript's `??` reads it. The onboarding task, the audit
         export's import histories and the metrics' webhook backlog are real now. A vocabulary value named like a
         prelude constructor (`error`) gets its type's name as a prefix (`DispositionError`).
      2. Enterprise: onboarding, `/org/sessions` and its revoke, `/org/security`, SSO against the local test IdP
         (`/testidp/authorize`), paged invites, support tickets with time-limited access grants and their access
         log, and the metrics' scope note (`enterprise/enterprise.mjs`, `repositories/enterprise.mjs`). MFA,
         invites, the audit export and support's create and reply are in already. [**done**: the battery's first 131
         checks pass, through the delivery centre, and 113 requests answer as TypeScript's do, ids included.] The
         process's request counters live in one process (`platform/request_metrics`): a response is counted once
         it is built, without waiting, and `/admin/metrics` answers in TypeScript's key order, with its
         `development` and `analytics` groups. The audit export's case histories and support
         access are real now, and so is onboarding's coverage-plan task.
      3. The delivery centre's flows over support replies, callbacks and injected failures (`messaging/delivery.mjs`).
         [Its checks already pass after slice 2.]
      4. Suitability: a player's preferences, an opportunity's requirements, the suitability view and sharing it
         with a club (`scouting/suitability.mjs`). [**done**: `scouting/suitability`; the battery's first 164 checks
         pass, through suitability, and 87 requests answer as TypeScript's do, ids included. `slotsOverlap`'s 4 rule
         cases are generated.] A slot's zone offset is taken at one fixed instant (15 January 2026), as TypeScript
         takes it, so summer time is ignored on both servers. A training slot counts as within the player's
         availability when it only overlaps it (docs/known-issues.md).
      5. Transitions: the club's list and pack view, the admin level review, and the legacy representation routes
         answering 404 (`verification/transitions.mjs`). The player's side is in already. [**done**: the
         battery's first 198 checks pass, through the legacy lane, and 42 of 46 requests answer as TypeScript's do,
         ids included; the other four differ only in the seed's own dates and random ids.] The case lists,
         withdrawing and placing are in too, and so is the transition sweep (expiry and the placement check-in), at
         boot and with the periodic sweeps, as in TypeScript; not on `/admin/sweep`. A pack's evidence shows only its
         id and recording time on both servers (docs/known-issues.md).
      6. Group workspaces: groups, membership, programmes, grants and `/org/shared/:id`, the group report
         (`groups/`, `repositories/groups.mjs`). [**done**: `groups/groups` and `group_routes`; the battery's first
         247 checks pass, through both group sections, and 57 requests answer as TypeScript's do, ids and
         notifications included.] Each act re-checks the group inside its unit and refuses from the state it finds
         there, so a lost race needs no rerun. The audit export's grants are real now.
      7. Budget scenarios: lines, exchange-rate assumptions, approval, actuals (`recruitment/budgets.mjs`).
         [**done**: `recruitment/budgets` and `budget_routes`; the battery's first 271 checks pass, through the
         budget section, and 48 requests answer as TypeScript's do, ids and case history included.] The totals and
         `convertMinor` are generated rule cases now (8 of the 26). Each act reads the case and its scenario inside
         its unit. Finance access is `roles.is_finance_role`, the lead tier plus `/finance|treasurer/i`.
      8. Backup, verify and restore into an empty directory, `/readyz`, and delivery work surviving a SIGKILL
         restart (`store.copyTo` in `wiring.mjs`). [**done**: `enterprise/backups`; all 277 checks pass, and the
         battery is on `BATTERIES`. 13 requests answer as TypeScript's do.] The copy (`store.copy_to`, `VACUUM
         INTO`) runs on a read-only connection, not the writer as in TypeScript, so units keep committing while it
         copies; it has its own long timeout and fails as `500 BACKUP_FAILED`, never a panic. The SIGKILL restart
         needed nothing new: every dispatch is a row, and the boot sweep picks it up. The manifest file is compact
         JSON, where TypeScript indents it.
      9. The rule cases (26, mostly `ageOn`, `isAdult` and `b32encode`) and the 7 hand-port calls. [**done**: all
         33 cases are generated and none is left to port by hand, so operations is ported.] The 7 hand-port calls were
         only a `Date` argument: the recorder now writes a Date as `{ "$date": ms }`, as it does bytes and Maps, so
         `ageOn` and `isAdult` calls are cases in every battery, about 100 fewer hand-port calls. The ones left take or
         give `NaN`, or a null dob, which Gleam's player can't hold. `webhookUrlProblem` is tested with local
         destinations allowed, since its suite sets `ALLOW_LOCAL_WEBHOOKS=1`.
8. **The cross-domain batteries:** `platform/api`, `contracts`, `dates` and `productionHardening`. Each slice is
   about a session. The gaps named below come from matching the batteries' paths against the router's strings, not
   from a run, so start each slice by syncing its battery and running it to see how far it gets. A battery goes on
   `BATTERIES` when all its checks pass.
   1. `platform/contracts` and `platform/productionHardening`. Both check hardening over routes that are mostly in
      already. The gaps seen so far are `/capabilities` and its honesty about the deployment, `/source-changes`,
      the CORS allowlist, the baseline security headers, the oversized-body refusal, and the production boot
      refusing simulated faults. Then their rule cases (36 and 27) and hand-port calls (16 and 22). [**done**:
      both batteries pass and are on `BATTERIES`, and the ledger has both done: 82 cases generated, 17 hand-port
      calls ported, and the rest closed in `NO_COUNTERPART`, mostly because the typed `Event` is the registry.] Most gaps were already
      closed. What was missing: a decision didn't re-check its Room's rev inside its unit, so two racing decisions
      both landed; CORS (`platform/cors`); `Retry-After` on a 429; and the request instrumentation
      (`platform/instrument`: correlation ids, the request log, the counters), which stands after the fault layer
      as TypeScript's does, so a preflight, a simulated fault or an unreadable body isn't counted
      (docs/known-issues.md). `events.registered` counts the registry's 98 names, declared in `live_event`, though
      only 69 of them can be emitted yet. Several rules-suite fixtures used values TypeScript can never produce
      (a trust band `established`, a change type `general_update`, a Passport identity other than unchecked or a
      ScoutBox document review, a reference status `live`, an evidence tier `verified`, a `When` without its
      precision), so they were fixed at source on `battery-untangle`. The integrity report counted every open
      Room in a duplicated group, where TypeScript counts each one after the first. `config.problems` is now
      pure and checks the Trust Score weights in every mode, and `box_cam_test_provider` reports `test_only` when
      it is on. Mail is always the local outbox here (no SendGrid), so `email_transport` never says `configured`.
   2. `platform/dates` [**done**: all 72 live checks pass and the battery is on `BATTERIES`; 2,079 of its rule
      cases are generated and 201 of its 241 hand-port calls ported]. Only verified attendance
      (`POST /player/attendance`) and reading the notification preferences (`GET /player/prefs`) were missing. The
      date rules are typed now. `platform/temporal` is temporal.ts: a `Day` is always a real day, an instant is
      whole milliseconds, and what can't be read is a typed problem (`DayProblem`, `InstantProblem`, `DueProblem`,
      `LocalProblem`, `age.DobProblem`); only the HTTP edge writes temporal.ts's words. A `zones.Zone` is always one
      the offsets table knows, which replaced the second zone list (`rules/time_zones`). Three day parsers became
      one, and `briefs` and analytics now share `isDayWithin` (a blank bound is open, as in TypeScript; `briefs`
      closed it). The analytics `Window` holds days. A record that mirrors a TEXT column and is read back from
      rows (an Offer's terms, a contract, an assessment's context) still holds the day's text, converted where the
      request is read: typing those is item 11's work. The 54 cases left are the agents compliance rules
      (`selectPolicyVersion`, `ruleStatusAt`, the minor gate, `consentSufficiency`) and
      `effectiveHandoffStatus`, which go with compliance's own pending cases; the 40 hand-port calls left are
      theirs, verification's `effectiveStatus`, and `validateScheduleInput` (a closure).
   3. `platform/api` §0–§12: auth, guardian sign-up's email-verification gate (`/auth/guardian/verify-email`,
      `/guardian/verify-id`), pairing (`/guardian/children/:id/pairing-code`, `/auth/player/pair`), a trial with
      alternative slots and its ICS, season history and preferences, saved searches and alerts, a mandatory report,
      moderation's escalation, the funnel and a signing to its invoice, club email-domain verification, exports,
      deletion and aging-up (`/player/aging-up/complete`), the admin resolve and the push log, and the platform
      separation. The battery has no rule cases. [**done**: all 88 checks of §0–§12 pass; the battery stays off `BATTERIES`
      until §13–§14 pass too.] Probed signed in against the TypeScript server, comparing error codes as well as
      statuses (an empty body hid three routes behind a 404 that looked unrouted). Ported: player passwords at
      sign-up and sign-in; guardian e-mail verification, the ID check (`identity/idv`: TypeScript's development
      attestation) and the disclaimer; pairing codes (`identity/pairing`, `pairing_codes` newly generated) with
      their two budgets (`limits.spent` reads a budget without spending it, for acts where only a failure is
      charged); a past season filed into the history; the saved-search list, delete and the alert when a player
      joins; the funnel's trials, reports and signings; the club e-mail confirmation; the guardian export; and
      aging-up. The dev transport now keeps a withheld code's full mail text in memory for `/admin/outbox`
      (`messaging/dev_mail`), as TypeScript's does. Unit tests cover pairing, the budget, season filing and the
      saved-search match, since the battery doesn't run yet.
   4. `platform/api` §13–§14: the Grassroots player journey (`/player/season-wrap`, `/org/looking-for`), the club
      toolkit (`/org/squad/:id/release`, `/org/pathway-record`), the typed open days, match days and friendlies, the
      player's record field by field, and storage and persistence on disk. [**done**: all 202 checks pass and the
      battery is on `BATTERIES`; from the programme on, 103 of the battery's 109 requests answer as TypeScript's do,
      with ids, codes and times masked.] The open days are `development/open_days` (the club's list, delete and
      answers, a player's and a guardian's registration, and the radar), the journey `development/grassroots_journey`
      (the programme and the season wrap). An organisation's view (`orgs.view`) carries its looking-for positions and
      federation check now, read by `orgs.setup`; they were always empty. The directory and the radar share the
      pathway record. `/player/me`'s `pathway.signals.coachVouches` counts the published references; it read 0. A
      list refuses a bad item by its index only through `input.items` or `items_between`: `input.list_of` names the
      list, where valibot names the item, and eight calls in six modules still use it. The six requests left differ outside this
      slice: the seed's attendance dates, `/org/players/:id`'s `similarPlayers.archetypes` (empty here), the legacy
      signing's response (`firstQualifyingInteraction` lacks the ledger row's other fields, and the record has six
      more), and `/player/export`'s threads and insights (empty here). Item 9 should take them.
9. **Parity beyond the batteries, after every battery passes.** The batteries reach only part of the server: 85
   `Not ported yet:` markers are left (development 20, recruitment 16, agents 10, scouting 9, identity 8, the rest
   fewer), `/org/players/:id/morelike` answers 501 past its guards, and a few TypeScript routes aren't routed at
   all. Many markers are stale: later slices ported what they name. For each slice from 1 on, first write the checks
   into a TypeScript battery (or a rules suite), pass them there and sync, so the behaviour is specified on both
   servers, then port it here. A domain is done when `grep "Not ported yet:"` finds nothing in it and it answers no
   501. Uploads and video analysis stay out of scope (see Out of scope). Slices 3 to 9 are independent of each other.
   0. Audit the markers [**done**: 66 `Not ported yet:` left (65 after slice 1), 5 re-tagged `Out of scope:`]. Each marker was checked
      against both trees. 12 were stale and went: the whole agents domain bar one live event, a Room's evidence
      gate and vacancy, a request's Contact, the decision draft, the verification tokens. Others now name only what
      is left (`season` filing and the safety console's claim mirror are ported, their live events aren't). Four
      describe TypeScript's own behaviour and became plain notes: the minor
      pathway, `request_consent`, the journey's Trust & Safety viewer (no route builds it), and legacy plain-text
      passwords. Most of what is left is live events (about 35 markers). The ledger markers were wrong: both
      schemas have the `detail_*` columns, and only `ledger.Entry` lacks them. `assessment_disagreement` never
      fires in TypeScript (it reads `value`, not `rating`), so it is in docs/known-issues.md, not here. The Box Cam
      clip uploads nothing (it tags a `/player/media` row), so it is in scope after all. The route diff found
      these TypeScript routes unrouted here: the film room's `media/:mid/tags` and `/view`,
      `POST /player/media/:id/captions`, `POST /org/assessments/:id/review`, `POST /admin/vouches/:id/revoke`,
      `POST /org/verification/domains/:id/remove`, the Box Cam development plan (player and guardian) and
      `GET /org/box-cam/drills`, and the uploads routes (out of scope).
   1. Item 8.4's leftovers: the legacy signing response's missing fields, `/player/export`'s threads and insights
      (`channels.for_player` and `insights.for_player` exist; only the wiring is missing), and the seed's
      attendance dates. `similarPlayers` goes with slice 5. [**done**: `platform/api` gained SD1, LS1–LS2 and
      EX1–EX2, and the three responses answer exactly as TypeScript's do, bar the export's signed media link.] A
      legacy signing answers the record `recordCompletedSigning` built, not the stored one: no package fields, and its
      first qualifying interaction is the whole ledger row (`signings.legacy_json`). The export's threads are every
      thread about the player, whoever the counterparty (`channels.every_for_player`). The seed dumper writes the
      two text columns TypeScript's seed takes from its clock (an attendance's day, a clip's upload instant) as SQL
      over `NOW_MS`; both were frozen at the dump's date.
   2. Live events, the whole registry. Do it in two parts:
      1. Delivery. Add the `public_safe` audience (every stream) and the subject rule (`liveSync.mjs`: a payload with a
         `playerId` and no `orgId` reaches the player, their guardian and every org that may see them and isn't
         blocked). Then add the catalogue pings: `players` (from about 25 acts, some unmarked: badges, the medical
         share, availability, the timeline, the first-team seeker, the film room, captions), `orgs`, `opportunities`,
         `openTrials`, `campaigns`, `friendlies`, `ledger`. `feedback` and `applications` reach no stream here, but
         the subject rule delivers them in TypeScript, which contradicts item 4's note: check that first. Also close
         a removed staff member's streams.
      2. The domain events no `live_event.Event` constructor declares: `inbox`, `requests`, `evidence`, the eight
         `development_*`, the `contact_*` events with `contact_responded` and `contact_agent_routed`,
         `player_development_evidence_changed`, the three `box_cam_*`, and `policy_version_published`.
   3. Recruitment: citing a `local_test` Box Cam session when the test provider is on (trials, decisions, and the
      decision surface's `boxCam` candidates, which list none here), a Room decision's `lifecycle` record (always
      null; `decisions.lifecycle_json` renders it), the `contact_response` budget (30 answers an hour), and
      attaching a trial report in a channel.
   4. Agents [**done** by the audit: only `policy_version_published` is left, in slice 2].
   5. Discovery and scouting: the similarity engine (`morelike`, and `similarPlayers`' players and archetypes),
      the film room's tags and view, captions, an assessment's lead review, the evidence-gap rule
      `attribute_never_observed`, the matching counters in `/admin/metrics` (`matching_query_run` and the
      watchlist ones), and lowering text as JavaScript does in the directory search (`lower_js`).
   6. Development: the Box Cam development plan (player and guardian), the club's drill list, and keeping a clip.
   7. The ledger, verification and safety: a detail on `ledger.Entry`, written to the `detail_*` columns and
      `ledger_protocols` and read back by `view`. That covers Box Cam preferences, the Combine, a verification
      decision and a root approval. Also the operations events' detail in `/admin/metrics`, removing a
      verification domain, and the admin's vouch revoke.
   8. The rest of the sweep: the insight sweep (review-later reminders, pruning exposure older than 90 days), the
      week-old application reminders, the trial-feedback escalation and the completed-trial assessment reminder.
      Their columns (`reminded_at`, `feedback_escalated_at`) exist; nothing writes them.
   9. Platform: `SCOUTBOX_TRUST_PROXY` (`TRUST_PROXY_INVALID`, the operator report's `proxy_trust`, and the open
      question below), the operator report's `dataLayer.domains`, and its notification counters
      (`suppressedByPreference`, `unknownTypes`).
10. **A performance sweep, after every battery passes.** Don't let it hold up the port. The server calls
   `list.length`, `list.unique`, `list.contains` and friends on lists all over, including on hot paths and inside
   loops, where each is a linear walk. Add a small library that does these operations in the fastest way possible
   (sets and dicts for membership and de-duplication, a length taken once), and move the hot call sites onto it.
   Measure before and after with `dev/perf.mjs`.
11. **Type a player's date of birth, after every battery passes.** `players.birth_date` is read as a `String`, so
    the age rules (`rules/age`) parse it again on every call. Decode it once at the row boundary into a typed day (a
    `calendar.Date`, or an opaque `BirthDate`), through a column override in the generated row decoder, so no rule
    can be handed a malformed one. `adult_sql` can keep comparing text: a `YYYY-MM-DD` day sorts as dates do.
    Country stays text: it is free text of 1 to 40 characters on both servers, and a closed type would first need
    the TypeScript server to take a code list.

The date rules are mapped (`platform/temporal`, `rules/age`, the trial and contact rules): a new date rule is a
function over `Day`, `Zone` and millisecond instants, and its cases go in `TEMPORAL_MAP`'s neighbours in
`dev/battery_cases/map.mjs`.

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
- **Port only as far as the battery reaches.** Mark the rest `Not ported yet:`. There are 85 such markers, and the
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

Untangling is finished. What remains is the port itself. The rule-case backlog is mostly mapping work that grows with the ported rules: about
4,500 cases pending (4,003 of them in recruitment) and about 350 hand-port calls, by `LEDGER.md`.

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
