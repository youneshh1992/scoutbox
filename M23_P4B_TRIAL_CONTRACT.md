# M23 P4B — The Trial Contract (as built)

This is the canonical behaviour of a Trial in ScoutBox from P4B onward. It
supersedes the P4A architecture documents for anything they left open and
keeps them in place as the record of what was decided before the build
(`M23_P4A_DECISION_REGISTER.md` D-1 … D-30, `M23_P4A_FINAL_ARCHITECTURE.md`,
`M23_P4A_TRIAL_PRIVACY_MATRIX.md`). Where the build departed from the P4A
test plan, §0 says so.

The governing rule: **the recruitment lifecycle describes what has actually
happened**, and a Trial is a chain of distinct facts —

> invitation ≠ accepted ≠ scheduled ≠ attended ≠ completed ≠ assessment ≠ decision

— each recorded by the person or system entitled to record it, none derived
from another.

---

## 0. Chronology — what the build fixed that P4A left open

| P4A said | P4B built | why |
|---|---|---|
| Test plan D1: cancel before acceptance may need a `withdrawn` request status — "decide in P4B-2" | **No new request status.** A pending invitation is answered by the recipient (accepted / declined) or stays pending; the club cannot withdraw it through the Trial routes. | A new request status is a contract change for every Inbox reader; the plan itself said to refuse it unless the audit demanded it, and it did not. |
| Test plan F1: `409 TRIAL_COMPLETION_REQUIRES_ATTENDANCE` | `409 TRIAL_COMPLETION_REQUIREMENTS_NOT_MET` with `reasons[]` | One code, several reasons; the UI shows the list. |
| Test plan H3: "test-only provider in production mode → refused" | `404 TRIAL_BOXCAM_INCOMPATIBLE` (same body as unknown) | A session the club could never see is indistinguishable from one that does not exist. |
| Test plan B6: aging between acceptance and reschedule | Handled by re-derivation on every action (`recipientTrial`, `reauth`, `trialAcceptGate`): a player who became an adult is told the trial is theirs, the guardian is told the player now manages it. **Not exercised by a dedicated clock-stepped birthday check**; the M group proves the re-derivation mechanism through guardian-route loss and restoration (M6, M7, M14, M14b). | Recorded honestly; a birthday check is cheap to add if a later milestone needs it. |
| Test plan K1: contributor "can assess, cannot schedule" | `trial_view` = viewer and above; `trial_assess` = contributor and above; `trial_write` = room lead and above; mirrored in `roomCan`. | Confirmed. |
| D-21 timezone truth: exact IANA | Exact IANA, plus four modern names ICU still reports under legacy aliases (D-P4B-1). | A real city is not an invalid zone. |
| D-8 material change | The organiser zone, the session count, a session's start or end, its venue name or town are material; `kind`, `instructions` and the venue address line alone are not. | The family confirms *where and when*; a label, a note or a corrected street line is not a change of plan. |
| Acceptance of a concrete slot | The trial is created already `scheduled` and **confirmed** (revision 1 = the chosen slot). | The recipient chose the day and the time; asking them to confirm it again is theatre. |
| Seed names | The Eastport scout is **Tom Field** (the plan wrote Tom Reilly). | The seed is the truth. |

Everything below restates the contract as it now stands.

## 1. What a Trial is, and what it is not

A Trial row exists **only after** a player or guardian accepts a trial
invitation. An invitation is a request; a draft, a room task and the
`planTrial` action are not even that. A Trial has an operational state —
`legacy_accepted | accepted | scheduled | completed | cancelled` — that is
derived from its own fields and is never a case status. The case statuses
`trial_requested`, `trial_scheduled` and `trial_completed` are *proved by*
the invitation, the confirmed schedule and the completion respectively;
`trial_in_progress` is not a status.

## 2. The state model

```
                    invitation (db.requests, type trial)
                       │ accepted by the routed recipient
                       ▼
        ┌──────── accepted ────────┐        (no confirmed revision)
        │  propose ──► scheduled   │        (a CONFIRMED revision, ≥1 session)
        │        ◄── decline       │
        │  material revision clears confirmation; cosmetic keeps it
        │                          │
        │  attendance recorded on a started session (append-only)
        │                          │
        ▼                          ▼
    cancelled ◄────────────── completed
  (club, player, guardian;    (club only; gate: confirmed, ≥1 attended/partial,
   any phase; case unchanged)  last session ended; case → trial_completed)
```

`legacy_accepted` is a pre-P4B row with nothing recorded; it enters the
diagram at `accepted` the moment a schedule is proposed. `completed` and
`cancelled` are final; a report (`status: reported`) is a separate obligation
that survives both and is not completion.

## 3. Who receives, and who may act

- The recipient is **derived now, every time**, from the live player,
  organisation, guardian records and clock — never trusted from a client, a
  stored snapshot or an earlier step. Adult → the player. Minor → the
  verified, non-removed, designated guardian. No valid route → the action is
  refused, nothing is written, the child is never contacted.
- The child's own device sees a five-field outcome line and can do nothing.
- Agencies never reach minors; unverified clubs never reach minors.
- Club roles: viewer reads; contributor reads and may assess in Trial
  context; room lead and recruitment lead do everything else. The role is
  derived from the room's membership on every request, not from the token
  (W4, W5 prove the gate; a demotion mid-flow is not a dedicated check).
- A family that blocked the club: every club action is refused except
  **cancel**, which is a safety notice; the recipient can still cancel (the
  decline path) and cannot confirm a schedule with an organisation they
  blocked; the mandatory report may still be filed and does not notify them.
- A player who removed their account: the trial stays on record as ids,
  states and times, read-only for everyone; the audit stops naming them.

