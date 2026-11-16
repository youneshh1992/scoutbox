# Bringing the batteries across

The TypeScript server's e2e batteries (`../scoutbox/scoutbox-server/e2e/`, 56 batteries, ~81k lines) are the
specification the Gleam server has to meet. Three run here today: `platform/staff`, `platform/safeguarding` and
`platform/playersAndGuardians`. Most of the rest can't, because they import from the TypeScript server's own
code. This plan makes every battery language-neutral at its source, so that one file passes on both servers.
Wherever a battery's checks can't be expressed over HTTP, it also gives them a path to the Gleam side.

## What the coupling actually is

The pilot evaluation counted 23 coupled batteries and treated the fixture writer as the main problem. Measured
across the whole tree (November 2026), the picture is different:

- **46 of 56 batteries import TypeScript-server internals**, beyond the two helpers `sync.mjs` already copies
  (`scripts/testPort.mjs`, `domains/identity/totp.mjs`). Only 10 are clean: the 3 already ported, plus
  `platform/{notifications,delivery,messaging,connectedMode,api}`, `discovery/exposureCalibrationAndCoverage`
  and `scouting/clubWorkflows`.
- They import from 104 distinct modules. By number of uses in battery code (an automated count, so approximate):

  | Kind of use | Uses | Examples |
  |---|---|---|
  | Pure rule functions, called in the test process | ~3,260 | `isAdult`, `can`, `evaluateSubmission`, `effectiveStatus`, `playerMatchesBrief` |
  | Specification tables | ~1,520 | `EVENT_REGISTRY`, `RATE_LIMIT_POLICY`, `TYPE_CATEGORY`, `*_ERROR_HTTP`, `*_INPUT_CODES`, `PERMISSIONS` |
  | Implementation facts | ~160 | `DATA_MIGRATIONS`, `TABLE_BACKED`, `*_MIGRATION`, `*_TABLES` |
  | Storage readback and open layers | ~90 | `readRecords`, `openLayer`, `plantCase` |
  | Array-backed reference models | ~60 | `buildRecruitmentJourney`, `createEvidenceProvider` (`scripts/recruitmentReadsFixture.mjs`) |
  | Fixture writes | ~50 | `writeFixture`, `legacyMoves` |
  | Implementation unit tests | ~40 | `openStore`, `runDataMigrations`, `createFaultLayer`, `installAsyncErrorForwarding`, `ProductionCvProvider` |

- **Most of a coupled battery is a unit test of TypeScript modules.** The heavy batteries open with
  "pure engine" sections (`agents/core.mjs` sections A–D and T1 run to line 773 before the first boot). Similar
  checks are also scattered through the HTTP sections. About three quarters of all internal uses come before
  the first server boot. Two batteries, `development/boxCamCvRobustness` and
  `development/combineProductionGate`, never start a server at all.
- **Fixtures and readback are only about 5% of the coupling.** The SQL fixture writer on `sql-fixture-writer`
  (`~/Code/scoutbox-fixture`, `cabcf078`) covers the write side, but that was never the bulk of the coupling.
- **The current sync mechanics don't scale.** `sync.mjs` rewrites one spawn spelling,
  `spawn('node', ['server.mjs'], {`, which 8 batteries use. 48 use `spawn(process.execPath, [SERVER], {` with
  a path built from `'..', '..'`. The guard misses dynamic imports built with `path.join(HERE, '..', '..', …)`:
  `platform/dates.mjs` spawns a child script that imports `temporal.ts` that way.
- **The server's test contract is wider than its routes.** Batteries also set environment variables (`PORT`,
  `DATA_DIR`, `SCOUTBOX_QUIET_LOGS`, `NODE_ENV`, `SCOUTBOX_TEST_CLOCK`, `SCOUTBOX_FAULTS`, `MEDIA_SECRET`,
  `ADMIN_KEY`, `BOX_CAM_TEST_PROVIDER`, `AGENT_VERIFICATION_TEST_PROVIDER`, `SCOUTBOX_SEED_DEMO`,
  `ALLOW_DEV_LOGINS`) and call development routes (`/__faults`, 19 uses; `/__rate-limits`). All of these are
  part of the specification.

Most of the work is therefore not a fixture problem. Each battery holds two specifications in one file: one
about the server's behaviour over HTTP, and one about the rules inside it. The two need different treatments.

## Principles

1. **A battery imports nothing from the server tree.** Everything it needs comes from `e2e/support/`, which is
   language-neutral or generated. This settles the evaluation's open question: batteries do not keep importing
   `domain.ts`, `roles.ts` or the other shared modules.
2. **Untangle at the source, keep the TypeScript server green.** Every change is made in
   `../scoutbox/scoutbox-server`, and its `npm run e2e` and `npm test` pass after each battery. The Gleam
   repository never edits a copy (as now).
3. **One battery file, two targets.** The only file that differs between the two repositories is the server
   launcher in `e2e/support/`. After that change `sync.mjs` stops rewriting batteries: it copies them verbatim
   and refuses any reference outside `e2e/`.
4. **No check is dropped silently.** A check that leaves a battery is moved, never deleted, and a ledger records
   where it went: a rules suite, a generated Gleam test, a hand-ported Gleam test, or "TypeScript implementation only",
   with the reason.

## Treatment by kind

