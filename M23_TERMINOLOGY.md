# M23 — Terminology

Words that look interchangeable and are not. Each entry says what the term
means, and — where it matters more — what it does **not** mean.

---

### Recruitment Case

The canonical, club-specific record of one club pursuing one player.
`db.recruitmentCases`, introduced by M12, unchanged by M23.

There is exactly one open case per organisation and player. It is the only
recruitment lifecycle object; nothing else stores a stage.

### Recruitment Room

The club-private collaboration workspace attached to a case — discussion,
tasks, evidence review, decisions. A case **is** a Room when `case.room` is
truthy.

Not a second pipeline. M17 said so when it built it, and M23 kept it that way.

### Lifecycle Status

The current operating position of the case: `case.room.status`. One of
eighteen values, canonical, written by exactly one function.

Not a UI state, not a label, and not a measure of the player.

### Stage (`case.stage`)

The M12 vocabulary — `identified`, `review`, `observation`, `trial`,
`decision`, `closed` for professional clubs; a shorter grassroots set.

**A pure derivation of the lifecycle status.** Authority runs one way:
`status → stage`, never the reverse. On a case that has a Room, the stage is
therefore not writable at all: M12's legacy stage route refuses it and the M12
decision routes skip it. Translating a stage back into a status is not the
safer option — the mapping is lossy in that direction, and a lossy inverse
cannot be authoritative.

A plain M12 case has no lifecycle, so its stage is still its own.

### Recruitment Journey

A **viewer-safe projection** over canonical records, computed on read.

Not a stored object. There is no `db.recruitmentJourneys` and there will not
be one: a second copy of a derivation is a second thing that can be wrong.

### Internal Interest

The fact that a club has opened a case on a player, before anything has been
communicated to them.

**Org-private and undetectable.** A player asking about such a case receives a
byte-identical response to one for a case that never existed. Interest is not
something the subject may infer from a difference in an answer.

### Contact Planned

The club has **decided internally** to approach the player. Nobody has been
contacted.

### Contacted

A real recruitment communication **has actually been initiated**, or a
legitimate external contact has been **recorded** as having happened.

It does **not** mean any of:

- a staff member opened a draft
- a contact object was created
- a form was started
- someone pressed "plan contact"

The finer transport states — `draft`, `sent`, `delivered`, `failed`,
`responded` — belong to the Contact object when that phase ships. They are
**not** lifecycle statuses: a case does not change position in recruitment
because an email bounced.

Enforced as a precondition: reaching `contacted` requires `contact_delivered`
evidence, which nothing in P2 can supply.

### Trial

A scheduled, accepted session the player attends. The lifecycle carries
`trial_requested`, `trial_scheduled` and `trial_completed`.

`trial_in_progress` is **deliberately not** a case status. A trial that is
under way is a state of the *trial*; the club has not moved the player
anywhere in recruitment by starting it.

#### Trial vocabulary (P4B, decision D-30)

The words below name distinct facts and are never used for one another.

- **Invitation** — a `db.requests` row of type `trial`, sent by the club to
  the routed recipient. Its states are **invited** (pending), **accepted**
  and **declined**. An invitation is not a trial.
- **Trial** — the `db.trials` row that exists only once an invitation is
  accepted. Its operational states are **accepted** (no confirmed
  schedule), **scheduled** (a confirmed revision with at least one
  session), **completed** and **cancelled**; **rescheduled** names the act
  of proposing a new revision, not a state. `legacy_accepted` is the
  read-only reading of a row written before P4B.
- **Session** — one dated, timed, placed occurrence inside a trial's
  schedule, with a stable id across revisions and a contextual **kind**
  (`onboarding, training, drill, small_sided, match, other`).
- **Revision** — one proposed schedule; a **material** revision changes
  where or when and asks the recipient again.
- **Attendance** — what happened at a session: **attended**, **partial**,
  **no-show**, **club cancelled**, **player withdrew**; `not recorded` is
  derived. Attendance is never a judgement.
- **Completion** — the club's explicit statement that the trial has taken
  place (gated on attendance and the last session having ended). Neither a
  report nor an assessment.
- **Feedback report** — the legacy mandatory `trial.report`; still owed
  after completion.
- **Scouting assessment** — `db.assessments` written in Trial context;
  human judgement, behind the blind rule.
- **Recommendation** — the assessment's `recommendation`
  (sign / monitor / pass): an opinion.
- **Observation** — what Box Cam recorded about a linked session, as a
  state with policy copy; a refusal is *no reliable observation*, never
  poor performance.
- **Citation / evidence link** — a reference from a trial session to a Box
  Cam session the player already shares; copies nothing, proves nothing.
- **Decision** — `db.roomDecisions`: the recruitment act.
- **Outcome** — reserved for M12 outcome reports and signings (confirmed
  outcome); never a Trial state. The child's device shows an **outcome
  line** — the organisation and the trial's state — which borrows the word
  for the family's summary only.

