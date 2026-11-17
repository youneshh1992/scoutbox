# Evaluation: migrating `scoutbox-server` to Gleam

November 2026. Box Cam CV is out of scope (it is moving to a native language whatever happens here).

## Summary

A Gleam port of the server is feasible. Nothing found so far blocks it, and the parts of ScoutBox's design
that matter most (one serialised writer, named acts guarded in SQL, effects after commit, typed tables that
refuse junk) carry over cleanly. Several of them get *stronger*, because rules the server now checks at run time
become rules the compiler checks.

It is still a rewrite of roughly 128k lines of server code, not a conversion, and it would happen while the
code is still being cleaned up. The main costs are three:

- **Development speed during and after the port.** Agents are less fluent in Gleam, and there is more
  hand-written boilerplate (decoders, encoders, refusal mapping).
- **A thinner, younger ecosystem.** Small libraries, one-maintainer packages and version churn are real, and
  some of each turned up within a few hours of the spike.
- **Losing shared types with the five TypeScript apps.** API types would have to be generated rather than
  shared.

My honest view: if ScoutBox is going to live for years and its main risk is subtle correctness bugs in
safeguarding, permissions and workflow state, Gleam is a defensible and probably good long-term choice. It is
not a boondoggle, provided the port is bounded: checked against the e2e batteries, and with go/no-go points
decided in advance. It would turn into one if it ran alongside feature work, or if it stalled halfway, leaving
two servers.

**Recommendation:** run one more calibration step before deciding (see the end). Meanwhile, stop putting new
effort into the TypeScript conversion beyond what's already in flight, because almost none of it carries over to
Gleam.

**Update after the second calibration (safeguarding, below):** four of the five go criteria hold; the fifth, a
fixture writer the coupled batteries can reuse, does not. The port itself went faster and more faithfully than
expected. The two open costs are untangling the batteries and read performance. Neither is a no-go condition,
so the decision is a judgement, set out at the end.

**Decision, 17 November: go.** Both conditions of the conditional go are met: the batteries untangle in minutes,
and with a patched esqlite that reads a query's rows in one call on a normal scheduler, Gleam's one-client
directory is within 7% of the TypeScript server's, and under load the directory runs at 4.6 times its throughput
and report resolution at 2.7 times. The port runs domain by domain behind the batteries
(`~/Code/scoutbox-gleam/battery-tests-port.md`). See "Read speed, and the decision" at the end, and its TODOs.

## What was tested

The spike is at `~/Code/sqlite_spike`, outside the repo. It's a slice shaped like the server:

- STRICT tables with vocabulary CHECKs.
- A follow-ups repository with an SQL-guarded status move, history child rows and `RETURNING`.
- A derived projection (match facts) refreshed by a before-commit hook.
- The unit of work as a single writer process.
- Read-only connection pools.
- Effects returned as data.
- A statement cache.
- A schema-driven code generator.

There are 17 tests and a benchmark against `node:sqlite` on the same schema.

### The storage layer works

| Check                                                                               | Result                                               |
|-------------------------------------------------------------------------------------|------------------------------------------------------|
| 50 processes × 20 read-then-write units on one row, yielding between read and write | 1000/1000, no lost updates                           |
| Reads while a 375 ms write unit runs                                                | Worst read about 0.1 ms; readers see the last commit |
| A unit returns an error                                                             | Everything rolled back, no effects sent              |
| A unit crashes (panic, failed assert)                                               | Rolled back; the writer carries on                   |
| `unit()` called inside a unit                                                       | Refused immediately, not a deadlock                  |
| A write on a read connection                                                        | Refused by SQLite (`Readonly`)                       |
| CHECK violation                                                                     | `ConstraintCheck` with the constraint text           |
| Distance rule as SQL math vs the Gleam rule                                         | Agree to about 1e-11 km over 300 random points       |
| Unicode lowercasing                                                                 | Works via an app-written `name_search` column        |

Here is what changes in the model compared with today's server:

- **A write outside a transaction can't compile.** Writes need a `Tx`, and only `unit()` creates one. Today
  `writeRules.ts` checks this at run time.
- **A GET can't write by construction.** Read handlers get a read-only connection, and SQLite refuses the write.
- **The async machinery disappears.** Today's store has to refuse async work, observe stray promises, and use
  `AsyncLocalStorage` and a module-global `unit`. Gleam on the BEAM has no `async`, so the problem doesn't
  exist.
- **Joining a unit is passing the `Tx`.** There's no runtime guess between joining the open unit, using an
  enclosing transaction, or opening a new one.
- **A slow write delays only other writes.** Today it stops the whole event loop.
- **Effects are values, not callbacks.** A test can assert on what an act would send.

### Things you can't do

- **No custom SQL functions.** esqlite, the C library sqlight wraps, can't register them. That affects
  ScoutBox's `haversine_km`, `distance_tenths` and `lower_js`:
  - The distance rules can be written in SQLite's built-in math functions, which esqlite compiles in.
  - `lower_js` becomes a column the application writes.
  - Both are small changes, but the distance one touches the under-18 and Grassroots-radius visibility rules,
    so the port must re-prove them with the existing batteries.