| Kind | In the TypeScript tree | On the Gleam side |
|---|---|---|
| **Rule checks in the test process** (pure-engine sections, and stray rule assertions in HTTP sections) | Move them out of the battery into a rules suite, `scripts/rules/<domain>/<battery>.mjs`, run by `npm test`. The assertions don't change. | Record every call these suites make to a TypeScript rule, with its result, and generate ordinary gleeunit tests from them that call the ported rule. Calls that can't be recorded are ported by hand (see Rule cases). |
| **Rule function as an HTTP oracle** (an expected response computed by calling a TS rule) | Replace the call with the literal value it returns for that fixture. Fixtures are deterministic, so print the value once and paste it in. The rule's own coverage stays in the rules suite. | Nothing beyond the battery. |
| **Specification tables** | `scripts/specSnapshot.mjs` writes each table to `e2e/support/spec/<name>.json` from the modules that define it. `npm test` fails if a snapshot drifts. Batteries import the JSON. Tables that hold functions keep only their data, and their behaviour goes into the rules suite. | `sync.mjs` copies the snapshots. The Gleam code declares each table as typed values, and one Gleam test per table proves it equals the snapshot. The table is still declared in Gleam, so error codes stay a custom type rather than strings. |
| **Fixture writes** | Merge `sql-fixture-writer`, then move each battery from `writeFixture` to `e2e/support/sqlFixture.mjs`: plain rows, plain SQL, refused by the schema. | Shared as is, since both servers use the same migrated schema. |
| **Storage readback** | Add `e2e/support/sqlRows.mjs` next to the writer: a read-only connection, `rows(dir, table, where?)` returning stored rows exactly as stored, and `json(column)` for JSON columns. Rewrite readback assertions in terms of rows and columns, not repository shapes. `plantCase` becomes plain SQL in `sqlFixture.mjs`, because it already is SQL underneath. | Shared as is. |
| **Repository refusal of bad fixtures** (`*_INPUT_INVALID` from `writeFixture`) | This tests the TypeScript repositories. Move it to that repository's unit suite. Where the schema itself refuses the record (CHECK, STRICT, foreign key), keep the check in the battery as a plain-SQL insert that is expected to throw. | The schema checks come across. Repository validation gets Gleam repository tests. |
| **Implementation facts** (`TABLE_BACKED`, migration ids, `*_TABLES`) | If it states a real contract ("offers are a table"), rewrite it as a schema check: `sqlite_master` has the table, `user_version` or the migrations table has the row. Otherwise move it to a TS unit suite. | Schema checks are shared. |
| **Implementation unit tests** (`openStore`, `runDataMigrations`, fault layer, Express async error forwarding, `ProductionCvProvider`, `ObservationRun`) | Move them to TS unit suites. | Gleam equivalents are written by hand when that subsystem is ported, and recorded in the ledger. |
| **Array-backed reference models** (`recruitmentReadsFixture.mjs`) | Where the model computes an expected HTTP response, use literals as for oracles. Where it is itself under test, it goes to the rules suite. | As for rule checks. |
| **Process contract** (env vars, `/__faults`, `/__rate-limits`, test clock, test providers) | Document it once in `e2e/support/CONTRACT.md`: each variable and development route, what it does, and which batteries use it. | The Gleam server implements the contract. A battery whose contract piece isn't ported yet stays off `BATTERIES`. |

## Rule cases: generated Gleam tests from the rules suites

The pilot proves rules with generated cases (`dev/rule_cases.mjs` → `test/fixtures/rule_cases.json` →
`rules_test.gleam`). This does the same with two differences. The inputs are the ones the battery authors
chose, which are the curated boundary cases. And the output is Gleam test code, not JSON, so the tests read as
ordinary gleeunit tests and the compiler checks them:

```gleam
//// Generated by dev/battery_cases.mjs from the TypeScript rules suite for recruitment/offersAdversarial.
//// Do not edit: change the battery or the rule, then regenerate.

import gleeunit/should
import scoutbox/rules/age.{Person}
import scoutbox/test_support.{day}

pub fn s_p5_gb_the_day_before_the_18th_birthday_is_not_test() {
  age.is_adult(Person(dob: "2008-03-15", country: "GB"), day("2026-03-14"))
  |> should.equal(False)
}
```

- **Recorder (`dev/battery_cases.mjs` in this repository).** It runs the TypeScript rules suites under a Node
  module hook (`module.register`). The hook wraps two things:
  - the exported functions of `domains/**`, `domain.ts`, `temporal.ts` and `roles.ts`. A call is kept when its
    arguments and result are plain data (they survive a JSON round trip). A thrown refusal is kept as the
    refusal's code.
  - the suite's assertion helpers (`ok`, `neg`). Each assertion's message is attached to the rule calls made
    since the previous assertion.

  The recorder makes every call a second time with the clock shifted (`SCOUTBOX_TEST_CLOCK`), and marks any call
  whose result changes as clock-dependent. The TypeScript rules suites contain no recording code; it all lives
  in this repository's `dev/`.
- **Mapping (`dev/battery_cases/map.mjs`).** One entry per ported TypeScript function: the Gleam function that
  plays its role, and a printer for each argument and for the result. A printer turns a JavaScript value into a
  Gleam expression: camelCase fields become a constructor with labelled fields, vocabulary strings become their
  generated constructors, missing fields become `None`, and a refusal becomes `Error(…)`. Printers are written
  per type, not per function, and the same types (a person, a case, an agreement) recur across many functions.
  Gleam doesn't have to mirror TypeScript's module layout: the mapping names wherever the rule lives in Gleam.
