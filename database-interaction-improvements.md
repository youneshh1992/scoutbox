# Database interaction improvements

Ideas for making the server's SQL safer and its generated code more useful. They came out of evaluating
[Marmot](https://github.com/pairshaped/marmot) (type-safe SQL codegen for SQLite in Gleam) against
`scoutbox-server`. We decided not to adopt Marmot. Its type set is fixed, so it would lose our typed ids, CHECK
enums and CHECK bools. Its functions take a bare `sqlight.Connection`, which bypasses `Tx`/`Read` and our
statement cache. And it can't express composed SQL. Some of its ideas are still worth taking.

None of this is implemented. Each item needs agreement on its design first.

## Where we stand

Counted across `src/scoutbox`, excluding the generated `rows/` and `vocab/`:

- 550 `store.query/one/write/run` call sites. 299 have fully literal SQL, 151 are literal plus `row.columns`,
  `table` or `qualified(..)`, and about 100 build SQL dynamically (visibility, keyset paging, partial
  `UPDATE … SET` lists).
- About 1,300 positional argument constructors written by hand: 748 `sqlight.text/int/…` and 560 `id.*_sql`.
  Swapping two arguments compiles.
- About 270 lines of hand-written `decode.field`/`decode.at` for projections that aren't a whole `Row`.
- 144 hand-written `UPDATE`s, 53 `INSERT`s and 37 `DELETE`s (the generated `insert` is used 116 times).

When Marmot inferred types over our 419 static queries, it found no base-type mismatches. That means a check
that ties each `?` to its column is reliable for simple shapes. It went wrong only inside `CASE` and
`INSERT … SELECT`, and those shapes should be skipped, never guessed.

## 1. Check every static query against the schema

**Cost:** low. **Value:** high.

Add a dev check (`npm run sql:check`, run by `e2e:check`) that:

1. Parses `src/` with `glance` (already in `build/packages`).
2. Finds each `store.query/one/write/run` call whose SQL argument is a string literal, or literals joined with
   `<>` to `<row module>.columns`, `.table` or `.qualified("alias")`. It rebuilds the SQL text from the
   generated modules' constants.
3. `prepare`s each statement against the in-memory schema `dev/scoutbox_dev.gleam`'s `schema()` already builds.
   It fails on any statement that doesn't prepare: a misspelt column, a dropped or renamed table.
4. Where the argument list is written out at the call site, it fails if the number of `?` placeholders differs
   from the list's length.

This catches errors in branches no battery happens to run. A throwaway Python version of step 2 extracted 419
of the 550 call sites. A `glance` version should also resolve module-local aliases (`columns`, `table` passed as
parameters), which the throwaway one missed.

Open questions:

- Should a call the checker can't resolve be reported, or silently skipped? Reporting it makes coverage
  visible, but most of those calls are intentionally dynamic.
- Should it also `EXPLAIN` each statement and keep the plans? That could later flag full scans on hot paths.

## 2. Catch arguments bound to the wrong column

**Cost:** medium. **Builds on:** #1.

Match each `?` to the column it binds, for the simple shapes only:

- `col = ?`, `col <> ?`, `col < ?` (and the other comparisons), `col IS ?`, `col IN (SELECT value FROM json_each(?))`, with or
  without a table alias;
- `SET col = ?` in an `UPDATE`;
- `INSERT INTO t (a, b, c) VALUES (?, ?, ?)`.

Then compare the column's generated type with the argument at the same position in the call:

- `id.<name>_sql(..)` must match a column of that id type. For example, `id.player_sql(x)` against a
  `RecruitmentCaseId` column gets flagged.
- `sqlight.text` must match a TEXT or enum column, `sqlight.int` an INTEGER column, and `sqlight.bool` a CHECK
  bool. A `nullable(..)` constructor needs a nullable column in a write position.

This catches swapped arguments of different types. 560 of the ~1,300 constructors are typed ids, so that covers
most swaps. Two `String` arguments swapped with each other still get through.

Any `?` the checker can't tie to a column is skipped: `CASE`, `INSERT … SELECT`, expressions and function
arguments. Arguments built away from the call site (`args` passed in, `list.map` results) are skipped too.

## 3. Typed fragments for SETs and WHEREs from the existing generator

**Cost:** medium. **Fixes the cause rather than detecting it.**

Generate typed pieces alongside each table's `Row`, built on `platform/sql`'s rule that a fragment carries its
own arguments:

```gleam
offer_row.set_updated_at(now)   // Fragment("updated_at = ?", [sqlight.int(now)])
offer_row.where_id(offer_id)    // takes id.OfferId: Fragment("id = ?", [id.offer_sql(offer_id)])
```

A hand-written update then becomes:

```gleam
sql.concat([
  sql.text("UPDATE recruitment_offers SET "),
  sql.join([offer_row.set_updated_at(now), offer_row.set_status(offer_row.Issued)], ", "),
  sql.text(" WHERE "),
  offer_row.where_id(offer_id),
])
```

None of these arguments can go in the wrong place or have the wrong type. Unlike #1 and #2, this also covers the
dynamic partial updates (`identity/players.gleam`'s `sets` list), and the typed `where_` pieces keep ids typed
right up to the SQL.

Design questions:

- **Surface size.** Doing every column of 196 tables doubles the generated code. Options: generate only for
  columns something actually uses (the generator would have to scan `src/`, and it already compiles `src/`
  first), or only `set_` for non-key columns and `where_` for key and foreign-key columns.
- **Aliases.** Joined queries need `where_id_of("o", offer_id)` or a `qualified` variant.
- **Operators.** Start with `=` only, then add `IS NULL`/`IS NOT NULL`, and comparisons on INTEGER columns if
  they turn out to be needed.
- **Relationship to #2.** Once most `UPDATE`s use typed fragments, #2 mainly guards reads with inline argument
  lists.

## 4. Columns that carry their own decoders

**Cost:** medium. **Priority:** low, unless positional decoding has caused bugs.

Projections that aren't a whole `Row` decode by position (`row.width`, `row.width + 1`, …, about 270 lines). Do
for result columns what fragments do for arguments: a generated `offer_row.col_status` carries its SQL name and
its decoder, and a small combinator builds the select list and the decoder together, so their positions can't
drift:

```gleam
let #(select, decoder) =
  projection.build({
    use id <- projection.column(offer_row.col_id)
    use status <- projection.column(offer_row.col_status)
    projection.done(#(id, status))
  })
```

This is the per-query row decoding Marmot generates, with our types, and with no `.sql` files or extra codegen
step.

## Checked and not needed

- **A cached statement's column count going stale after `ALTER TABLE`.** Marmot's README warns about this for a
  cached `SELECT *`. No migration alters a table, our only `SELECT *` is inside a CTE (`platform/operator`), and
  `scoutbox_store_ffi` refuses a changed argument count for a cached SQL text.
- **Lock waits holding dirty I/O threads.** Already handled: `scoutbox_store_ffi` retries `SQLITE_BUSY` in
  Erlang rather than sleeping inside `sqlite3_step`.
- **Marmot's migration runner and statement cache.** Ours already do more: data migrations and `writer_pragma`
  in the runner, and the ETS cache with a scheduler chosen per statement.

## Suggested order

1. #1, which is small, mostly prototyped, and gives #2 its foundation.
2. #2, once #1 has shown how much of the codebase it can resolve.
3. #3 as its own design, informed by which mistakes #2 actually finds.
4. #4 only if it's needed.
