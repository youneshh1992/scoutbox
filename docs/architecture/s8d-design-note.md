# S8d design note — signing packages, signings, follow-ups, outcome reports

*30 October 2026, on `feat/sqlite-schema` after `46965e0`. The first step under the rules of 30 October: a two-page
note for the Founder's product questions, no design-review cycle, the fidelity rule of `CLAUDE.md` ("typed columns
only; junk rejected at the route; the migration reports what it dropped"). S8c stays pending its one review; S8d is
built on top of it. The next free migration identifier is `0018`.*

## 1. What moves

The last four recruitment blobs, written by two modules, become the nine tables already drafted in
`docs/architecture/sql/02_recruitment.sql` (lines 1530–1880; the mapping comments there are the field-level spec):

| Blob | Writer | Tables | Rows today |
|---|---|---|---|
| `signingPackages` (the M23 P7 signing workflow over an accepted offer revision) | `m29/index.mjs` — start, draft edits, document, ready, party completion, executed document, complete, cancel, void, supersede, T&S void, player deletion | `signing_packages`, `signing_revisions`, `signing_documents`, `signing_revision_parties`, `signing_history` | seed only |
| `signings` (completed signings; legacy standing rows from before P7) | `m29/index.mjs` `recordCompletedSigning` (`:285`); the legacy route in `server.mjs` only reads today | `signings`, `signing_parties` | seed only |
| `followUps` (91/182/365-day milestones after a signing) | `m12/operations.mjs` — the sweep schedules and marks due, the report route completes, admin moves a due date | `follow_ups` | seed only |
| `outcomeReports` (the club's report at a milestone; player/guardian confirm or dispute) | `m12/operations.mjs` `:69`, `:97` | `outcome_reports`, `outcome_report_confirmations` | seed only |

`idempotency_keys` gains the owner `signing_packages` (the `keys` map of a package: start, ready, party, cancel, void,
supersede, complete), the fourth broadening of the same table. Readers of `db.signings` are spread across nineteen
modules (journey, passport, insight, Nobody Missed, Second Look, dashboards, offers); readers of `db.signingPackages`
across five. Every reader keeps reading the collection; what it reads is a read-only view over the tables, as in
S8a–S8c.

## 2. How this step differs from S8a–S8c (the rules of 30 October)

- **Typed columns, no lossless side columns.** No `absent_keys_json`, `offtype_json` or `extra_json`. The drafted DDL
  already has the vocabulary and length CHECKs (`status IN (…)`, `progression <= 200`, `experience_rating 1–5`) and
  the three partial unique indexes the code enforces today (one live package per offer, one completed package per
  offer, one signing per package / per offer / one standing legacy row per org and player). They are kept.
- **Junk is rejected at the route.** The m29 and m12 routes already validate their bodies (`validateTerms`, the
  outcome report fields, `ALREADY_RESPONDED`); the step adds the checks the tables now imply (an unknown status word,
  an over-long note, an unknown field) and answers the existing error shape. A client that sent something the old
  store silently kept now gets a 400 with the field named.
- **The migration reports, it does not preserve.** Seed rows that fit the columns import; a field the column cannot
  hold is normalised where the draft says so (a signing without `method` → `LEGACY_RECORDED`; a missing `rev` → 1;
  the three dead signing fields `cancelledAt` / `revokedAt` / `voidedAt`, read but never written, are dropped) and
  the boot log and the cutover record name each normalised or dropped field with the row id. A row that cannot be
  typed at all (no id, no org, a status outside the vocabulary) **stops the migration with the ids** rather than
  being dropped: a dropped signing would silently change follow-ups and invoices, and seed data is cheap to fix.
- **No rollback tool, no historical-build boot, no superseded-build compatibility, no operator warning.** The gate
  for S8d is the existing backend chain (which still boots the nine builds for S7a–S8c until the merge) plus the
  Player suite; the new unit suite covers the migration on the seed fixtures and the repository.
- **Explicit writes, not in-place edits.** See the question below; the recommendation is the explicit model.

## 3. References

- Player ids on all nine tables: **no key, tolerant and counted**, exactly as Q7a, Q8a and Q8c-a decided for the
  earlier recruitment tables. Follow-ups are kept after a player's deletion by design ("departed player"); the
  erased player's retained row (S4b-R) resolves. This is the same answer for the fourth time, so it is applied, not
  asked.
- Guardian / party ids (`outcome_report_confirmations.by_id` is a player or a guardian by `by_kind`; the signing
  parties are a provenance summary): no key, checked in code against the final tables as Q7c and Q8c-b did.
- Real keys: `org_id → orgs`, `case_id → recruitment_cases`, `offer_id → recruitment_offers`, the staff ids →
  `org_users`, `signing_package_id → signing_packages`, `follow_up_id → follow_ups`, `signing_id → signings` (all
  RESTRICT). `offer_revision_id` stays a plain indexed column checked in code, because `offer_revisions.id` is
  indexed but not unique (S8c, accepted) and this step does not alter an accepted table; `transaction_id`,
  `document_evidence_id` and `first_qualifying_ledger_id` stay plain ids to tables of later files.

## 4. The one question for the Founder

**Write model.** Two ways to build it, both finishing the table count for recruitment:

- *Storage swap* (as S8a–S8c): the routes keep editing the records in memory; the repository detects the changes at
  save time and writes rows. About a day. It leaves S8d in the state the 27 October review called "a row-shaped JSON
  file": every one of these tables would be revisited in the end-state work.
- *Explicit writes* (recommended): `signingPackages.start / revise / markReady / completeParty / complete / cancel /
  void / supersede`, `signings.record`, `followUps.schedule / markDue / complete / moveDueDate`,
  `outcomeReports.file / respond` — each a repository function that writes its rows inside the route's unit of work,
  and the in-memory records become true read-only views. The 43 mutation sites in `m29/index.mjs` and the 8 in
  `m12/operations.mjs` are converted to those calls. About two to three days. S8d then becomes the first domain
  built the way the end-state proof will rebuild the others, and is not migrated twice. Reads stay in memory for
  now; moving them to SQL is the end-state proof's job on recruitment as a whole.

The product consequence is only time: one day against two to three, with the second path leaving nothing to redo.
What the user sees is identical either way. **Recommendation: explicit writes.**

## 5. Tests and the gate

- Tests first, on the unchanged tree: a unit suite `scripts/testSigningsFollowUps.mjs` — the migration of the seed
  fixtures (every seed row typed; the normalisations reported with ids; a malformed fixture row stopping the boot
  with its id; the keys rebuilt; the three uniqueness rules as database errors), the repository functions (each write
  lands as rows inside a unit of work and is restored on failure; the views read-only), the route-level validation
  (an unknown status word or field answered 400 with the field named).
- The existing batteries named from source: `m23SigningE2E` (260), `m23SigningHardeningE2E` (212), `m12E2E`,
  `m23RecruitmentJourneyE2E` and the journey persistence battery; `m23SigningPersistence` is one of the four
  pre-existing failures (its fixture seeds a case without `ownerUserId`) and is fixed in this step so it can join
  CI, since its subject is exactly these tables.
- The gate: backend `npm test` on Node 22 and 24, the Player suite; results recorded in the plan's §E and the PR, not
  in a new section of `OPERATIONS.md`.

## 6. Out of scope

The end-state proof (reads to SQL, the in-memory mirror dropped, the 100k-player timing) — next, on recruitment as a
whole. S9–S13. The merge to `main` (the Founder's instruction). Any change to an accepted S0–S8c table.
