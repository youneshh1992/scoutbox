# M21 — Development Hub 2.0

The structured place where a player, a guardian, a coach and an authorised club
manage development over time.

> **ScoutBox should document and coordinate development — not claim to measure a
> player's worth, ceiling or future.**

---

## 1. Philosophy

Development is specific or it is nothing. "Improve weak-foot passing
consistency, in progress, three coach-confirmed sessions and one assessment"
is a sentence a coach and a player can both act on. "Development Score: 82" is
a sentence that invites a decision about a person which the number cannot
support, and which nobody can argue with because there is nothing in it to
argue with.

So the Hub answers six questions and no others:

1. What is this player currently working on?
2. What development goals have been agreed?
3. What evidence supports progress?
4. What changed since the last review?
5. Which actions are complete, active, blocked or overdue?
6. What should be reviewed next?

## 2. Non-goals

M21 does not answer how talented a player is, what their potential is, whether
they will turn professional, whether they should be signed, whether one player
is developing better than another, or whether one coach is better than another.

There is no Development Score, Potential Score, Improvement Score, Readiness
Score, Growth Score, Academy Score or Player Progress Rating — and no field in
any payload one could be stored in. `assertDevelopmentVocabulary()` runs at
boot and refuses to start a server whose own labels have drifted; the
acceptance suite scans live responses for the identifier forms.

There is no AI coaching, no generated training plan, no automatic weakness
detection and no personalised recommendation. The goal library is seven fixed
lines of text shown identically to everyone, and it says so on the payload.

## 3. Architecture

```
Football Passport            canonical player truth        (M15, read-only)
       ↓
assessments · evidence · Box Cam · Combine · trials         (M12–M16.1, read-only)
       ↓
Development Plans            db.developmentPlans           ← M21 owns
       ↓
Development Goals            db.developmentGoals           ← M21 owns
       ↓
Development Actions          db.developmentActions         ← M21 owns
       ↓
Evidence Links               db.developmentEvidenceLinks   ← M21 owns (references only)
       ↓
Development Reviews          db.developmentReviews         ← M21 owns (append-only)
       ↓
Development History          projected from audit()        ← no store
```

Five stores, all workflow. Not one holds a fact about a player that another
store already holds. The timeline has no store at all: it is a projection over
the append-only `history` that `audit()` has written on every record since M12.

Modules: `m21/shared.mjs` (vocabulary, limits, transitions, boot assertion),
`m21/targets.mjs` (objective targets), `m21/evidence.mjs` (link resolution),
`m21/permissions.mjs` (one access table), `m21/plan.mjs` (the one projection),
`m21/reviews.mjs` (append-only reviews), `m21/index.mjs` (migration and routes).

## 4. Reuse of existing development functionality

`M21_REUSE_AUDIT.md` is the full table. The decisive finding:

**M12's `db.devObjectives` already exists and is a narrower concept.** It can
only be seeded from published club feedback, only a player or guardian can
create one, and it hard-refuses a third objective — *"One or two focused
objectives — not a laundry list."* Widening it to carry M21 would break three of
its own guarantees and change a Passport projection M15's suite asserts. So M21
**bridges** to it: a plan or goal may record an existing objective as its
origin, by id, on explicit user action. The M12 record, its routes and its
Passport projection are untouched, and `m12E2E` and `m15E2E` staying green is
the test of that decision.

Reused verbatim: `audit()`, `guardRev`/`bumpRev`, the M18.2 conflict UX, the
dirty-form guard, the provenance vocabulary, `orgCanSee`, `guardianOwnsChild`,
`isAdult`, the destructive-action pattern. Extended: the event registry, the
notification preferences (by one category), the rate-limit table, the migration
registry, the organisation audit log.

**Not** reused: Recruitment Room tasks. Same word, different privacy contract —
a Room task is a staff work item inside a club's private decision workspace and
is never sent to the player, while a Development Action can be assigned to the
player. Merging them would leak one or gag the other.

One rule was extracted rather than copied: M16.1's `effectiveState` — a Combine
result stops counting the moment Trust & Safety invalidates the Box Cam session
it was bound to — now lives in `combineShared.mjs` as `liveCombineState`, with
`isProductionValidCombine` beside it. M16.1 calls it and so does M21, so there
is one definition of production validity in the codebase.

## 5. Ownership

A plan has exactly one owner for its whole life:

- **player** — created by an adult player, or by the guardian of a minor;
- **org** — created by a club or a grassroots organisation.

Ownership is immutable. A player's plan cannot be handed to a club; a club that
wants its own creates one. This avoids the question "whose record is this?"
having two answers.

## 6. Visibility

Stated explicitly at creation, never derived from who created it.

| Owner | Allowed | Meaning |
|---|---|---|
| player | `private` | The player (and, for a minor, their guardian) |
| player | `player_guardian` | The player and their guardian |
| player | `shared_with_org` | …plus each organisation the player explicitly names |
| org | `org_private` | The owning club only |
| org | `player_guardian` | The club, and the player and their guardian |

A club cannot make its own plan visible to a second club, and a player cannot
mark a plan club-private. Those combinations have no meaning and are refused
rather than accepted and ignored.

`private` on a minor's plan still means the guardian can see it: a guardian
manages a minor's account, and a plan the guardian could not read would be a
safeguarding gap dressed up as privacy.

Narrowing a player plan's visibility withdraws every share with it.

## 7. Plans

```
id · playerId · owner{kind, orgId} · createdBy · title · status · visibility
sharedWithOrgIds[] · startDate · nextReviewAt · endDate
originObjectiveId? · originTrialId? · templateId?
createdAt · updatedAt · completedAt · archivedAt · rev · revAt · revBy · history[]
```

Statuses: `draft`, `active`, `paused`, `completed`, `archived`. Deliberately no
`closed` — M17's Rooms use that word for something else, and §10 asks for the
ambiguity removed rather than copied.

**§64, decided explicitly:** a `draft` plan may have zero goals; an `active`
plan may not. Save it as a draft if you are not ready.

Limits: 5 active plans per owner per player, 20 goals per plan, 20 actions per
goal, 30 evidence links per goal or action. These bound abuse, not ambition —
a plan with twenty goals is already a plan nobody will work through, and the
refusal says so.

## 8. Goals

```
id · planId · title · description? · category · status
blockReason? · blockNote? · targetDate? · target?
originObjectiveId? · createdBy · rev · history[]
```

Categories: technical, tactical, physical, psychological, match understanding,
position-specific, other.

Statuses: `not_started`, `in_progress`, `blocked`, `achieved`, `stopped`.
`not_started → achieved` is refused: a goal nobody started cannot have been
achieved through this plan. `achieved → in_progress` is allowed, because a
reviewer who ticked the wrong goal must be able to correct it, and the history
keeps both.

**Achieved is not verified ability.** The sentence travels with the word:

> Achieved means the plan owner or reviewer marked this agreed objective
> complete. It is not a ScoutBox finding that the player permanently possesses
> this ability.

Blocked reasons: waiting for an assessment, scheduling, facility, waiting for a
coach review, other.

**Two vocabularies the mandate offered conditionally are absent.** §13 permits
an `availability / rehabilitation` category and §48 an `injury_or_unavailable`
block reason *only if the repository already supports them safely*. It does
not: there is no medical vocabulary, no consent model for health data and no
retention rule for it anywhere in ScoutBox. Adding either would create a
structured, filterable field for a diagnosis inside a football coaching record.
A blocked goal can say `other` in the author's own words.

## 9. Actions

```
id · goalId · planId · type · title · dueAt? · assignee? · status
createdBy · completedAt? · history[]
```

Types: training, assessment, video review, match objective, coach review,
combine, box cam, evidence request, custom. A typed action is a *label on a
to-do*; it does not create the Box Cam session or Combine attempt it names.

Statuses: `todo`, `in_progress`, `done`, `blocked`, `cancelled`.

Assignment respects ownership: only the plan's player, that player's guardian
(for a minor), or current staff of the owning organisation. A colleague in
another club is never an assignee, and neither is a removed one.

A player assigned an action may tick it even on a club plan they cannot
otherwise edit — that is the point of assigning it — but they may not change
its title, type, due date or assignee.

**Completing an action never completes its goal.** There is no code path from
an action write to a goal status.

Progress is expressed as counts and a sentence made of counts:
`3 of 5 actions completed`. Cancelled actions leave the denominator. There is
no ratio field in the payload, and no surface draws a progress bar — the same
three numbers rendered as a filled bar reads as a measure of the player.

Overdue is derived from a date that has passed. It is never attributed to
anyone.

