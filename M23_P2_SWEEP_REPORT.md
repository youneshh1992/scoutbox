# M23 P2 — Total Defect Sweep: Final Report

> Before ScoutBox gains another workflow layer, every path into the current one
> must be accounted for — writes, restores, races, permissions, migrations,
> legacy code, tests and failures alike.

---

## 1. The result

**Eleven defects found, eleven fixed.** Four were crashes — a 5xx produced by
one word of request body or one malformed stored record. Five were silent wrong
answers: a case in two states at once, a lead quietly demoted, a replay
answered 200 to someone who could never have performed it. Two were dead code
and stale documentation describing behaviour that did not exist.

Plus one **test defect**: a suite that converted a failed boot into a passing
check and silently dropped four assertions.

| | Before | After |
|---|---|---|
| m23E2E | 161 checks, 54% negative | **331 checks, 69% negative** |
| m23Persistence | 55 checks | **67 checks** |
| m182E2E | 330 *or* 333, non-deterministic | **334, stable over six runs** |
| Schema version | 2300 | **2301** |
| Full battery | — | **4,178 checks, 0 failures, 19 suites** |

## 2. The finding that matters most

**Not one defect was found by reading the code.**

Every one came from stating a property over a whole product and evaluating it:
every state × action × role (1,368 combinations); every stage in both
vocabularies; every inbound edge to every evidence-bearing status; every
required store; every error body the routes can produce; every one of the
eighteen lifecycle states restored from a snapshot.

Or from the other technique that worked: **change the world after a token is
minted, then use the old token.** Promote, demote, remove, cross the tenant
boundary, kill the process.

The prior passes read carefully and found real things. This pass found eleven
more in code that had already been read carefully — which is the argument for
properties over inspection, not an argument about the care taken.

## 3. What each blind spot was made of

Three patterns account for all eleven.

**A comment is not a call site.** `ctx.syncRoomStatusFromStage` was declared,
documented accurately, and never invoked. The documentation describing what it
did was true of the intent and false of the system. So was
`M23_RECRUITMENT_WORKFLOW.md` §1, which described a translation that never
happened, and `journey.mjs`'s JSDoc, which advertised options the function never
destructured.

**A loose negative assertion survives the defect.** `neg(raced.status !== 200)`
passes whether the refusal is the evidence gate (correct) or a permission error
(a demoted lead). That one assertion hid D5 from the whole battery. Every
negative in this sweep names its error code.

**A pure function has no module registration to lean on.** `db.assessments`
exists in every running server because `m12/shared.mjs` creates it at
registration. `buildRecruitmentJourney` is a pure function over a database and
declared it required. Two lists in two files stated one contract and disagreed.

## 4. Architecture decisions taken, with reasons

**A derived field is not writable.** `case.stage` derives from `room.status`,
so on a case that has a Room the legacy stage route now **refuses**
(`STAGE_NOT_SETTABLE_ON_ROOM`) rather than translating. Translating looks
generous and is wrong: `roomStatusForStage` inverts a lossy projection —
eighteen statuses onto six stages — so `decision` alone means four statuses,
and a round-trip would move a room at `offer_made` *backwards*. **A lossy
inverse cannot be an authoritative write.** That is why authority runs one way.
A plain M12 case has no lifecycle and keeps its old behaviour exactly.

**One event, one name, one reason code.** Three actions reach `under_review`,
and from a withdrawn case all three were offered at once — each writing a
different reason into a history nothing ever rewrites. Actions now declare
`applicableFrom`. The transition table is untouched; only which action may
*name* a given edge narrows. Stated in the suite as a property: no state ever
offers two actions for the same move.

**Creation is an inbound edge too.** It runs no transition table, correctly —
there is no state to transition from — which made it the one edge to an
evidence-bearing status carrying none of the burden. Adoptions that would land
there start at `under_review` instead, with the original stage recorded in the
creation activity. Stated over both vocabularies, so a stage added later cannot
reintroduce it.

