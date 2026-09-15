# M23 — Write-Site Audit

A mechanical sweep of every production write that can move a recruitment case,
or that a lifecycle status claims as proof.

The question is not "does the lifecycle route validate?" — it does. The
question is **how many other ways into the same state exist**, and what each of
them checks. A rule enforced on one path and absent on a second is not a rule;
it is a default that happens to hold until someone uses the other door.

Scope: `status`, `stage`, `signed`, `under_contract`, `signings`,
`room.status`, `case.stage`, `recruitmentCases`, `case.history`, `rev` /
`expectedRev`. Test scripts are excluded — they are not production writers.

---

## Summary

```
authoritative lifecycle writers : 1
migration-only writers          : 2
unsafe direct writers           : 0
unvalidated signed writers      : 0
```

Three defects were found and fixed in this pass, all in the same family: a
*derived* field being written by something other than the function that derives
it. Details in §5.

---

## 1. `room.status` — the canonical lifecycle field

One function writes it. Everything else calls that function.

| # | File / function | What it writes | Who can call it | AuthZ | Transition validated | Evidence validated | Rev | Idempotency | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `m17/rooms.mjs:74` `applyStatus()` | `room.status`, `case.stage`, `updatedAt`, `archivedAt`/`closedAt`, `rev` | module-internal only | by caller | by caller | by caller | **bumps** | n/a | **authoritative** |

`applyStatus` is not exported and is not reachable through `ctx`. Its four
call sites are:

| Call site | Entry point | AuthZ | Transition | Evidence | Rev guard |
|---|---|---|---|---|---|
| `:562` room creation | `POST /org/rooms` | org session + `orgCanSee` + open-room uniqueness | n/a — creation | **n/a, and that is now constrained** (§5.3) | sets rev 1 |
| `:686` status move | `POST /org/rooms/:id/status` | `requireCan(set_status)` | `validateTransition` | `STATUS_EVIDENCE_REQUIRED`, **fails closed** | `guardRev` before the write |
| `:760` reopen bridge | `ctx.reopenRoom` → M18 Second Look | room role + `orgCanSee` | `validateTransition` | same gate, fails closed | via `applyStatus` |
| `:789` lifecycle seam | `ctx.applyLifecycleTransition` → M23 `POST /org/rooms/:id/lifecycle` | M23 role policy | `canTransitionRecruitmentCase` | injected provider, fails closed | `guardRev` before the write |

Two lines assign `room.room.status` outside `applyStatus` — `:560` and `:838`,
both inside room **creation**, both on an object that does not yet exist as a
room, and both immediately followed by `applyStatus` on the same line-block.
They choose the starting value; they do not move a live room. Every subsequent
write goes through the single writer.

`ctx.createRoomForPlayer` (`:810`) is the one room creator reachable from
another milestone — M18 Nobody Missed and M19 Dynamic Watchlists both use it,
so neither has its own creation path.

## 2. `case.stage` — a derived field

| # | File / line | What it writes | Verdict |
|---|---|---|---|
| 1 | `m17/rooms.mjs:75` (in `applyStatus`) | the derivation of `room.status` | **authoritative** |
| 2 | `m12/scouting.mjs:387` | initial stage of a **new plain case** (no room facet) | safe — no lifecycle exists yet |
| 3 | `m12/scouting.mjs:472` `POST /org/cases/:id/stage` | legacy stage move | **fixed** — refuses a Room (§5.1) |
| 4 | `m12/scouting.mjs:498` `POST /org/cases/:id/decision` | `'decision'` | **fixed** — skipped on a Room (§5.2) |
| 5 | `m12/scouting.mjs:515` `POST /org/cases/:id/approvals/:aid` | `'decision'` | **fixed** — skipped on a Room (§5.2) |
| 6 | `m17/rooms.mjs:541`, `:824` | `stage: null` in a new case literal | safe — `applyStatus` fills it on the next line |

`PATCH /org/rooms/:id` destructures an explicit allowlist — `priority`, `tags`,
`leadScoutUserId`, `ownerUserId`, `restricted`, `deadline`. It accepts neither
`status` nor `stage`, so an unknown key is discarded rather than applied.

## 3. `db.signings` — the evidence `signed` rests on

| # | File / line | Operation | Entry point |
|---|---|---|---|
| 1 | `server.mjs:2151` | `db.signings.push(signing)` | `POST /org/players/:id/signing` |

**That is the only writer in the repository.** No helper, no seam, no migration
and no lifecycle path creates one.

The direction is enforced by absence, which is the only way it can be enforced:

```
signing truth  →  lifecycle      m23/evidence.mjs reads db.signings
lifecycle      ✗  signing truth  nothing in m17/ or m23/ writes it
```

This matters because a signing is a revenue event. It issues a success-fee
invoice, changes the player's level, writes their timeline, sets
`contractStatus: 'under_contract'` and adds them to a grassroots squad. If a
lifecycle transition could cause one, moving a case on a screen would bill a
club.