- **Generator.** For each mapped function it writes `test/scoutbox/battery/<domain>/<module>_test.gleam`, with
  one test per recorded call, named from its assertion message (deduplicated, with a suffix where one message
  covers several calls). Identical calls are written once. The output is formatted with `gleam format`, and a
  `--check` mode fails when a committed file differs from what the recording gives, like `e2e:check` and
  `codegen:check`. Generated files are never edited by hand.
- **Unported functions produce no tests.** A function with no mapping entry gets no generated code, so nothing
  has to be stubbed for it to compile. The generator lists it as pending, with its call count, and the ledger
  shows it.
- **The compiler catches drift.** If a Gleam rule's signature or types change, its generated tests stop
  compiling. Fix the mapping or the rule and regenerate.
- **The rest is hand-ported.** Calls the recorder can't keep (closures, class instances, stateful engines,
  clock-dependent calls) are listed by function with their call counts. Each becomes a hand-written gleeunit
  test, ported from the rules suite's assertion, in `test/scoutbox/<domain>/`.
- **Some rules have no Gleam function.** Where a rule is folded into SQL (as with the distance rules), its
  mapping entry generates tests that go through the SQL function or a store query instead.
- **Not birdie.** A birdie snapshot is accepted from Gleam's own first run, so it would only prove that Gleam
  still agrees with itself. The expected values here have to come from TypeScript.

## Box Cam: records only

Box Cam's video processing and analysis will move to a service of its own, in another language. This server will
keep the records. The Gleam port therefore takes only the skeleton other domains depend on: the Box Cam tables
(they come with the copied migrations anyway), the routes that read and keep sessions and results, and the read
rules other domains apply to those records (trust scores, matching, second look and the development hub all read
Box Cam results). Nothing of the analysis is ported: no computer-vision engine, frame decoding, providers, quality
gates, scenes or Combine production gate.

- **Three batteries stay TypeScript-only for good:** `development/boxCamCvProvider`,
  `development/boxCamCvRobustness` and `development/combineProductionGate`. They test the analysis itself. They
  are listed as `TYPESCRIPT_ONLY` in `scripts/e2eBoundary.mjs`: they don't have to keep the boundary, aren't
  untangled, aren't copied to the Gleam repository, and their rules aren't recorded. They belong to the video
  service when it exists.
- **`development/boxCam` and `development/combine` are split when their turn comes.** In the TypeScript tree, each
  is split into a records battery, which is untangled and ported as usual, and an analysis battery, which joins
  `TYPESCRIPT_ONLY`.
- **Other batteries get their Box Cam results from fixtures, not from the test provider.** Five batteries outside
  Box Cam start the server with `BOX_CAM_TEST_PROVIDER=1` to produce results: `passport/trustScore`,
  `discovery/matchingAndWatchlists`, `discovery/secondLookAndNobodyMissed`, `development/hub` and
  `platform/contracts`. When each is untangled, its results are written as Box Cam rows with `sqlFixture.mjs`
  wherever the battery tests what other domains make of a result, not how the result was produced. The Gleam
  server then needs no test provider. The door through which the video service will hand results over isn't
  designed yet, and shouldn't be guessed at here.
- **The recorder skips the analysis.** It doesn't wrap `domains/development/boxcam/cv/**`, the providers or the
  drill engine. It does wrap the read rules over records that other domains call (`combineShared.mjs`).

## Steps

Each step ends with the TypeScript server's `npm test` and `npm run e2e` passing.

### 1. Infrastructure (TypeScript tree) [done]

Done on `battery-untangle` in `../scoutbox` (off `typescript-foundation`). `npm test` passes (72/72), as do
`npm run e2e` (56/56), `tsc` and `biome ci`. As built:

1. **Fixture writer.** `sql-fixture-writer` (`cabcf078`) fast-forwarded in: `e2e/support/sqlFixture.mjs`,
   `schema.sql` and its drift check (`testSqlFixtureSchema`).
2. **Row reader and case plants.** `e2e/support/sqlRows.mjs` is the read-only row reader: `readRows(dir)` with
   `rows`/`row`/`count`/`tables`/`all`, the one-shot `rows(dir, table, where)`, and `json(text)`. It refuses
   unknown tables and columns, and returns rows in primary-key order. `plantCase(F, id, …)` and
   `legacyMoves(F, id, chain, …)` are now plain SQL in `sqlFixture.mjs`. They take an open fixture and a case id
   rather than a repository record, and `plantCase` returns the stored row. `testE2ESupport` proves both leave
   exactly what the repository versions leave. (It was mutation-checked: dropping a column from the SQL plant
   fails it.)
3. **Launcher.** `e2e/support/server.mjs` exports `serverCommand()` (`[process.execPath, [server.mjs]]`) and
   `serverDir`. It is the one file a port replaces.
