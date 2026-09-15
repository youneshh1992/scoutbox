# M23 P2 — Final Defect Register

Every defect found by the total sweep, with how it was found, why it survived
until now, and what closed it.

The column that matters most is **"why it survived"**. Ten defects passed a
1,500-check regression battery; understanding what made each invisible is worth
more than the fix.

---

## Summary

| | |
|---|---|
| Defects found | **11** |
| Fixed | **11** |
| Crashes (5xx from a request or a record) | 4 |
| Silent wrong answers | 5 |
| Dead code / stale documentation | 2 |
| Schema version | 2300 → **2301** |
| m23E2E | 161 → **331** checks, 54% → **69%** negative |
| m23Persistence | 55 → **67** checks |

> These are the sweep's own numbers and are left as the sweep recorded them.
> Defects found by the passes that followed it are in the **addendum** at the
> end of this file, not merged into the table above — a register that
> back-dates later findings stops being a record of what was known when.

**Not one was found by reading the code.** Every one came from a property
stated over a whole product — every state × action × role, every stage in both
vocabularies, every required store, every error body — or from changing the
world after a token was minted and using the old token.

---

## D1 — The declared bridge that was never wired

**`ctx.syncRoomStatusFromStage`** existed in `m17/rooms.mjs`, documented as
keeping M12's legacy stage route aligned with the room status. A
repository-wide search returned exactly one hit: its own definition.

So `POST /org/cases/:id/stage` wrote `case.stage` on a case that was also a
Room while `room.status` stayed put. One case, two representations, disagreeing
— with no transition table, no evidence requirement, no history entry and no
rev bump. A concurrent lifecycle caller holding `expectedRev` still passed the
rev guard, because nothing had moved the token.

**Why it survived.** The seam was declared with a correct-sounding comment, and
a comment is not a call site. Every test that moved a stage used a plain M12
case, which has no Room and therefore no disagreement to expose.

**Fix.** The route refuses a Room (`STAGE_NOT_SETTABLE_ON_ROOM`, 409) and names
the lifecycle route. Wiring the seam up would not have been the fix:
`roomStatusForStage` inverts a lossy projection — eighteen statuses onto six
stages — so `decision` alone means four statuses and the round-trip would move
a room at `offer_made` *backwards*.

**Severity.** Medium. No stage maps to `signed`, so the legal boundary was
never crossed. But `m13/planning.mjs` reads `c.stage`, so a Room could be made
to vanish from planning while remaining open.

## D2 — The M12 decision routes wrote the derived stage

`POST /org/cases/:id/decision` and `.../approvals/:aid` both set
`c.stage = 'decision'` directly — the same desync as D1, through a different
door.

**Why it survived.** D1's search pattern was `.room.status =`. These write
`c.stage`, which looks innocuous until you know the stage is derived.

**Fix.** Guarded with `if (!c.room)`. The decision is still recorded in full;
only the write to the derived field is skipped. Refusing the decision would
have been wrong — recording it is the point of the route.

## D3 — Room creation was an inbound edge carrying no burden

Room creation runs no transition table, correctly: there is no state to
transition from. But an adopted M12 case inherits its stage, and grassroots
`awaiting_response` maps to **`trial_completed`**, which is evidence-bearing.
Opening a Room on such a case asserted that a trial had been completed.

**Why it survived.** Every evidence test asked "can I *transition* to an
evidence-bearing status?" Creation is not a transition, so nothing asked.

**Fix.** `adoptionStatusForStage`: an adoption that would land on an
evidence-bearing status starts at `under_review`, and the original stage is
recorded in the `room_created` activity so nothing is lost. Stated as a
property over both vocabularies, so a stage added later cannot reintroduce it.

## D4 — Three names for one move, three different reason codes

`startReview`, `resumeCase` and `reopenCase` all land on `under_review`, and
from a withdrawn case **all three were offered at once**. Each writes a
different reason code into a history that is never rewritten, so "resumed from
hold" could be recorded for a case that was never held — and an analytics
consumer counting `case_reopened` would undercount every reopen taken under
another name.

**Why it survived.** Every hold/reopen test used the *right* action. Nobody
asked what else was on offer.