**Null prototypes on tables indexed by data we did not write.** Five tables. A
plain object literal answers truthy for `constructor` and `toString`, so every
`if (!TABLE[key])` guard in the codebase silently let those through. Fixing the
tables makes the guards that were already written start working — a structural
fix rather than a scatter of new guards.

**A replay is still an action.** Permission is checked before an idempotent
replay is answered. Full validation cannot stand in: by replay time the case
has moved, so every replay would be refused for the wrong reason.

**Corruption is reported, never rendered as fact, and never as an oracle.** A
`case.history` that is not a list is refused, not shown as
`{ entries: [], total: 0 }` — which asserts that nothing ever happened. And the
refusal sits *below* the concealment branches: a player told "this case is
corrupt" where a stranger is told "no such case" has been told the case exists.

## 5. What was deliberately not done

**84 of 116 `db.x ??=` collections are still absent after migrations alone.**
Measured, not estimated. Each is safe today because its module's default runs
after `loadSnapshot()` — a guarantee that depends on registration order, which
is exactly how `db.assessments` was lost. Guaranteeing all 84 is a
platform-wide bootstrap change, outside a sweep scoped to M23's own paths, and
D2's own mandate forbade broadening a persistence fix into unrelated
refactoring. Recorded in `M23_STORE_INITIALIZATION_AUDIT.md` §10 with the
honest statement of what is guaranteed today.

**No expiry rule for recorded external contacts.** The Contact contract names
it as the open question and refuses to invent a number nobody could defend
before seeing how clubs actually record them.

**No index, no cache.** Perf was measured again, not tuned: the projection's
cost still tracks the target case rather than the database, no collection is
read more than twice for one journey, and nothing is retained across
projections.

## 6. Documents produced

| Document | What it is |
|---|---|
| `M23_WRITE_SITE_AUDIT.md` | every production write touching status, stage, signings, history or rev — with caller, authorization, transition, evidence, rev and idempotency |
| `M23_P2_FINAL_DEFECT_REGISTER.md` | all eleven defects, each with **why it survived** |
| `M23_CONTACT_CONTRACT.md` | the Contact semantics, frozen before Contact is built |
| `M23_STORE_INITIALIZATION_AUDIT.md` §9–§10 | the D2 recurrence, and the measured scale of what remains |
| `M23_RECRUITMENT_WORKFLOW.md` | corrected where it described behaviour that did not exist |
| `M23_TERMINOLOGY.md` | corrected for the same reason |

## 7. The numbers the mandate asked for

```
authoritative lifecycle writers : 1      (applyStatus, m17/rooms.mjs:74)
migration-only writers          : 2      (room rev backfill; assessments container)
unsafe direct writers           : 0
unvalidated signed writers      : 0
writers of db.signings          : 1      (POST /org/players/:id/signing)
lifecycle paths that reach it   : 0
```

## 8. State of the branch

- 154 commits ahead of origin. **Nothing pushed. No PR opened.**
- Working tree clean; no stray server processes; no port leaks.
- 19 suites, 4,178 checks, 0 failures. `apiE2E` adds 129 against a live server
  (it takes an externally started one by design).
- `m23Perf` re-run: unchanged, still measured rather than tuned.

## 9. Readiness for Contact

The gate the Contact phase inherits is already built and already refuses:

- `contacted` requires `contact_delivered`, keyed by **target status**, so
  every inbound edge carries the identical burden and a future edge cannot skip
  it;
- a missing evidence provider **fails closed**;
- the transition writes exactly one history entry, through the single writer;
- the reason code matches the event, by construction;
- there is no `PATCH { stage }` and no legacy route around it.

Contact's job is to supply one evidence kind to a gate that already exists.
`M23_CONTACT_CONTRACT.md` says what that kind means, what it does not mean, and
the six things Contact must not do.

**This report is the review gate. Contact implementation has not begun.**
