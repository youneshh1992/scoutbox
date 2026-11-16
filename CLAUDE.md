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
  and no maintained Gleam package covers it. Today `src/` has none. If you must add one: keep it in one small
  module, document why Gleam can't do it, and test it directly, because the type checker can't see across FFI.
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
  - `gleam dev` (the generator) compiles `src/` first, so code that uses a name the generator has not written yet
    blocks the run that would write it. Regenerate before using a new column or table.
  - A domain record that is a generated `Row` is a type alias: its constructor can't be matched through the alias.
    Match with a guard (`Some(u) if u.removed_at != None`) or the row module's constructor.
  - Function calls are not allowed in case guards, nor constructors with a non-constant argument
    (`if x == Some(user.id)`): bind the value first (`let me = Some(user.id)`).
  - `|>` binds looser than `<>`: `"a" <> x |> f <> "b"` pipes the whole left side. Call `f(x)` instead.
  - A unit runs in the writer's process: read the request body before it (`http.parse_body`), never inside.
  - Two vocabularies of one table that share a value get prefixed constructors (`reports.TargetKindPlayer`).
  - Imports go at the top of a module; when a need turns up mid-file, add the import there, don't wrap the
    function. The stdlib already has `list.try_map`, `string.join` and friends: look before writing one.

## Writing the data layer here

- Tables come from `priv/migrations`; their Gleam is generated (`npm run codegen`). Shared vocabularies are declared
  once in `dev/scoutbox_dev.gleam`.
- SQL that takes arguments is built from `platform/sql` fragments, which carry their own arguments. To read extra
  columns after a row, select them after `row.columns` and decode them at `row.width`, `row.width + 1`, ….
- A rule the TypeScript server has (in `domain.ts` and similar) is proved against it with cases generated from the
  TypeScript rule itself (`dev/*_cases.mjs` writes `test/fixtures/`). `dev/shape_diff.mjs` compares whole responses.
- A battery's checks of the rules themselves live in the TypeScript tree's `scripts/rules/<domain>/<battery>.mjs`.
  `npm run cases` records their calls to the rules (with the clock frozen); `dev/battery_cases/map.mjs` maps each
  ported rule to its Gleam and generates a gleeunit test per call into `test/scoutbox/battery/` (never edit those).
  `dev/battery_cases/report.json` lists each function's cases (generated or pending) and the calls to port by hand,
  which go in `test/scoutbox/<domain>/`. `npm run cases:check` (part of `e2e:check`) fails when any of it is stale.
- `LEDGER.md` (`npm run ledger`, checked by `e2e:check`) says, per TypeScript battery, where its checks went and what
  is left, and which domains are ported. Record a hand port in `HAND_PORTED` (`dev/battery_cases/map.mjs`).

## Server rules (as in the TypeScript server, enforced by types where possible)

- Writes need a `store.Tx`, and only `store.unit` makes one. Pass the `Tx` to join a unit. Never call `unit`
  inside a unit.
- Side effects are returned from the unit as `app.Effect` values and dispatched after COMMIT. Never send
  anything from inside a unit. `notifications.notify` returns the push it asks for as an effect: pass it up to the
  unit's effects, never drop it (`use _ <-` and `list.try_each` drop it silently; use `notifications.each`).
- Expected failures are values: `store.refuse(e)` rolls the unit back. Map one act's refusals into another's
  with `store.map_refusal`. `panic` and `let assert` are for broken invariants only.
- Request input is read with `platform/input` shapes. It is valid as sent or refused in the shared refusal
  format; never coerce.
- Responses are explicit `json.object` allowlists in the TypeScript server's key order. Batteries compare key
  order.
- Tables come from numbered migrations in `scoutbox-server/priv/migrations/`, copied from the TypeScript
  server's schema.
- Behaviour that depends on a domain not yet ported is marked `Not ported yet:` in a comment. Grep for it.

## Batteries

`scoutbox-server/e2e/` holds copies made by `e2e/sync.mjs`. Never edit a copy: edit the source battery in the
TypeScript tree and re-sync. To port a battery, port its routes, add it to `e2e/batteries.mjs`, run
`npm run e2e:sync`, then `npm run e2e`. `npm run e2e:check` fails when a copy has drifted from its source.