`contractStatus` is written at `server.mjs:2178` (signing), `:2372` (release)
and `:2965` (the player's own profile edit, against a fixed allowlist). None is
reachable from a lifecycle route.

## 4. `case.history` and `rev`

**History.** `m17/rooms.mjs:114` `activity()` is the only writer of room
history entries; `m12`'s `audit()` writes the same array with the M12 action
vocabulary (`created`, `stage`, `assigned`, `decision`, `linked`). The two do
not collide: M20's funnel and M23's projector both key on
`room_status_changed`, which only `activity()` ever writes — from three places,
all of them immediately after a completed status move (`:697`, `:797`, and the
reopen pair at `:694`/`:792`).

Nothing rewrites or removes an entry. There is no code path that deletes from
`case.history`.

**Rev.** `bumpRev` has four production call sites: `applyStatus` (`:83`), the
metadata PATCH's workflow fields (`:635`), a recorded decision (`:1121`), and
M19's watchlist (`m19/index.mjs:530`). Migration step 2 sets `rev = 1` on
rooms that predate the field — the only non-`bumpRev` write, and it runs once
against a snapshot, not against a live request.

`guardRev` runs **before** the write on every guarded path, and on the
lifecycle route it runs **after** validation, so a stale rev on an impossible
action reports the impossibility rather than sending the caller away to reload
and retry the same impossible thing.

## 5. Defects found and fixed

### 5.1 A declared bridge that was never wired — `STAGE_NOT_SETTABLE_ON_ROOM`

`ctx.syncRoomStatusFromStage` existed at `m17/rooms.mjs:1295`, documented as
keeping the legacy stage route aligned with the room status. **Nothing called
it.** A repository-wide search returned exactly one hit: its own definition.

So `POST /org/cases/:id/stage` wrote `case.stage` on a case that was also a
Room, while `room.status` stayed where it was. One case, two representations,
disagreeing — with no transition table, no evidence requirement, no history
entry and no rev bump. A concurrent lifecycle caller holding `expectedRev`
would still pass the rev guard, because nothing had moved the token.

The severity is bounded: no stage maps onto `signed`, so the legal boundary was
never crossed. But `m13/planning.mjs:192` reads `c.stage` to decide which
players are in the pipeline, so a Room could be made to vanish from planning
while remaining open.

**It is not fixed by wiring the seam up.** `roomStatusForStage` is the inverse
of a lossy projection — eighteen statuses collapse onto six stages — so
`decision` alone means any of `offer_consideration`, `offer_made`,
`offer_accepted` or `offer_declined`, and a round-trip would move a room at
`offer_made` *backwards*. A lossy inverse cannot be an authoritative write.
That is precisely why authority runs `status → stage` and never back.

Fixed: the legacy route now returns **409 `STAGE_NOT_SETTABLE_ON_ROOM`** when
the case has a Room, naming `POST /org/rooms/:id/lifecycle` in the response. A
plain M12 case has no lifecycle to protect and is untouched. The dead seam is
deleted, and the comment where it stood now records why no bridge belongs
there.

### 5.2 The M12 decision routes wrote the derived stage

`POST /org/cases/:id/decision` and `POST /org/cases/:id/approvals/:aid` both
set `c.stage = 'decision'` directly — the same desync as §5.1, reached from a
different route.

Fixed by guarding both with `if (!c.room)`. The decision is still recorded in
full, for a Room and a plain case alike; only the write to the derived field is
skipped. Refusing the decision would have been the wrong fix: recording it is
the point of the route, and moving the case is not.

### 5.3 Room creation was an inbound edge with no burden

Room creation lands on a status without consulting the transition table or the
evidence gate — correctly, because there is no "from" state to transition from.
But an adopted M12 case inherits its stage, and grassroots `awaiting_response`
maps to **`trial_completed`**, which is evidence-bearing. Opening a Room on such
a case asserted that a trial had been completed. No trial need ever have
existed.

Fixed with `adoptionStatusForStage` (`m17/shared.mjs`): an adoption that would
land on an evidence-bearing status starts at `under_review` instead, and the
original stage is recorded in the `room_created` activity so the club's own
record of where it had got to is not lost.

Stated as a property, not as a special case for `awaiting_response`: no stage
in any vocabulary, present or future, can start a room at a status that asserts
something the records do not prove. The suite checks it that way, over every
stage in both vocabularies.

## 6. Regression coverage

Eleven checks, seven of them negative, in `scripts/m23E2E.mjs` group **W**:

| Check | Asserts |
|---|---|
| W1 | the honest inverse *does* reach an evidence-bearing status — the hazard is real, not hypothetical |
| W2 | but adoption does not start there |
| W3 | **property**: no stage in either vocabulary starts a room at an evidence-bearing status |
| W4 | and every adoption start is a real status, never null or invented |
| W5 | the legacy stage route refuses a Room with `STAGE_NOT_SETTABLE_ON_ROOM` |
| W6 | and names the lifecycle route rather than failing blankly |
| W7 | the refusal left the lifecycle exactly where it was |
| W8 | an M12 decision on a Room is still recorded — disarmed, not broken |
| W9 | but does not write the derived stage behind the lifecycle's back |
| W10 | and moves no rev, because it moved no lifecycle state |
| W11 | a plain case with no Room still moves through the legacy route exactly as before |

W11 is the one that keeps the fix honest: refusing a Room is not a licence to
break the cases that have no lifecycle to protect.

## 7. What this audit did not find

- No path writes `signed` without `confirmed_join` evidence.
- No path creates a `db.signings` row to satisfy a lifecycle transition.
- No path deletes or rewrites a `case.history` entry.
- No path writes `room.status` on a live room outside `applyStatus`.
- No route accepts a `stage` or `status` key that is applied without validation.
