# M19 — Explainable Matching and Dynamic Watchlists

## 1. What this is

Two features, and one sentence each.

**Explainable Matching** answers: *which players my organisation can already
see satisfy the criteria my club wrote, and exactly why?*

**Dynamic Watchlists** answer: *keep that answer current as the facts change,
and tell me what changed and why.*

That is the whole scope. Everything else in this document exists to keep it
that small.

## 2. What this is not, in the product's own words

Neither feature decides, implies, computes or hints at any of the following:

- who is the **best** player;
- who is the **most talented**, or has the **highest potential**;
- who **should be signed**, trialled, contacted or looked at first;
- who is **likely to succeed**;
- who **deserves** an opportunity.

There is no match score, no percentage fit, no rank, no tier and no
"recommended player". Preferred criteria are **counted** — "2 of 3 met" — and
that count is never divided, normalised, compared between players, or used to
order anything. A count of the club's own criteria is a fact. A score would be
a judgement ScoutBox has no business making.

The forbidden vocabulary is enforced, not merely avoided: `m19E2E.mjs` §8
sweeps the server modules and both clients for *AI Match Score*, *Talent
Score*, *Potential Score*, *Recruitability*, *ScoutBox Rating*, *Best Match*
and *Recommended Player*, allowing them to appear only inside a sentence that
denies them. `m19Live` and `m19DemoSpotcheck` repeat the sweep against the
rendered pages.

## 3. Why matching had to be explainable

A club that cannot see why a player appeared cannot correct the criteria that
produced them, cannot defend the shortlist to a director, and cannot tell an
error from a preference. An unexplained list is also the exact shape in which
bias hides: nobody can audit a number.

So the unit of the feature is not the list, it is the **line**: for every
player, one line per criterion, saying whether it was met and in what words.
The list is a by-product of the lines.

## 4. The vocabulary a club writes criteria in

Eleven criterion types, in one table (`m19/criteria.mjs`):

| Type | Operators | What it tests |
|---|---|---|
| `position` | `in` | primary, or primary + secondary unless `primaryOnly` |
| `age` | `between`, `gte`, `lte` | the age on the visible projection |
| `geography` | `within_radius` | inside the permitted area, in km |
| `level` | `lte`, `in` | amateur / semi_pro / pro |
| `foot` | `in` | preferred foot; "Both" satisfies either |
| `availability` | `equals` | the recorded availability |
| `evidence` | `exists` | a named evidence requirement is on record |
| `evidence_recency` | `within_days` | footage (or any evidence) dated inside a window |
| `trust_band` | `gte` | evidence confidence at or above a band |
| `combine_result` | `exists` | a production Combine Verified result exists |
| `combine_measurement` | `gte`, `lte` | a Combine measurement against a threshold |

Eight operators, in one table: `in`, `equals`, `between`, `gte`, `lte`,
`within_radius`, `within_days`, `exists`. A client submits **criteria**, never
an evaluator: there is no path by which a caller supplies code, a weight, or a
result.

Anything outside these tables is refused with its own code
(`CRITERION_TYPE_UNKNOWN`, `CRITERION_OPERATOR_UNKNOWN`,
`CRITERION_OPERATOR_NOT_SUPPORTED`, `CRITERION_VALUE_UNKNOWN`,
`CRITERION_VALUE_OUT_OF_RANGE`, `CRITERION_RANGE_INVALID`,
`CRITERION_VALUES_REQUIRED`, `CRITERION_TOO_MANY_VALUES`). Nothing is ever
silently dropped: a criterion the club wrote either runs or is refused by name.

## 5. Required and preferred

`required` decides membership. A player must satisfy **every** required
criterion to appear at all.

`preferred` adds context. A player still matches when a preferred criterion is
not met; the card shows met and unmet preferred lines equally plainly, plus the
count. A preferred criterion can never remove anyone, and never reorders
anyone — `m19Live` M19-3 asserts that adding one changes neither the membership
nor the order.