## 4. What the family sees, and when

| surface | before acceptance | after acceptance |
|---|---|---|
| day, times (organiser zone), venue **name and town**, message, who invited | yes | yes |
| exact address, arrival instructions | **never** | yes |
| schedule revisions, whether their confirmation is awaited | — | yes |
| completion state and the club's reason for a cancellation | — | yes |
| attendance notes, evidence links, assessments, the club's user ids, case id, club history | never | never |

The child of a guardian-managed trial sees none of the rows above except the
organisation and the state.

## 5. Scheduling

- A schedule is a **revision**: timezone + 1–20 sessions (15 min – 12 h,
  non-overlapping, distinct stable ids). Prior revisions are retained
  verbatim with `supersededAt`.
- A revision that changes *where or when* (zone, times, session count,
  venue name or town) asks the recipient again; one that changes only the
  kind, the instructions or the address line keeps their confirmation.
- A session that has ended, or has attendance recorded, is history: a
  revision must carry it unchanged or the revision is refused. The only
  way out of a session that will not happen is to cancel the trial.
- At most 30 revisions.
- The recipient's decline returns the trial to `accepted` with the declined
  revision on record; the club proposes again or cancels.

## 6. Attendance

Attendance is *what happened*: `attended | partial | no_show |
club_cancelled | player_withdrew`, per session, append-only, recorded once
the session has started, by the club (manual) or by the existing trial-day
check-in. `not_recorded` is derived. A club-private note may accompany it
and reaches nobody else. Attendance is never a judgement, never a score
input, never read by Trust, Matching or Watchlists.

## 7. Completion and cancellation

- Completion is **explicit** and gated: confirmed schedule, at least one
  attended or partial session, last session ended. It moves the case to
  `trial_completed` through the single lifecycle writer in the same save.
  It is not a report, not an assessment, not a decision; a completed trial
  with no assessment is valid.
- Cancellation records who cancelled (`club | player | guardian`), in what
  phase, with what reason (mandatory from the club, optional from the
  family) and how many sessions had been attended. The case does not move.
  Cancelling twice replays.

## 8. Box Cam evidence

- A link is a **reference** to a finalised Box Cam session of the same
  player that the club may see under the Combine consent rule, evaluated at
  the moment of linking. A trial is not consent to the player's footage.
- The club learns three things about a session it may see: not final,
  withdrawn, already cited. Everything else — wrong player, unknown id,
  test-only provider — is one `404`.
- The projection carries provenance (`box_cam_observed`), the verification
  state, `simulated`, and an observation **state** with policy copy. A CV
  refusal is "No reliable observation available", never poor performance
  (D-17). `combineVerified` is `false` with the platform reason until the
  platform says otherwise. Never a trace, a nonce, frames or a confidence
  number.
- Linking writes nothing to the Box Cam session, adds no Passport event
  and is read by nothing in Trust. Unlinking tombstones; consent withdrawn
  after linking leaves the rows as history and refuses new links.

## 9. Assessment

An assessment in Trial context is the same `db.assessments` object, behind
the same blind rule and the same single publication door
(`publishedFeedback`). Its Trial context is set at creation and immutable;
its evidence references may cite a trial session or a linked Box Cam
session and nothing else. The trial lists that an assessment *exists*, by
whom, in what state — never its content. No aggregate number exists
anywhere. An assessment never moves the case; a decision does, separately.

## 10. Concurrency, idempotency, atomicity

- `expectedRev` is required on every club mutation; it is an integer or it
  is refused, never coerced. Stale → `409 TRIAL_VERSION_CONFLICT` with the
  current state.
- A `clientKey` binds an action to a payload fingerprint: same key + same
  payload replays with no second effect; same key + different payload is
  refused. Keys are per action and per case.
- Every write is one save. Where the transport refuses (failure injection
  channel `trial`), nothing is written: no row, no case move, no
  notification.

## 11. Rate policies

`trial_invite` 30/h per org; `trial_schedule` 60/h per org (propose, revise,
cancel); `trial_attendance` 120/h per org (attendance, completion);
`trial_evidence_link` 60/h per org; `trial_response` 30/h per recipient.
Plus the deterministic invitation cooldown after a decline (`retryAt`
given). Per-organisation counters never touch another organisation's.

## 12. Errors

One band per code, no default (`m23/errors.mjs`). Refusal before
persistence, always with a code; the 404 band conceals; the 409 band names
`current`; the 422 band is "well-formed, permitted, possible — and the world
says no" (no recipient, no guardian route).

## 13. Events, audit, journey, analytics

Events are org-private ids. The audit log carries the operational record
(`recruitment_trial`) with ids, states, counts and flags only. The journey
shows milestones and counts. Analytics counts the process
(`trial_process`: invited / declined / accepted / scheduled / completed /
cancelled, small-n applied) and reads no note, no address and no
observation. Nothing about a Trial is a KPI of the player.

## 14. Historical honesty

Pre-P4B rows are `legacy_accepted` with nothing invented. Corrupt rows are
named in the log, omitted from lists and counted, and answer
`TRIAL_STATE_UNKNOWN` alone; the evidence provider answers *not satisfied*
for a case whose trial cannot be read. A tombstoned trial still proves the
case it proved (D-26). Reminder markers survive a restart and are never
re-sent.

## 15. What Trial must not do — confirmed by test

- Never write a case status directly (only the lifecycle writer).
- Never write a Box Cam session or a CV result.
- Never read an assessment body or produce a number about the player.
- Never contact a minor directly, never trust a recipient from a client.
- Never share an address or instructions before acceptance.
- Never let a note, a reason typed for the club, or an assessment leave the
  organisation.
- Never move a case backwards, and never move it forward on a fact that
  was not recorded.
