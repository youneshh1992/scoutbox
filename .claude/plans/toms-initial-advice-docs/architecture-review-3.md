# ScoutBox: architecture review 3 (progress check)

*Reviewed 27 October 2026 on `feat/sqlite-schema` at commit `9fb1bc6`. It follows review 2 of 19 October 2026 at `c6cf5e1` and the first review of 9 October 2026 at `66c095c`.*

## Summary

**He's getting on well with the work itself, and badly with how it's organised.**

- **Progress is real and has sped up.** In four working days (21–24 October) the project finished two pending steps and moved most of recruitment, the hardest and most important domain so far, into real tables. About 89 tables are now live, up from about 45, out of about 325 planned. The code is careful and the tests pass.
- **None of review 2's process recommendations show up in the work.** I can't tell whether they were passed on. Either way the process has got heavier, not lighter:
  - every step still has several review-and-correct rounds
  - every step still gets a rollback tool
  - the schema still copies the old JSON quirks
  - CLAUDE.md has grown from about 5,800 to about 8,000 words
  - another ~72,000 words of Markdown were written in eight days
  - nothing has been merged to `main`
- **The new recruitment code is a storage swap more than a rebuild.** Routes still edit in-memory objects directly, and the repository works out what changed at save time by fingerprinting every record. The project's own records say that saves are not faster. So this stage changes how the data is *stored* but not yet how the app *works*, and most of the benefit the migration was meant to bring is still to come.

**Verdict:** at this pace the table count could be finished in roughly a month. But the result would be a relational database that the app uses as if it were a JSON file, and a pile of process artefacts. The biggest win now is to (1) make the brief lighter and (2) prove the end state on one domain before migrating another 236 tables in the current style. Concrete text he can paste to his agent is in §7.

---

## 1. What changed since 19 October

| Item | 19 Oct (`c6cf5e1`) | 27 Oct (`9fb1bc6`) |
|---|---|---|
| Commits in the period | – | 21, over 4 working days (21–24 Oct), none since |
| Lines changed | – | +13.7k / −1.7k across 93 files |
| …Markdown | – | +4.5k lines, about **72,000 words** |
| …repository code (excluding rollback) | ~8.1k lines | +2.7k lines, which is about 250 KB because the lines are very long (up to 776 characters) |
| …tests and fixtures | ~13.5k lines, 32 files | +3.9k lines, 40 files |
| …rollback tools | ~2.8k lines | +0.8k lines, 29 files |
| Migrations | 0001–0013 | 0001–0017 |
| Live SQLite tables (I ran all migrations on an empty database) | about 45 | **92**, of which about 89 are domain tables |
| Collections moved out of the JSON blob | 23 | **33** of ~130 |
| Frontend changes | – | none (the feature freeze is holding) |
| `main` | `66c095c` | still `66c095c`, now **76 commits behind** |
| CLAUDE.md | ~5,800 words | ~8,000 words. The "Server structure" bullet alone is ~5,600 words. |
| `docs/architecture/*.md` | ~121k words | ~181k words |
| `OPERATIONS.md` | ~15.5k words | ~22.5k words |
| Root Markdown files | ~295 | 296 |

### Steps finished in the period

| Step | What | Commits | Status |
|---|---|---|---|
| S6b | 8 safeguarding/audit logs | 2 | accepted (`f0abd34`) |
| S4b-R | Deleting a player keeps a minimal "retained" record | 3 | accepted (`9b109dc`) |
| S8a | Recruitment requests and trials (16 tables) | 6: 4 design, 2 implementation | accepted (`7a7efc6`) |
| S8b | Recruitment cases, rooms, decisions (25 tables) | 6: 3 design, 3 implementation | accepted (`7072dd9`) |
| S8c | Contacts and offers (9 tables) | 5: 3 design, 2 implementation | **pending acceptance** (`9fb1bc6`) |

Each recruitment sub-step went through this sequence: write a design → independent review → one to three design corrections → implement → independent review → one or two implementation corrections → record the acceptance. That's about a day and a half per sub-step.

### Items from review 2