A Recruitment Brief has no preferred class: everything a brief carries is
required, because that is what writing a brief has always meant in ScoutBox.
`briefCriteriaToCanonical()` makes that explicit rather than assumed.

## 6. Protected traits are never matchable

`isProhibitedCriterion()` refuses any criterion type that names a protected
characteristic — ethnicity, race, religion, disability, family income, school
type, sexual orientation, socioeconomic status — in whatever spelling, casing
or separator it arrives, and it refuses **before** any other validation runs so
the refusal is unambiguous in an audit. It shares its list with M18's
`PROHIBITED_BRIEF_FIELDS`, so a trait ScoutBox refuses in a brief it also
refuses in a criteria set, in either class.

The criteria editor offers only the eleven types above, so the refusal is
mostly theoretical from the UI. It is enforced on the wire regardless, because
the UI is not the security boundary.

## 7. One engine, not two

There is exactly one matching engine: `matchPlayerToCriteria()` in
`m19/match.mjs`.

M18's `playerMatchesBrief()` is now a thin adapter over it. That was the
first decision of this milestone and the most consequential: two engines would
eventually disagree about what a club asked for, and the disagreement would
appear as Nobody Missed and Player Matching giving different answers about the
same brief. `m19E2E` §5 asserts byte-identical output from both entry points
and that `m18/shared.mjs` holds no evaluator of its own.

## 8. Fail closed, always

A fact that is missing does not satisfy a criterion about it. An unknown age is
not "probably fine"; a distance that could not be established is not "probably
near"; a date that was never recorded is not "just now". Every one of the
eleven types is asserted against an empty facts projection in `m19E2E` §4
(abuse case A36).

A criterion type that somehow reaches the engine unvalidated returns
`met: false` with "This criterion cannot be evaluated" rather than defaulting
to true (A42).

## 9. Authorization runs before matching. Always.

The order is the whole security design:

```
organisation standing → authorization → visibility → blocks →
minor / guardian / agency rules → grassroots radius → candidate facts → matching
```

Matching is the **last** step. `visibleCandidates()` calls `orgCanSee()` and
then `ctx.m18MatchFacts()` — the same projection Nobody Missed uses, which is
built on `playerViewForOrg()` and returns null the moment the organisation may
not see the player. There is exactly one read of `db.players` in the whole
module and it is inside that guarded scan (A54).

So there is no path by which a criterion is evaluated against a player the club
is not allowed to know exists — **including through a count**. The response
reports the total of *visible matches* and deliberately carries no "considered"
figure that would reveal the size of anything else (A24).

Three organisations over the same seeded data see three different universes
(14 / 12 / 2 in the acceptance suite), and a player one club may see and
another may not is simply absent from the second club's answer (A60).

## 10. Distance is authorisation, not decoration

A grassroots organisation is authorised to see distance; a Pro club is not. So
the match card carries `distanceKm` only for the former, and the `distance`
ordering is **refused** with `SORT_NOT_AVAILABLE` for the latter — an ordering
must not leak what the field does not (A35).

The geography *explanation* carries no number at all, for anyone: it says
"Within the club's permitted search area". Explaining a match must never become
a way to locate a child. Where the organisation is already authorised to see
distance, the card shows it separately, as it always did.

## 11. Ordering is declared, deterministic, and not a ranking

Five orderings: `recent_evidence` (default), `name`, `age`,
`evidence_confidence`, `distance`. None is called "best match", "relevance" or
"fit, and no ordering option is a quality rank. Every comparator ends on the
player id, so two reads of the same data return the same order. The chosen
ordering is declared both in the body (`ordering`) and on the wire
(`X-ScoutBox-Ordering: <sort>,player_id`).

Asking for an ordering called `best_match` gets the declared default, because
no such ordering exists (A50).

The preferred-criteria count is reported per player and is never a sort key —
asserted from the source (§7 of the suite) and from the returned order (§12).