4. **Spec snapshot.** `scripts/specSnapshot.mjs` writes 31 files under `e2e/support/spec/`, one per source module
   (`domains/platform/rateLimit.mjs` → `spec/platform/rateLimit.json`, keyed by export name plus `$source`). The
   seed list is the plain-data tables more than one battery uses, plus every `*_ERROR_HTTP` map and
   `*_INPUT_CODES`. It refuses functions, Sets, Maps, class instances and non-finite numbers: `LIFECYCLE_ACTIONS`,
   `CRITERION_TYPES`, `GAP_RULES` and the `*_AUDIT_ACTIONS` Sets are behaviour, so they go to rules suites.
   `JOURNEY_REQUIRED_STORES` is an implementation fact and was left out. Batteries will import the files with
   `import x from '../support/spec/….json' with { type: 'json' }`. `biome.json` ignores the folder, because it is
   generated. `testE2ESupport` runs the drift check.
5. **Contract.** `e2e/support/CONTRACT.md` documents 17 settings, `/__faults`, `/__rate-limits` and
   `x-scoutbox-test-clock`. `scripts/e2eContract.mjs` finds every setting and development route the server reads
   and prints which batteries use each. `testE2ESupport` fails when a battery uses one the page doesn't name. The
   batteries use more than the first survey found: `SCOUTBOX_FAST_SWEEPS` (17 batteries), `TEST_LICENCE_REGISTRY`
   (6), `ALLOW_LOCAL_WEBHOOKS` (3) and `SESSION_TTL_DAYS`, and they depend on `ADMIN_KEY`'s default
   (`scoutbox-admin`).
6. **Rules suites.** `runTests.mjs` runs every `scripts/rules/**/*.mjs` as `rules/<domain>/<battery>`
   (`npm test -- rules/agents`). There are none yet.
7. **Boundary check.** `e2e/support/boundary.mjs` holds the check itself: pure and import-free, so the Gleam
   `sync.mjs` can use the same one. It flags imports and paths climbing out of `e2e/`, and any mention of
   `server.mjs`. `scripts/e2eBoundary.mjs` applies it to every file under `e2e/`, with two lists:
   `NOT_YET_NEUTRAL` (53 batteries), which may only shrink, since a listed battery that passes is an error; and
   `TYPESCRIPT_ONLY` (the three Box Cam analysis batteries). `runE2E.mjs` refuses to run on any problem.
   Every battery is listed today, the 10 clean ones included, because all of them import `testPort.mjs` and
   start `server.mjs` themselves. Step 2 clears those.

### 2. Mechanical normalisation (all 56 batteries, one codemod) [done]

Done on `battery-untangle`. As built:

- **Spawns.** A one-off codemod rewrote every server start in the 53 batteries outside `TYPESCRIPT_ONLY` to
  `spawn(...serverCommand(), { cwd: serverDir, … })` and dropped their `SERVER`/`SERVER_DIR` paths, along with
  any `HERE`, `ROOT`, `fileURLToPath` or `path` that was then unused. (`cwd` was already the server directory
  wherever it was missing, because `runE2E.mjs` runs batteries from there.) `scouting/clubWorkflows`' header
  comment no longer names `node server.mjs`. The `TYPESCRIPT_ONLY` batteries were left alone, apart from their
  `testPort.mjs` import path.
- **`testPort.mjs`** moved to `e2e/support/`. The unit suites in `scripts/` import it from there, so there is one copy.
- **`totp.mjs`.** `e2e/support/totp.mjs` is a separate authenticator: `totp(secret, nowMs)` only, written for
  the battery, not copied from the server. `testE2ESupport` proves it agrees with `domains/identity/totp.mjs` on the
  RFC 6238 vectors and 200 random secrets and times. `operations/clubOperations` still imports the server's
  `totp`/`totpValid`/`b32encode`: its "unit fixtures" section tests them, and it moves to a rules suite in step 4.
- **Boundary fix.** The "starts the server itself" rule matched the launcher's own import (`support/server.mjs`);
  it now excludes it, with a test both ways. With that, the 10 clean batteries came off `NOT_YET_NEUTRAL` (43 left).
- **Gleam `sync.mjs`** copies `support/**` (except `support/server.mjs`) and the listed batteries byte for byte,
  without banners. It refuses a `TYPESCRIPT_ONLY` battery and any boundary problem, using the TypeScript tree's
  `boundary.mjs`. `--check` also reports copies that no longer have a source, and a sync removes them. The Gleam
  `support/server.mjs` exports `serverCommand`/`serverDir` like the TypeScript one. The three ported batteries pass.

### 3. Calibrate on three heavy batteries

These are the evaluation's conditional-go item 1: `recruitment/journey` (6 modules, fixtures, `plantCase`),
`agents/core` (9 modules, the biggest pure-engine block), and `platform/storeGuarantees` (8 modules, mostly
implementation facts). For each:

1. Move rule checks into `scripts/rules/…`. Most are contiguous sections; find the stray ones by grepping for
   the imported names.
2. Replace oracle calls with literals and table imports with `spec/` JSON.
3. Move fixtures to SQL and readback to rows, and handle implementation facts as the table says.
4. Add the battery's rows to the ledger (step 5).

**Pass mark:** each battery passes on the TypeScript server, passes the boundary check, and took under half a
session. Its rules suite passes, and `dev/battery_cases.mjs` records its calls and lists them as pending. Time each battery and use the
three times to replace the estimate below. If a battery goes well over half a session, stop and write down why
before going on.

**[done]** All three pass, keep the boundary, and are off `NOT_YET_NEUTRAL` (40 left). By the clock, each took a few
minutes: `platform/storeGuarantees` 5, `recruitment/journey` 3, `agents/core` 3, and the recorder about 15. As built:

- **Rules suites.** `scripts/rulesSuite.mjs` gives a suite the battery's `ok`/`neg`/`section` (and is the one place the
  recorder hooks). The pure sections moved verbatim into `scripts/rules/agents/core.mjs` (A–D, T1),
  `scripts/rules/recruitment/journey.mjs` (A) and `scripts/rules/platform/storeGuarantees.mjs` (the archetype count,
  and §4's projection over arrays). Each battery's header says where they went.
- **Check counts reconcile.** Real `ok`/`neg` checks, battery + rules suite: storeGuarantees 30 → 25 + 7 (one new
  check, and the plan count is now in both), journey 153 → 115 + 38, agents/core 351 → 248 + 103. A raw grep counts
  the three helper definitions too; the ledger script must leave them out.
- **What the HTTP sections needed.** Very little: none of the three used a rule as an oracle. The work was readback
  and fixtures.
  - `storeGuarantees` §1 now boots the server on an empty directory and checks the file it creates against
    `schema.sql`'s migration rows, instead of opening the repository layer. §2's `COUNTER_MISSING` became "the
    server refuses to start without its counter row", and the `createIdCounter` unit check went to
    `testDataLayer`. §3 reads the plans from `/meta`, and the plans the `orgs.plan` CHECK allows.
  - `journey`'s offline plants are SQL: `plantCase`/`legacyMoves` from `sqlFixture.mjs`, a legacy `signings` row, and
    a Second Look item's three rows. These were copied from what the repository wrote in a probe run.
  - `agents/core`'s readback is rows. `readRecords` hid two things that raw rows show: a deleted player is a
    tombstone row (`deleted_at` set), not an absent one; and S3 and S5 were vacuous, because they read collections
    `readRecords` doesn't have (`representations`, `claims`). They now check that there is no `representations` table,
    and search `ver_claims`.
- **Mutation checks**, one or two per battery, all caught: Grassroots' attribution window set to 18; the journey's legacy
  signing row removed, and its Second Look item removed; the erasure no longer clearing `dispute_reason`. A first
  try, unlinking the legacy signing from its case, wasn't caught. The projection finds the signing by club and
  player, so the original battery wouldn't have caught it either.
- **Recorder.** `dev/battery_cases.mjs` (`npm run cases`, `cases:check`) runs each rules suite twice under
  `dev/battery_cases/preload.mjs`.
  - In-process module hooks put a wrapper between `scripts/` and each rule module (`domains/**` minus Box Cam
    analysis, `domain.ts`, `temporal.ts`, `roles.ts`), and wrap `rulesSuite`'s `ok`/`neg`.
  - The second run moves `Date` on by 400 days. That is a patch in the suite's process, not `SCOUTBOX_TEST_CLOCK`,
    which only the server reads.
  - `dev/battery_cases/report.json` lists, per battery and function, the calls, the distinct cases, and the
    hand-port calls by reason. Today: 430 cases pending over 40 functions, and 26 calls to port by hand.
    `buildRecruitmentJourney` and `createEvidenceProvider` take query closures; one `can` call has an `undefined` in
    the middle of its arguments.
  - No recorded call depends on the clock. A scratch fake tree proved the detection works, along with coded
    refusals, callbacks and re-exports.
  - The mapping, printers and generator wait for the first ported rule (step 6): nothing these suites call is
    ported yet.

### 4. The rest, just ahead of each domain's port

Untangle each battery when its domain is next in line for the Gleam port, not all at once. Each untangling is
then checked straight away by a real port, and the TypeScript batteries change in small, reviewable steps.

**Port order.** Domain by domain, with the cross-domain batteries last. The `platform/*` batteries aren't one
slice. Run against the TypeScript server with each matched route logged, the ten left after the pilot hit 135
routes the Gleam server doesn't have, and most of those belong to other domains. Porting them in battery order
would mean porting most of the product under the heading "platform". So:

1. **Messaging:** `platform/notifications`, `platform/messaging`, `platform/delivery`. These cover message
   threads, the feed and its preferences, the delivery centre (in-app and e-mail dispatches, sweeps, provider
   callbacks), the push log, support tickets and webhooks. They also need answering a request
   (`/player|guardian/requests/:id/respond`) and the transition packs (`/player/transitions…`). Each battery
   adds 10–16 routes. **[done]** All three pass unchanged on the Gleam server (66, 64 and 48
   checks), each mutation-checked once. What the port needed beyond the routes:
   - **Pushes are effects.** The notifier asks for an `effect.SendPush` with `store.emit` (none when the notice
     is muted, repeated or deferred); the unit collects it and dispatches it after COMMIT, so nothing has to pass
     it up and none can be dropped. A test asserts what an act would push with `store.unit_effects`
     (`test/scoutbox/messaging/notifications_test.gleam`).
   - **Two vocabularies made shared:** the notification categories (`notifications`, `notification_pref_categories`)
     and the webhook events (`webhook_deliveries`, `webhook_endpoint_events`).
   - **`input.items`**, a list whose refusal names the item (`events[1].status`), and `input.id_of(max)`.
   - **Outbound HTTP** for webhooks: `gleam_httpc`. Each send takes a lease on its delivery (`next_at` moved on in
     a unit), because two sweeps can overlap here, where the TypeScript server's single thread keeps an in-flight
     set. The delivery sweep re-reads each dispatch in its own unit for the same reason.
   - **Where it differs:** a delivery callback's signature is checked over the body as sent, not the parsed body
     serialised again; reply text is not NFC-normalised (no FFI).
   - Partly ported on the way, and marked `Not ported yet:` in the code: transition packs (open, grant, withdraw a
     grant; not the lists, placing, the club's side or the sweep), webhooks (subscribe and deliver; not list, rotate
     or deactivate), support tickets (file and reply; not the lists or access grants), and the feed `target` (a
     request's inbox; not a staff member's Room).
2. **Sessions and live events:** `platform/sessionsAndPorts`, `platform/connectedMode`. These need sign-out,
   grassroots registration, guardian sign-up, staff SSO, the event stream and its tickets (SSE), the session
   lifetime (`SESSION_TTL_DAYS`) and the production boot refusals (`ADMIN_KEY_UNSAFE`,
   `AGENT_TEST_PROVIDER_IN_PRODUCTION`, `FAULTS_IN_PRODUCTION`). SSE was outside the pilot's scope, so give it
   its short check first.

   Both batteries reach further than their names. `connectedMode` also needs signed media links, scrypt password
   hashing (grassroots registration with a password, provisioned credentials, the first-login administrator),
   SSO's production refusal and `/org/tactical`'s `LEAD_REQUIRED`. `sessionsAndPorts`' section T posts to six
   create routes of other domains (`/org/searches`, `/org/squad`, `/org/open-trials`, `/org/friendlies`,
   `/player/media`, `/player/medical/records`) and expects a 201 for a valid body. Order: the SSE check, a scrypt
   check, signed media links and the rest of `connectedMode`, then `sessionsAndPorts`.

   **SSE short check [done].** ewe 9 serves server-sent events itself (`ewe.sse`: a selector-driven process per
   stream, which notices the client leaving), so nothing was vendored or written in FFI. As built:
   - **One hub actor** (`platform/live`): the event ids, the 500-event replay buffer (typing is never kept), the
     tickets, and the open streams, each monitored so a stream whose process ends leaves. Joining and reading
     what was missed are one call, so no event falls between them.
   - **Events are typed** (`platform/live_event`): one constructor per registry entry, its fields the registry's
     payload keys. `live_test` proves the keys and the replay policy equal `spec/platform/eventRegistry.json`, so
     the TypeScript server's payload stripping isn't needed. Ported: `messages` (a send, a read receipt),
     `typing` and `notify`; the rest of the registry is `Not ported yet:`.
   - **Published after COMMIT** as an effect (`effect.Live`); typing, which records nothing, publishes at once.
     Who may receive an event is resolved once when it is published (a thread's parties, a staff member's
     organisation), then checked by each stream in its own process against live records (suspension, removal).
   - **Wiring:** Wisp's body can't carry a stream, so `GET /events` passes through the router and its middleware
     like any route and answers with a marker header; the adapter (`platform/wisp_ewe`) removes it and opens the
     stream.
   - **`dev/sse_check.mjs`** runs on both servers: 14 behaviour checks with the battery's own frame reader (all
     pass on both, apart from the sign-out one, which waits on `/auth/logout`), then fan-out. One message at a
     time to N streams on one thread, 20 messages, client and server on one laptop:

     | | per stream p50 / p99 | last stream p50 | memory per stream |
     |---|---|---|---|
     | TypeScript, 100 streams | 23 / 46 ms | 24 ms | 81 KB |
     | Gleam, 100 streams | 5 / 11 ms | 6 ms | 131 KB |
     | TypeScript, 1,000 streams | 187 / 211 ms | 194 ms | 44 KB |
     | Gleam, 1,000 streams | 22 / 36 ms | 33 ms | 84 KB |

     A single stream gets its message in about 5 ms on either server. The client is one Node process reading
     every stream, so the Gleam figures at 1,000 are partly the client's. Gleam uses about twice the memory per
     stream, measured as the BEAM's resident size; it isn't broken down yet (each stream is one process, its
     connection's).

   **Scrypt short check [done].** Pure Gleam (`platform/scrypt`), no FFI or NIF. It agrees with Node's
   `crypto.scryptSync` on 47 keys from `dev/scrypt_cases.mjs`: RFC 7914's vectors, 40 small-parameter shapes, and
   the server's own parameters with a hex-text salt. It also verifies hashes the TypeScript server's own
   `hashPassword` stored. `identity/passwords` reads and writes the stored form, `scrypt$<salt>$<hash>`, so seeded
   and fixture hashes stay valid on both servers. Timed with `gleam run -m scrypt_bench` at N=16384, r=8, on an
   M1 Pro with 6 schedulers:
   - **One hash: 467 ms**, against Node's 38 ms. About 12 times slower; the Salsa20/8 core is about 0.5 µs, near
     what plain integer arithmetic costs on the BEAM.
   - **Eight at once: 816 ms** wall clock. Each runs on its own scheduler and is preempted, so other work keeps its
     latency: a 1 ms sleep took at most 3.9 ms meanwhile. Node's `scryptSync` blocks its only thread for each hash.
   - **One trap, now in the module's comment:** building ROMix's 16 MiB table by appending to one binary took
     16.5 s a hash, because the BEAM copied it on every append once BlockMix built other binaries in between.
     Building a list of blocks and joining it once fixed it.

   So a password sign-in costs about half a second, and the server handles about 13 of them a second at most.
   That's usable for sign-in, but slower than the TypeScript server. If it matters, the choices are a NIF (C
   scrypt or Argon2id) or PBKDF2 from OTP's crypto, on both servers together.
