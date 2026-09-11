# M18 — Second Look + Nobody Missed

> **Second Look** asks: has something materially changed about this player
> since *we* last decided?
> **Nobody Missed** asks: are there eligible players who match *our own stated
> criteria* but never entered our evaluation workflow?
>
> Neither decides who is talented, who deserves a contract, who was wrongly
> rejected, or who will succeed.

## 1. Philosophy

Clubs lose players two ways. They archive someone for a reason that later stops
being true and never find out; and they never look at someone who matched what
they said they wanted. M18 closes both gaps with deterministic rules and
nothing else — no AI recruiter, no `playerPotentialScore`, no `shouldRecruit`,
no `missedTalentScore`, no `rejectionWasWrong`, no `probabilityOfSuccess`.

Both systems are **workflow** systems. Human recruiters remain responsible for
every judgement.

## 2. Second Look, defined

An item surfaces only when all of these hold: the organisation had a room, a
prior decision exists, material change happened **after** that decision, the
change is either relevant to the decision's reason or clears the general
threshold, the player is still visible and not blocked, and the room is in an
ended state.

Approved language: *Second Look · Worth Another Look · New Since Your Review ·
Evidence Changed · Since You Last Reviewed · Review What Changed*. The product
never says the decision was wrong and never says ScoutBox thinks you should
sign anyone — a copy sweep in the suite enforces it.

## 3. Reason-aware matching

`SECOND_LOOK_POLICY_VERSION = 1` holds one table mapping each M17 archive
reason to the change types that could actually bear on it:

| Archive reason | Resolved by |
|---|---|
| `insufficient_recent_evidence` | full match, evidence added, tier upgrade, gap closed |
| `insufficient_full_match` | full match, gap closed |
| `reference_missing` | verified reference added |
| `combine_missing` | production Combine Verified added |
| `trial_needed` / `trial_outcome` | trial completed |
| `physical_profile` | development block completed, Combine added |
| `technical_fit` / `tactical_fit` | full match, trial completed |
| `not_current_priority` | substantial evidence only |
| `position_need` | position changed |
| **`squad_space`, `budget`, `timing`, `registration`, `travel_logistics`, `eligibility`** | **nothing** |

The last row is the honest part. Those are facts about the **club**: no amount
of new footage makes a squad place or a budget appear. A change never resolves
them, and a candidate reports them in `unresolvedReasonCodes` so no surface can
imply otherwise. `player_unavailable` is also unresolvable — ScoutBox emits no
availability-changed event, and inventing one would be worse than the gap.

## 4. Material change engine

Sixteen normalized change types across evidence, references, Combine, Box Cam,
trials, assessments, record facts and closed evidence gaps. Each is collected
from a canonical store with its own clock:

| Source | Detected by |
|---|---|
| Evidence added / full match | `recordedAt` |
| Tier upgrade | `verification.reviewedAt`, **only when later than `recordedAt`** |
| Evidence superseded | the correcting row's `recordedAt` |
| Evidence disputed | `disputes[].at` |
| Reference added / revoked | `createdAt` / `withdrawnAt` |
| Combine verified | `completedAt`, production providers only, live effective state |
| Box Cam | `finalizedAt` (first evidence only) and assignment `updatedAt` |
| Trial | `report.filedAt` · Assessment | `submittedAt` · Gap | `updatedAt` |

Nothing copies a source payload: only the type, the canonical identity and the
clock travel.

## 5. Fingerprints and deduplication

One real change reaches M18 through several projections — the Combine
projection, the Passport, the Trust components. The fingerprint is
`type:sourceSystem:sourceId` and deliberately excludes the timestamp, so the
same fact is the same change whenever it is observed. Deduplication keeps the
earliest observation. **Three projections of one Combine result produce one
change, not three alerts**, and all changes for a player group into **one item**.

## 6. The latest decision cycle

Decisions are append-only, so the current one is the row with
`supersededById == null` — exact, unlike last-by-timestamp. Archive → reopen →
review → archive again means the next change compares against the **second**
archive. Items are keyed per **(org, room, decision)**, so a new cycle gets a
fresh item rather than colliding with the terminal one from the previous cycle.

