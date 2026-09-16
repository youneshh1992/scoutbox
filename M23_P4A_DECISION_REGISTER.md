# M23 P4A — Decision Register

Every architectural decision for the Trial workflow, with the alternatives
that were considered and the reason they lost. The twenty required decisions
(§135) are D-1 … D-20; the rest are the decisions the audit forced.

Format per entry: decision · alternatives considered · reason · existing
system reused · risk · future consequence.

---

### D-1 — What is the canonical Trial object?

**Decision:** `db.trials`, extended additively. A trial row keeps today's
meaning — *an accepted trial* — and its two-valued `status` (the report
obligation). The operational truth moves into new fields on the same row:
`caseId`, `workflowState`, `schedule`, `attendance[]`, `completion`,
`evidence[]`, `keys`, `rev`, `history[]`.
**Alternatives:** (a) a new `recruitmentTrials` store beside `db.trials`;
(b) widen `db.trials.status` to a scheduling vocabulary; (c) put the Trial
on the case (`case.trial`).
**Reason:** (a) creates a competing concept for the eleven readers that
already join on `db.trials` (Passport, Rooms, M18, M20, M21, journey); (b)
breaks the `REPORTS_OUTSTANDING` gate, `trialStateFor`, the Passport summary
and the Second Look producer, exactly as `M23_REUSE_AUDIT.md` B4 warned; (c)
makes the case carry fine-grained truth, which §8 forbids.
**Reused:** `db.trials`, the migration registry (additive step, 2304), the
store contract (no change).
**Risk:** old rows lack the new fields; handled by the legacy interpretation
rule (reuse audit C9), never by backfilled facts.
**Consequence:** P4B-1 is a migration + one writer, not a new subsystem.

### D-2 — Is a separate Trial session model needed?

**Decision:** No separate store. Trial sessions are an **embedded, bounded
array** on the trial: `trial.schedule.sessions[]`, each
`{ id, kind, startsAt, endsAt, timezone (inherits), venueRef, arrival, notes, evidence[] }`,
≤ 20 per trial.
**Alternatives:** a `trialSessions` store; reusing Box Cam sessions as Trial
sessions; reusing Development Hub actions.
**Reason:** the snapshot store has no query planner and sessions are only
ever read with their trial; a separate store adds a join with no query it
would serve. Box Cam session ≠ Trial session (§34): only some Trial sessions
have Box Cam evidence, and a Box Cam session is the player's record. Dev Hub
actions are player-development-shaped and player-visible.
**Reused:** `trial.day` for staff, consents, arrival, emergency, check-ins
(unchanged; a Trial session references `day` check-ins by time window).
**Risk:** a very long trial (weeks of sessions) hits the bound; the bound is a
product statement, not a technical one, and is raised by a decision, not by
accident.
**Consequence:** no new store contract entry; the perf model stays "one
scan of `db.trials`".

### D-3 — What proves `trial_requested`?

**Decision:** An **authorised invitation that was actually delivered**: a
`db.requests` row of `type: 'trial'` for this org, this player and this case
(`caseId` on the request), issued through `issueRecruitmentRequest`, with
`status ∈ { pending, accepted }`. A declined or suspended invitation does not
prove it; nothing internal (a draft, a room task, `planTrial` alone) proves
it. Mirrors Contact: the recipient-visible object is the evidence.
**Alternatives:** `planTrial` with no evidence (today); a Trial row.
**Reason:** `trial_requested` says a trial was asked for. Today the action
has no precondition, so a case can say "trial requested" with nobody asked.
A Trial row cannot be the evidence because rows are created at acceptance
(D-1), which is later.
**Reused:** the request writer, `STATUS_EVIDENCE_REQUIRED` keyed by target
(add `trial_requested: { kind: 'trial_invited' }`), the evidence provider.
**Risk:** this **widens the evidence table by one entry** — not the lifecycle
(no new status, no new edge). Recorded as the one P2-table change P4B makes.
**Consequence:** `planTrial` becomes evidence-gated; the club sends the
invitation from the Room and the case advances through the canonical writer
when the request is issued (the same `advanceCase` pattern as Contact).

### D-4 — What proves `trial_scheduled`?