3. **The domains, in port order** (recruitment, discovery, passport, development, agents, …). Each domain's
   batteries are untangled just ahead of its port.
4. **Last, the cross-domain batteries:** `platform/api` (61 new routes across trials, squad, billing, open
   trials, vouches, pairing and exports), `platform/contracts` (Rooms, briefs), `platform/productionHardening`
   (Rooms, briefs, second look, "nobody missed", the Passport) and `platform/dates` (trials, open trials,
   friendlies, matchdays, development plans, compliance policies). Each is an integration check over several
   domains, so it should come almost free once those domains are ported. `dates`' rules suite alone records
   2,253 rule calls over 52 functions, which are proved as their rules are ported.

`contracts`, `dates`, `productionHardening` and `sessionsAndPorts` are already untangled (see below). Untangling
ahead of the port was cheap, so it needn't wait for its domain.

**Platform so far [in progress].**

- **The schema is the TypeScript server's.** `dev/migrations_sql.mjs` records its 40 migrations as SQL, one file
  per migration id, into `priv/migrations/`. A first boot of either server therefore creates the same file, and a
  directory `sqlFixture.mjs` wrote is one the Gleam server recognises. `e2e:check` fails if the files drift. The
  row generator takes an allowlist of the tables this server uses (`tables` in `dev/scoutbox_dev.gleam`), so the
  other 300-odd tables exist without generated modules. The demo seed is dumped for every table. It loads only
  while `meta.orgsInit` is `pending`, and it obeys `SCOUTBOX_SEED_DEMO`.