**Fix.** Actions declare `applicableFrom`. The transition table is unchanged;
only which action may *name* a given edge narrows. New refusal
`LIFECYCLE_ACTION_NOT_APPLICABLE` (409). Generalised in the suite as: no state
ever offers two actions for the same move.

## D5 — A recruitment lead was silently demoted

`m23/index.mjs` called **`isLead(req)`** on both routes. `isLead` takes a *user*
and reads `user.role`; `req.role` is undefined, so it always returned false. No
recruitment lead ever resolved as `recruitment_admin` on either M23 surface. A
lead who had not personally opened the room fell through to `contributor` — no
hold, no reject, no close, no reopen — a restricted room denied them entirely,
and `confirmSignedOutcome` was unreachable for everyone.

**Why it survived.** Two reinforcing blind spots. The role tests are pure: they
pass a role in directly and never exercise HTTP resolution. And the one live
check that touched it asserted `status !== 200` — which a 403 satisfies exactly
as well as the 422 the test was written for. **A negative assertion loose
enough to survive the defect is not coverage.**

**Severity.** High as a functional defect; not a security hole, because it
failed closed.

**Fix.** `isLead(req.orgUser)`, plus a live discriminator that reads the
resolved role without needing a transition P2 cannot legally perform:
`confirmSignedOutcome` is admin-only and role is checked *before* the
transition table, so from `watching` a lead gets 409 and anyone below gets 403.
H4 tightened to name its refusal. Reverting the fix turns A1, A4 and A6 red.

## D6 — The idempotent replay skipped permission

The replay branch answered before any permission check. A caller whose role
could never have performed the action received **200 `{idempotent: true}`** with
the original `from`/`to` — told their request had succeeded.

**Why it survived.** Idempotency was tested as a correctness property (does a
repeat perform the action twice?), never as an authorization surface.

**Fix.** `actionPermittedForRole` answers the narrow question — may this role
do this at all, ignoring where the case is — and the replay is refused 403 with
nothing of the original transition echoed back. Full validation cannot stand in
for the check: by replay time the case has moved, so every replay would be
refused for the wrong reason.

## D7 — Prototype keys walked past every table guard

`LIFECYCLE_ACTIONS` was a plain object literal, so
`LIFECYCLE_ACTIONS['constructor']` was truthy. The route's
`!LIFECYCLE_ACTIONS[action]` guard passed it through, the validator read
`.roles` off Object's constructor, and **one word of request body became a
500**. The same hazard existed on the read side, where the key comes from
stored data: a status of `__proto__` would have walked past
`ROOM_TRANSITIONS[status]` and `STAGE_MAP[...]`.

**Why it survived.** The guards were written and are correct. JavaScript's
prototype chain makes them lie.

**Fix.** Structural, not a scatter of guards: every lookup table indexed by a
client value or a stored value has a **null prototype**, so a key we did not
define answers `undefined` and the guards that were already written start
working. One helper, five tables.

## D8 — `String(value)` on request data

`validateReasonCodes` coerced with `String(c)`, which invokes the value's own
`toString`. `reasonCodes: [{ toString: 1 }]` threw "Cannot convert object to
primitive value" out of the route.

**Why it survived.** `String()` is the idiom for "make this safe". It is not.

**Fix.** A reason code that is not a string is not a reason code. Type check
before coercion.

## D9 — A required store present but not a list

The projector's gate was `db?.[k] === undefined`, so `null` — the shape a
half-finished migration leaves behind — passed as "present" and threw a
TypeError deeper in, where it reads as a projector bug rather than the broken
infrastructure it is.

**Fix.** `missing` and `malformed` reported separately in the same refusal, so
a log says which problem to go and look for. Plus: a `case.history` that is not
a list is refused as `CASE_HISTORY_CORRUPT` (500) rather than rendered as
`{ entries: [], total: 0 }`, which asserts that nothing ever happened.

The refusal sits **below** the concealment branches: a player told "this case is
corrupt" where a stranger is told "no such case" has been told the case exists.

## D10 — The D2 persistence defect recurred at `db.assessments`

A pre-M23 snapshot upgraded cleanly, kept all thirteen original statuses,
invented no history — and the journey route answered **500**. `db.assessments`
did not exist.