### Decision Pending — a derived condition only

`trial_completed` with no current decision. **Computed, never stored.**

Storing it would create a second truth about one fact, which could then
disagree with the first. It appears in `journey.conditions`, alongside
`trialActive` and `offerAwaitingResponse`, which are derived for the same
reason. P5 adds `decisionOutstanding` (a non-terminal case with no formal
decision) and `hasFormalDecision` beside it, derived the same way.

### Formal Decision (P5)

The club's internal, explicit, human act on a case: a row in
`db.roomDecisions` with `kind: 'formal'` and an outcome of `progress`,
`hold` or `reject`, recorded by a room lead or recruitment lead in the same
save as the lifecycle move it asks for. It ends at `offer_consideration`.

**Not** an advisory recommendation (M17's rows, which have no `kind`), not a
draft, not a score, not an offer, and not something the player is told.
Nothing derives it from evidence, an assessment, a trial, Box Cam or a Trust
Score; a case with a completed trial and two assessments saying "sign" still
has no decision until a person records one.

### Advisory Recommendation

An M17 decision row (`POST /org/rooms/:id/decisions`). An opinion in the
chain, shown as *advisory* when it is at the head. It evidences nothing: an
advisory "offer" does not satisfy `offer_consideration`.

### Draft Decision

`kase.decisionDraft` — one per case, with its own `rev`, edited and
discarded under `expectedRev`. Labelled *Draft — not a formal decision*. It
moves nothing, notifies nobody, is not in the chain and is not a milestone.
Finalizing it writes the formal row and clears it in one save.

### Supersession

A later formal decision replacing the current one. The earlier row is not
edited: it gains `supersededById` and its own `rev` moves; the later row
carries `supersession { of, reason }` with the reason the history keeps.
Both remain readable. There is no "edit a decision".

### Outcome vs recommendation

The **outcome** (`progress | hold | reject`) is what a formal decision *is*.
The **recommendation** (`offer | continue_watching | archive`) is how M17
spells the same row so every legacy reader — Second Look, Nobody Missed, the
journey, M20 — keeps reading one chain. A formal row carries both; an
advisory row carries only the second.

### Offer Made

The club has sent a structured recruitment proposal to the player or guardian.

### Offer Accepted

**The player or guardian accepted a ScoutBox recruitment proposal.** Labelled
in the product as **"Accepted in ScoutBox"**.

It does **not** mean, and must never be presented as meaning:

- a legally executed playing contract
- an employment contract
- federation registration
- a completed transfer
- that the player has joined
- a work permit

### Signed

A **separate, confirmed** fact: the player actually joined, established by a
`db.signings` record for the same club and the same player.

Creating a signing has real consequences — a success-fee invoice, a change to
the player's level, `contractStatus: 'under_contract'`. So the causation runs
one way only:

```
signing truth  →  lifecycle
lifecycle      ✗  signing truth
```

M23 reads signings. M23 never writes one. If lifecycle could cause a signing,
moving a case on a screen would bill a club.

Every inbound edge to `signed` — including the retained `offer_made → signed`,
which exists for signings concluded outside ScoutBox — carries the **identical**
evidence requirement. There is no weaker path.

### Offer Declined

The player or guardian declined. Distinct from the club withdrawing, because
they are different decisions by different people, and collapsing them would
misattribute one to the other.

### Hold (`on_hold`)

The club has deliberately paused a **live** case, with a reason and optionally
a date to look again.

**Not terminal.** Not a rejection. Every ordinary route out stays open, and the
funnel does not count it as progress — a paused case has not advanced.

### Closed

The case is filed away. The label says only that.

It does **not** say why, and a closed case is never presented as a rejection:
rejection is `archived` or `withdrawn` with a structured reason code.

### Reopened

A previously ended case brought back, as a first-class transition rather than a
new record. The terminal history it had **survives**; the reopen is appended
after it.

### Confirmed Outcome

What actually happened in the world, as opposed to what the workflow recorded:
a signing, or an M12 outcome report (`registered`, `released`, `left`,
`unknown`).

The journey derives **one** terminal outcome from these. It does not store a
sixth field called "outcome" beside the five the product already has.

### Lifecycle reason code vs decision reason code

Two vocabularies, no overlap, and the difference is not cosmetic.

A **decision** reason code (M17, 20 of them) says why a club *concluded*
something about a player — `squad_space`, `needs_more_evidence`,
`timing`. It is an opinion, attached to a recorded decision.

A **lifecycle** reason code (M23, 16 of them) says why a case *moved* —
`case_closed`, `rejected`, `hold_resumed`, `case_reopened`. It is an event,
attached to a transition.

Supplying a decision code on a transition writes a judgement about a person
into a record of what happened to a case. The lifecycle route refuses it by
name.

The prohibited list — protected characteristics — is shared by both, with one
implementation and one error code. That rule is not allowed two versions.
