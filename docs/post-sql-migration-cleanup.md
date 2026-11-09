# Post-SQL-migration clean-up

A survey of `scoutbox-server/` after the SQLite migration (9 Nov 2026): where the code is, how much of it is
incidental complexity and how much is business rules we must keep, and the clean-ups worth doing. Line counts are
`wc -l` over tracked files, comments and blank lines included.

## Where the code is

About 136k lines in all: roughly 80k production and 52k tests.

| Area                           | Lines | What it is                                  |
|--------------------------------|-------|---------------------------------------------|
| `domains/`                     | 45.7k | Route handlers and rules (22% comments)     |
| `e2e/`                         | 35.2k | The behavioural batteries                   |
| `repositories/`                | 24.1k | 40 repositories and 40 migrations           |
| `scripts/`                     | 17.5k | Unit tests, fixtures and tools              |
| `server.mjs`                   | 5.2k  | 160 routes, plus the wiring of every domain |
| `m12/`, `m13/`, `m20/`, `m27/` | 4.4k  | Milestone-named modules                     |

The largest domains are recruitment (12k; `lifecycle/` alone is 6.4k) and development (11.5k, of which Box Cam's
computer vision is 5.6k). There are 847 routes in total.

## Hotspots, most incidental first

### 1. Repositories store documents across tables

Most incidental code is here (~24k lines). The domain code still works on nested aggregates (an offer with arrays
of revisions, keys and history). Each repository splits an aggregate into child tables on write and rebuilds it on
read. Updates go through `update(id, draftFn)`: load the record, clone it, let the caller change the copy,
re-validate the whole aggregate, compare it with the stored version to enforce rules such as "history only grows"
or "these fields never change", then write it back. This recreates the blob store on top of tables.

So each aggregate is defined three times:

- the DDL, with its CHECK constraints;
- a JavaScript validator (207 `type*()` functions in 28 repositories);
- encoders and decoders (96 `decode*` and 39 `*Row` functions).

The domain limits (`OFFER_LIMITS` and the like) are checked at the route, again in the repository validator, and
again by the database. There are 59 draft-style update APIs, and they are hard to square with ground rule 3 in
[`architecture.md`](architecture.md) (explicit writes).

**Why it matters for soundness.** The domain decides a change, then the repository works out what changed by
comparing copies and re-checks the rules by diffing. Rules such as "history only grows" or "a closed context does
not reopen" are therefore defined twice, in different forms. The domain is also tied to the storage shape (nested
arrays), and every write rewrites the whole aggregate. The validators are load-bearing while drafts exist: a draft
can carry any field, and the validator is all that stops a field with no column being silently dropped.

**Target shape.** Write through intent-named operations (`offers.issue(id, revisionId, by)`). History is a table
that is only ever inserted into, so "only grows" holds by construction. Status changes update named columns, and
the checking is left to two layers: the route and the database. Keep what is sound today: aggregates assembled
for reads and views, the `rev` optimistic concurrency on parent rows, and units of work.

**Cost.** 281 draft-edit call sites in domain code to rewrite, and new named operations in each repository. Expected
net saving: 20–30% of the repository layer (validators and diff checks go; decoders mostly stay), plus some unit
tests of repository refusal codes (94 asserts). Converted one domain at a time against its e2e battery.

### 2. Wiring in `server.mjs`

Domains are connected through context bags still named after milestones (`m17Ctx` … `m29Ctx`): 12 spreads of one
domain's context into another, and hooks patched in after registration. Long comments explain the order of
registration because the dependencies themselves are hidden. The late-bound hooks (agent core ↔ compliance ↔
transactions ↔ integration, and offers ↔ signings) are dependency cycles between domains, which is a soundness
problem in its own right. Each domain should take the repositories and the few services it needs as named
arguments, and the cycles should be broken (a shared read seam, or events) rather than patched after registration.

The 160 routes still in `server.mjs` (player, guardian and org auth, messaging, erasure, the admin console) are
real features. The server rules say they belong in `domains/<domain>/`.

### 3. Helpers rewritten in each module

16 local `now()` helpers, 5 readers of the `x-scoutbox-test-clock` header, idempotency handling in 33 files, local
error and `safe()` side-effect wrappers, and 7 copies of `deepFreeze`. None of these are rules; each should be
one shared module under `domains/platform/`.

### 4. Comments

About 10k comment lines in `domains/`. Many are "what never happens here" essays that restate invariants already
enforced in code. Trim them to the surprising parts as each file is touched.

### 5. Box Cam computer vision

The engine is a settled decision (deterministic, server-side, no third-party model; see
[`decisions.md`](decisions.md)). However, `cv/holdout.mjs`, `cv/fixtures.mjs`, `cv/families.mjs` and `cv/scenes.mjs`
(~1.7k lines) and `evaluation.json` / `holdout.json` (~2.1k lines) are only used by `scripts/tools/` and the e2e
batteries. They are evaluation tooling and can move out of `domains/`.

### 6. Milestone modules

`m20/` is recruitment analytics and `m27/` is the agent cross-app integration, both real features. `m12/` and `m13/`
hold shared helpers and delivery. Fold them into `domains/` under domain names. Nothing to delete.

### 7. Tests

The e2e batteries are the specification and stay. The unit tests would shrink only as a side effect of item 1.

## What is genuine and stays

- The recruitment lifecycle, offer and signing state machines.
- The compliance engine and its policy versions.
- Minors and safeguarding gates, auth and sessions.
- Response allowlists (these could be declared more compactly).
- The SQL schema itself.

The rules are likely well under half of the production lines.

## Plan

1. **Low-risk clean-ups, in any order:** shared helpers (item 3), move the Box Cam evaluation tooling (item 5),
   fold the milestone modules (item 6).
2. **Pilot item 1 on offers:** `domains/recruitment/offers/` (1.6k) and the offer half of
   `repositories/recruitmentContactsOffers.mjs` (0.9k), checked against `e2e/recruitment/offers*.mjs`. Measure the
   reduction before deciding on the other domains.
   **Done (9 Nov):** 11 draft edits became 8 named acts; the offer validator is gone, and its pointer rules are now
   composite foreign keys. Size: the route module went from 950 to 894 lines; the repository grew slightly in lines
   (895 → 914) but shrank 6% in characters. The saving per domain is small; the case for continuing is soundness.
   Contacts, in the same file, are still whole-record.
   **Follow-up:** `offerIntegrity` (`offer.mjs`) still checks shapes the schema now rules out (unknown statuses, duplicate
   or missing revisions). Trim it once the batteries that test it on in-memory records have been looked at.
3. **Wiring (item 2)** after the pilot, since row-level repositories change what each domain needs.
4. **Comments (item 4)** as files are touched.