See the sorting-audit appendix in `M18_2_SORTING_AUDIT.md` for how M19's
surfaces fit into the platform-wide table.

## 12. A Dynamic Watchlist is saved criteria

Not a saved list of players. The distinction is the feature.

A stored list of player ids treated as truth goes stale in exactly the ways
that matter: a player is blocked, ages out, their evidence expires, and nobody
wrote to the watchlist to say so. So a watchlist stores **criteria**, and
membership is **derived** every time it is read.

Two modes, and the mode is always **chosen**, never inferred:

- `live_linked` — follows a Recruitment Brief. Edit the brief and the list
  follows. Editing the watchlist's own criteria is refused with
  `WATCHLIST_LIVE_LINKED` and the two honest options named.
- `snapshot` — keeps its own copy of the criteria. Later changes to a brief do
  not touch it.

Creating one without a mode is refused (`WATCHLIST_MODE_REQUIRED`). Creating
one with no required criterion is refused (`CRITERIA_REQUIRED_EMPTY`) — it
would silently mean "everyone this club can see".

## 13. The honest limitation: there is no scheduler

This build has no background job runner. Nothing recomputes while the
application is closed.

That is stated in three places rather than hidden: in the payload
(`refreshNote`), on the screen, and here.

Membership is correct **as of the last read**, and the page says when that was.
This is a real limitation and it is the reason the feature is called a Dynamic
Watchlist rather than a live one. Adding a scheduler is a later milestone's
work; claiming one now would be a lie the product could not keep.

What does exist is honest reconciliation: on every read, the derived membership
is compared with the previous derivation, and the differences are recorded as
explained transitions.

## 14. Transitions, and why each one happened

Entry reasons: `criterion_now_met`, `criteria_changed`, `brief_changed`,
`newly_visible`, `first_evaluation`.
Exit reasons: `criterion_no_longer_met`, `criteria_changed`, `brief_changed`,
`unavailable`.

Where possible the transition names the **specific criterion that flipped** —
"Matches age criteria (17)" — rather than saying "something changed". When the
criteria set itself changed, comparing criterion by criterion would be
misleading, so the honest answer is given instead: the criteria changed.

None of these reasons says a player got better or worse. That is asserted, not
just intended (A49).

## 15. The privacy-safe exit

A player can leave a watchlist because they blocked the club, because a
safeguarding rule changed, because their account was removed, or because their
guardian withdrew consent. Naming which one would leak exactly what the rule
exists to protect.

So all of them surface as one reason: `unavailable` — "This player is no longer
available in this watchlist". A57's sibling assertion (A46) checks that the
text names none of the possibilities.

## 16. The change summary is the last recorded change, not this read's diff

A diff is consumed by whoever reads first. The client refetches when a
colleague's edit arrives over SSE; the second read legitimately finds nothing
new; and the person who opened the page is told nothing changed when two
players had just left.

So the summary is read back from the recorded history: the last change, the
players it moved, and the time it happened — the same answer for every reader.
The history is the durable record anyway, so this introduces no second source
of truth. Found by `m19Live` M19-10; asserted by A44.

## 17. Notifications are grouped, mutable, and never player-facing

Membership changes are grouped into **one** notification per watchlist. A brief
edit that moves twenty-five players is one sentence, not twenty-five
interruptions.

`watchlist_changes` is its own notification category, on by default and **not**
mandatory — nothing about a saved search is safety-critical (A57).

A transition is notified at most once: `transitionFingerprint()` makes the same
transition under the same criteria a single event, so re-reading a watchlist
cannot re-announce it (A44).

Nothing is ever sent to the player. There is no player, guardian or public
route in M19, and `m19E2E` §22 asserts that a player's own notifications and
Passport say nothing about watchlists, matching or criteria.

## 18. Lifecycle

`active` → `paused` → `active`, and anything → `archived`, which is terminal.

