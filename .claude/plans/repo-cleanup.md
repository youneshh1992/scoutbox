# Repo cleanup plan

> **Status, 3 Nov 2026: phases 0–6 are done on `repo-cleanup`** (commits `93bd503`..`d54847c`, on top of the
> tag `docs-archive-2026-11`).
>
> - **Deviation, code comments:** comments that cite old docs were left as they are. `CLAUDE.md` explains
>   how to read them from the archive tag.
> - **Deviation, CLAUDE.md:** it was written now rather than left as an outline.
> - **Deviation, reference docs:** three documents were moved whole into `docs/reference/`.
> - **Next:** the code follow-ups in `docs/architecture/migration.md` §4.1 (remove the rollback machinery), then §4.2.

*Written 3 November 2026 on `repo-cleanup` (which is `feat/sqlite-schema` + 1 commit, 83 commits ahead of `main`).*

## Goal

Get the repository to a state where a human can find the rules, the product decisions and the migration
status in a few minutes. An agent should be able to continue the SQLite migration without dragging
half a million words of process history into its context.

Three outputs:

1. A clean root: code, a short README, a short CLAUDE.md, and nothing else that is prose.
2. The real decisions in those docs (product rules, Founder decisions, UI approvals), distilled into a small
   set of documents under `docs/`, with the conflicts and supersessions resolved.
3. A short, live migration plan that replaces the 1.4 MB in `docs/architecture/` and lets the remaining
   steps (S9–S14) move quickly.

Nothing is lost by deleting. Everything stays in git history, and Phase 0 tags it so it is easy to get back.

---

## What's there now (measured)

| Where | Size | What |
|---|---|---|
| Root `*.md` | **294 files, 3.3 MB** | 204 of them are `M23_*`. |
| …by filename | ~41 matrices, ~40 audits/reviews, ~30 handoffs/readiness/final reports, ~26 defect registers/fix packs, ~24 test reports/verification | Evidence and process. About 160 files, almost no lasting value. |
| …the rest | ~130 specs, contracts, models, IA, design | This is where the real decisions are, mixed in with superseded drafts (`*_PROPOSAL`, `*_CONTRACT` and then `*_IMPLEMENTATION`, `P6` and then `P61` "hardening"). |
| `docs/architecture/` | 1.4 MB | `sqlite-migration-plan.md` alone is 410 KB. Most of it is §D (dated decision rounds) and §E.2/E.3 (verbatim copies of old CLAUDE.md). There are six readiness reviews / design notes, 90–320 KB each. `sqlite-schema.md` (100 KB) and `sql/*.sql` are the target schema. |
| `scoutbox-server/OPERATIONS.md` | 152 KB | Operator runbook for a deployment that doesn't exist, plus domain contracts. |
| `CLAUDE_old.md` | 3.2k words | Since 30 Oct: about 1,400 words of architecture rules (mostly good), then about 1,800 words of UI approvals. |
| `AGENTS.md` | short | Points at CLAUDE.md, GRASSROOTS_CLUBHOUSE.md, PRO_EXECUTIVE.md, AGENT_FINANCE.md, HANDOFF_CLAUDE_AGENT.md. Codex reads it (see the `handoff/codex-*` branches). |

**Things that will break if we just delete:**

- Tests that read root docs and assert on their contents or existence:
  - `e2e/m24f3DensityAudit.test.mjs:130` → `M24F3_SCREEN_DENSITY_AUDIT.md`
  - `e2e/m24f4MinimalismAudit.test.mjs:126,136` → `M24F4_ALL_APP_SCREEN_AUDIT.md`, `M24F4_MINIMAL_PRODUCT_RULES.md`,
    `M24F4_PLAYER_VISUAL_RESET.md`, `M24F4_DIRECTOR_DASHBOARD.md`
  - `e2e/m24f5VisualAcceptanceAudit.test.mjs:161` → `M24F5_KEPT_SCREEN_REVIEW.md`
  - `e2e/m24f2DensityAudit.test.mjs:95` → `design-system/README.md` (not at the root, but same pattern)
  - `scoutbox-server/scripts/m20E2E.mjs:133` → `M20_METRICS.md`
  - `scoutbox-server/scripts/m21E2E.mjs:1258–1270` → `M21_DEVELOPMENT_HUB.md`, `M21_TERMINOLOGY.md`, `M21_MATRIX.md`
