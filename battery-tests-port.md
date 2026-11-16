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

### 2. Mechanical normalisation (all 56 batteries, one codemod)

- Change every spawn to `spawn(...serverCommand(), { cwd: serverDir, … })`, and drop each battery's own
  `SERVER` and `SERVER_DIR` path. Script it and review the diff by eye: there are three spellings today.
- Move `testPort.mjs` and `totp.mjs` into `e2e/support/`. The battery is their only user besides the server's
  own `totp` use, which keeps its copy. Add a drift check if both copies stay.
- In the Gleam repository, `sync.mjs` becomes a verbatim copy of `e2e/**` (the battery list plus `support/`),
  except `support/server.mjs`, which this repository owns, and the `TYPESCRIPT_ONLY` batteries, which it never
  copies. The rewrite code goes, and the guard becomes `support/boundary.mjs`, the same check `runE2E.mjs` uses.
  The three ported batteries must still pass.

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

### 4. The rest, just ahead of each domain's port

Untangle each battery when its domain is next in line for the Gleam port, not all at once. Each untangling is
then checked straight away by a real port, and the TypeScript batteries change in small, reviewable steps.
Order: the remaining `platform/*` batteries first (the pilot's domain, and `contracts`/`dates`/
`productionHardening` carry the shared tables and date rules), then domain by domain in port order.

The two batteries that never start a server, `development/boxCamCvRobustness` and
`development/combineProductionGate`, move into `scripts/rules/` whole and come off the e2e list. They reach
Gleam only as cases and hand-ported tests.

### 5. The ledger

`e2e/support/LEDGER.md` is generated by a script, with hand-written reasons. It has one row per battery: the
modules imported, whether the battery passes the boundary check, where its moved checks went, and on the Gleam
side whether the battery is in `BATTERIES`, its recorded calls all have generated tests (none pending), and its
hand-ported tests exist. Generate the import columns with the same counting this plan used (the scripts are worth keeping in
`scripts/`).

**A domain is ported when** every battery of the domain passes on Gleam, unchanged; its generated rule tests pass,
with no recorded call pending; every hand-port row is done; and every row marked "TypeScript implementation only" has a
reason a reviewer has accepted.

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
and the readback rewrites. Step 3's calibration will narrow it. The hand-port rows are counted with each domain's
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