A club may also have opened a **second room** for the same player years later.
"Since we last decided" still has exactly one answer, so only the **most recent
ended room per player** projects a candidate; the superseded cycle stops
projecting entirely, and the surviving item carries the reason from the club's
last decision rather than a mixture of both. Without that rule one new full
match raised one alert per historical room — the duplicate-alert failure this
milestone exists to prevent. It was found by the live browser journeys, not by
the engine tests, and both suites now guard it.

## 7. Snapshot comparison

The M17 decision-time snapshot is used rather than reconstructing the past from
today's data. Where the snapshot never recorded a field, the comparison says
**"Previous detail unavailable"** — never a fabricated value and never a
misleading zero.

Trust movement is derived from component **levels**, because the stored
snapshot deliberately drops per-component coverage (a club may not see it) and
M16.2's `trustChangeReasons` cannot read it. The existing code vocabulary is
preserved. A Trust movement is **context**: an item never exists because a
score moved, only because underlying facts changed.

## 8. Positive and negative change

Evidence removal, dispute, reference revocation and Combine invalidation are
material too, and surface as **Evidence Changed** rather than *Worth Another
Look*. The copy reads "a source used in the previous review is no longer
current" — it never accuses the player of anything.

## 9. Lifecycle, dismissal and cooldown

`open → reviewed → dismissed → reopened_room → expired`, with a transition
table. Dismissal is organisation-private with an optional structured reason and
changes nothing about the player. Once handled, the **same fingerprint set can
never regenerate the item**; genuinely new evidence can, immediately, and
substantial new evidence bypasses the 30-day cooldown. Open items expire after
120 days so no stale backlog accumulates.

## 10. Room reopen

A Second Look **never** reopens a room. A recruiter clicks Reopen Room, and the
call goes through M17's own `reopenRoom`: the same transition table, reason
requirement, snapshot capture, decision memory and activity trail. The archived
decision stays in history; the reopen is added to it. Source context
`second_look` plus the item id is recorded so the funnel can later distinguish a
reactivation from an organic discovery.

## 11. Recruitment Briefs

`db.recruitmentBriefs` — explicit, versioned club demand with states
`draft · active · paused · closed · archived`; only an active brief inside its
date window produces candidates. It reuses the existing criteria vocabulary and
can link a tactical `roleId` or a `vacancyId`.

**Why a new store rather than `org.tactical.roles[]` or
`opportunity.eligibility`:** those carry position/age/foot/level and radius
respectively, but neither carries evidence requirements, Combine requirements,
an evidence-confidence band, lifecycle states, activity windows or versioning.

Validation refuses, never repairs: inverted or impossible ages, negative radius,
unknown position, unknown evidence criterion, invalid Trust band, malformed
window — and every protected characteristic and proxy (race, ethnicity,
religion, sexual orientation, disability, family income, school type, postcode
deprivation, physical maturity, national origin) by its **own** error code, so
the refusal is unambiguous in an audit. Grassroots briefs are capped at the
standing 50 km radius and semi-pro level structurally, not optionally.

A material criteria change bumps `version`; an identical edit does not.
Historical coverage keeps the version it was computed against.

## 12. Nobody Missed matching

Boolean rules only. No weights, no preference ordering, no score. Every
criterion produces a `met`/`not_met` reason, so **"why is this player here?"** is
always answerable with the same list the club typed in. Unknown age and unknown
distance **fail closed**, exactly as the standing gates do.

The order of operations never changes:

> organisation standing → player visibility → blocks, minors, radius →
> brief eligibility → evaluation history → Nobody Missed

A hidden player never enters the candidate set. Matching and then concealing is
how side channels are born.

## 13. Meaningful evaluation

`EVALUATION_COVERAGE_POLICY_VERSION = 1` names nine signals that count — an
open room, a decided room, an open case, a submitted assessment, a trial, a
signing, a shortlist, an explicit deferral, a squad entry — and three that
explicitly do **not**: a profile view, a search impression, a Passport view.
Looking at somebody is not evaluating them. A decision inside 90 days marks the
player recently decided.