- `scripts/open-claude.mjs:8` throws if `CLAUDE.md` is missing. This is the Founder's
  `Open ScoutBox in Claude.command` launcher, so it is **broken right now** while CLAUDE.md is renamed.
- 34 server source files mention `*.md` files in comments. Harmless, but they'll dangle.

---

## Phase 0: Safety net (before any deletion)

1. **No merge to `main` first.** The cleanup is done on `repo-cleanup`, directly on top of `feat/sqlite-schema`.
2. **Archive tag: done (3 Nov).** The local annotated tag `docs-archive-2026-11` points at `1ba8937`, the last
   commit before the cleanup. It holds all 294 root docs (the original `CLAUDE.md` included),
   `docs/architecture/` and `OPERATIONS.md`. Recover any of them with, for example,
   `git show docs-archive-2026-11:M17_RECRUITMENT_ROOMS.md`. Push the tag with the branch. Do *not* create an
   `archive/` folder. That would just move the problem.
3. Each phase below is its own commit, so the Founder's agent sees a clear sequence.
4. Restore a minimal placeholder `CLAUDE.md` straight away so the launcher works. It can be a three-line
   pointer to `CLAUDE_old.md` until Phase 6.

## Phase 1: Inventory (scripted, cheap)

Build one table in the scratchpad (not committed) with one row per root doc:
`file | words | last-touched date (git log) | milestone | class (evidence / spec / design / process) | referenced-by (code, tests, other docs)`.

A first pass by filename pattern is already easy (see the counts above). Two refinements:

- **Supersession chains by name:** `X_PROPOSAL` → `X_CONTRACT` → `X_IMPLEMENTATION` → `X_CLOSURE`/`FINAL`,
  and `P6_*` → `P61_*` "hardening". Within a chain only the latest file, plus anything it says it overrides,
  needs reading.
- **Keyword sweep over the "evidence" class** for `Founder`, `decided`, `decision`, `approved`, `supersede`,
  `must`, `never`. These files are mostly tables of test counts, but a decision occasionally hides in one.
  Only the matching paragraphs go into Phase 2, not whole files.

## Phase 2: Distil (parallel subagents, by domain, not by milestone)

Milestones cut across domains (M23 touches recruitment, agents, terminology and boot), so group by domain.
Run one subagent per cluster. Each reads its files **newest first** and writes a structured extract
(≤1,500 words) to the scratchpad:

- **Product rules and invariants still in force**, one line each with the source file. Where cheap, check the
  claim against the code (e.g. "the player never sees room discussion": is that enforced in the route?).
- **Founder decisions**, with date and verbatim wording where it exists.
- **Superseded / contradicted items**: what overrode what, and when.
- **Open questions** the docs leave unresolved.
- **Discard explicitly:** test counts, matrices, defect lists, commit hashes, review-round narration,
  "not production approval" disclaimers, and anything describing an intermediate build.

Suggested clusters (file lists come from the Phase 1 table):

| # | Cluster | Main sources |
|---|---|---|
| 1 | Recruitment workflow (requests, trials, rooms, decisions, contacts, offers, signings, journey) | M17, M23 P3–P8.1, M23_RECRUITMENT_WORKFLOW, M24_RECRUITMENT_NAVIGATION_IA |
| 2 | Agents, compliance, transactions, conflicts, consent | M23 P5.6A–F, P6_AGENT_* |
| 3 | Football Passport, verification, provenance, trust score | M14, M15, M16_2 |
| 4 | Development hub, Box Cam, At-Home Combine, CV providers | M16, M16_1, M21, M22 |
| 5 | Matching, watchlists, analytics, metrics | M19, M20, M23 P8 analytics |
| 6 | Safeguarding, minors/guardians, privacy, auth, sessions | M18*, M23 P6 minor/guardian, *_PRIVACY_HARDENING, M24C/D/E auth |
| 7 | Navigation, IA, terminology | NAVIGATION_ARCHITECTURE, M23_P25*, M24D_NAVIGATION_IA, M21/M23_TERMINOLOGY |
| 8 | UI and brand approvals per app | BRAND_RULES, PRO_EXECUTIVE, GRASSROOTS_CLUBHOUSE, AGENT_FINANCE, HANDOFF_CLAUDE_*, M24A–M24F5 design/rules docs, CLAUDE_old.md lines 172 onward, `design-system/README.md` |
| 9 | Platform contracts (error contract, boot contract, temporal/date types, capabilities/env, deploy) | M23_ERROR_CONTRACT, M23_PRODUCTION_BOOT_CONTRACT, M23_P57_*, M22_CAPABILITIES, DEPLOY, README |
| 10 | Keyword hits from the evidence class | Phase 1 sweep output only |