**Why it survived.** `m12/shared.mjs` runs `db.assessments ??= []` at module
registration, so a *running* server always has it and no test that goes through
HTTP can see the gap. `buildRecruitmentJourney` is a pure function over a
database, with no module registration to lean on. Two lists in two files stated
the same contract and disagreed: `JOURNEY_REQUIRED_STORES` included
`assessments`; `PRODUCTION_REQUIRED_STORES` did not.

**Fix.** `m230_002_assessments_present` (schema 2301), plus a drift guard
stated as containment rather than as a list of names.

**Measured, not fixed:** 84 of 116 `db.x ??=` collections are absent after
migrations alone. Recorded in `M23_STORE_INITIALIZATION_AUDIT.md` §10 as the
next persistence pass's work; fixing all of them is a platform-wide bootstrap
change outside a sweep scoped to M23's paths.

## D11 — `LIFECYCLE_STATE_UNKNOWN` mapped to 400

A stored state this build does not recognise is corruption, not a malformed
request. 400 tells the caller to fix something they cannot fix; 409 invites a
reload-and-retry that cannot succeed.

**Fix.** 500. It is our problem and should read as our problem.

---

## Two documentation defects, fixed with the code

- `M23_RECRUITMENT_WORKFLOW.md` §1 claimed both legacy stage paths "translate
  it into the status it means … and go through the single writer". Neither did:
  one had no bridge at all (D1) and the metadata PATCH accepts no stage key.
- `m23/journey.mjs` advertised `orgCanSee` and `player` options it never
  destructured. Removed, and replaced with why no visibility callback is needed
  — the projection carries no player identity.

---

## What the sweep looked for and did not find

- No path writes `signed` without `confirmed_join` evidence.
- No path creates a `db.signings` row to satisfy a lifecycle transition; there
  is exactly **one** writer of `db.signings` in the repository.
- No path deletes or rewrites a `case.history` entry.
- No path writes `room.status` on a live room outside `applyStatus`.
- No lifecycle transition moves Trust, the Passport, a Development Plan, a
  Second Look item or Combine eligibility — measured by taking a reading,
  moving the lifecycle five times, and taking the reading again.
- No error body carries a private note, a colleague at another club, another
  club's name, a stack trace, a file path or an internal exception name.
- No score, readiness, probability or percentage appears anywhere in the
  projection.

---

# Appendix — the final corrections round

Three correction items (production boot contract, live/browser regression,
recovery bundle) found **five more defects**. Appended, not merged into the
list above: the original eleven were what the sweep found, and these are what
the corrections found.

## B1 — `db.idvQueue` and `db.orgNotes` were created on first write

Both initialised by `db.x ??= []` **inside a request handler**
(`server.mjs:1162`, `server.mjs:1729`), so they came into existence on
whichever request arrived first.

**Why it survived.** Every read of them is guarded, so nothing crashed — and a
guarded read is exactly what makes this invisible. A store that appears on
first write cannot be reported by `missingRequiredStores()`, cannot be named by
the `STORE_MISSING` boot log, and a restore that dropped it looks healthy until
someone files the first note. **Read-time repair is not a lifecycle; it is the
absence of one.**

**Fix.** `m230_003_core_server_stores_present`, schema 2301 → 2302. `server.mjs`
has no `register()` of its own, so the core registry is the right home.

## B2 — `db.verRootTransfers` was created inside the transfer route

`m14/organisations.mjs:593`. It existed only once somebody had already
requested a root transfer. Moved to `m14/shared.mjs` with its twelve siblings.

## B3 — `db.reviewLater` existed by accident

Nothing initialised it at registration. It was present after boot only because
`m13/index.mjs` calls `tick()` once synchronously, `tick()` calls
`insightSweep()`, and that opened with `db.reviewLater ??= []`.

A real execution that really worked — but a store whose existence depends on a
sweep having been scheduled moves the day the sweep is made lazy, deferred or
put behind a flag. Init moved to `m13/shared.mjs`.

## B4 — the lifecycle route validated against the WRONG reason taxonomy

**Found by the live suite**, on the first attempt to hold a case with a
lifecycle reason code.

`m23/index.mjs` called `validateReasonCodes` from `m17/shared.mjs`. That
validates against M17's 20 **decision** reason codes — why a club *concluded*
something about a player. M23 publishes 16 **lifecycle** reason codes — why a
case *moved*. The two sets overlap in **zero** codes.