- **Paused** still shows membership; only the change notifications stop.
- **Archived** stops maintaining membership, keeps its history, and is **not**
  reopened (`WATCHLIST_ARCHIVED`).

An archived or brief-less watchlist shows a **stated reason**, never an empty
list presented as the factual answer "no players match" (A43). That distinction
matters: zero because nobody qualifies and zero because the list is switched
off are different facts, and a recruiter must not confuse them.

## 19. Concurrency

Watchlist writes use the shared M18.1 contract: `expectedRev`, a 409 carrying
`currentRev`, `updatedBy` and `updatedAt`, and the same `ConflictNotice`
component every other surface uses.

The rename form pins the revision it was **started** from, so a live refetch
cannot silently adopt a colleague's newer revision and turn a conflict into a
last-write-wins overwrite. A refetch also never overwrites a name someone is in
the middle of typing. Both found by `m19Live` M19-11.

## 20. Tenant isolation

Another organisation's watchlist id is `404 WATCHLIST_NOT_FOUND` — the same
answer a nonexistent id gets — on read, on write, on history and on the Room
bridge. A 403 would confirm the record exists, which is a membership oracle.
The 404 comes **before** the concurrency check, so a stale-write probe cannot
be used to detect existence either.

Another organisation's brief id is `404 BRIEF_NOT_FOUND` for the same reason.

## 21. The Room bridge

"Add to Recruitment Room" from a watchlist calls the **canonical M17 Room
creator**, so every standing gate, the one-open-room rule and the activity
trail behave exactly as they do from anywhere else. It is not a second Room
creation path.

It is idempotent: a player who already has an open Room gets that Room, not a
second one, and the response says so (`existed: true`).

The player **stays on the watchlist** while they still match. A Room and a
watchlist answer different questions, and being evaluated is not a reason to
stop tracking whether someone still meets the criteria.

Rooms opened this way record `sourceContext: 'dynamic_watchlist'`, alongside
the `matching` context, in M17's existing source vocabulary.

## 22. Events

Five, all registered, all `org_private` / `org_internal`, all carrying ids
only:

`watchlist_created`, `watchlist_updated`, `watchlist_membership_changed`,
`watchlist_archived`, `matching_room_created`.

A membership-change event never ships who moved or how many; the recipient
re-reads under their own authorization. `minimizePayload()` drops anything not
on the allowlist, and A58 asserts it on this event specifically.

## 23. Rate limits

`matching_query` — 240/hour, per organisation.
`watchlist_write` — 120/hour, per organisation.

Per organisation, not per user, so one member cannot spend a colleague's budget
or evade their own by switching accounts. A club is also capped at
`LIMITS.watchlistsPerOrg` (60) non-archived watchlists, with a message that
names the way out.

## 24. Storage and migration

`SCHEMA_VERSION` is 1900. One new migration step, `m190_001_dynamic_watchlists`,
creates `db.dynamicWatchlists` and `db.watchlistHistory`. It is idempotent, as
every step in `m182/migrations.mjs` is.

Verified three ways in `m19E2E` §23–§24: a clean database boots and migrates; a
restart derives exactly the same membership without inventing a wave of
transitions; and a database aged back to the M18.2 shape (M19 collections
removed, schema record set to 1820) migrates forward, keeps its M18-era
Recruitment Briefs, and accepts a new watchlist immediately.

## 25. Performance, measured

From `scripts/m19Perf.mjs`, on one machine with a warm process. **No SLA is
claimed and none of these figures should be quoted as one.**

- One criterion evaluation: **265–380 ns**.
- A full eight-criterion evaluation for one player: **~1.75 µs**.
- 1000 candidates × 8 criteria, in process: **~4 ms**.
- Reconciliation of a 1000-member list with a 10% turnover: **~0.6 ms**.
- Over HTTP on the seeded dataset: matching **~2.5–3 ms**, a watchlist read
  **~3.2 ms**, against a Discover list at **~1.9 ms** and `healthz` at
  **~1.6 ms**.