- **`platform/storeGuarantees` passes unchanged.** It needed `/meta`, `/capabilities` (with the integrity check
  run at boot), the refusal to boot without the id counter, the response headers (`X-ScoutBox-Schema`, the
  hardening headers, `X-ScoutBox-Retry`), the lifecycle vocabulary, and the review queue with exposure recorded on
  profile views. Its rules suite's 18 cases and 19 hand-port calls are still pending.
- **Process contract:** the fault layer (`SCOUTBOX_FAULTS`, `/__faults`, the route faults, and named seams inside
  a unit, including the `unit.sqlite_commit` failure) is ported. The test clock is not yet.
- **Wall-clock time in IANA zones** (`platform/zones`) is ported for push deferral and the date rules. OTP has no
  zone database, so `dev/zone_offsets.mjs` records every zone's offsets from 1800 to 2200 from Node's ICU into
  `priv/zone_offsets.json`. `zones_test` checks 8,945 cases from `temporal.ts`.
- **Undecided:** `productionHardening` boots with `BOX_CAM_TEST_PROVIDER=1` and expects `/capabilities` to report
  `production_cv` as configured. This server reports it not configured, because Box Cam's analysis is going to a
  service of its own. That needs deciding before the battery is ported.
- **Waiting on a reviewer:** the moves to TypeScript unit suites made while untangling `sessionsAndPorts` and
  `contracts` (async error forwarding, the migration runner, the discovery repository's typing, the fault layer)
  have no verdict in `ACCEPTED` yet.

The two batteries that never start a server, `development/boxCamCvRobustness` and
`development/combineProductionGate`, move into `scripts/rules/` whole and come off the e2e list. They reach
Gleam only as cases and hand-ported tests.

**First domain: verification [done].** `verification/organisationsAndStaff` and its adversarial battery were
untangled (their pure-helper sections moved to `scripts/rules/verification/`, 47 + 30 checks, counts reconciled,
mutation-checked) in minutes, then ported end to end: both pass unchanged on the Gleam server (184 and 72 checks).
What the pipeline needed on the way:

- **Recorder.** The clock now stands still at a fixed instant (so generated values are reproducible and a rule taking
  `now` is given it); a call that changes its arguments keeps them as it left them (`argsAfter`, for
  `applyTransition`); Buffers and Maps are recorded tagged (`$bytes`, `$map`). With that, 68 of the suites' 87 calls
  are cases; the 16 token-store calls (a stateful store) are hand-ported in `test/scoutbox/verification/`.
- **Generator** (`dev/battery_cases/{map,printers,generate}.mjs`). Printers are per type; vocabulary and error-code
  constructors are read from the Gleam source, so names can't drift; a record printer refuses a JavaScript field it
  has no mapping for. A claim prints as an update of a hand-written base row (`test/scoutbox/battery/base.gleam`).
  All 68 generated tests passed on their first run; three deliberate rule mutations were each caught.
- **Row generator fixes** the domain surfaced: a vocabulary named after a prelude type (`List`), a CHECK allowing
  several `IN` lists (risk flags were silently dropped from the codes enum), and SCREAMING_SNAKE constructor names.

### 5. The ledger

`e2e/support/LEDGER.md` is generated by a script, with hand-written reasons. It has one row per battery: the
modules imported, whether the battery passes the boundary check, where its moved checks went, and on the Gleam
side whether the battery is in `BATTERIES`, its recorded calls all have generated tests (none pending), and its
hand-ported tests exist. Generate the import columns with the same counting this plan used (the scripts are worth keeping in
`scripts/`).

**A domain is ported when** every battery of the domain passes on Gleam, unchanged; its generated rule tests pass,
with no recorded call pending; every hand-port row is done; and every row marked "TypeScript implementation only" has a
reason a reviewer has accepted.

**[done]** Built in two halves, because the TypeScript tree mustn't read the port:

- **TypeScript tree: the accounting.** `scripts/e2eLedger.mjs` counts each battery's checks where they are written
  (`ok`, `neg`, and one-line helpers built on them such as `G`, `P`, `expect`, `bad`), and the server modules it
  imports. It compares them with `scripts/e2eLedger.baseline.json`, frozen from `3c843bb2` (after the launcher
  codemod, before any check moved). The rule is baseline = battery + rules suite + moved − added, where `NOTES`
  records each move to a unit suite and each added check, with the reason. `testE2ESupport` fails when a battery
  doesn't reconcile. All 56 reconcile today. Counting the helpers matters: `verification/organisationsAndStaff` has 10 `bad(…)`
  checks that the step-3 grep missed. Mutation-checked: deleting one rules-suite check fails it. A battery that
  gains checks for product reasons before it is untangled needs a note too.
- **Gleam repository: the ledger.** `dev/ledger.mjs` writes `scoutbox-server/LEDGER.md`, not `e2e/support/LEDGER.md`,
  from the TypeScript rows, `BATTERIES`, `report.json`, `HAND_PORTED` (new, in `map.mjs`: the hand-ported function →
  its test file) and `ACCEPTED`, the reviewer's verdict on each move to a TypeScript unit suite (the Gleam test that
  covers it, or why none is needed). It has a
  domain summary with a ported verdict, then per battery: modules then → now, checks then → battery + rules suite,
  answered, cases generated/pending, hand-port done/total, and what's left. Sections list the moves, additions,
  hand-port calls and pending functions. `e2e:check` runs `ledger --check`, and stale `HAND_PORTED`/`ACCEPTED`
  entries are refused. **Verification comes out ported**, the first domain to do so. The one move to a TypeScript unit suite,
  `storeGuarantees`' `createIdCounter` check into `testDataLayer`, is covered by `test/scoutbox/ids_test.gleam`
  (`ids.next` refuses without its counter row; mutation-checked).