- **No commit hooks or update hooks exposed through sqlight.** The before-commit derivation is application-level
  anyway, so this didn't matter.

### Performance

| | Gleam (sqlight/esqlite) | Node (`node:sqlite`) |
|---|---|---|
| Point lookup, statement cache + decode | 13.4 µs | 2.8 µs (prepared once) |
| Point lookup, sqlight as shipped (prepares every call) | 18.4 µs | 11.4 µs (prepares every call) |
| Point lookup through the reader pool | 25 µs | n/a |
| Write unit (insert + history + hook + COMMIT) | 112 µs (8.9k/s) | 170 µs (5.9k/s) |

- **Writes are at least as fast as Node.** Committing to disk dominates.
- **Reads cost 4–5× more per statement.** About 4.5 µs of that is decoding 8 columns. esqlite itself costs
  about 9 µs per lookup even without decoding. My unmeasured guess is that every step is handed to the BEAM's
  separate threads for blocking calls ("dirty schedulers").
- **What that means per request:** 10–50 statements cost roughly 0.15–0.7 ms, well within the 5 ms p50 target.
- **The offsetting win is parallelism.** Reads and response building (JSON encoding, projections, permission
  checks) run on every core. Today one Node thread does all of it, and it would saturate first under load.
- **The writer stays a single serial lane.** It is today too. At about 9k small units a second, it's far beyond
  what this product needs.

**Statement cache.** sqlight doesn't reuse prepared statements, so the spike adds a cache of about 60 lines of
Erlang (`spike_ffi.erl`):
- It keeps each connection's statements in that connection's own process.
- It refuses a call whose argument count differs from the first call. esqlite keeps old bindings across a reset,
  so passing too few arguments would otherwise silently reuse the previous call's values. That's a quiet
  data-corruption risk that a naive cache would have.

## Code generation

| Option | Verdict |
|---|---|
| **squirrel** | Postgres only. Its approach (ask the database to describe each query) doesn't work on SQLite, which can't report a query's column types or nullability. |
| **parrot** (sqlc) | Not suitable. Vocabularies come back as `String` and booleans as `Int`. It typed a computed REAL as `Int`, which compiles and then fails at runtime. It produced Gleam that didn't compile for a parameter inside a math function. Every query gets its own near-duplicate type. It becomes a runtime dependency and downloads the sqlc binary. |
| **Own generator, schema-driven** | Works. It reads the migrated schema from SQLite and writes, per table, a row type, decoder, column list, insert and a real enum per CHECK vocabulary. It handles clashing values and keyword column names. It runs as `gleam dev`, its dependencies are dev-only, the generated files are committed, and birdie snapshots guard it. |
| **gleamgen** (as the renderer) | Usable, marginal gain. Clean formatted output and import handling. But our code shape comes from the schema, so nearly everything goes through its untyped "dynamic" API and its type safety barely applies. String templates plus `gleam format` would be about as good. |
| **cake** (query builder) | Fine for the handful of optional-filter queries (directory search). It doesn't know the schema and gives no typed results. One gotcha: an empty `where.and([])` produces invalid SQL that only fails at run time. |
| **birdie** (snapshots) | Recommended. It caught a real generator bug in the spike. |

Remaining codegen work for ScoutBox:
- **Shared vocabularies.** ScoutBox shares many across tables (`domain.ts`). They need declaring once, or
  mapping in the generator, rather than becoming one type per table.
- **Dates** are plain `String`s today.
- **Queries that don't return whole rows** (joins, aggregates, projections) still need hand-written decoders.
  Expect a lot of them.

## Safety and robustness

This is the strongest argument for the move.

- **Sound types.** Gleam has no `any`, no `undefined`, and no way to type-cast around the checker short of an FFI
  call. A `Status` is one of its constructors. A missing branch is a compile error. That covers the transition
  tables (`ROOM_TRANSITIONS`, `CLAIM_TRANSITIONS`), the role and permission rules, and safeguarding visibility.
  TypeScript's checker can be bypassed in many ways (`as`, untyped parameters, unchecked indexing, `allowJs`
  boundaries), and today's `writeRules.ts`, `typeof fn !== 'function'` guards and stray-promise detection exist
  because of that.
- **Errors are values.** `Result` matches the "refuse, don't coerce; expected failures are return values"
  philosophy already written into `docs/architecture.md`. Nothing throws past a caller unseen.
- **Crash isolation.** A bug in one request or one sweep crashes one process. In the spike, a panic inside a unit
  rolled back and the writer carried on. Today an unhandled rejection or a blocking loop affects the whole server.
- **Supervision.** Sweeps, the writer, the readers and SSE connections become supervised processes with defined
  restart behaviour. Today that's hand-written timers.