## 10. Evidence

```
{ id, planId, goalId | actionId, playerId, sourceType, sourceId, linkedBy*, linkedAt }
```

Four ids, a provenance stamp, and no content. The complete allowed key set is
exported as `EVIDENCE_LINK_FIELDS` and asserted by the suite against a real
stored link: if a future change adds a `label`, a `value` or a `note`, the store
has started holding evidence and the test fails.

Sources: Passport evidence, assessment, Box Cam session, Combine result, trial
report.

Everything a surface renders is resolved from the canonical record at read
time, every time. Three consequences, all wanted:

- an invalidated Combine result reads as invalid **now**, not as it was when
  someone linked it;
- evidence the viewer may not see resolves to "unavailable" carrying nothing at
  all — not the label, not the value, not the organisation;
- the link survives. History says something was cited and is no longer
  available, rather than quietly deleting the citation.

Ownership is absolute: a link may only point at a record belonging to the same
player, checked at write time and again at read time. Access is checked before
existence, so a caller cannot use the difference between "no such id" and "not
yours" to enumerate another club's records.

An assessment is visible to the owning organisation, and to the player only
where the club published feedback. A trial report is visible to the club that
ran the trial and to nobody else — and even then M21 shows that it exists,
never a line of what it says.

## 11. Provenance

The canonical M18.2 vocabulary, unchanged: `player_submitted`,
`guardian_submitted`, `system_recorded`, `historical_migration`,
`box_cam_observed`, `scoutbox_reviewed`, `verified_coach_confirmed`,
`verified_club_confirmed`, `authoritative_registry`, plus the source badges
`combine_verified` and `simulated_demo`. M21 invents no label.

## 12. Box Cam

A Box Cam session can be linked to a goal as **observed training evidence**. It
carries a sentence saying ScoutBox recorded activity consistent with the drill
and does not measure how much the player improved.

Volume is never progress. No payload in M21 aggregates hours, streaks or
session counts into anything, and there is no field one could be put in. A
count of linked items is a count of linked items.

A fixture-driven session is labelled simulated wherever it appears.

## 13. Combine

A Combine result can be linked as evidence and is the only source that can
satisfy an objective target.

Production validity is M16.1's own predicate, `isProductionValidCombine`:
Combine Verified *right now* (so an invalidated Box Cam session withdraws it
immediately), a measured value present, and not produced by a test-only
provider. A demo or simulated number never crosses a production threshold.

## 14. Objective targets

```
{ sourceType: 'combine_attempt', protocolId, protocolVersion, metricType,
  metricUnit, operator, value }
```

One metric, one operator, one number. No formula language, and there will not
be one: an evaluable formula is a score with extra steps.

Validation refuses, with a reason: an unknown protocol, an unknown protocol
version, a metric renamed by the client, an unknown operator, an operator
pointing the wrong way down the metric (a "≤" target on Box Touch 60 sets out
to get worse), exact equality on a sub-unit measurement, a negative or
non-numeric value, a fractional value on a whole-number metric, and a value
larger than the protocol's window can produce.

The protocol version is pinned at creation. Measurements are never compared
across protocol versions.

**Honest limitation:** the only source is a Combine attempt. Box Cam records
observed training, not a verified metric; an assessment records an evaluator's
opinion on a scale that is not comparable across templates. Pretending either
could satisfy a numeric threshold would be the fake quantification §31 forbids.

## 15. Target-state semantics

Three states, three different sentences:

| State | Means |
|---|---|
| `target_met` | The best production-valid measurement satisfies the comparison. |
| `target_not_met` | A production-valid measurement exists and is short. |
| `no_current_valid_measurement` | There is nothing valid to compare. |

The third carries one of four reasons, because a player who never attempted the
protocol, one whose only results were simulated, one who used a different
protocol version and one whose result was invalidated are four different
situations a coach needs to tell apart.

**Meeting a target never marks the goal achieved.** The payload says so at the
exact moment somebody would otherwise tick the box: one measurement is not the
whole football objective, so manual achievement stays authoritative.

## 16. Reviews

```
id · planId · reviewerKind · reviewedBy · orgId? · reviewedAt
sharedSummary? · internalNote? · goalSnapshots[] · nextReviewAt?
sharedWithPlayerAt? · shareScopes[] · supersedes? · supersededBy? · history[]
```

