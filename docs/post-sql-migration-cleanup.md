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
   **Contacts done too (9 Nov):** the repository has no JavaScript validator left (895 → 832 lines, 75k → 63k
   characters); acts share one `act(id, input, bookkeeping)` shape, and a whole-record create must read back as
   written.
   **Recruitment cases done too (9 Nov):** the case and its four Room tables have no JavaScript validator (the
   repository went from 1,222 to 1,121 lines and from 100k to 84k characters); the draft edits in eight route files
   became 28 named acts. A Room's status moves only along `ROOM_TRANSITIONS` (plus the lifecycle's resume out of
   `on_hold`); a decision's snapshot and chain and a comment's reply are composite keys. The shared write kit
   (`repositories/writes.mjs`) now serves contacts and offers too.
   **Trials and requests done too (9 Nov):** `repositories/recruitment.mjs` has no JavaScript validator (1,017 → 963
   lines, 86k → 77k characters); the 30 draft edits in `trialRoutes.mjs`, `journeys.mjs`, the sweeps and `server.mjs`
   became 24 named acts. A schedule proposal must be one past the current revision, nothing changes an ended trial,
   completion needs a scheduled trial and a report is filed once, all guarded in SQL; a report names its trial's player
   by a composite key. The erasure tombstone is now the repository's `redactPlayer` (SQL), as for cases.
   **Agent transactions, compliance and core done too (9 Nov):** 57 draft edits in the three agent route modules
   and `m27/` became named acts. `agentTransactions.mjs` (1,033 → 801 lines, 88k → 66k characters) and
   `complianceRecords.mjs` (1,356 → 1,049 lines, 125k → 92k characters) have no JavaScript validator. A transaction's
   status moves only along `ACTOR_`, `COMPLIANCE_` and the new `PARTY_CHANGE_TRANSITIONS`, nothing is added to an ended
   one, and a route's rev bump is its own act after the re-evaluation. Composite keys replace four JavaScript checks: a
   snapshot names an evaluation of its own context (transactions and reviews), a binding is in a transaction of its own
   agency, a releasing party is only in a transfer or a loan. A document's and a review's `supersededBy` is now worked
   out from the row naming it. Compliance history whose detail is derived must read back as written. The agent core's
   acts guard `AGENT_TRANSITIONS` and `CLIENT_TRANSITIONS` in SQL; its `create` still types from the field specs, so it
   grew (934 → 994 lines) and belongs with the "validators but no draft updates" pass. Left in these modules: the two
   `compliancePolicies` edits (reviewer revocation, policy publication) and `users.update` on ending a membership.
   **Verification and transitions done too (9 Nov):** the 37 draft edits in the claim routes (`claims/index.mjs`,
   `organisations.mjs`, `review.mjs`, the token helpers), `transitions.mjs`, the vouch routes in `server.mjs` and the
   vouch withdrawal in `scouting/passport.mjs` became named acts. `verification.mjs` and `transitionsVouches.mjs` have
   no JavaScript validator: a create must read back as written. A claim's status moves only along `CLAIM_TRANSITIONS`
   (now in the repository), from the status its caller judged, guarded in SQL; the domain's `transitionChanges` works
   out a move's effects and the old `patch(draft)` callbacks became named corrections. A token is used once, a dispute
   resolved once, a case leaves `open` once, a vouch code is spent once. Composite keys: a reference cites a claim of
   its own coach at its own organisation, and a new version supersedes a reference of the same player, coach and
   organisation. CHECKs now hold the required fields of the nullable groups the typers used to check (a registry
   result's time, a placement's instant, a withdrawal's reason). Size: `transitionsVouches.mjs` went from 391 to 346
   lines (29k → 26k characters); `verification.mjs` grew (663 → 723 lines, 59k → 65k characters), since its 13 record
   kinds trade one generic update for about 25 guarded acts. The spec-to-columns mapping is shared in `writes.mjs`.
   **Box Cam done too (9 Nov):** the 24 draft edits in the Box Cam, Combine and CV routes became 20 named acts, and
   `boxCam.mjs` has no JavaScript validator (896 → 751 lines, 71k → 61k characters). Each act is guarded in SQL by the
   state it moves from: a session's result is worked out once, while it is recording (as is an accepted batch); an
   attempt is measured once, while it is ready; an entry completes once, a dispute is resolved once, a request completes
   once, and a cancelled assignment never moves. Invalidation and restore are their own acts and insert the integrity
   event, so the history only grows by construction. Composite keys replace four JavaScript checks: a session's
   assignment and challenge entry, a dispute's session, and an attempt's session and request all belong to the same
   player. The events route's observation check moved to the domain (`shared.mjs`).
   **Follow-up:** `offerIntegrity` (`offer.mjs`) still checks shapes the schema now rules out (unknown statuses, duplicate
   or missing revisions). Trim it once the batteries that test it on in-memory records have been looked at.
   **Still to do (9 Nov):** about 85 draft edits remain in domain code (by `grep`); 22 repositories still export
   JavaScript validators. In order:
   1. ~~**Trials and trial requests**~~ (done, above).
   2. ~~**Agent transactions, compliance and core**~~ (done, below; the wiring of their cycle is still step 3).
   3. ~~**Verification**~~ (claims and `transitionsVouches.mjs`, done above), then ~~**Box Cam sessions**~~
      (`boxCam.mjs`, done above).
   4. **Then decide whether to stop.** The identity long tail (`identity.mjs`, `users.mjs`, `orgs.mjs` and others,
      ~60 edits, mostly 1–7 single-field edits per repository) carries little state-machine risk: convert a repository
      when it is next worked on. The repositories with validators but no draft updates (`integrations`,
      `insightCoverage`, `signingsFollowUps`, `enterprise`, …) can move to "reads back as written" in one pass, with no
      route changes.
3. **Wiring (item 2)** after the pilot, since row-level repositories change what each domain needs.
4. **Comments (item 4)** as files are touched.