- **Simplicity of the type system.** `fieldSpecs.ts`-style conditional types can't be written. The cost is more
  generated or hand-written code. The benefit is code a reviewer (or agent) can read without unpicking
  type-level programs.

Where Gleam is **not** safer than today:
- **SQL is still strings.** The checks are the tables' CHECKs and keys (as now), plus generated decoders that fail
  loudly. A query whose result shape is wrong fails at run time, exactly as now.
- **`let assert` and `panic` exist.** They need the same review discipline as `throw`.
- **Opaque types don't stop a `Tx` being stored and used after its unit.** Rust lifetimes would; Gleam doesn't.
  Convention and review cover it.
- **FFI code is unchecked.** The statement cache and any Erlang glue need tests of their own.
- **A unit that times out has an unknown outcome.** It may still commit. Same as today's server would face with
  any async boundary, but it needs handling (idempotency keys already exist).

## Development speed

- **During the port:** expect a dip.
  - 849 routes, about 77k lines of domain code and about 51k lines of repositories need rewriting.
  - The 47k lines of unit suites and scripts need rewriting too, or at least the ones that test internals.
  - The 87k lines of e2e batteries talk plain HTTP and can be kept unchanged in JS and pointed at the new server.
    That's the biggest de-risking asset: a language-independent specification already exists.
- **Agent fluency** is lower than in TypeScript. In the spike, compile errors came from stdlib changes
  (`list.range` removed in 1.0), closure generalisation, phantom-typed library APIs and project naming rules.
  All were quick to fix, because Gleam's compiler messages are excellent, but each costs a round trip. Library
  APIs often had to be read from source rather than recalled. Expect more of this in the long tail (HTTP
  middleware, crypto, multipart uploads).
- **After the port:** probably neutral to positive.
  - Refactors are safer: the compiler finds every call site and missing branch.
  - Compilation is fast.
  - The formatter and language server are good.
  - Against that: more boilerplate per field (decoder, encoder, validator, response builder) and no reflection or
    macros, so the generator has to carry more of the load.
- **Who can work on it:** today that's Tom plus agents. Gleam's hiring pool is small. If the team is expected to
  grow with conventional hires, that's a real cost; if it stays agent-led, it matters less.
- **The freeze:** the port fits "architecture work" only in spirit. It would effectively extend the freeze, and
  the Founder should hear in plain terms that new features would wait until it's done.

## Library and ecosystem risk

Within a few hours, the spike hit:
- A latest-version library that doesn't compile on the current Gleam (gleamgen 0.3.6, which the resolver picked
  silently).
- A dependency-range conflict between two dev tools, resolved by pinning birdie.
- A package name that doesn't exist (`maths` → `gleam_community_maths`).
- stdlib API removals.

None was serious. All of them would recur over years.

| Need | Gleam option | Risk |
|---|---|---|
| SQLite | sqlight → esqlite | sqlight is maintained by Gleam's creator. esqlite is a long-lived Erlang library. Low–medium: missing features (custom SQL functions, statement reuse) must be added ourselves. |
| HTTP server | wisp + mist | Core-team maintained, widely used in Gleam. Low. |
| JSON | gleam_json | Low. |
| Crypto (HMAC, hashing, random) | gleam_crypto / Erlang `:crypto` | Low: OTP's crypto is mature. TOTP is already hand-written in ScoutBox. |
| Input validation with path-named refusals | hand-written over `gleam/dynamic/decode` | Medium effort, low risk: valibot's behaviour has to be rebuilt to the existing refusal format. |
| SSE / live events | mist | Low; a natural fit for processes. |
| Outbound providers (mail, push, webhooks) | gleam_httpc or Erlang clients | Low–medium: fewer vendor SDKs, so the raw HTTP APIs are used directly. |
| Observability (metrics, error reporting, tracing) | Erlang telemetry, OpenTelemetry Erlang, vendor Erlang SDKs | Medium: thinner and less documented than Node's, and Gleam-specific wrappers are rare. |

- **The safety valve is Erlang.** Any mature Erlang library is usable through small FFI shims. Elixir libraries
  are harder (macros, build tooling), and much of the BEAM ecosystem's breadth lives in Elixir.
- **Churn policy:** pin versions, keep dependencies few, and prefer core-team or Erlang-backed packages over
  single-author Gleam ones.

## Shared types with the apps

All five clients are TypeScript, and CLAUDE.md wants their hand-copied API types moved into a shared package.

- **With a TypeScript server**, that package can be the server's own types.
- **With Gleam**, the API types would be generated: Gleam response types → JSON Schema or TS declarations, built
  by the same kind of generator. That's sensible discipline anyway (one source, generated outward), but it's new
  tooling to build and keep correct.
- **Gleam can also compile to JavaScript.** Pure shared rules (`roles`, `temporal`, parts of `domain`) could be
  written once in Gleam and compiled for the apps. That would honour "one definition per rule" across server and
  clients. Gleam's JS data types (linked lists, class-based records) are awkward to consume from TypeScript, so
  this suits functions with simple inputs better than data shapes. Worth an experiment, not a plan.

