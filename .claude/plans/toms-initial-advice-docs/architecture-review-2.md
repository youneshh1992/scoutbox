# ScoutBox: architecture review 2 (progress check)

*Reviewed 19 October 2026 on `feat/sqlite-schema` at commit `c6cf5e1`. It follows the first review of 9 October 2026 at `66c095c`.*

## Summary

**The direction is right and the work is real.** The project took the first review seriously:

- Features were frozen.
- Architecture rules were added to CLAUDE.md.
- The three identity holes were closed.
- A genuine relational SQLite layer is being built, one domain at a time, with real tables, migrations, transactions and tests.

The foundations are now in decent shape:

- the repository pattern
- versioned migrations
- a "unit of work" for atomic multi-table writes
- hashed session tokens
- allowlisted responses

**The pace and the process are the concern.** About 25% of the data is now in tables after ten days, and that 25% is the easier part. The remaining 75% is the core business logic: recruitment, scouting, verification, agents and development. There are three reasons it's slow:

1. **Too much ceremony for what's at stake.** As far as I can tell there are no real users and no production data yet, but the project behaves as if it's migrating a live bank:
   - every step gets a copy-only rollback tool
   - every step goes through several rounds of "independent acceptance"
   - every step comes with a readiness review of tens of thousands of words
2. **Too much fidelity to old behaviour.** The migration copies the quirks of the old JSON store into the new schema, byte for byte, instead of fixing them.
3. **The end state still keeps everything in memory.** Writes are now per-row, but reads still scan in-memory arrays, so a big part of the scaling problem is still unsolved.

**Verdict:** heading in the right direction, but it needs a course correction on *how* the work is done, not *what* is being done. The details are in §3, and the recommendations in §7.

---

## 1. What changed since 9 October

| Item | 9 Oct | 19 Oct |
|---|---|---|
| Commits since the last review | – | 55, all on `feat/sqlite-schema`, over 10 days |
| Lines changed | – | +53.9k / −5.6k across 168 files |
| …of which Markdown | – | about 11k lines added (net ~7k) |
| …of which new repository code | 0 | about 8.1k lines (`scoutbox-server/repositories/`) plus 1k of migrations |
| …of which rollback tools and probes | 0 | about 2.8k lines |
| …of which new server tests | 1 unit test file (23 checks) | 32 `test*.mjs` files, ~13.5k lines; ~360+ checks according to the project's own records |
| Player app unit tests | none | 4 Jest files (~250 lines) |
| Frontend changes | – | almost none, so the feature freeze was respected |
| Real SQLite tables in use | 1 (`collections`, holding JSON blobs) | about 45 |
| Collections moved out of the blob | 0 of ~130 | 23 of ~130 |
| `server.mjs` | 4,787 lines | 5,171 lines |

### Items from the first review

| First-review item | Status |
|---|---|
| Freeze features | **Done.** It's in CLAUDE.md and has been respected. |
| Add architecture rules to CLAUDE.md | **Done**, but it has since grown out of control (see §4). |
| Org login lets anyone choose their role | **Fixed** (`3fe242b`). |
| SSO test secret has a default | **Fixed** (`3fe242b`). |
| `trust proxy` not set | **Fixed** (`httpTrust.mjs`, `server.mjs:358`). |
| Session tokens stored in plain text, found by scanning | **Fixed.** They're stored as sha256 hashes and looked up through an indexed SQL query (`repositories/sessions.mjs`). |
| Responses built by spreading the record and deleting fields | **Fixed for players and guardians** (`views/playerViews.mjs`). This is now a CLAUDE.md rule. |
| Real relational schema | **Designed in full.** It has about 320 tables in `docs/architecture/sql/*.sql`, and about 45 are live. |
| Every save rewrites everything | **Partly fixed.** Migrated domains write per row; the other ~107 collections are still rewritten on every save. |
| Full scans on every query and no pagination | **Not started.** `GET /org/players` still maps every player in memory (`server.mjs:2033`). |
| Blocking `scryptSync` | **Not started** (`adapters.mjs:21`). |
| Move the server to TypeScript, organise by domain | **Not started.** The plan deliberately puts this after the migration. `m12/`–`m29/` are all still there. |
| Shared types package, merge Club and Grassroots | **Not started.** This is correct during the freeze. |
| Player email accounts, real IDV and SSO | **Not started.** |
| Make `main` the trunk, use tags and short PRs | **Half done** (see §5). |
| Clean out the root Markdown files | **Barely started.** Six files were deleted, including `backup.md`; about 295 remain in the root. |

