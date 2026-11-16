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

## Box Cam: records only

Box Cam's video analysis is moving to a separate service, so the Gleam port takes only the records and the read
rules other domains apply to them.

- `development/boxCamCvProvider`, `boxCamCvRobustness` and `combineProductionGate` are `TYPESCRIPT_ONLY` for good.
- `development/boxCam` and `development/combine` will each be split into a records battery, which is ported, and an
  analysis battery, which becomes TypeScript only.
- Batteries outside Box Cam that start the server with `BOX_CAM_TEST_PROVIDER=1` should get their results from
  `sqlFixture.mjs` rows when they are untangled. This applies to `passport/trustScore`,
  `discovery/matchingAndWatchlists`, `discovery/secondLookAndNobodyMissed`, `development/hub` and
  `platform/contracts`.
- How the video service will hand results over isn't designed yet. Combine results, and so the Passport's Trust
  Score in real use, wait on that design.

## Progress

### Infrastructure and normalisation [done]

Done on `battery-untangle` in `../scoutbox`:

- `e2e/support/` holds the fixture writer, the row reader, the case plants, the launcher, the spec snapshots,
  `CONTRACT.md`, an independent `totp.mjs` and `testPort.mjs`.
- `scripts/e2eBoundary.mjs` enforces the boundary with two lists. `NOT_YET_NEUTRAL` may only shrink, and
  `TYPESCRIPT_ONLY` is permanent.
- One codemod moved every server start onto the launcher.
- `sync.mjs` uses the same boundary check as the TypeScript tree.

### Untangling [in progress: 24 of 53 neutral]

**Untangling is cheap.** A heavy battery takes a few minutes, not the half session first estimated. It doesn't
have to wait for its domain's port: `contracts`, `dates`, `productionHardening` and `sessionsAndPorts` were done
early. What costs time:

- **Readback semantics.** Repository reads hid things that raw rows show: tombstone rows (`deleted_at` set), and
  vacuous checks over collections that didn't exist. Check what a rewritten readback actually reads.
- **Fixture rows.** Copy them from what the repository wrote in a probe run.
- **Rule oracles in HTTP sections.** These are slower to replace than moving whole sections.

Every untangled battery is mutation-checked at least once. One mutation that wasn't caught turned out to be a gap
in the original battery, so check the original before blaming the rewrite.

### Porting, domain by domain [in progress: 17 batteries pass unchanged]

Port order is domain by domain, with the cross-domain batteries last. The `platform/*` batteries reach into most
of the product, so they aren't one slice.

| Area | Batteries passing | State |
|---|---|---|
| Platform (staff, safeguarding, players and guardians, store guarantees, messaging, notifications, delivery, connected mode, sessions and ports) | 9 | done |
| Verification | 2 | **ported**: the first domain with every ledger row closed |
| Recruitment: Rooms, Offers, decisions persistence | 5 | trials with `recruitment/decisions` next, then signings |
| Agents: core | 1 | the transaction workspace is partly in |
| Cross-domain: `api`, `contracts`, `dates`, `productionHardening` | 0 | last |

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
  journey's history never names anyone, and a snapshot's `passportVersion` is always null.
- **Port only as far as the battery reaches.** Mark the rest `Not ported yet:`. There are 120 such markers, and the
  next battery in a domain usually starts by clearing some.

Measured trade-offs to keep in mind:

- **Scrypt** is pure Gleam and about 12 times slower than Node: 467 ms per hash, about 13 sign-ins a second at
  most, but it doesn't block other work. If that matters, use a NIF or PBKDF2, on both servers together.
- **SSE** fan-out is about 8 times faster than TypeScript at 1,000 streams, but uses about twice the memory per
  stream.

Open questions:

- **`productionHardening`** expects `/capabilities` to report `production_cv` as configured. This server says it
  isn't, because the analysis is moving out. Decide which before porting the battery.
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

Untangling the remaining 29 batteries is about **2–4 sessions** in all, and can run ahead of the port. The real
cost is the port itself. The rule-case backlog is mostly mapping work that grows with the ported rules: about
3,000 cases pending (2,253 of them in `dates`) and about 300 hand-port calls.

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
