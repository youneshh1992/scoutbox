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

**The cycles, traced (10 Nov).** Only one of them is a real two-way dependency. The rest come from registration
order, or from a domain reading another's context where a repository read or a pure import would do.

| Late binding in `server.mjs`                                  | Direction it really runs                                                                                                                                                       | Fix                                                                                                                                                                                                |
|---------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `Object.assign(m24Ctx.hooks, m25Ctx.hooks)`                   | Core → compliance (review items for facets and disputes, the Approach verdict). Compliance, transactions and integration use the core only for `requireCap`, `resolveMembership`, `profileOf` and `findOwnAgreement`. | **Done (10 Nov):** `domains/agents/access.mjs`; compliance registers before the core and hands it `coreReviews`. |
| `agentIntegration` holder, filled after `registerIntegration` | Lifecycle → integration (`contactRoute`, `contactTargetSnapshot`); transactions → integration (`caseBelongsTo`, `duplicateTransactionOf`, `bindHandoff`). Integration reads transactions only through `agentTransactions.reads`, and the lifecycle only through pure imports. | Register integration before the lifecycle and transactions, and pass it in as a value. The holder goes away.                                                                                    |
| `m28Ctx.setSigningSummary(m29Ctx.summaryForOffer)`            | Offers → signings (the summary on an offer view). Signings reads offers only through `recruitmentReads.offers` and pure imports from `offer.mjs`.                               | Register signings before offers and pass `summaryForOffer` to `registerOffers`.                                                                                                                    |
| `m24Ctx.hooks.auditRows` wrapped to append transaction rows   | Neither: an agency's audit feed merges three repositories' rows.                                                                                                                | **Done (10 Nov):** the core takes `auditSources` (compliance's and transactions' row functions). Transaction rows need the transaction module's compliance snapshot view, so transactions now register before the core. |
| `m25Ctx.transactionSeam.hooks.representationReviewed`         | **Two-way.** Transactions call compliance throughout (open, project, evaluate, consent, review). A T&S decision on a declared-only binding must verify or withdraw the transaction's representation, and that then re-evaluates compliance. | Compliance publishes "review decided" inside the unit of work, and transactions subscribes at wiring. This is the one place for an event. It must stay synchronous and in the same unit, so a decision and its effect on the transaction commit together. |

Smaller late bindings, fixed as their routes move: `m17Ctx.recruitmentEvidence` (create the provider before
`registerM17`), `m19Ctx.matchFactsKeeper`, and the forward `let` contexts that the routes in `server.mjs` call
(`m23Ctx` trial hooks, `m13Ctx.mfaGuards`, `m14Ctx.syncLegacyOrgVerification`, `m182Ctx`). Erasure's
`onPlayerDeleted` fan-out becomes an explicit list of each domain's `redactPlayer`.

Target order: platform and repositories → agent access → compliance → integration → transactions and the
lifecycle → agent core routes → signings → offers → journeys. The `...m19Ctx` spreads become named arguments
along the way.

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
2. **Item 1, writes through named acts: done for the state machines, stopped 10 Nov.** Converted: offers, contacts,
   recruitment cases and Rooms, trials and requests, agent transactions, compliance and core, verification and
   transitions, Box Cam. Over 150 draft edits became named acts guarded in SQL by the state they move from, and
   those repositories have no JavaScript validator: a create must read back as written, and composite foreign keys
   replace the cross-record checks. The shared write kit is `repositories/writes.mjs`. Most repositories shrank by
   10–26% in characters (`verification.mjs` grew); the case for the work was soundness rather than size.
   About 78 draft edits remain (`players` 16, `users` 7, `orgs` 7, then 1–5 per repository), none of them in a
   multi-step state machine, and most of them in the routes still in `server.mjs`. Convert each one when its route
   moves into `domains/` (item 2), so every line is touched once. Two groups go first, in wiring slice (a):
   - the guardian verification flags (`emailVerified`, `idVerified`, `disclaimerAccepted`), which gate minors'
     safety, become one-way acts guarded in SQL;
   - ending an organisation membership (`removedAt`), written separately in `agents/core` and
     `scouting/scouting.mjs`, becomes one `users.remove(id, by)`.

   Parked: the repositories with validators but no draft updates (`agentCore`'s `create`, `integrations`,
   `insightCoverage`, `signingsFollowUps`, `enterprise`, …) move to "reads back as written" in one pass, with no
   route changes. `offerIntegrity` (`offer.mjs`) still checks shapes the schema now rules out; trim it once the
   batteries that test it on in-memory records have been looked at.
3. **Wiring (item 2)**, in slices, each checked against its batteries:
   - (a) ~~The guardian account and its gates leave `server.mjs`.~~ Done 10 Nov: `domains/identity/guardians.mjs`.
     The guardians repository has no draft update, and `users.remove` ends a membership once. The
     child-management routes still mount on its router and move in (f).
   - (b) ~~Agent access, then compliance before the core.~~ Done 10 Nov. `m24Ctx`–`m26Ctx` are now
     `agentCoreDomain`, `complianceDomain` and `transactionsDomain`.
   - (c) Integration before the lifecycle and transactions, which retires the holder.
   - (d) Signings before offers.
   - (e) The review-decided event.
   - (f) The remaining `server.mjs` routes, converting their draft edits as they move.

   **Names.** Each slice also renames what it touches after its domain: the milestone contexts (`m13Ctx` …
   `m29Ctx`, `m162Ctx`, `m182Ctx`) and registration functions (`registerM12` … `registerM23`) become, for
   example, `rooms` and `registerRooms`, and the milestone directories fold into `domains/` (item 6). By the end of
   (f), `grep -E 'm[0-9]+Ctx|registerM[0-9]'` finds nothing.
4. **Comments (item 4)** as files are touched.