So the route accepted a judgement about a player as the reason a case closed,
and refused every one of the sixteen reasons the milestone defines.
`rejectCase`, `withdrawCase` and `closeCase` *require* a reason, which meant
the only reasons they would take were from the wrong vocabulary — written into
an append-only history that nothing ever rewrites. `isLifecycleReason` was
exported and never called.

**Why it survived.** Every prior test that supplied a reason code through the
route supplied an M17 decision code, because that is what the route accepted;
and every test that exercised the M23 taxonomy called the pure validator, which
only checks that the list is non-empty. Neither half ever met the other.

This is D3's shape one level up: two tables answering one question, and the one
that mattered was never asked.

**Fix.** `validateLifecycleReasons` in `m23/lifecycle.mjs`, refusing a decision
code with `LIFECYCLE_REASON_UNKNOWN` and publishing the taxonomy that would
work. `/org/recruitment/lifecycle` now publishes the codes and marks which
actions require one. The **prohibited** set is shared deliberately and keeps
M17's `ROOM_REASON_PROHIBITED`: a protected characteristic can never be a
reason for anything, and that rule must not have two implementations.

Four existing m23E2E assertions passed M17 decision codes to the lifecycle
route. Per §51 they were not weakened — they encoded the wrong vocabulary and
now use the right one. New group V (18 checks) asserts the separation as a
property, including that every action requiring a reason has a valid default in
its own taxonomy.

## B5 — the new live suite hung after printing success

`e2e/m23Live.test.mjs`, first version: the spawned backend and two static
servers are ref'd handles, so the process printed `37 checks passed` and then
never exited. Success to a human reading the tail; a timeout to a harness — and
it held ports 4023 and 8723, which broke the next run with `EADDRINUSE`.

This is **D1 exactly** (m22E2E, found by the M22 pass) reproduced in new code
by the same author. Every other Live suite ends with `process.exit(0)`; this one
now does too, after closing the statics and stopping the backend.

---

## Observed but not reproduced — m18E2E `changeCount`

`S1: one underlying change, one item` failed **twice in roughly thirty runs**,
both times during a full sequential battery, never in isolation.

Measured deliberately rather than assumed: **10 consecutive clean runs at the
pre-correction baseline** (`74a0aef`, in a separate worktree) and **10
consecutive clean runs at the current tip**, plus 9 further runs under
deliberate CPU load from three concurrent suites. Not reproduced in 29
attempts.

It is therefore **not** a regression from this work — it predates it and is
rare. Per §51 the assertion was **not weakened**: it now prints the second
change's type, source system and timestamp when it trips, so the next
occurrence identifies itself instead of costing another thirty runs.

Recorded as open, low severity, in a pre-existing suite.

---

# Addendum — defects found after the sweep

The sections above are the total sweep's record and are unchanged. Everything
below was found later, by the correction pass and the freeze pass, and is
recorded in the order it was found.

| ID | Severity | Found by | Status |
|---|---|---|---|
| **B4** | high | the new browser/live suite, on its first attempt to hold a case | **fixed** `a4bb7af` |
| **B5** | medium | my own new live suite, hanging after success | **fixed** `a4bb7af` |
| **B6** | **high** | 50-run stress reproduction of the m18E2E flake | **fixed** `8e8d0a3` |
| **C1** | low | the store-contract pass | **fixed** `213b980` |
| **C2** | low | the dead-code sweep | **fixed** `7605e75` |

## B6 — one event, three clock reads

*This supersedes "Observed but not reproduced — m18E2E `changeCount`" above.
That section recorded, accurately, what was known at the time: two failures in
roughly thirty runs and 29 clean attempts at reproducing them. It was not a
test flake. It was a product defect, and it is now closed.*

**The assertion.** `S1: one underlying change, one item` — one underlying
change to a player's record must produce exactly one Second Look item, with
`changeCount === 1`. It failed intermittently with `changeCount === 2`.