---

## 2. The SQLite data layer: how it works now

The design is a sensible "strangler" migration:

- **Tables per domain.** Each domain gets its own tables, created by a numbered migration (`repositories/migrations/0001…0013`). Each cutover is recorded in a `data_migrations` table, and the server decides which store is authoritative from that record, never from whether a table exists. That's a good, deliberate choice.
- **One repository per domain.** Each repository owns its tables, and its write functions (`players.insert`, `notifications.create`, …) are the only way to change that data. The old `db.players` array still exists, but as a read-only Proxy view that throws if anything tries to write to it directly. This is an effective way to stop an AI agent from sneaking around the new layer.
- **`store.unitOfWork(() => …)`** runs a write that touches several tables, or a table and a remaining blob, in one SQLite transaction. If it fails, the in-memory state is rolled back too. Side effects such as push notifications and live events only run after the commit (`store.afterCommit`). This is the right design, and it's often skipped by much more experienced teams.
- **Constraints.** The tables use STRICT mode, real foreign keys where the data allows them (for example `org_users.org_id → orgs`), indexes, and CHECK constraints.
- **Runtime requirement.** Node 22.16+ or 24+ is required, and the server refuses to start on anything else (`runtime.mjs`).

### What's live

| Step | Domain | Tables |
|---|---|---|
| S0–S3 | Staff accounts, sessions, organisations | `org_users`, `sessions`, `orgs` |
| S4a | Players, guardians, guardian–child links | `players`, `guardians`, `guardian_children`, `media_deletions` |
| S5 | Player sub-records (media, attendance, timeline, badges, drills, …) | 12 `player_*` tables |
| S6a | One-time codes (hashed) | `email_challenges`, `pairing_codes` |
| S7a–d | Notifications, delivery, outbox and push, message threads | about 11 tables |
| S6b (today, not yet "accepted") | 8 safeguarding and audit logs | `blocks`, `reports`, `ledger`, … |

### What's left

| Step | Domain | Planned tables |
|---|---|---|
| S4b | Player deletion rewrite (tombstones, retention) | needs Founder decisions |
| S8 | Recruitment (requests, trials, cases, offers, signings) | 55 |
| S9 | Scouting and assessment | 33 |
| S10 | Verification and passport | 31 |
| S11 | Agents, compliance, transactions | 61 |
| S12 | Development, Box Cam, discovery | 57 |
| S13 | Operations, integrations, production init | 45 |
| S14 | Retire the blob store | – |

So roughly 280 of about 320 planned tables are still to come. They hold the core business logic, which is the part with the most routes and the most complicated state machines. The domains done so far were mostly identity and plumbing.

---

## 3. Is it heading in the right direction?

### Yes, on the fundamentals

- The schema is designed up front and kept as reviewed `.sql` files, with a test that checks the DDL (`testSchemaDdl.mjs`).
- Migrations are versioned and forward-only. There's no "create the table if it's missing" guesswork.
- Writes are atomic, side effects run after commit, and nothing falls back to JSON silently.
- Secrets are hashed: both session tokens and one-time codes.
- The tests are mostly real. They open real SQLite files in temp directories, kill processes and check durability, and check rollback.
- The agent is clearly following the rules in CLAUDE.md, which shows that putting architecture rules there works.

### Concern 1: the end state still keeps everything in memory

Each repository loads its tables into an in-memory mirror at boot and serves `db.players` and friends from it (`repositories/identity.mjs:281`, "in-memory state"). Route code still calls `db.orgs.find(...)` 92 times and `db.players.find/filter` dozens of times, and the player directory still builds a view of every player for every request.

So what has been fixed is **write amplification** (no more whole-database saves for migrated domains). Still unfixed:

- **memory:** every row of every table lives in RAM
- **read scans:** no query uses the indexes except sessions and a few lookups
- **single process:** the in-memory mirror means you still can't run two server processes

That's fine as a transition step. But the plan (`docs/architecture/sqlite-migration-plan.md`) only says in passing (§C.1) that reads should become scoped SQL queries. S14, "retire the blob store", doesn't require the mirrors to go. **There should be an explicit milestone that moves the hot reads to SQL queries with pagination**, at least the org player directory, player profile and inbox, and drops the mirrors. Otherwise the project could finish S14 and still have the scaling ceiling from the first review, just moved from "save" to "boot and RAM".