## Operations and lifecycle

- **Deployment:** `gleam export erlang-shipment` produces a self-contained BEAM release. The Dockerfile and
  `fly.toml` need rewriting, and the image needs the Erlang runtime rather than Node.
- **Native code:** esqlite compiles SQLite from source when the project builds, so a C toolchain is needed in CI
  and image builds. That also pins the SQLite version to esqlite's bundled copy rather than Node's.
- **Running it:** the BEAM's built-in introspection (observer, remote shell, process inspection) is a real
  strength for diagnosing a live server. Vendor APM tooling is weaker than for Node.
- **Scaling:** unchanged. SQLite means one machine and one writer in either language. The BEAM's multi-node
  distribution isn't useful with SQLite. If ScoutBox ever needs several machines, that's a database change
  (Postgres), which is a bigger decision than the language. Gleam's best typed-SQL tool (squirrel) is
  Postgres-only, so that path would get easier, not harder.
- **Memory:** the BEAM's baseline is higher than a single Node process, but per-connection costs are low.
  Not a concern at this scale.

## Risks, ranked

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The port stalls halfway, leaving two servers | Medium | High | Big-bang behind the batteries; no feature work in either server meanwhile; a go/no-go after the calibration domain; keep the JS server until every battery passes. |
| Behaviour drifts in ways the batteries don't cover | Medium | High (safeguarding, permissions) | Batteries are the spec; add batteries before porting where coverage is thin; port the visibility SQL and re-prove it first. |
| Agent productivity lower than expected | Medium | Medium | Measure it in the calibration step; build the platform layer (store, codegen, validation, routing) first so domain code is mostly mechanical. |
| A library is abandoned or breaks | Medium over years | Low–medium | Few dependencies, pinned; Erlang fallbacks; own the small pieces (statement cache, validation). |
| Read performance gap matters more than expected | Low | Medium | Statement cache, less per-query decoding, batched child-row reads (already the rule); perf battery on the Gleam server. |
| API type generation drifts from the apps | Medium | Medium | Generate TS types from the Gleam types in CI; fail the build on a diff. |
| Staffing beyond Tom + agents | Unknown | Medium | Decide whether the team will grow with conventional hires before committing. |

## Staying on TypeScript instead

The lower-risk alternative is to finish the TypeScript conversion and take the architectural wins without
changing language:
- An explicit `Tx` handle instead of the ambient unit.
- Effects returned as data.
- An outbox for side effects.
- A lint rule banning conditional and mapped types outside a few files.

That gets perhaps half the robustness benefit for a fraction of the cost. It keeps TypeScript's soundness gaps,
the async hole in the unit of work, and shared types with the apps for free. If those soundness gaps are what
actually bother you day to day, this alternative won't fix them. If the main worry is the ambient unit of work
and `fieldSpecs.ts`-style complexity, it will.

## Next step: calibrate before deciding

Port one real vertical slice into a Gleam server skeleton and run its existing e2e batteries against it
unchanged:
- Platform basics: sessions and auth middleware, the refusal format, paging.
- The identity pieces it needs.
- `signingsFollowUps`.

Decide go/no-go on:

1. **Batteries:** do they pass unmodified, apart from storage-only assertions?
2. **Time:** how long did the slice take, and what does that extrapolate to across 849 routes?
3. **Code size:** how much domain code was hand-written versus generated, and is it readable?
4. **Performance:** is p50 on the slice's hot paths under 5 ms with the perf seed?
5. **Libraries:** did anything need a library that doesn't exist or doesn't work?

If the slice goes well, plan the full port bottom-up through the domain layers (platform → identity … →
passport), one layer at a time, each closed by its batteries. If it goes badly, the cost was one domain, and the
TypeScript path above is still open.

## Calibration 2: the safeguarding slice (November 2026)

The first calibration ported the staff slice (11 routes). This one tested the parts that would justify the move:
rules over joined data, acts that write several tables, the code generator, and batteries that reach into the
TypeScript server. The code is in `~/Code/scoutbox-gleam` (commits `e8d8974` to `e1baaf1`); the TypeScript-side
fixture writer is on the unpushed branch `sql-fixture-writer` (commit `cabcf078`, worktree
`~/Code/scoutbox-fixture`).

### Results against the go criteria