| Review 2 recommendation | Status |
|---|---|
| 1. Lower the ceremony (no rollback tools, one review round, short notes and commits) | **Not done.** Three new rollback tools, two or three review rounds per step, design notes of 12–18k words, commit messages up to 1,450 words. |
| 2. Change the fidelity rule (validate junk input instead of preserving it) | **Not done.** `02_recruitment.sql` has 150 `absent_keys_json` / `offtype_json` / `extra_json` columns. |
| 3. An explicit "reads move to SQL" milestone | **Not done.** No plan change. |
| 4. Merge to `main` regularly, tag baselines | **Not done.** No merges and no tags. |
| 5. Rewrite CLAUDE.md as short rules | **Not done.** It's 40% longer (see §4). |
| 6. Player unit tests and milestone E2E scripts in CI | **Not done.** `ci.yml` is unchanged. |
| 7. Carry on with S8, in smaller merges | **Done in part.** S8 was split into S8a–S8d, which is good, but none of them were merged. |

---

## 2. The good news

- **Recruitment is the right domain to tackle, and it's mostly done.** Requests, trials, cases, room decisions, contacts and offers are the core of the product. S8d (packages, signings, follow-ups, about 9 tables) is all that's left of it.
- **The schema now enforces real integrity.** These are real foreign keys:
  - organisation → orgs
  - case → recruitment_cases
  - request → recruitment_requests
  - staff ids → org_users

  On top of the keys there are code-checked guardian references and a "one open trial per case" rule. The reviews found real integrity bugs, for example a room decision that could chain to a decision in a *different* room (S8b, F1). That is the kind of thing review exists to catch.
- **The tests are still good, and they pass.** On Node 26.12.1 I ran each of the 37 suites in `npm test` on its own:
  - **24 suites ran to completion: 295 checks, 0 failures.** These include all three new recruitment suites, player erasure and the schema DDL check (8 files, 325 tables).
  - **13 suites need to open a local network port**, which my sandbox refuses (`listen EPERM`). These are the 3 that start a server partway through and the 10 `*Server.mjs` / atomicity suites. They were **not run** by me.
  - **I couldn't run the Player Jest tests** because `scoutbox-player/node_modules` isn't installed and my sandbox can't reach npm. So they were **not run** either.
- **The decisions are being put to the Founder** (Q7a–c, Q8a, Q8c-a/b) and recorded rather than guessed. The agent is also disciplined: it follows CLAUDE.md, writes tests first and doesn't touch the frontend.

---

## 3. Concerns

### Concern 1: the new repositories don't change how the app works

In S0–S7 a repository's write functions were the only way to change its data (`players.insert`, `notifications.create`). The recruitment steps chose a different model (`repositories/recruitmentContactsOffers.mjs`, header comment):

> the two views are read-only ARRAYS … whose elements are the plain, mutable records the routes hold; every in-place change … is detected and written by the next save's flush

So route code such as `m23/contactRoutes.mjs` and `m28/index.mjs` still does `offer.status = 'accepted'` on an in-memory object. At save time each repository fingerprints every record to find what changed, then writes those rows. Only 38 lines of route code changed in the whole period.

This was a pragmatic choice: it kept every route working with almost no change. But it means:

- **Saves are no faster.** The fingerprint serialises every record on every save. The project says so itself: "Not met and not claimed: a faster save, the whole-snapshot-write objective."
- **The business rules still live in route code**, written as in-place edits, not in the domain layer.
- **Memory and reads are unchanged.** Everything is still loaded into RAM at boot and scanned in memory (review 2, Concern 1).

In effect the recruitment domain now has a *row-shaped JSON file* with foreign keys. That's progress, but the two expensive parts are still ahead: moving writes into explicit domain operations, and moving reads into SQL. If the remaining ~236 tables are migrated the same way, all of them will need a second pass later.

### Concern 2: the review loop has reached diminishing returns

The early review findings were real bugs. The later ones are increasingly about scenarios that can't happen in practice. The clearest example is S8b's third round (`7072dd9`):

- The finding was that a database file written by an *intermediate, superseded development build* (`b7c0dd0` or `2fe05df`), which existed for a few hours, wouldn't be refused cleanly.
- The fix added a "key format" marker, which every reader, save path, guard and rollback tool now checks first. It came with an error message that tells an operator to run the superseded build's own rollback tool.
- The commit's own wording is "synthetic only": no such file exists outside the tests.