### Concern 2: copying quirks instead of fixing them

The migration principle is "the existing end-to-end suites are the specification", which is right. But it's being applied at the level of storage bytes, not API behaviour. Examples from CLAUDE.md and the code:

- **Push tokens.** `POST /push/register` accepts "any truthy JSON value" as a device token. The new schema stores it "losslessly as JSON text", keeps objects and arrays as distinct tokens, and keeps non-finite numbers "live" but persists them as null (`server.mjs:4058`). A push token is a string, so the right move was to validate it as one.
- **Mail destination.** The outbox `to` field can be "ANY JSON value", stored across two columns (`to_address`, `to_json`), because an old route passes an array by mistake.
- **Callback timestamps.** A delivery callback's non-finite clock is "kept in memory for the process … and stored null".
- **Report targets.** `targetPlayerId` is stored "as received", whether it's a number or an object.
- **Absent vs null.** Many tables carry `absent_keys_json` and `extra_json` columns so that "absence is preserved as absence" and unknown fields survive.

Each of these is a small bug in the old code. Carrying it into the new schema makes the schema less strict, adds code and tests, and makes the bug permanent. For a pre-launch product, the better rule is: **keep API behaviour the same for valid input, and validate or normalise invalid input** (the migration reports what it changed). This one decision would probably remove a third of the complexity in each step.

### Concern 3: the process costs more than the work

- **Correction rounds.** Each step goes through several rounds of "implemented → independent review → correction → correction → acceptance recorded". S7 alone took about 20 commits. Many commits are documentation-only corrections to readiness reviews.
- **Planning documents** under `docs/architecture/` now add up to about 120k words. `s7-readiness-review.md` alone is about 45k words, roughly the length of a novel.
- **CLAUDE.md is now about 5,800 words.** The "Server structure" section has become a single bullet point of about 3,000 words, a changelog full of commit hashes and phrases like "independently accepted at `ac50b60…` for the bounded migration milestone and its three corrections — not production approval". An agent reads this on every task. It's hard for a person to follow, and it uses up a lot of the agent's attention on history rather than rules.
- **Rollback tools for every step.** Every step ships a "copy-only rollback" tool (about 2.8k lines in total), proven against the previous build. That's valuable when there's production data you can't lose. As far as I can see there isn't any yet: everything says "not production-approved", and the data is seed and demo data. A backup plus "re-seed" would do.

None of this is *wrong*, and it reflects a careful agent responding to a reviewer. But at this rate, S8–S13 (about 280 tables of the hardest logic) will take a long time.

---

## 4. Documentation and agent instructions

- **Good:** durable decisions now go into `docs/architecture/` and `OPERATIONS.md` instead of new root-level milestone reports, and some obsolete files were deleted.
- **Not good:**
  - The root still has about 295 Markdown files.
  - The new documents are extremely long.
  - The commit messages are paragraphs, for example "S7c correction (review of 78c14b9): a non-finite number inside an accepted array mail destination is kept live and persisted as …".
- **Suggestions:**
  - **Cut CLAUDE.md down to rules only**: what to do and not do, in short bullets. Move the "migrated so far" status into a table in the migration plan. The architecture section should fit on a screen.
  - **Cap the readiness reviews.** A step's design note should be one or two pages: tables, decisions, anything that differs from the old behaviour, and the tests. `docs/architecture/s5-player-subrecords.md` (~3.9k words) is about the right size; S7's is ten times that.

---

## 5. Git and branching

- **Better:**
  - `main` was fast-forwarded to `66c095c`, so GitHub now shows a real product.
  - Branches are named after the change (`fix/identity-hardening`, `feat/sqlite-schema`).
  - CLAUDE.md now carries the right rules.
- **Not following its own rules yet:**
  - **No merges since.** `feat/sqlite-schema` is a 55-commit, 10-day branch that has never been merged into `main`. The identity fixes (`fix/identity-hardening`) are on it, but they aren't on `main` either.
  - **The merged-in branch is still there.** The rules say branches should be short-lived and merged through a PR with green CI, and `fix/identity-hardening` should have been merged and deleted.
  - **There are still no tags**, although the rules call for them.
  - **The old pre-review branches** (`claude/desktop-project-migration-…`, `handoff/codex-*`, `design/*`) are still on the remote.