| Criterion | Result |
|---|---|
| Both batteries pass | **Yes.** `platform/safeguarding` 61 checks, `platform/playersAndGuardians` 58, `platform/staff` still 28. Only `e2e/sync.mjs`'s mechanical rewrites; no assertion changed. Both passed on their first run. |
| The distance rules agree | **Yes, to the last bit except at the edge itself.** 1,503 cases generated from domain.ts (random pairs, and pairs bisected to the last double either side of the 50 km radius and of each rounding edge). 1,500 agree exactly; 3 sit within 1e-12 km of an edge, where macOS's `cos` and V8's `x ** 2` differ from V8 in the last bit. No implementation outside V8 can match it bit for bit, and a stored location that close to an edge is not a real case. |
| Hand-written code per route clearly below the staff slice | **Yes.** 241 hand-written lines per route for the staff slice (217 after its decoders were replaced by generated ones), 109 for safeguarding and 107 for players and guardians. 4,802 lines are generated. |
| The second battery took markedly less time than the first | **Yes in total, modestly per route.** About 33 minutes for safeguarding's 37 routes and 10 for the second battery's 16 (0.9 against 0.6 minutes a route). |
| The SQL fixture writer generalises | **No, not as it stands.** See below. |

### Time

All in one working session, wall-clock:

| Step | Time |
|---|---|
| 1. Code generator, and the staff slice refitted to it | 12 min |
| 2. Distance rules, proved | 5 min |
| 3. Safeguarding slice: 6 migrations, the seed, rules, repositories, 37 routes, battery passing, shape diff | 33 min |
| (rule proofs: 5,652 visibility and 45 moderation cases from domain.ts) | 2 min |
| 4. Players and guardians: 16 more routes | 10 min |
| 5. `sessionsAndPorts` untangled (a subagent, in parallel) | 9 min |
| 6. Measurement | about 15 min, mostly benchmark runs |

These are an agent's minutes, not a person's, and both slices were chosen to be self-contained. Read them as
relative pace, not as a schedule.

### Code generation in practice

- The generator (`dev/scoutbox/codegen.gleam`, about 600 lines) reads the migrations into an in-memory SQLite
  database and writes one module per table: the `Row`, its decoder, the column list and count, `insert`, and
  `new(…)` from the required columns (nullable ones start as `None`, defaulted ones at their SQL `DEFAULT`), so a
  40-column ledger insert is three named fields and a record update. It uses plain string templates and
  `gleam format`; gleamgen was not needed.
- Shared vocabularies are declared once (5 of them; `player|guardian` alone recurs in 29 columns of the full
  schema) and rendered as their own modules, so constructors read `party.Player`, `audience.OrgUser`.
- The generated `Row` serves as the domain record, with what is derived from it as functions. That, more than
  the decoders, is what removed the boilerplate.
- Two frictions: `gleam dev` compiles `src/` first, so code that names a not-yet-generated column blocks the run
  that would generate it; and a `Row` used through a type alias can't be pattern-matched by constructor, so
  matches become guards.

### Faithfulness beyond the batteries

The batteries check what they assert, not everything a response carries, so two more checks were added:

- **Rule proofs.** Cases generated from the TypeScript rules themselves, checked against the ported ones: the
  visibility rule (5,652 decisions: players either side of each country's adult cutoff, 29 February, every kind
  of organisation, on five days including a leap day), moderation (45 hits and near-misses, on Erlang's PCRE
  against V8's regexes) and the distance rules. All agree.
- **Shape diff** (`dev/shape_diff.mjs`). The same 37 requests of both servers, compared by key path, key order
  and JSON type. It found two things the batteries missed: an organisation's attendance items had their keys in
  the wrong order, and a stats update didn't log activity or award journey badges. Both were fixed. The 8
  responses that still differ are exactly the ones marked `Not ported yet:` (similarity, a notification's deep
  link, process metrics, insights).

The visibility rule (the under-18 wall, verified clubs only, the Grassroots radius) is now one SQL expression
used by every read, single player or list. Adulthood is one cutoff-date comparison, identical in Gleam and SQL.

### Untangling the batteries

The fixture writer itself works: plain SQL through `node:sqlite`, row-for-row identical to the TypeScript path,
141 lines, with a schema snapshot (`e2e/support/schema.sql`) and a drift check in `npm test`. All 56 TypeScript
batteries and 71 unit suites pass on the branch. It took 9 minutes.

It does not generalise, because `writeFixture` is the smaller part of the coupling:

- Every one of the other 23 batteries imports TypeScript internals directly (1 to 15 imports each: constants,
  models, migration ids).
- 19 read results back through the repositories (`readRecords`), and 13 run repository code in the test
  process (`openLayer`, `plantCase`).
- Several fixtures exist to test the repositories' own refusal of bad records, which plain SQL can only
  reproduce where the schema itself refuses.
- `sessionsAndPorts` itself still can't run against Gleam: section A tests Express's async error forwarding
  by importing a server module, and other sections test live-event tickets and signed media links (both out of
  scope). Its import is dynamic (`await import('../../domains/…')`), which the Gleam repository's
  `e2e/sync.mjs` guard does not detect: that guard needs fixing.

The agent's estimate is half a day to a day of rework per coupled battery, most of it replacing the internal
imports and repository reads, not the fixtures. Two decisions are needed first: whether batteries may keep
importing shared rule and constant modules (`roles.ts`, `domain.ts`), or whether those values are copied into
`e2e/support` as part of the specification; and a plain-SQL row reader to match the writer.

### Performance

The TypeScript perf population (10,000 players with their lists, 500 organisations, 3,333 guardians), written
as SQL into each server's own database. M1 Pro, 6 cores, load generator on the same machine.

| Measurement | TypeScript p50 / req/s | Gleam p50 / req/s |
|---|---|---|
| Org player view, one client | 51.7 ms / 19 | 1.3 ms / 748 |
| Org player view, 32 clients | 1,614 ms / 19 | 24 ms / 1,280 |
| Directory page of 20, one client | 2.5 ms / 391 | 3.8 ms / 241 |
| Directory page of 20, 32 clients | 64 ms / 457 | 61 ms / 441 |
| Report resolution, one client | 1.2 ms / 735 | 0.7 ms / 1,309 |
| Report resolution, 32 clients | 30 ms / 990 | 13 ms / 2,277 |

- **The 5 ms p50 target holds** for both named paths.
- **The org player view is not a fair comparison.** The TypeScript figure is mostly its "more like this"
  ranking, which scans all 10,000 players on every view; the port doesn't have it yet.
- **The directory is the fair read comparison, and Gleam does not pull ahead.** It is about 50% slower for one
  client and level under concurrency, with the BEAM at about 560% CPU of 600. A read costs several times more
  CPU here, as the spike predicted per statement. Not yet profiled. The likely causes: sqlight re-preparing
  about 15 statements per request (the spike's statement cache isn't in this server), term conversion when
  decoding, and building large JSON views.
- **Writes do pull ahead**: resolution is 2.3 times the TypeScript throughput at 32 clients.
- **One configuration bug found:** with 4 read connections, the org view *slowed* under concurrency (534 req/s
  against 746 for one client), because each reader runs one read at a time. The server now opens 16.

### Libraries

Nothing missing blocked the slice. No library was vendored this step and `src/` still has no FFI.

- **No IANA time-zone database** in OTP or any maintained Gleam package. Validating a zone name was solved by
  generating the accepted names from the TypeScript rule; computing quiet hours in a person's zone (push
  deferral) is a real gap, and outbound providers will need it.