**Decision:** A Trial row (so: accepted by the routed recipient) whose
`schedule.confirmedAt` is set, with **at least one concrete session**
(`startsAt` a valid UTC instant in the future at confirmation, `timezone`
present, `venueRef` present), and `workflowState === 'scheduled'`. Acceptance
alone is not scheduling (§73).
**Alternatives:** acceptance = scheduled (today's implicit meaning);
club-side "mark scheduled" with no session.
**Reason:** an accepted invitation with "date TBC" is not a scheduled trial;
a club claiming a schedule with no time is not either.
**Reused:** `confirmTrial` action, evidence kind `trial_confirmed` (renamed in
meaning only: it now reads "trial confirmed with a concrete schedule").
**Risk:** an invitation that carried a concrete date and was accepted is both
accepted and schedulable in one step; the writer sets `confirmedAt` at
acceptance when the accepted slot is concrete, so the common case is one
transition, not two.
**Consequence:** rescheduling after confirmation clears `confirmedAt` until
the recipient re-confirms (D-8); the case stays at `trial_scheduled` (a case
does not move backwards because a date changed — §4 of the Contact contract
applied to Trial).

### D-5 — What proves `trial_completed`?

**Decision:** `completion.state === 'completed'`, which the organiser may set
only when: the trial is `scheduled`, **at least one session has attendance
recorded as `attended` or `partial`**, the last scheduled session's `endsAt`
has passed, and the trial is not cancelled. Assessment is **not** required
(§22): a completed trial with no assessment is the "Trial completed but no
evaluation recorded" condition (D-24).
**Alternatives:** completion on report filed (today's `reported`); completion
on last session end (automatic); completion on assessment.
**Reason:** `reported` can be true of a trial that never happened; automatic
completion would assert attendance nobody recorded; assessment is judgement,
not operation.
**Reused:** `completeTrial` action, evidence kind `trial_completed`, the
single writer.
**Risk:** clubs forget to complete; the M12 sweep gets a persisted
"completion pending" reminder marker (§68).
**Consequence:** `decisionPending` (derived) keeps its meaning:
`trial_completed` with no current decision.

### D-6 — Who receives a minor's Trial invitation?

**Decision:** The guardian returned by the P3 resolver
(`resolveContactRecipient`, renamed `resolveRecipient` in P4B-2 without
changing its rules): exactly one verified guardian (`idVerified`,
`disclaimerAccepted`, lists the child, not removed); several → the player's
designated guardian; none → **fail closed** (`TRIAL_GUARDIAN_REQUIRED`).
Agencies and unverified clubs never reach the resolver for a minor
(`visibleToOrg`). The minor sees the existing guardian-managed outcome item
only.
**Alternatives:** the legacy `routedTo: minor ? 'guardian' : 'player'` with
an unverified `player.guardianId`.
**Reason:** the legacy rule has no verification and no fail-closed branch;
P3 already replaced it for Contact and the two rules must not diverge.
**Reused:** `resolveContactRecipient`, `issueRecruitmentRequest`'s
`guardianId` override, `guardianManagedOnly`.
**Risk:** none new. **Consequence:** the open-day invite path (P4A-D11) must
adopt the same resolver.

### D-7 — What happens when guardian state changes?

**Decision:** The recipient is re-derived at every mutation. Before
acceptance: invalid guardian → the invitation cannot be sent (or, if pending,
cannot be accepted: `TRIAL_GUARDIAN_REQUIRED` on accept). After acceptance:
schedule confirmation and every reschedule require a valid recipient; if
none exists the club may **only cancel** (with the operational notice) and
the Trial records `blockedBy: 'guardian_unavailable'`. **Aging into
adulthood** between invitation and attendance: the player becomes the
recipient of subsequent steps; earlier guardian acts stay in history with the
recipient snapshot they were made under; no re-acceptance is demanded of the
player for a trial the guardian already accepted, but any *new* schedule
revision is confirmed by the now-adult player. **Club verification loss**
after invitation: the Trial cannot be scheduled/rescheduled/linked; cancel
only; the family is notified of the cancellation through the existing
`trial_day` notification. **Block after invitation**: D-16.
**Alternatives:** freeze the recipient at invitation.
**Reason:** a frozen recipient lets a revoked guardian keep receiving a
child's schedule.
**Reused:** resolver, `visibleToOrg`, `safeguardingCertified`.
**Risk:** a legitimate trial stalls because a guardian's ID review lapsed;
that is the correct failure mode.

### D-8 — How is Trial attendance represented?

**Decision:** Per session, on the trial:
`attendance[] = { sessionId, state ∈ { attended, partial, no_show, club_cancelled, player_withdrew }, source ∈ { checkin, manual }, recordedBy, recordedAt, note? }`.
A `day.checkins[]` entry inside the session's window is the strongest
source (`checkin`); a `manual` record is allowed for sessions without
check-in but is labelled as such. Attendance is **never a judgement** and
never feeds Trust, Matching or any score. Reschedule (D-9) is separate from
attendance.
**Alternatives:** attendance on the trial as a whole; inferring attendance
from Box Cam.
**Reason:** a three-session trial attended once is a fact about sessions;
Box Cam presence is presence in front of a camera, not attendance at an
event.
**Reused:** `day.checkins`, `player.attendance` (a check-in still writes the
coach-signed attendance row as today).

### D-9 — Which assessment system owns Trial assessment?

**Decision:** `db.assessments` (M12 F2), with an optional
`context.trialId` (+ `context.trialSessionId`) and evidence refs extended to
`{ kind: 'box_cam_session', id }` / `{ kind: 'trial_session', id }` beside
the existing `segmentId`. Everything else is inherited: templates, 1–5 or
`notObserved`, confidence, blind-until-submitted, second opinions, per-attribute
compare, immutability, `publishedFeedback` as the only door to the player.
The legacy **trial performance report** (`trial.report`, six mandatory
numbers, `coachRating`) stays exactly as it is — the M12 player-feedback
obligation — and is **not** extended; P4B does not build a third judgement
record.
**Alternatives:** `trialReviews`; extending `trial.report` into the
assessment; retiring the legacy report.
**Reason:** §24; the assessment system already has every property the Trial
needs; the legacy report is a player guarantee ("the player always gets
something back") read by the Passport and the CV, and retiring it is a
product decision outside P4B.
**Risk:** two records with the word "rating" (the 1–10 `coachRating` and the
1–5 attribute ratings). Terminology note: the legacy report is a *feedback
report*; the assessment is the *scouting assessment*; the Trial UI labels
them so.

### D-10 — Can multiple assessors exist?

**Decision:** Yes, independently, exactly as today: any org user with
`trial_assess` (contributor+) may author their own assessment in the Trial
context; they see others' only after submitting their own (blind rule); the
compare view keeps every scout's cell and refuses cross-version averages.
**No aggregate Trial score; disagreement is preserved** (§56–§57). The
recruitment decision is a separate human act (D-22).
**Reused:** `assessmentAccessList`, `assessment-compare`, `secondOpinionOf`.

### D-11 — How does Box Cam link to a Trial?

**Decision:** **Trial → session references**: `trial.schedule.sessions[].evidence[] = { kind: 'box_cam_session', id, linkedBy, linkedAt, keys }`.
Nothing is written on the Box Cam session. Link authorisation (necessary
change N2): same `playerId`, `finalizedAt`, not cancelled/invalidated, not
test-only in production, `orgCanSee`, and the player's recruitment opt-in or
an active request from this org (the Combine consent rule). Provenance is
read live from the source at projection time (N3/N5).
**Alternatives:** `trialId` on `db.boxSessions`; a link table; arrays on both
sides.
**Reason:** §30 — the session is the player's; the club's workflow id does
not belong on it; two-sided arrays drift.
**Risk:** a link to a session later invalidated by T&S: the link row stays,
the projection says `evidence_withdrawn`.

### D-12 — Can multiple Box Cam sessions link to one Trial?

**Decision:** Yes — many per Trial session and many Trial sessions per
Trial. Each link is idempotent on `(trialSessionId, sessionId)`; linking the
same session twice is a replay, not a second row.

### D-13 — Can a Trial exist with no Box Cam?

**Decision:** Yes. Box Cam is an optional evidence source; nothing in the
schedule, attendance, completion, assessment or lifecycle gates reads it.
`evidence[]` empty is a normal Trial.

### D-14 — Does Trial evidence enter the Passport automatically?

**Decision:** **Option C for observations** — referenced, not promoted. A
Trial-linked Box Cam session is projected by the Passport exactly as any
other session of that player (existing `box_session_completed`, `private`);
the Trial link adds no Passport event. **Trial participation** keeps the
existing `trial_attended` event but P4B keys it on **recorded attendance**
(any `attended`/`partial` session), not on acceptance; legacy rows keep their
current meaning under a `legacy` flag. `trial_outcome` (the legacy report)
is unchanged. **Assessments never travel** beyond their existing
existence-only event and `publishedFeedback`.
**Alternatives:** A (auto-eligible with provenance "captured during Trial at
Club X"); B (explicit publish).
**Reason:** the Passport is a projection over the player's own records; a
club-linked observation is still the player's session and already appears
under the player's own rules. Adding a Trial-flavoured event would let a
club's workflow decorate a player's Passport. Option A's provenance line is
recorded as **possible later** (§114) behind an explicit player/guardian
selection, which the existing `publicSelections` mechanism can carry.

### D-15 — Who can see Trial Box Cam observations?

**Decision:** The player (own session, always); the guardian of a minor;
the **linking club** through the Trial evidence projection while the consent
rule holds (`orgCanSee` ∧ (opt-in ∨ active request)); T&S (diagnostics
route, `rawFrameViewer: null`). **Not** other clubs, not Passport viewers
beyond the existing session projection, not the public. Consent for
club-created Trial footage is **flagged for professional legal review**
(§43): the existing event consent covers attendance; the Combine opt-in
covers club access to observations; whether a Trial-specific acknowledgement
is needed for a minor is a legal question P4A does not answer and P4B must
not assume.

### D-16 — Who can see human Trial assessment, and what may a blocked club still do?

**Decision (visibility):** the authoring scout, leads, and other submitted
assessors of the same org (blind rule); T&S on request; **never** the player,
guardian, minor, other clubs or the Passport, except `publishedFeedback`
through the existing single door.
**Decision (block policy, §103–§104, documented not implemented):**
- before invitation: cannot invite (existing `BLOCKED` on request).
- pending invitation: recipient may decline only (existing rule); the
  invitation is shown as withdrawn to the club; no reminder is sent.
- accepted/scheduled: the club may **cancel** (an operational safety notice
  delivered through `trial_day`, which is not solicitation), may **not**
  reschedule, add arrival/staff, link evidence or assess; the family's
  restricted data is withheld (P4A-D9, fixed); the mandatory report may still
  be filed to close the club's obligation but its player notification is
  suppressed while the block stands.
- after partial attendance: as scheduled.
**Reason:** a block must never strand a minor with an unannounced trial
(cancellation is safety), and must never become a channel for renewed
recruitment (everything else is refused).

### D-17 — What happens when Box Cam refuses?

**Decision:** The Trial evidence projection shows the refusal state with the
existing player-facing copy (`m22/policy.mjs:286-297`) under the heading
"no reliable observation available"; the session still links (it happened);
no attendance, completion or assessment field is derived from it; absence of
observation is never displayed as, sorted as, or counted as performance
(§47–§48). Confidence is not rendered; verification state is.

### D-18 — What is safe to show in the recruitment journey?

**Decision:** Club viewers: milestones `trial_invited`, `trial_accepted`
/`trial_declined`, `trial_scheduled`, `trial_rescheduled`,
`trial_attendance_recorded` (per session, state only),
`trial_completed`/`trial_cancelled`, `trial_assessment_recorded`
(existence, assessor **role**, never content), `trial_evidence_linked`
(count). Player/guardian viewers: their own invitation, the confirmed
schedule (sessions, venue after acceptance), attendance as recorded,
cancellation — never `caseId`, never an assessment, never internal phases.
T&S: ids and states.

### D-19 — What belongs in P4B vs a later Box Cam milestone?

**Decision:** `M23_P4A_BOXCAM_CHANGE_CLASSIFICATION.md`: necessary N1–N6
(link by reference, link authorisation, safe projection, refusal semantics,
immutable provenance, session `kind` on the Trial); optional O1–O6; Box Cam
2.0 F1–F9 (multi-player tracking, pose, tactics, clips, live, new
models/protocols/platforms, Combine Verified, ratings, real-world
validation). P4B depends on nothing blocked by real-world validation.

### D-20 — What DB/schema changes will P4B require?

**Decision:** one additive migration (`m230_005_trial_workflow`, schema
2304) that adds neutral containers to `db.trials` rows (`workflowState:
'legacy_accepted'` when absent, `schedule: null`, `attendance: []`,
`completion: null`, `evidence: []`, `keys: {}`, `rev: 1`, `history: []`,
`caseId: null`); an optional `context.trialId` on `db.assessments` (no
migration; absent = not a Trial assessment); `caseId`/`trialId` on new
request rows (optional); no new store; no index (D-25). Deletion cascade
(D-26): trials are tombstoned to ids (`playerId` kept, `playerName` removed,
`day.emergency` removed, `report` notes removed), never deleted while a case
references them; the case history stays. Full table in the architecture doc
§12.

---

## Further decisions the audit forced

### D-21 — Timezone truth
UTC instants (`startsAt`, `endsAt` ms) + the organiser's IANA `timezone` on
the schedule (defaulting from the venue's country when known, else required
input). Clients display in the organiser zone with an explicit label and may
additionally show the device-local time, labelled. Recipient timezone is not
stored (players carry no timezone today); no browser-local timestamp is ever
persisted. Legacy `proposedDate` rows are date-only and shown as such.

### D-22 — Trial assessment ≠ recruitment decision
No assessment writes a decision; decisions stay in `db.roomDecisions` with
their reason taxonomy (`trial_outcome` already exists). `decision_pending`
stays derived (§77). Offer begins at the `trial_completed →
offer_consideration` edge and is not designed here (§79).

### D-23 — Location privacy
The invitation carries venue **name and town** only. Exact address, arrival
instructions and the contact person are shared with the routed recipient
after acceptance (they live in `day.arrival` and `schedule.sessions[].venueRef`),
for minors to the guardian only, never in search, profile, analytics or
export. Staff names shown to the family are the trial-day safety staff, as
today; scouts' personal contact details are never exposed (§70).

### D-24 — Trial completed with no evaluation (§60)
P4B does not modify M18. Recommendation for a later M18 pass: the Nobody
Missed `trial` signal should read `completion.state === 'completed'` rather
than "any row", and Second Look's `trial_completed` change should fire on
completion, with `assessment_submitted` remaining separate — so "completed
but not evaluated" becomes visible without a rating.

### D-25 — Indexes
None. Access patterns are trial-by-org (list), trial-by-case (journey,
evidence), trial-by-player (Passport), all single scans of `db.trials` with
the filter in the scan, as Contact measured. Sessions and evidence are
embedded. Re-measure in P4B-9 with 500 trials × 5 sessions; add an index
only if the journey's per-request cost grows with the store measurably.

### D-26 — Deletion, revocation, historical honesty (§46)
Player account removed: the trial is tombstoned (ids kept, names, notes,
emergency contact and report text removed; `attendance` states kept), the
case keeps its history and status, the evidence provider answers from the
tombstone so a `trial_completed` case stays honest. Guardian revoked: the
recipient re-derives (D-7). Club loses access (verification revoked or
block): reads of the family's restricted data stop; history stays. Box Cam
session invalidated: link stays, projection says withdrawn. Evidence never
re-appears by repair.

### D-27 — Reminders and calendar
Reminders (T-48h, T-24h, completion pending, assessment pending) are
persisted markers on the trial examined by the existing M12 sweep. Calendar
stays internal: a timezone-aware ICS export replaces the date-only one; no
external calendar integration.

### D-28 — Checklist
Operational checklist items (registration, schedule, attendance, assessment
outstanding) are **Room tasks** with `linkedResource: { type: 'trial', id }`
— staff-only, never sent to the player. Development Hub is not repurposed.

### D-29 — Analytics
Process metrics only: invitations sent, accepted, scheduled, completed,
completion rate, assessment-outstanding count, scheduling delay
(distribution); `SMALL_N_MIN = 5` unchanged; counts never suppressed. No
ability ranking, ever.

### D-30 — Terminology (§80)
- **invited / accepted / declined**: states of the invitation (request).
- **scheduled / rescheduled / cancelled / completed**: states of the Trial.
- **attended / partial / no-show**: states of a session's attendance.
- **feedback report**: the legacy mandatory `trial.report`.
- **scouting assessment**: `db.assessments` in Trial context.
- **recommendation**: the assessment's `recommendation` (sign/monitor/pass)
  — an opinion.
- **decision**: `db.roomDecisions` — the recruitment act.
- **outcome**: reserved for M12 outcome reports and signings (confirmed
  outcome); never used for a Trial state.
`M23_TERMINOLOGY.md` is extended with these in P4B-8.
