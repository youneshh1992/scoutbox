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