- **No scrypt** in OTP's crypto. Out of scope here, but until it lands no password-protected account can sign in,
  and a new player account stores a hash no password matches.
- **No statement reuse in sqlight**: likely part of the read cost above.
- `gleam_regexp` (Erlang PCRE) agreed with V8 on the moderation corpus. `gleam_time` covered the date rules.

### Extrapolation and the freeze

64 of 849 routes now answer (7.5%). The method, stated so it can be argued with:

- **Routes.** This session ported 53 routes and built the platform pieces they needed. At 40 to 60 routes per
  comparable session, the remaining ~785 take 13 to 20 sessions. The remaining domains are heavier (recruitment
  rooms, offers and signings with their state machines, the agents' compliance engine, Box Cam, uploads), so
  double it: **25 to 40 sessions**.
- **Untangling the 23 coupled batteries:** a quarter of a session to a whole session each: **6 to 23 sessions**.
- **The out-of-scope checks** (live events, uploads, outbound providers and time zones, observability, password
  hashing, deployment): about one session each: **6 sessions**.
- **Read performance:** profiling and the statement cache, **1 to 3 sessions**, with an uncertain outcome.

**Total: about 40 to 70 working sessions.** At a few sessions a working day that is roughly two to four months
of freeze. The spread is mostly the batteries and the heavier domains; the next domain ported would narrow it.

For the Founder, in plain terms: if we go, new features wait roughly two to four months while the server is
rebuilt behind the same tests. Everything users see should behave the same throughout; the payoff is fewer
hidden safeguarding and permission bugs afterwards, because the rules are checked by the compiler and proved
against today's behaviour.

### Decision

By the criteria set in advance, this is **not a clean go**: the fixture writer does not generalise. It is not a
no-go either: the slice did not stall on the ecosystem, the generator halved the hand-written code, and the
freeze plausibly fits the year.

My recommendation is a **conditional go**: before committing to the freeze, spend two or three sessions on the
two open costs, each with its own pass mark:

1. **Untangle three of the heaviest coupled batteries** (say `recruitment/journey`, `agents/core`,
   `platform/storeGuarantees`) with a plain-SQL row reader beside the writer, after deciding whether batteries may
   import the shared rule modules. Pass: each passes on the TypeScript server, imports nothing from its internals,
   and took under half a session.
2. **Profile the directory read and add the statement cache.** Pass: Gleam's one-client directory p50 within 25%
   of the TypeScript server's, and ahead of it at 32 clients.

If both pass, plan the full port domain by domain behind the batteries, keeping the TypeScript server until
every battery passes. If the batteries don't untangle cheaply, the TypeScript path in this document remains, and
the fixture writer is worth keeping either way.

## Read speed, and the decision (17 November)

The port carried on after the second calibration without the two conditions above being closed. This section
closes them. By then about a day and a half had been spent (Sunday evening to Tuesday morning): the pilot, both
calibrations and the port so far.

### Condition 1: untangling — passed

32 of the 53 batteries that will be ported are now language-neutral, including all three named
(`recruitment/journey`, `agents/core`, `platform/storeGuarantees`). A heavy battery takes minutes, not the half
day estimated above. The fixture writer did generalise once a row reader (`e2e/support/sqlRows.mjs`) sat beside it
and rule checks moved to `scripts/rules/`. The details are in `battery-tests-port.md`.

### Condition 2: read speed — passed, with a patch to esqlite

**The cause is esqlite's dirty schedulers, not SQLite.** esqlite runs `step` (and `open`, `close`, `exec`,
`finalize`) as dirty I/O NIFs. All dirty I/O schedulers share one run queue, so every row a query returns pays a
scheduler hop, and under concurrency they contend for that queue. Measured in `~/Code/sqlite_spike`, on the
M1 Pro (6 cores):