That's 10 subagents. The UI cluster (8) needs the most care: the Founder clearly cares about those approvals,
and AGENTS.md treats them as binding. Condense them, but keep every concrete rule (colours, lockups, which
screens, what not to change).

## Phase 3: Consolidate

1. One consolidation pass merges the extracts. Conflicts are settled by date, and where the docs disagree
   with the code, the code wins (note the disagreement).
2. Output, all under `docs/`:

   ```
   docs/
     README.md              index: what's where (one screen)
     decisions.md           Founder decisions log: date | decision | area. One line each, newest first,
                            including the storage ones from plan §E.1 (Q4, Q7a, Q8c-a, …) in plain English.
                            Open questions at the bottom.
     product/
       recruitment.md       one per cluster 1–7 and 9: the rules and invariants, 1–3 pages each,
       agents.md            written as "how it works / what must stay true", not as history
       passport.md
       development.md
       matching-analytics.md
       safeguarding.md
       navigation.md        (includes terminology)
       platform.md          error contract, boot, env/capabilities, deploy (absorbs DEPLOY.md)
     design/
       brand.md             shared brand rules
       player.md, pro.md, grassroots.md, agent.md   approved UI per app (absorbs the root design docs)
     architecture/          see Phase 5
   ```

   `design-system/` stays where it is (it holds assets and reference captures). Its README just links to `docs/design/`.
3. No confirmation step before deletion. The Founder reviews `decisions.md` later, and anything lost can be
   recovered from the archive tag and added then. To make that review easy, mark each entry where the docs
   contradicted each other or the code (e.g. "⚠ resolved by recency"), so he can check those first.

## Phase 4: Delete and repair

1. Delete every root `.md` except `README.md`, `CLAUDE.md` and `AGENTS.md`. `DEPLOY.md` goes to `docs/product/platform.md`.
2. Fix the doc-reading tests. These are "the doc exists and says X" checks, which test nothing about the
   product. Remove those assertions and keep any assertions in the same files that check real UI or route
   behaviour. (Read each test first: some may assert on rendered output and only *also* check the doc.)
3. Rewrite the root `README.md`: what the apps are, how to run them, how to run tests, and where docs live. One screen.
   The current one still says "Milestone 11".
4. `AGENTS.md` → a pointer: "Read CLAUDE.md." That keeps Codex and Claude on one source.
5. Sweep the 34 comment references in server code: either point them at the new doc or drop them.
6. Keep `render.yaml`, `fly.toml` and `Dockerfile`. Neither target is live, but the Founder's web Claude may
   use them to serve the demo. Note that in `docs/product/platform.md`.
7. Rebuild the demo artifacts (`node e2e/buildDemos.mjs` and `node e2e/demoFreshness.test.mjs`) and run both test suites,
   to show nothing behavioural changed.

## Phase 5: Restructure `docs/architecture/` for a fast migration

### What to keep

- `sql/*.sql` and `sqlite-schema.md` as the **target** schema. Add a header saying it's a starting point, not a
  contract: a step may redesign its tables when that gives a better model. Not byte-identical, but faithful to
  the product rules in `docs/product/`.
- The S8d design note as the **template** for the remaining steps (typed columns, explicit repository writes, no
  lossless junk columns). At 14 KB it's the right size.

### What replaces the rest

One new `docs/architecture/migration.md`, about 2–4k words, which becomes the live plan:

1. **Where we are**: the §E.1 status table, cut to `step | tables | migration | repository | status`. No
   hashes or acceptance prose.
2. **The end state** we're migrating to:
   - tables are authoritative
   - writes are explicit domain operations (no in-place edits plus fingerprinting)
   - hot reads are SQL with pagination
   - the blob store is retired

   This puts review 3's recommendation 3 into the plan, which has never been done.
3. **Rules for the remaining steps**, building on the Founder's 30 Oct decisions:
   - No production data exists. Rollback = re-seed. No rollback scripts, no historical-build boots, no
     compatibility with files from earlier dev builds.
   - Validate and reject junk at the route. Typed columns only. The data import reports what it dropped. It does
     not preserve it.
   - Schema may diverge from `sql/*.sql` where the design is better. Record the difference in the PR description.
   - One step per domain file (S9 scouting, S10 verification, S11 agents/compliance, S12 development/Box Cam,
     S13 operations), split only if a step gets too big to review. Each step is a short branch and PR into `main`.