Reviewer kind follows from who the reviewer is, not from what they send: a club
cannot file a "Player reflection" and a player cannot file a "Coach review". A
provenance the subject can set is not provenance.

A snapshot records goal status, action counts, evidence **references** and the
target state at review time. It does not snapshot the Passport: a frozen copy of
canonical evidence inside a review would be a second Passport with a date stamp,
slowly becoming wrong.

## 17. Review immutability

There is no PATCH route for a submitted review anywhere in this milestone, and
no DELETE. A review's value is that August still says what August said.

Corrections append: a new review names the one it replaces, the original is
marked `supersededBy` and stays fully readable. A review can be corrected once —
correct the current version instead. A club corrects its own review; a player
corrects their own reflection; nobody corrects somebody else's record.

## 18. Timeline

Projected from the append-only `history` that `audit()` writes. Twenty-one
timeline-worthy actions, in a fixed allowlist: plan created / activated /
paused / completed / archived / shared / unshared / visibility changed, goal
created / updated / status changed / target set, action created / status
changed / completed, evidence linked / unlinked, review submitted / shared /
superseded.

Reads and saves that changed nothing never appear — they are absent by
construction, not filtered out by something somebody has to remember. Entries
marked internal (visibility changes, review submissions, supersessions) stay
inside the owning organisation.

`detail` is written by the server and carries a status name or an id — never a
note, a summary or free text.

## 19. Player experience

Player app → **Development**: Overview, My Goals, Actions, Evidence, Reviews,
History. A minor reads their plan and the guardian manages it, on the guardian
screen, per child.

The overview is counts and dates: active goals, actions due, overdue, linked
evidence available, last review, next review. It carries the sentence *"These
are counts of agreed work. There is no overall figure here, and ScoutBox does
not calculate one."* exactly where a headline number would otherwise sit.

## 20. Club experience

Club and Grassroots → open a player → **Development**. It adds **no top-level
sidebar destination** (§54); `navConfig`'s 197 checks pass unchanged, which is
how that is enforced rather than asserted.

The club surface shows everything the player's does, plus its internal review
notes, clearly marked as staying inside the club — because a coach needs to know
which half of what they wrote the player will read.

## 21. Guardian and minors

Unchanged from the existing model, which is the requirement. A minor cannot
create a development plan (`GUARDIAN_MANAGED`), can read their own, and cannot
write to it. The guardian creates and manages it. `guardianOwnsChild`,
`req.playerIsMinor` and `isAdult` are reused verbatim; M21 introduces no new
safeguarding capability and no new direct minor capability.

Once a player is an adult the guardian relationship confers no access, whatever
the stored child list still says.

## 22. Agency

An agency has no viewer context in `planAccess` at all. It reads nothing,
writes nothing, and in particular gains no route to a minor. §75 asks that
agencies follow current restrictions; no access is the safest reading, and it
is what is built.

## 23. Room and trial relationship

A Recruitment Room may reference a plan, and a trial outcome may prompt a coach
to create a goal — **by explicit user action only**. No judgement is
auto-created from a trial outcome (§57).

Room notes, Room decisions and Room comments are never copied into development,
automatically or otherwise (§56). Room tasks are not reused at all: see §4.

## 24. Passport relationship

The Passport stays canonical. M21 links evidence that appears in it and puts no
goal, action, plan or review inside it. Development work is invisible in the
Passport unless it produced canonical evidence by the existing rules.

## 25. Trust relationship

The M16.2 Trust Score appears as **evidence confidence**, for context, and is
never development progress. Trust policy is not modified. A development action
cannot raise Trust; only canonical evidence the existing Trust policy already
recognises can, through the path it always used.

## 26. Notifications

One new category: `development_updates`, on by default, mutable. §81 asks for a
reasonable count; the honest trade is stated rather than hidden — a person who
mutes it mutes shared goals, due actions and shared reviews together. Three
switches almost always set the same way is how a preferences screen stops being
read. `security_account` remains mandatory and is untouched.

Player-facing changes reach people as notifications, never as a stream event —
see §27.

**There is no scheduler.** Due and overdue are worked out when the page is
opened. Nothing wakes up at midnight, and a player who does not open the app is
not reminded. The catalogue says so and the copy repeats it (§84/§85).

## 27. Privacy