- **Suggestion:** merge each accepted step to `main` through a PR. S0–S7 are all marked accepted, so they could have been 5–8 separate merges by now. That makes `main` the real current product and keeps each review small.

---

## 6. Tests and CI

- **The server unit tests are a big improvement:** from 23 checks to 32 test files that exercise real SQLite files, crash durability and rollback. That's the most valuable thing produced in this period after the schema itself.
- **The Player app has a Jest setup** with four real tests. That's small, but it's a start.
- **Gaps:**
  - CI doesn't run the Player unit tests (`.github/workflows/ci.yml` only type-checks and exports Player).
  - The ~70 milestone end-to-end scripts are still not in CI, even though the plan calls them "the specification" for the migration.
  - Without them in CI, "the domain passes the E2E suites unchanged" is checked by hand, if at all. Adding the ones that cover migrated domains (`m13E2E`, the `m23*Persistence` scripts) would cost little and protect a lot.
- **What I ran (20 October, Node 24.22.0, `c6cf5e1`).** I ran each of the 29 suites in `npm test` on its own, because my sandbox doesn't allow tests to open a local network port:
  - **18 suites ran to completion and passed**, with 251 checks and 0 failures. These cover the store, schema DDL, unit of work, identity mapping, repositories, migrations, rollback tools, sub-records, one-time codes, notifications, dispatches, outbox and push, channels and the safety audit.
  - **3 suites** (`testIdentity`, `testSessions`, `testOrgs`) passed all 40 of their checks before reaching a part that starts a real server, which the sandbox refused (`listen EPERM`).
  - **8 server-level suites** (`test*Server.mjs`, `testWriterAtomicity`) couldn't start at all for the same reason.
  - So the repository and migration layer is independently verified. The route-level and crash-durability suites are **not run** by me, and they still need checking in CI or on an unsandboxed machine.
  - On Node 23 the whole chain refuses to start, by design (§2).

---

## 7. Recommendations

In priority order:

1. **Lower the ceremony to fit a pre-launch product.**
   - Tell the agent that there's no production data to protect yet.
   - Rollback is "restore the backup or re-seed", so drop the copy-only rollback tools for new steps.
   - One review round per step, not three or four.
   - Design notes of one or two pages.
   - Short commit messages.
2. **Change the fidelity rule.** Preserve API behaviour for valid input. Invalid or junk input (non-string push tokens, array e-mail destinations, object player ids) is rejected or normalised, and the migration reports what it changed. Stop adding `absent_keys_json` and `offtype_json`-style columns to new tables unless a client actually depends on the difference.
3. **Add an explicit "reads move to SQL" milestone**, starting with the org player directory (paginated, filtered and sorted in SQL), player profile and inbox. Drop the in-memory mirror for a domain once its reads are queries. Measure it with the existing `dataLayerPerf.mjs` harness at 100k synthetic players.
4. **Merge to `main` regularly.** Open a PR per accepted step, merge it, and tag the baselines. Delete the stale branches.
5. **Rewrite CLAUDE.md's architecture section as short rules** (one screen), and move status and history into the migration plan.
6. **Put the Player unit tests and the relevant milestone E2E scripts into CI.**
7. **Then carry on with S8 (recruitment).** It's the biggest and most important domain. Consider splitting it into a few smaller merges rather than one large step.

The things on the first review's list that are correctly waiting until after the data layer are still waiting: TypeScript on the server, the domain folders, the shared types package, merging Club and Grassroots, and the player email, IDV and SSO work. They should stay that way. But the data layer has to finish in weeks, not months, for any of them to start, and that depends mostly on recommendations 1 and 2.

---

## How this review was done

- I compared the repository at `66c095c` with `c6cf5e1`, using git statistics and the commit log.
- I read the migration plan's status, principles and cross-cutting sections, `store.mjs`, `repositories/sessions.mjs`, parts of `repositories/identity.mjs` and the relevant routes in `server.mjs`.
- I counted tables, collections and in-memory scans with grep.
- I did **not** review every commit or every repository line by line.
- I ran the server unit suites on Node 24 (see §6). The suites that start a server couldn't run in my sandbox. I didn't run the Player Jest tests or the end-to-end scripts.