Other symptoms:

- **Every step now boots the real historical build of every previous step** to prove its rollback. That's nine builds so far (`SCOUTBOX_PRE_S7A` … `SCOUTBOX_PRE_S8C`), so the cost of the test gate grows with each step.
- **Warnings like "Never boot the previous build directly on a 0017 file"** are being written into OPERATIONS.md for a deployment that doesn't exist.
- **Two or three design rounds happen before any code is written**, each producing thousands of words of corrections to a document nobody but the agents will read.

The reviewer is doing its job as instructed. The instructions are the problem: they don't say what level of risk is in scope, so every theoretical path counts as a finding.

### Concern 3: the fidelity rule is now the biggest source of complexity

Every recruitment table carries "absence preserved as absence", "off-type values as received" and "unknown own fields, a prototype-named one included". The S8c header comment spends several paragraphs on which kinds of null "act" become rows and which stay as written. This is the main reason the new repositories are about 80 KB each, and the main reason design reviews keep finding edge cases.

For a pre-launch product with seed data, almost none of this protects anything real.

### Concern 4: the instructions document is becoming unreadable, and it's now inconsistent

CLAUDE.md is the one file every agent session reads first. It now has these problems:

- **About 8,000 words, mostly status history** with commit hashes. It's dominated by paragraphs like "independently ACCEPTED at commit `f0abd34…` on 21 October 2026 for its bounded storage-migration scope — not production, security, legal-compliance or deployment approval".
- **A broken splice.** The S8b and S8c status paragraphs were inserted into the *middle* of the S8a paragraph. The text runs from S8a's acceptance straight into S8b and S8c, then back to S8a's design details ("(plan §D.8 the implementation record; §D.7 the design…") without any break.
- **Conflicting statements.** One passage still says the next free migration identifier is `0015` ("was `0014` … `0015` is next"), and two later passages say `0018`.

An agent can probably cope with this. A human can't, and that matters because the human is the only one who can tell when the agents are going in circles.

### Concern 5: one long-lived branch

`feat/sqlite-schema` is now 18 days and 76 commits ahead of `main`, and `main` hasn't moved since 9 October. Five steps are marked accepted, and all of them could have been merged. The longer this goes on, the more GitHub and any demo built from `main` misrepresent the product. It also makes a single, much riskier merge more likely.

---

## 4. How he's getting on: the human side

From the records, the Founder's role in this process is:

1. relaying between a building agent and a reviewing agent
2. answering decision questions, every one of which was answered with the option marked "(Recommended)"

That isn't a criticism. Those were probably the right answers. But it shows the loop is running on autopilot, with the human approving rather than steering. The questions he's asked are framed in storage terms ("Approve tolerant (Recommended)" for whether `player_id` columns carry a foreign key), which a non-programmer can't really judge.

The questions that *are* his to answer aren't being asked:

- Is there any real data anywhere yet?
- When does he want the first real users?
- What has to be true for that?
- Is it worth two extra days to make files from superseded development builds fail gracefully?

---

## 5. Is it heading in the right direction?

**Mostly yes on *what*, no on *how*.**

- **The table design is good.** The schema files (`docs/architecture/sql/*.sql`), the migration runner, the unit of work and the after-commit side effects are all sound, and will serve the product well.
- **Two things put the outcome at risk:**
  1. The data layer finishes as a faithful copy of the old JSON behaviour, in memory, with no speed-up. Each domain then needs a second migration to get the actual benefits.
  2. The process artefacts (180k words of architecture notes, 29 rollback tools, nine historical build boots, an 8k-word CLAUDE.md) become a cost every future change has to pay.

---

## 6. Rough pace forecast

| | Tables | Time at the current pace |
|---|---|---|
| Live | ~89 of ~325 | – |
| S8d | ~9 | 1–2 days |
| S9–S13 | ~227 | at ~12 tables/working day (S8a–c), about 4 working weeks |
| S14 (retire the blob) | – | plus whatever that takes |
| "Reads to SQL" and explicit domain writes | all domains | **not planned or estimated** |