Every M21 SSE event is organisation-private and carries ids only. That is a
design decision, not an accident of shape: an event carrying a bare `playerId`
is delivered by the existing rules to every organisation that can currently see
that player — right for a catalogue ping, a leak for a private development
plan. So the Hub broadcasts nothing player-directed at all. A plan shared with
two clubs emits one event per club; a private plan emits none, because there is
nobody it would be right to tell.

Org-private plan and review detail never appears in the player event stream, the
Passport, M20 analytics, M19 matching or any shared surface. The internal note
is absent from the player's payload rather than hidden in it — but its
*existence* is acknowledged, because pretending the club wrote nothing is its
own dishonesty.

Tenant isolation: every organisation lookup is composite, and a foreign record
answers as a nonexistent one. A 403 on a foreign plan id would confirm the plan
exists.

## 28. Concurrency

`rev` / `expectedRev` / 409, from M18.1, on plans and goals. The conflict body
is the shared shape, so M18.2's `ConflictNotice` renders it with no new code:
who changed it, when, reload or keep your edits. The conflict never carries what
the other person wrote.

Actions and evidence links are deliberately **not** versioned, following M18.1's
own stated rule: a lost update on a checkbox is an inconvenience, not a
corrupted decision record, and demanding a rev for every trivial edit trains
people to send whatever number makes the error go away.

Idempotency is natural rather than a key store: a retried create is recognised
by being the same create — same actor, same content, inside a sixty-second
window — and returns the record that already exists. Evidence links are exactly
unique on `(target, sourceType, sourceId)`.

## 29. Events and audit

Eight events, all registered with an audience, a privacy class and a payload
allowlist: `development_plan_created`, `_updated`, `_completed`,
`development_goal_created`, `_updated`, `development_action_completed`,
`development_evidence_linked`, `development_review_submitted`. Each has its own
literal `broadcast('…')` call site, so the M18.2 source check can see it and so
can anyone grepping. An unregistered development event throws rather than being
dropped.

The organisation audit log gains four actions and no more: plan created, plan
archived, visibility changed, review submitted. Every action checkbox belongs in
the plan's own history, which is richer and read by the people doing the work.
What a review *says* never reaches the audit feed.

## 30. Performance

`scripts/m21Perf.mjs` measures the plan projection at 10 and 50 goals, action
handling, history at 100 and 500 events, evidence resolution and review
projection, and reports medians. No SLA is claimed.

The snapshot store has no query planner and no indexes — a scan **is** the
access path — so `collectPlan` does one pass per collection and the projection
does the rest in memory. No index was added: see §153/§154 discipline, and the
perf report for the measured numbers that justify not adding one.

## 31. Migration

Schema `2100`, step `m210_001_development_stores`. Additive, idempotent, and
the only thing that creates the five stores.

This matters because of a defect M20 found: `db.trials` had only ever been
created by the demo seed, so a snapshot restored without it would have thrown on
the first read. The acceptance suite proves the M21 stores do not repeat it by
booting a server with an empty data directory and reading each store before
anything writes, and by asserting that `seed.mjs` never mentions them.

## 32. Limitations

Stated plainly, because every one of them is a real edge a user will meet.

1. **No scheduler.** Due and overdue are read-time facts. Nobody is reminded
   while the app is closed, and no copy implies otherwise.
2. **Only a Combine result can satisfy an objective target.** Box Cam and
   assessments are linkable as evidence but are not comparable numbers.
3. **UTC calendar days.** A late-evening deadline in UTC+13 is a different
   calendar day from local intuition.
4. **One notification category.** Muting development mutes shared goals, due
   actions and shared reviews together.
5. **No health vocabulary.** There is no availability/rehabilitation category
   and no injury block reason. A blocked goal says `other`.
6. **Actions are not rev-guarded.** Two people ticking the same action is
   last-write-wins, by the M18.1 rule.
7. **Idempotency is windowed.** An identical create long after the first is a
   new record, correctly.
8. **A count of linked items is not a measure of evidence.** There is no
   evidence strength, confidence or score in the Hub.
9. **ScoutBox does not police what a coach types.** It supplies behavioural
   vocabulary and refuses to structure trait labels; the free text is the
   author's, and a determined author can still write something unkind in it.
10. **Achieved is a human judgement.** It records that a reviewer marked an
    agreed objective complete, and nothing more. Everything in this milestone
    is built so that the word cannot quietly come to mean anything else.