## 14. Evaluation Coverage

`meaningfully evaluated eligible ÷ all currently eligible`. 30 of 42 is 71%.
It is called **Evaluation Coverage** — never Scout Quality, Recruitment
Quality, Scouting Score or Fairness Score — and its own note says it measures
workflow coverage, *not* scouting quality, player talent or freedom from bias.
Groups below the platform's small-n threshold of 3 are suppressed with nulls
rather than misleading zeros, and no eligible players yields no percentage
rather than 0%.

## 15. Second Look vs Nobody Missed

A previously evaluated player is **never** returned to Nobody Missed. Add a
candidate to a room and they leave the queue and count as evaluated; archive
that room and they stay evaluated. Relevant later evidence reaches the club
through Second Look instead. The two queues cannot claim the same player for
the same brief at the same time.

## 16. Privacy, tenant isolation and event safety

Every lookup is org-scoped and a foreign item, brief or queue returns the same
404 as one that never existed. M18 registers **no player, guardian or public
route at all**. No player-facing surface mentions Second Look, Nobody Missed, a
brief, coverage or an archive reason.

M17's archive event previously leaked the archiving club's id, the room status
and the private reason codes to the subject player's SSE stream. That was fixed
before M18 was built: `shouldDeliver` now treats any payload carrying an
`orgId` as organisation-private, checked before the `playerId` rule. M18's own
events follow the same rule, and the suite opens a real player stream to prove
nothing arrives.

## 17. Minors, guardians, agencies, grassroots

Unchanged and enforced before matching: the agency/minor wall, the
verified-club requirement, guardian routing, the grassroots radius and level
ceiling. Guardians see only the normal player-facing request, trial and
evidence flows.

## 18. Trust, Combine and Box Cam

Trust Score may be an optional **minimum evidence-confidence band** — never a
default, never an ability filter, never a global wall, and it never makes a
player invisible. Combine criteria accept only **production-valid** results: a
test-provider result is excluded from change collection and from brief
eligibility. Box Cam is never used as a desirability proxy — training volume,
streaks and minutes are not inputs; only the availability of verified
development evidence is, and only when a brief asks for it.

## 19. Analytics

Organisation-private counters: items created, reviewed, dismissed, rooms
reopened, briefs created and activated, candidates reviewed, dismissed and
added to rooms. No player ids, no names, no organisation names. **No scout
ranking of any kind** — M18 measures workflow coverage, not employee
performance, and infers nothing about why a player was missed.

## 20. Performance

Candidate eligibility is derived live on every read so a block or a
visibility change takes effect immediately; authorization is never cached. The
match runs against a lightweight fact projection rather than a full Passport
assembly, and candidate scans are bounded.

## 21. Known limitations

- **`player_unavailable` cannot be resolved** — no availability-changed event
  exists. Documented rather than faked.
- **`current_club_confirmed` and `position_changed` are declared change types
  but are not yet emitted by the collector**: the underlying stores expose no
  reliable per-change clock (`prefs.updatedAt` is bumped by any preference
  edit). They are reachable through the mapping the moment a clock exists.
- **Combine invalidation is detected by exclusion, not by a timestamp** — the
  stores write none — so it removes a result from collection rather than
  raising an explicit "invalidated" change.
- **`snapshot.sourceRefs.passportVersion` is always null** upstream; M18 uses
  the id sets and the trust hash instead.
- **No optimistic concurrency on brief edits** — ScoutBox has none anywhere;
  M18 follows the existing convention of explicit state guards.
- **T&S has no M18 surface at all** — aggregate metrics only.
- Rate limits are in-memory speed bumps, matching the codebase.

## 22. M19 contract

M19 (Explainable Matching + Dynamic Watchlists) can reuse the Recruitment
Brief, the match engine, the lightweight candidate facts and the per-criterion
explanations as they stand. Dynamic Watchlists are deliberately **not** built
here. Nothing in M18 needs to be discarded to add them.