The forecast assumes the pace holds. The later domains (agents and compliance with 61 tables, development and Box Cam with 57) have more varied state machines than recruitment, and the gate cost grows with every step. So this is a lower bound.

---

## 7. Recommendations

In priority order. The quoted blocks are written so he can paste them to his agent.

1. **Find out whether there is any real data.** If there isn't, say so in CLAUDE.md, because almost everything else follows from it:

   > There is no production data and no deployment. Every database in existence is seed or test data and can be thrown away. From now on: no copy-only rollback tools, no booting historical builds, no compatibility with files written by earlier development builds, no operator warnings about deployments that don't exist. Rollback means "restore a backup or re-seed".

2. **Change the fidelity rule for the remaining steps:**

   > For S8d onwards, preserve API behaviour for valid input only. Store each field in a properly typed column. Do not add `absent_keys_json`, `offtype_json` or `extra_json` columns. Where the old code accepted junk (wrong types, unknown fields), validate it and reject it at the route, and the migration reports what it dropped or normalised.

3. **Prove the end state on one migrated domain before migrating more.** Take players/guardians, or recruitment requests:
   - move the hot reads to SQL queries with pagination (the org player directory first)
   - move the writes into explicit domain operations instead of in-place edits plus fingerprinting
   - drop the in-memory mirror for that domain
   - measure save time and memory at 100k synthetic players with `dataLayerPerf.mjs`

   That becomes the template for S9–S13, so each remaining domain is migrated once, not twice.

4. **Narrow the reviewer's scope:**

   > One review per step, on the implementation, not the design. Report only problems reachable through a real route with data the current build can produce. Files from superseded builds, synthetic-only states and hypothetical operators are out of scope. Anything below "a real user could lose or corrupt data" is a note, not a blocking finding.

   A short design note (one or two pages: the tables, the decisions, how it differs from the old behaviour, the tests) can go to the Founder for product questions without a review cycle.

5. **Merge now, then keep merging.** Merge the accepted steps to `main` through a PR now (S0–S8b, or the whole branch once S8c is accepted). Tag the baseline. After that, each step is its own short branch and PR. Delete `fix/identity-hardening` and the pre-review remote branches.

6. **Rewrite CLAUDE.md's server section** as one screen of rules, and move all the status and history into a table in `sqlite-migration-plan.md`. This also fixes the broken S8a/S8b/S8c splice. Something like:

   > - New state goes in tables owned by a repository under `repositories/`, created by a numbered migration.
   > - Writes go through repository functions inside `store.unitOfWork`; side effects use `store.afterCommit`.
   > - Responses use allowlists. Secrets are hashed.
   > - Status of each domain: see the table in `docs/architecture/sqlite-migration-plan.md`.

7. **Keep commit messages to a subject line plus a few bullets.** Write design notes in the 2–4k-word range (`s5-player-subrecords.md` is a good size). Stop adding to OPERATIONS.md until there's something to operate.

8. **Put the Player Jest tests in CI**, and the end-to-end scripts for the migrated domains (`m13E2E`, the `m23*Persistence` scripts). This is unchanged from review 2.

If he does only 1, 2 and 4, I'd expect each remaining step to take roughly half the time and produce a simpler schema. Doing 3 is what makes the migration deliver the scaling and maintainability it was started for.

---

## How this review was done

- I compared `c6cf5e1` with `9fb1bc6` using git statistics, the commit log and per-category line and word counts.
- I counted live tables by running all 17 migrations on an empty in-memory SQLite database (92 tables), and read `TABLE_BACKED` for the migrated collections (33).
- I read the headers and structure of `repositories/recruitmentContactsOffers.mjs`, migration `0017`, the S8b key-format fix (`7072dd9`), `repositories/index.mjs` and `store.mjs`, and the current CLAUDE.md.
- I ran the server suites one by one on Node 26.12.1 (see §2). The 13 suites that open a port, and the Player Jest suite, were **not run**.
- I did **not** review every commit or every repository line by line. I also don't know whether review 2 was passed on to the Founder or his agents.