- **Not checked statically:** that the batteries *pass*. The ledger can only say a battery is answered (in
  `BATTERIES`, kept identical by `e2e:check`); `npm run e2e` is the proof.

### 6. Gleam side, alongside step 4

- `sync.mjs` copies `e2e/support/spec/*.json`. Add one Gleam test per table proving it equals the snapshot.
- `dev/battery_cases.mjs`, its mapping and printers, as above. Add mapping entries as each rule is ported, then
  regenerate. Add `npm run cases` (record and generate) and `npm run cases:check`, and have `e2e:check` run
  `cases:check` too, so stale generated tests fail like stale battery copies.
- Implement the process contract as each piece is needed. The fault layer (`SCOUTBOX_FAULTS`, `/__faults`) and
  the test clock come first: 17 batteries use them, most of them in recruitment and agents.

## Estimate

This replaces the evaluation's "6 to 23 sessions" for 23 batteries, which undercounted by half:

| Group | Batteries | Per battery | Sessions |
|---|---|---|---|
| Infrastructure and codemod (steps 1–2) | | | 1–1.5 |
| Recorder, generator and the first printers | | | 1–1.5 |
| Light: 1–5 internal modules | 21 | ⅛–¼ | 3–5 |
| Medium: 6–9 modules (less the three Box Cam analysis batteries) | 9 | ¼–½ | 2–4.5 |
| Heavy: 10–17 modules | 13 | ½–1 | 6–13 |
| **Total** | 43 | | **about 13–26** |

Moving pure-engine sections is mostly cut and paste, so the spread comes from the HTTP sections' oracle calls
and the readback rewrites.

**After step 3:** the three heavy batteries took minutes each, not half a session, so the per-battery column above
is several times too high. A fair estimate for the remaining 40 is about **2–4 sessions**, plus the generator and
printers. The time goes on readback semantics (what a repository's records hid: tombstones, vacuous collections)
and on fixture rows copied from a probe run, not on moving sections. Batteries with rule oracles in their HTTP
sections, which these three didn't have, may be slower. The hand-port rows are counted with each domain's
port, not here. So are the mapping entries and printers, which grow with the ported rules.

## Risks

- **Literal expectations drift from the rule.** A literal pasted in for an oracle call is right only for that
  fixture. Keep the rule's coverage in the rules suite, and, where a literal stands in for a policy value, take
  it from `spec/` rather than typing it.
- **Rewriting a check can weaken it.** Each untangling is a diff to an existing check. Review that the moved or
  rewritten check still fails when it should: break the rule on purpose once per battery.
- **Checks can be lost in the move.** Count `ok(`/`neg(` per battery before and after, and require
  battery plus rules suite to equal the original. The ledger script does this.
- **A shared snapshot spreads one mistake to both servers.** Because the snapshot is generated from the
  TypeScript tables, it is exactly as right as they are, which is no worse than today.
- **The recorder misses rules that read state.** That is what the second call with a shifted clock and the
  hand-port list are for. Treat a module where most calls can't be recorded as a sign it isn't a pure rule.

## Out of scope

Porting the routes themselves; the Gleam implementations of live events, uploads and outbound providers (their
batteries are untangled on the same schedule, but stay off `BATTERIES` until the subsystem is ported); the e2e
UI suites in `../scoutbox/e2e/`, which drive the apps, not the server.
