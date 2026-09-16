# M23 P4A — Trial Privacy Matrix

Who may see which Trial data, decided before the data exists. Rows are data
types; columns are viewers. Cells: **full** · **partial** (what is listed) ·
**existence** (that a record exists, no content) · **—** (nothing, and no
error that reveals existence).

Viewer definitions follow the platform's existing ones: *club lead* =
`recruitment_admin` / `room_lead` of the organisation that owns the Trial;
*scout* = contributor in that Room; *viewer* = room viewer (restricted rooms
exclude unassigned staff entirely); *player* = the adult subject; *guardian*
= the verified guardian of a minor subject; *minor* = the under-age subject
on their own device; *other club* = any other organisation, whether or not
the player later appears in Discover; *T&S* = Trust & Safety.

The governing rules, all existing: a case is undetectable to its subject
(`m23/journey.mjs:137-160`); blocks and visibility walls are evaluated on
every read; the Passport only narrows; club-private judgement never travels
without an explicit publish (`m12/scouting.mjs:238-239`).

| data | club lead | scout | viewer | player (adult) | guardian | minor | other club | T&S |
|---|---|---|---|---|---|---|---|---|
| Invitation (request: org, named scout + role, message, venue name/town, proposed slots) | full | full | full | full (own) | full (child's) | outcome line only ("guardian-managed") | — | full |
| Case id, lifecycle status, room, decisions | full | full | full | — | — | — | — | states + ids |
| Confirmed schedule: sessions (kind, start/end, timezone) | full | full | full | full after acceptance | full after acceptance | — (existing guardian-managed item: date only if the guardian shares it in the family view) | — | full |
| Venue exact address, arrival instructions, collection policy | full | full | full | after acceptance | after acceptance | — | — | full |
| Named contact person for the day (safety staff name + role; never personal phone/email of scouts) | full | full | full | after acceptance (safety pack) | after acceptance (safety pack) | — | — | full |
| Family emergency contact (`day.emergency`) | day view only, **withheld while blocked** (P4A-D9) | day view only, same | day view only, same | own (set) | own (set) | — | — | full |
| Staff safeguarding checks (kind, status, expiry) | full | full | full | status only (safety pack: reviewed / not) | status only | — | — | full |
| Event consent records | full | full | full | own | own | — | — | full |
| Attendance per session (state, source, recorded by) | full | full | full | own states | own child's states | outcome line only | — | full |
| Reschedule / cancellation history (append-only) | full | full | full | own trial's (dates, reasons as written for the family) | same | outcome line only | — | full |
| Trial completion state | full | full | full | own ("completed" / "cancelled") | same | outcome line only | — | full |
| Box Cam session metadata (drill/protocol, capturedAt, verification state, simulated flag) linked to the Trial | while the consent rule holds: partial (projection) | same | same | full (own session, always) | full (child's) | full (own session, child device) | — | full (diagnostics) |
| Box Cam observations (accepted/refused state, quality band, experimental count behind disclosure) | while the consent rule holds: partial, never numeric confidence, never `trace[]`, never `nonce` | same | same | full (own, as the player app shows it) | full (child's) | full (own) | — | full (structured; `rawFrameViewer: null`) |
| Box Cam raw frames / video | — (none exist) | — | — | — | — | — | — | — (none exist) |
| Human Trial assessment (ratings, notes, recommendation, reviewer note) | full (all assessors') | own, and others' after submitting own (blind rule) | — | — | — | — | — (M13 group grant excepted, existing) | on request (existence, assessor role; content only for a T&S case) |
| Published feedback (`publishedFeedback`) | full | full | full | full (own) | full (child's) | existence + count (existing rule) | — | full |
| Legacy feedback report (`trial.report`: six numbers, strength/focus notes) | full | full | full | full (`/player/cv`, existing) | full | existence | — | full |
| Room tasks (Trial checklist) | full | full | own/assigned | — | — | — | — | ids and states |
| Internal notes (room comments, decision notes, assessment notes) | full | full (comments) | comments | — | — | — | — | ids only (`hadNote`) |
| Recruitment decision + reason codes | full | full | full | — | — | — | — | ids and states |
| Final shared outcome (signing, offer — P4+; today: `trial_outcome` event) | full | full | full | own Passport, per M15 visibility | same | — | via Passport only where public/selected | full |
| Journey milestones (`trial_invited … trial_assessment_recorded`) | full | full | full | own shared records only (`sharedRecordsFor`) | same | — | — | states + ids |
| Analytics (counts, completion rate, delays) | org aggregates, small-n suppressed | leads only (existing M20 RBAC) | — | — | — | — | — | platform aggregates |
| Audit log rows (`recruitment_trial`) | leads only | — | — | — | — | — | — | full |

## Minor data (§112)

- A minor's own device shows the guardian-managed outcome line and, once
  scheduled and shared by the guardian, the family view of the trial day
  (existing `familyTrials` for the child's id): date, venue name, safety
  staff names, checks explained, `emergencySet` boolean. Never the club's
  assessment, never observations the guardian has not opened, never the
  invitation message.
- Nothing club-private (assessment, notes, decision) becomes guardian- or
  minor-visible automatically. The single door remains `publishedFeedback`.
- External channels for a minor are routed to the guardian record by the
  delivery centre (`m13/delivery.mjs:43-47`); Trial notifications inherit it.

## Future club visibility (§113)

Another club sees **nothing** of a Trial from a different club: not its
existence, its schedule, its attendance, its evidence links or its
assessments. If the player later appears in Discover, the other club sees the
Passport under M15 rules — which contain no other club's assessment and only
the trial events the player's own visibility level permits (`trial_attended`
is `recruitment_own_org`, so it is visible only to the club that ran it
unless the player selects it for public display).

## Evidence portability (§114)

If a Trial-linked observation ever becomes a Passport item beyond the
player's own session projection (D-14 leaves this to an explicit
player/guardian selection), its provenance may say "captured during a trial
at Club X"; the club's assessment, notes and decision never travel with it.

## Concealment invariants P4B must keep

1. A player or guardian asking about a Trial they were not invited to gets
   the same 404 as for one that never existed.
2. A foreign organisation gets the same 404 body for a Trial, its sessions,
   its evidence and its assessments as for an unknown id.
3. No timing, rate-limit or error-code difference distinguishes "hidden"
   from "absent" (the P3 sentinel and parity checks are repeated for Trial
   in test groups J and O).
4. `requestForRecipient` continues to strip `orgId`, `userId`, `contactId`
   and gains `caseId`, `trialId` (the recipient sees the trial through the
   family view, never the club's ids).