| Point lookup | esqlite as shipped | `+SDio 1` | NIFs on normal schedulers | Node (`node:sqlite`) |
|---|---|---|---|---|
| Prepared once, one process | 8.6 µs | — | **2.4 µs** | 2.7 µs |
| Statement cache + decode | 13.4 µs | — | 3.8 µs | — |
| 8 connections in parallel, autocommit | 22k/s | 120k/s | **617k/s** | 311k/s |
| 8 connections, one read transaction each | 24k/s | — | 4.2M/s | — |
| Through the reader pool, 64 callers, 8 readers | 28k/s | — | 276k/s | — |

- **Throughput fell as connections were added** (114k/s for one, 22k/s for eight), the opposite of what the
  BEAM should give. With one dirty I/O scheduler (`+SDio 1`) it holds level; with 64 it collapses further.
- **Compile flags change nothing.** `-O2` in place of esqlite's `-Os`, and `SQLITE_THREADSAFE=2`, were each built
  (and checked in the binary's compile options) with no measurable effect. No build on disk had ever used custom
  flags.
- **The price of normal schedulers is long statements.** A statement that runs for 375 ms now holds a normal
  scheduler for that long; the spike's `reads_carry_on_while_a_slow_unit_writes_test` fails with every NIF moved.
  Concurrent 10k-row scans fell from 8.6k/s to 5.0k/s.

On the server, with the TypeScript server's perf population (10,000 players), measured the same morning, with
only `step` moved (`exec`, so BEGIN and COMMIT's fsync, stays dirty):

| Measurement | TypeScript p50 / req/s | Gleam as shipped | Gleam, `step` on normal schedulers |
|---|---|---|---|
| Directory page of 20, one client | 2.84 ms / 338 | 4.83 ms / 184 | **3.55 ms** / 277 |
| Directory page of 20, 32 clients | 70 ms / 415 | 82 ms / 336 | **21 ms / 1,363** |
| Org player view, one client | 52.8 ms / 18 | 2.41 ms / 408 | 1.94 ms / 485 |
| Org player view, 32 clients | 1,671 ms / 18 | 85 ms / 365 | 47 ms / 658 (17 ms / 1,688 with `+SDio 1`) |
| Report resolution, 32 clients | 38 ms / 782 | 38 ms / 769 | **20 ms / 1,557** |

- **The pass mark is met**: one-client directory within 25% (3.55 ms against a limit of 3.55), and 3.3 times
  TypeScript's throughput at 32 clients. The server still has no statement cache, which halves the per-statement
  cost in the spike, so the one-client figure should improve.
- **Most of the one-client directory time is not statement overhead.** About 15 statements at 10 µs is 0.15 ms of
  3.5. The rest is unprofiled: likely the visibility expression over the population, decoding, and building the
  JSON.
- **The server has slowed since the pilot** as domains were ported into the same paths: the org view at 32
  clients was 1,280 req/s, and is 365 as shipped today. Nothing caught it.
- The esqlite patches were measured on copies in `build/` and have been reverted; both projects build stock
  esqlite again.

### TODOs before and during the full port

**Done, 17 November, in one scoutbox-gleam commit** (TODOs 1, 2, 2a and 3 as first written):

- **The patched esqlite.** `scoutbox-server/vendor/esqlite.patch` (106 lines) and `dev/esqlite.mjs`
  (`npm run esqlite`): the Hex tarball fetched and checked against the manifest's checksum, patched, given a
  `gleam.toml`, and its NIF compiled with esqlite's own flags (about 10 s; nothing when current). `gleam.toml`
  takes `vendor/esqlite/` (not committed) as a path dependency, and `npm run e2e` runs the script first. The patch
  differs from the plan: it leaves upstream's `step` alone and adds `fetchall` (every row in one NIF call, on a
  normal scheduler) and `fetchall_dirty` (the same on a dirty one). That is smaller and easier to offer upstream.
  It also returns BUSY as an error: esqlite's own Erlang `fetchall` has no case for `$busy` and would crash.
- **The statement cache and the per-statement choice** (`platform/scoutbox_store_ffi.erl`, `src/`'s first `.erl`):
  each connection's statements are prepared once, in an ETS table owned by the writer's process (a unit runs in a
  fresh process, so a process-dictionary cache would never be reused for writes), with the spike's argument-count
  refusal. A statement runs on `fetchall` until one run takes over 1 ms, then on `fetchall_dirty` for good.
  `exec` (BEGIN, COMMIT, migrations) stays on sqlight, on a dirty scheduler.
- **Readers have `busy_timeout = 0`**, and a run that meets a lock is retried in Erlang, 1 ms apart, for up to 5 s
  (the old timeout), sleeping without holding a scheduler. The writer keeps its 5 s.
- **Tests** (`test/scoutbox/store_statements_test.gleam`): new arguments on a reused statement, the count refusal,
  errors and decode failures identical to sqlight's own, a slow statement moving to dirty, reads carrying on while
  a unit runs a long statement, and a read retrying through another connection's exclusive lock. Each was
  mutation-checked against the FFI.
- **Results**, the perf population, the same machine and morning:

  | Measurement | TypeScript p50 / req/s | Gleam before | Gleam now |
  |---|---|---|---|
  | Directory page of 20, one client | 2.56 ms / 374 | 4.83 ms / 184 | **2.73 ms / 366** |
  | Directory page of 20, 32 clients | 66 ms / 437 | 82 ms / 336 | **15.6 ms / 2,000** |
  | Org player view, one client | 53.5 ms / 18 | 2.41 ms / 408 | 0.97 ms / 961 |
  | Org player view, 32 clients | 1,640 ms / 19 | 85 ms / 365 | 10.5 ms / 2,755 |
  | Report resolution, one client | 1.29 ms / 707 | 1.22 ms / 719 | 0.70 ms / 1,220 |
  | Report resolution, 32 clients | 31 ms / 952 | 38 ms / 769 | 12.4 ms / 2,575 |

  The one-client directory is 7% behind TypeScript (the mark was 25%), and every path is ahead under load: the
  directory 4.6 times, report resolution 2.7 times.
- **A race the faster reads exposed.** `agents/core` L12 then failed every time: the live stream joined the hub
  in `on_init`, after ewe had sent the headers, so a client acting as soon as its stream opened could publish an
  event before the stream listened. The stream now joins before the headers go out (`live_routes.open`).
- `vendor/esqlite.patch` is recorded beside `platform/unicode` under the FFI rule in `scoutbox-gleam/CLAUDE.md`.

Still to do:

1. **Offer the `fetchall` pair upstream** to esqlite (BUSY as an error included). A public issue or PR, so Tom
   decides when.
2. **Known long work starts dirty.** Today a long statement pays one slow run on a normal scheduler per
   connection before it moves. When the "more like this" ranking, exports or the sweeps over every row are ported,
   give the store a way to start a statement on `fetchall_dirty`.
3. **Battery port ranges overlap.** In one full run of three, `recruitment/contacts` and
   `recruitment/signingsPersistence` failed together, consistent with two batteries drawing the same port from
   overlapping `pickPort` ranges (5600–5806 against 5700–5899, 5900–6099 against 5800–6006), so one battery's
   requests reached another's server. Both passed in six reruns and in the next full run. **Done:** every battery
   now takes each server's port from `freePort()`, and `pickPort` is gone. But `recruitment/contacts` still fails
   about one run in six on Gleam, run alone: X8's 21 MB body is refused from its `Content-Length` unread, and the
   socket closes with the body still arriving, so the client sees a reset instead of the 413. Express drains it.
4. **Decide the dirty I/O scheduler count** (`+SDio`) for production; with only `exec`, `open` and long statements
   dirty it matters less, but measure it.
5. **Put `dev/perf.mjs` under a threshold** (in `e2e:check`, or a nightly run) so a slowdown like the one since
   the pilot can't recur silently.

### Decision

**Go.** Both conditions of the conditional go are met, and the port has outrun every estimate above.

**The freeze, re-estimated from the real pace.** In about a day and a half: 25 of 53 batteries pass unchanged,
32 are untangled, and roughly 360 of the 849 routes answer (a rough count of the router's method arms). The
estimate above was 40 to 70 sessions, two to four months. What is left:

- the heavier half of the routes (agents and their compliance engine, discovery, development, passport,
  operations, the rest of recruitment) and their 28 batteries;
- untangling the last 21 batteries (2–4 sessions by the port plan's estimate);
- the rule-case backlog: about 3,000 recorded calls to map (2,253 in `dates`) and about 300 hand-ports;
- the TODOs above, and the out-of-scope checks not yet done (uploads, outbound providers, observability,
  deployment; live events and password hashing are in).

At the pace so far, with the remaining domains taken as twice as heavy, that is **one to two more weeks**. For the
Founder: new server features wait about two more weeks, not months; the TypeScript server stays in service until
every battery passes on Gleam.
