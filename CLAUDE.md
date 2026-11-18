# ScoutBox in Gleam

A pilot port of the ScoutBox server (`../scoutbox/scoutbox-server`, Node/TypeScript) to Gleam on the BEAM, with
SQLite through `sqlight`. The TypeScript server is the reference: its e2e batteries are the behavioural
specification this server must pass unchanged. Read `../scoutbox/CLAUDE.md` and
`../scoutbox/docs/architecture.md` for the product rules; they apply here too.

- `scoutbox-server/`: the Gleam server. How to run it and what is ported: its `README.md`.
- `.claude/docs/gleam/html/everything.html`: the whole Gleam language tour on one page. Read it when unsure of
  syntax or semantics rather than guessing from other languages.

## Writing Gleam here

- **Pure Gleam is always preferable.** Use Erlang FFI (`@external`) only when something is impossible in Gleam
  and no maintained Gleam package covers it. Today `src/` has two: `platform/unicode` (NFC, from OTP's tables)
  and `platform/scoutbox_store_ffi.erl` (the store's statement cache and scheduler choice, on the NIFs
  `vendor/esqlite.patch` adds; see the README).
  If you must add one: keep it in one small module, document why Gleam can't do it, and test it directly,
  because the type checker can't see across FFI.
- **`gleam check` is the fast feedback loop.** It type-checks the whole project in well under a second, so run
  it after every change instead of `gleam build` or `gleam test`. Then `gleam format` and `gleam test`.
- **Library APIs:** read the source in `scoutbox-server/build/packages/<package>/src/` instead of recalling it.
  The ecosystem moves quickly and remembered APIs are often stale.
- Known traps, all hit during the pilot:
  - `list.range` no longer exists. Use `list.repeat`, or recurse.
  - A function bound with `let` is not generic. If it's used at two types, make it a top-level `fn`.
  - `bit_array.slice` fails on bit strings that aren't whole bytes. Match with `<<b:bytes-size(n), _:bits>>`.
  - JavaScript's `length` counts UTF-16 units. Text limits use `input.utf16_length` so they agree with the
    TypeScript server and the apps.
  - `wisp_ewe` is not on Hex. It is vendored and adapted in `platform/wisp_ewe.gleam`.
  - esqlite is patched (`vendor/esqlite.patch`, built by `npm run esqlite`). After a fresh clone or a change to the
    patch, run it before any `gleam` command; `npm run e2e` runs it itself. Don't edit `vendor/esqlite/`: it is
    rebuilt from the patch.
  - A statement through the store runs on a normal scheduler until it takes over 1 ms. Known long work (a full
    scan, a sweep over every row) pays that once per connection; it is never wrong, only briefly slow for others.
  - `gleam dev` (the generator) compiles `src/` first, so code that uses a name the generator has not written yet
    blocks the run that would write it. Regenerate before using a new column or table.
  - A panicking `npm run codegen` (an id column it can't decide, say) has already deleted `src/scoutbox/rows` and
    `vocab`, so `src/` no longer compiles and the next run can't start. Restore them with
    `git checkout -- src/scoutbox/rows src/scoutbox/vocab`, fix the declaration, and run it again.
  - `clock.date_string` is JavaScript's `toDateString` (`Mon Nov 16 2026`). A `YYYY-MM-DD` day is `clock.iso_day`.
  - A domain record that is a generated `Row` is a type alias: its constructor can't be matched through the alias.
    Match with a guard (`Some(u) if u.removed_at != None`) or the row module's constructor.
  - Function calls are not allowed in case guards, nor constructors with a non-constant argument
    (`if x == Some(user.id)`): bind the value first (`let me = Some(user.id)`).
  - `|>` binds looser than `<>`: `"a" <> x |> f <> "b"` pipes the whole left side. Call `f(x)` instead.
  - A unit runs in the writer's process: read the request body before it (`http.parse_body`), never inside.
  - Two vocabularies of one table that share a value get prefixed constructors (`reports.TargetKindPlayer`).
  - `rows/id` imports the store, which imports `platform/effect`, so an effect can't hold a typed id: its ids are
    text (`effect.SendPush`, `live_event.Event`), built from typed ids by a function outside the cycle
    (`live_routes.messages(channel_id)`).
  - Imports go at the top of a module; when a need turns up mid-file, add the import there, don't wrap the
    function. The stdlib already has `list.try_map`, `string.join` and friends: look before writing one.

## Writing the data layer here

- Tables come from `priv/migrations`; their Gleam is generated (`npm run codegen`). Shared vocabularies are declared
  once in `dev/scoutbox_dev.gleam`.
- Ids are typed: each table declared `Ided` in `dev/scoutbox_dev.gleam` has an opaque `<Name>Id` in the generated
  `scoutbox/rows/id`, with `<name>_sql`, `<name>_json`, `<name>_decoder`, `<name>_to_string` and, given a prefix,
  `next_<name>(tx)` to mint one. Functions take and return the typed id. `id.<name>(text)` makes one only at a
  boundary: a path segment in the router, a request body or query field, a polymorphic column whose kind column
  says whose id it is, or a test's literal. `_to_string` is for text: a polymorphic column, a log line, a key.
  Every column named `id` or `*_id` must be typed by a foreign key or decided in `id_columns` (`RefersTo` or
  `Untyped` with its reason), or `npm run codegen` refuses it. Polymorphic pairs (`subject_kind` + `subject_id`,
  `audience_*`, `ref_id`, `by_*`) stay `String` for now.
- The match facts (`player_match_facts`, read by Nobody Missed) are a projection the migration's triggers mark dirty
  and `discovery/match_facts.drain` re-derives inside every unit, just before COMMIT (`store.with_before_commit`,
  installed at boot). A new input to the facts needs a trigger in the TypeScript migration, not a call from the act.
  A store opened in a test has no hook: install it there when the test reads the facts.
- SQL that takes arguments is built from `platform/sql` fragments, which carry their own arguments. To read extra
  columns after a row, select them after `row.columns` and decode them at `row.width`, `row.width + 1`, ….
- `npm run sql:check` (part of `e2e:check`) prepares every query whose SQL the source spells out against the
  migrated schema, checks its `?`s against the argument list when that is written out, and compares each
  argument with the column its `?` binds (an `id.player_sql` bound to a `case_id` fails). It reads literals,
  constants, row modules' `columns`/`table`/`qualified`, `let`s, and calls to helpers in the same module; SQL
  built with `string.join` or passed in from another module isn't read (`gleam dev sql-check --verbose` lists
  those). Prefer building a query from these, so it is checked.
- A rule the TypeScript server has (in `domain.ts` and similar) is proved against it with cases generated from the
  TypeScript rule itself (`dev/*_cases.mjs` writes `test/fixtures/`). `dev/shape_diff.mjs` compares whole responses.
- A battery's checks of the rules themselves live in the TypeScript tree's `scripts/rules/<domain>/<battery>.mjs`.
  `npm run cases` records their calls to the rules (with the clock frozen); `dev/battery_cases/map.mjs` maps each
  ported rule to its Gleam and generates a gleeunit test per call into `test/scoutbox/battery/` (never edit those).
  `dev/battery_cases/report.json` lists each function's cases (generated or pending) and the calls to port by hand,
  which go in `test/scoutbox/<domain>/`. A rule this server has nothing to play the role of (it refuses what the rule
  cleans, or its types hold what the rule repairs) is closed in `NO_COUNTERPART` with its reason, not left pending.
  `npm run cases:check` (part of `e2e:check`) fails when any of it is stale.
- `LEDGER.md` (`npm run ledger`, checked by `e2e:check`) says, per TypeScript battery, where its checks went and what
  is left, and which domains are ported. Record a hand port in `HAND_PORTED` (`dev/battery_cases/map.mjs`).

## Server rules (as in the TypeScript server, enforced by types where possible)

- Writes need a `store.Tx`, and only `store.unit` makes one. Pass the `Tx` to join a unit. Never call `unit`
  inside a unit.
- Side effects are `effect.Effect` values asked for with `store.emit(tx, e)` from anywhere inside a unit. The unit
  collects them (in its own process's mailbox) and they are dispatched in order after COMMIT; a refused or crashed
  unit sends none. Never send anything from inside a unit. Tests assert what an act asks for with
  `store.unit_effects`, which returns the effects instead of dispatching them. An effect from a branch the unit
  recovers from is kept, as that branch's row writes are.
- An act whose checks ran before its unit re-checks inside it (a rev, say) and answers `store.stale(what)` when
  another request moved the state first, never a panic. Its route is wrapped in `http.rerun_on_stale`, which runs
  it again from the top so it answers from the new state.
- Expected failures are values: `store.refuse(e)` rolls the unit back. Map one act's refusals into another's
  with `store.map_refusal`. `panic` and `let assert` are for broken invariants only.
- Request input is read with `platform/input` shapes. It is valid as sent or refused in the shared refusal
  format; never coerce.
  A vocabulary's accepted values come from its generated `pairs` (`input.one_of(v.pairs)`, or
  `input.one_of_these(v.pairs, [...])` for some of them); never type a value's text by hand.
- Responses are explicit `json.object` allowlists in the TypeScript server's key order. Batteries compare key
  order. A vocabulary value is written with its generated `to_json` (`claim_row.status_to_json`).
- Tables come from numbered migrations in `scoutbox-server/priv/migrations/`, copied from the TypeScript
  server's schema.
- Behaviour that depends on a domain not yet ported is marked `Not ported yet:` in a comment. Grep for it.

## Batteries

`scoutbox-server/e2e/` holds copies made by `e2e/sync.mjs`. Never edit a copy: edit the source battery in the
TypeScript tree and re-sync. To port a battery, port its routes, add it to `e2e/batteries.mjs`, run
`npm run e2e:sync`, then `npm run e2e`. `npm run e2e:check` fails when a copy has drifted from its source.