4. **Definition of done per step**: migration plus repository plus explicit writes; existing E2E scripts pass
   (storage-only assertions may be rewritten); unit tests for the repository; seed data boots; one
   implementation review under the 30 Oct scope. The design note goes in the PR description. Separate design
   files only for real product questions.
5. **Step template**: half a page, replacing the 8-heading template in §A.

### What goes

- `sqlite-migration-plan.md` (410 KB). §A principles 4–7 and §C are mostly superseded by "no production data".
  Anything still true moves into `migration.md`.
- `s4-readiness-review.md`, `s4-deletion-decision.md`, `s5-player-subrecords.md`, `s6/s7/s8b/s8c-readiness-review.md`.
  Founder decisions in them go to `docs/decisions.md`. Domain behaviour that's still true (e.g. retained player
  records on deletion) goes to the matching `docs/product/*.md`.
- `scoutbox-server/OPERATIONS.md`: cut it to what a developer running the server needs (env vars, data
  directory, units of work / afterCommit contract, backup). Domain contracts move to `docs/product/`.
  Target is under 10 KB.

### Code follow-ups this unlocks (separate commits after the doc cleanup, not part of it)

- Delete the rollback tooling and the historical-build boots from the test gate: `scripts/*Rollback.mjs`,
  `repositories/rollbackChain.mjs`, `repositories/*Rollback.mjs`, the `SCOUTBOX_PRE_*` plumbing. The Founder
  agreed on 30 Oct that they go "with the merge", tied to merging to `main`. Since we aren't merging first,
  bring that forward: with no real data the chain proves nothing worth keeping, and the archive tag preserves
  it. This is probably the biggest single speed-up to the test gate.
- Delete the S8b "key format" marker and any other guards against superseded dev-build files.
- **To raise with the Founder, not decide unilaterally:** S0–S8c tables still carry the lossless
  `absent_keys_json` / `offtype_json` / `extra_json` columns, and his 30 Oct decision says to leave them. With
  disposable data, a migration that drops them plus a re-seed would simplify those repositories a lot
  (the S8c one is about 80 KB). Worth proposing once S9 has shown the S8d template working.
- **To investigate:** with no real data, is the blob → table import needed at all for new steps, or can the seed
  write straight to tables? If the seed can, each step loses its import/reconcile code. Check how seeding works
  before committing to this.

## Phase 6: New CLAUDE.md (separate task, outline only)

About one screen, rules not history:

- What the repo is, the apps, how to run and test (or a link to README).
- Facts: no production data and no live deployment; the feature freeze stays until the migration is done.
- Server rules: CLAUDE_old.md "Server structure", "Shared code" and "Tests and CI" bullets, tightened.
- Review scope: the 30 Oct section, as is.
- **Docs rule:** never create Markdown at the root. Update `docs/` in place. Put design notes and test
  evidence in PR descriptions, not files. Commit messages are a subject plus a few bullets. This replaces the
  "Milestone gates" section, whose gate A produced more docs than it removed.
- Where to look: `docs/README.md`, `docs/architecture/migration.md`, `docs/design/<app>.md` before touching UI,
  `docs/decisions.md`.
- Git: branch from `main`, short-lived branches, PR per step. Push, merge, tag and deploy only on instruction.

---

## Order and rough effort

| Phase | Effort | Needs the Founder? |
|---|---|---|
| 0 Tag (done), placeholder CLAUDE.md | minutes | no |
| 1 Inventory | under an hour | no |
| 2 Distil (10 subagents) | an hour or two of agent time, then your read-through | no |
| 3 Consolidate | half a day | later: he reviews `decisions.md` after the fact |
| 4 Delete and repair | a few hours | no |
| 5 Architecture restructure | half a day for the docs; code follow-ups separate | yes, for the lossless-column question |
| 6 CLAUDE.md | an hour | review it with him so he knows the new rules |

## Decisions (Tom, 3 November 2026)

1. No merge to `main` before the cleanup. Work on `repo-cleanup`, on top of `feat/sqlite-schema`. The current
   commit is tagged `docs-archive-2026-11` as the recovery point.
2. No Founder confirmation of `decisions.md` before deletion. He reviews it later, and gaps are filled from the tag.
3. The feature freeze stays until the migration is done.
4. Neither deploy target is live. Keep `render.yaml` and `fly.toml` anyway (the demo may be served through them).