The reading: the criteria count is almost free; the cost is the candidate
**projection** — `orgCanSee` plus `playerViewForOrg` plus the evidence,
reference and Combine walks that build each facts record. Matching adds little
to what Discover already pays.

The probe found one real defect: `criteriaVersion()` was recomputed for every
candidate, and at eight criteria that hash was 3.3 of the 5.1 microseconds an
evaluation took. It is now memoised on the criteria set.

**Known limitation, stated rather than optimised away:** the candidate scan is
linear in the number of players in the snapshot, capped by
`LIMITS.maxCandidateScan`. There is no index over positions, ages or evidence,
because the snapshot store holds the working set in memory and has no query
planner to give one to. At tens of thousands of players this becomes the thing
to fix — with a maintained projection, not with a cache, because a cached
membership is exactly the stale list M19 exists to avoid. When the scan is
truncated the response says so (`truncated: true`) rather than presenting a
partial answer as complete.

## 26. The surfaces

Two destinations, both **inside** Recruitment. No new sidebar section — the
same discipline M17 and M18 kept.

- `#/recruitment/matching` — the criteria editor and the explained results.
  A search that was actually run is carried in the URL
  (`?c=<opaque>`), so a refresh, a Back press and a link to a colleague all
  reproduce it. The payload is opaque and **untrusted**: the server re-validates
  every criterion, so a hand-edited link can widen nothing.
- `#/recruitment/watchlists` and `#/recruitment/watchlists/:id` — the list and
  one watchlist, with membership, the change summary, the explanations, the
  history and the lifecycle controls.

Both flat hashes (`#/matching`, `#/watchlists`) also resolve, as every
destination's does.

The criteria editor uses **typed controls per criterion type**. There is no
free-text JSON field, because a criteria editor that accepts arbitrary
structure is an editor nobody can read back six weeks later.

Grassroots carries the same screens with two switches: no Combine criteria
(matching its simpler brief), and distance ordering available, because a
grassroots organisation is authorised to see distance.

## 27. Accessibility and internationalisation

Every criterion outcome is carried by a ✓ / ○ glyph **and** by words: the glyph
is `aria-hidden`, and a visually-hidden `.sr-only` twin says "met" or "not
met". Status is never colour alone. Every control in the editor has an
accessible name, the editor is keyboard-operable, and both screens fit 390px
with no sideways scrolling — all asserted in `m19Live` M19-2b and M19-12.

Full EN and FR, no raw keys, French labelled machine-translated as everywhere
else. The forbidden vocabulary is forbidden in both languages.

## 28. What was verified, and how

| Suite | What it covers | Result |
|---|---|---|
| `scoutbox-server/scripts/m19E2E.mjs` | 60 enumerated abuse cases (A1–A60), 12 positive cases (E1–E12), pure engines, source sweeps, HTTP, restart, M18.2→M19 upgrade | **357 checks, 246 negative (69%)** |
| `e2e/m19Live.test.mjs` | M19-1…12 through the real Pro workspace against a real server | **17 checks** |
| `e2e/m19DemoSpotcheck.test.mjs` | the same surface in the shipped single-file bundles, plus "no external request" | **67 checks, zero page errors** |
| `scoutbox-server/scripts/m19Perf.mjs` | engine, candidate sets at 100/500/1000, reconciliation, HTTP | measurements, no SLA |
| `scoutbox-server/scripts/m18E2E.mjs` | that M19 changed nothing about M18 | **286 checks, unchanged** |
| `e2e/navConfig.test.mjs` | the two new destinations and their deep links, in both apps | **195 checks** |

Six defects were found by these suites and fixed rather than documented around:
the `foot` criterion that could never match a real player; `criteriaVersion()`
recomputed per candidate; the change summary consumed by whichever read came
first; a live refetch clobbering a name being typed; the same refetch silently
adopting a colleague's revision; and a demo mirror that accepted a half-written
criterion the server refuses.