**Semantics first, before any run.** `changeCount` is `material.length` where
material is `dedupeMaterialChanges(changesSinceDecision(changes, decisionAt))`,
and a change's identity is `changeFingerprint = type:sourceSystem:sourceId`
with **no timestamp in it**. That single fact eliminated most of the candidate
explanations before a test was run: SSE replay, a duplicated broadcast and
listener-registration order all produce the *same* fingerprint and collapse
under dedupe. A count of 2 could therefore only mean a second genuinely
distinct canonical identity — which narrowed the question to "what else emits a
change with a different `type`?"

**Reproduction.** `scripts/m18FlakeProbe.mjs`: fresh database and fresh process
per run, `M18_FLAKE_LOAD=1` for CPU pressure, and a diagnostic that dumps every
fingerprint on mismatch. It reproduced on run 30 of 50 and named the defect
outright:

```
changeCount=2  decisionAt=1789513602502
  change: evidence_quality_improved:evidence:evd-1016  at=…514  (+12ms)
  change: full_match_added:evidence:evd-1016           at=…513  (+11ms)
```

Two different types, one source record, eleven and twelve milliseconds apart.
A brand-new piece of evidence had been reported as *an upgrade of itself*.

**Root cause.** `newEvidence` in `m12/passport.mjs` called `Date.now()` three
separate times while building one record — once for `recordedAt`, once for
`verification.reviewedAt`, once for the availability `expiresAt`. When the
millisecond ticked between the first two reads, `reviewedAt` landed 1ms after
`recordedAt`, and M18's `reviewedAt > recordedAt` test — a correct test for
"this evidence was reviewed later than it was filed" — read it as a later
review of an older upload.

**Why it survived.** It needed a millisecond boundary to fall inside a few
lines of object construction, so it appeared in roughly one run in twenty-five,
and only under the scheduling pressure of a full sequential battery. Nothing in
the product crashed. A club was simply told its evidence had improved when
nothing had been reviewed.

**Fix, at the writer.** One clock read for one event:

```js
const at = Date.now();
const rec = {
  …
  recordedAt: at,
  verification: { …, reviewedAt: reviewer ? at : null },
  expiresAt: claimType === 'availability' ? at + 90 * 86_400_000 : null,
};
```

Per §4, no retry, no sleep, no raised timeout, no widened expectation, no
"either count is fine". The forbidden fixes would each have hidden a real wrong
answer that a club would eventually have read.

**Regressions, two of them, at two levels:**

- `m12E2E`, at the owner — `reviewedAt === recordedAt` for evidence born with a
  tier. Deterministic; it does not depend on the clock ticking.
- `m18E2E`, as an invariant rather than a count — no single source record may
  produce two material changes. Stated over the fingerprints, so it catches any
  future writer that makes a creation look like an upgrade of itself, not just
  this one.

**Exit gate (§8).** Root cause identified and named. Regressions added at both
levels. **100 consecutive targeted runs** and **20 consecutive full m18E2E
runs**, zero failures. No retry, no quarantine, no sleep, no weakened
assertion anywhere in the fix.

**`M23-P2-FLAKE-CLOSED`.**

## C1 — `schema` counted as a store

The first production-store contract listed `db.schema` as migration-guaranteed.
It is the migration registry's own record of which steps have run — an object
keyed by step id, not a collection of domain records. Counting it made the
guarantee read one store broader than it is (124/43 rather than 123/42). It now
sits in `NOT_A_STORE` with `json`, which only ever appeared in the scan because
the filename `data/db.json` occurs in string literals.

Found by writing the contract down in a form something could check.

## C2 — a constant that was never read

`LIFECYCLE_INITIAL` was exported from `m23/lifecycle.mjs` with no caller
anywhere. Deleting it would have been the wrong repair: the value `'watching'`
existed in three places — that constant and both room-creation sites in
`m17/rooms.mjs` — and was *read* at none of them. The constant was not stale,
it was disconnected. It now lives in `m17/shared.mjs` as `INITIAL_ROOM_STATUS`,
beside the status set that owns it, both creation sites read it, and
`LIFECYCLE_INITIAL` remains as an alias so M23 can name it in its own
vocabulary without holding a second copy.

`LIFECYCLE_PRECONDITIONS`, in the same sweep, was kept but un-exported. It is
an alias of the one real table, and an *exported* alias reads like a second
precondition table to the next person — which is precisely D3, the defect this
milestone has already had to fix once.
