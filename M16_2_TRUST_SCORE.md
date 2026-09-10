# M16.2 — ScoutBox Trust Score

> **ScoutBox Trust Score reflects verification and evidence confidence — not
> football ability or recruitment suitability.**

## 1. Product definition

A 0–100 score answering one question: **how strongly is this player's football
record supported by trustworthy, current and attributable evidence?** It is
derived at read time from canonical sources and is explainable component by
component through *"Why this score?"*.

## 2. What the score means

Evidence confidence. A high score means a broad, attributable, currently-valid
record: identity established, club history confirmed, verified relationships,
provenance-bearing evidence, standardized measurements and attributed
references.

## 3. What the score does NOT mean

Not talent, ability, potential, football level, character, trustworthiness as
a person, popularity, effort, training volume, success, or whether a club
should sign anyone. A **low score means limited evidence, never bad
character** — and missing evidence is always phrased as an evidence gap.

## 4. Architecture

`m162/shared.mjs` (versioned policy + pure engine) and `m162/trust.mjs`
(canonical source gathering + viewer-safe routes), registered last because it
consumes everything else. It adds **no storage** (nothing is persisted — every
read recomputes), no new authentication and no authorization surface.

## 5. Relationship to M14 / M15 / M16 / M16.1

M14 answers *what fact was verified, by whom, with what authority*; M15 *what
the record contains*; M16 *what training ScoutBox observed*; M16.1 *what
standardized measurement it observed*. M16.2 answers *how strongly the whole
record is supported*. It **consumes** them and replaces none. In particular
M14's deliberate refusal of an account-level "verified: true" is preserved:
M14 claims remain the authoritative, fact-specific source of truth, and a
Trust Score is never evidence that an individual claim is valid.

**The Passport stays score-free.** M15 guarantees no numeric score appears in
the Passport projection (a number in a Football Passport has always meant a
talent rating). The Trust Score is therefore served from its own endpoints and
composed into the Passport header by clients — the separation is enforced by a
test.

## 6. Policy versioning

`TRUST_SCORE_POLICY_VERSION = 1`. Every weight, cap, curve, threshold, band
and level lives in the single `POLICY` object; no magic numbers exist in
handlers or components. The server refuses to boot if the weights do not total
100. Every profile and snapshot carries its `policyVersion`.

## 7. Weights

Identity 15 · Football history 20 · Relationships 20 · Evidence 20 ·
Combine 15 · References 10 (= 100).

## 8. Components

Each exposes `weight`, `availableWeight`, `coverageBp`, `earnedWeightBp`,
`level`, `reasons`, `strengths`, `gaps` and a `detail` object, so no score is
mysterious (§62 denominator transparency). Bands: Limited (0–39), Developing
(40–59), Established (60–74), Strong (75–89), Very strong (90–100).

## 9. Provenance and fact-specific authority

There is no single universal provenance rank applied blindly. Authority is
scored for the KIND of fact it supports: a club is strong authority for its
own affiliation with a player; a coach for the coach–player relationship; Box
Cam for the activity it observed and **not** for club affiliation (it is
absent from the history table entirely). Player-submitted history contributes
limited — never zero, never full — confidence and is labelled *"provided by
the player and not independently confirmed."*

## 10. Deduplication

The same fact reaches the engine through M14, the Passport, the timeline, club
history and Box Cam/Combine projections. `canonicalTrustSources()` keys every
item and counts the canonical source **once**, keeping the strongest statement
of it. The UI projection is never what gets scored.

## 11. Box Cam contribution

Box Cam Verified sessions strengthen Evidence Confidence because they add
platform-observed evidence — but Box Cam is **not an engagement score**. It
uses a diminishing curve and its own sub-cap, so it cannot max the Evidence
component alone, and 500 sessions score no higher than 50. Training duration,
streaks, reps and activity level are not inputs.

## 12. Combine contribution

A genuine **Combine Verified** result strengthens Combine Confidence because
it is standardized, independently measured evidence: standardized protocol,
server-minted Box Cam session, live capture, liveness, calibration, a detector
that supports the metric, server-derived result and integrity checks.
Coverage counts **distinct canonical protocols**, so repeating one protocol is
one protocol's worth. `partially_measured` receives no Combine Verified
contribution (its session may still count as Box Cam evidence).

## 13. Caps

Every component is capped at its weight, and Evidence has per-source sub-caps.
A player with 500 Box Cam sessions and 100 Combine attempts but no identity,
no confirmed history and no references scores **under 40** — proven by an
adversarial test.

## 14. Diminishing returns

Repeated evidence of the same kind yields decreasing contribution via policy
curves indexed by DISTINCT evidence count. Grinding cannot buy trust.

## 15. Invalidation and restoration

An invalidated Combine result (or an invalidated bound Box Cam session) stops
contributing **immediately** — the effective state is read live. This is a
REMOVAL of evidence, never a punitive penalty: the resulting score is exactly
the score of a player who never had that evidence, and no copy accuses anyone.
A legitimate restoration returns the contribution deterministically.

## 16. Minor fairness

Categories that cannot exist for a minor (agency representation) leave the
denominator rather than scoring zero, using the existing
`isAdult(DOB, country)` — **no new age flag**. An agency relationship neither
helps nor hurts a minor.

## 17. Grassroots fairness

A verified grassroots record reaches a **strong** band with no professional
affiliation whatsoever, proven by test.

## 18. Prestige independence

Club reputation, league, size, brand and academy prestige are not inputs — the
relationship projection carries no club name or prestige field at all. A
famous club and a park-side club give identical relationship confidence.
Popularity (followers, views, watchlists), recruitment outcomes (trials,
shortlists, signings) and payment are likewise not inputs; passing them
through the engine changes nothing.

## 19. Privacy

Viewer-safe projection: self/guardian/T&S see full components and gaps; a club
sees the score, band, component **levels** and safe signal wording plus the
disclaimer — never components, gaps, source ids, guardian identities,
assessment content, verification evidence or T&S reasons. Public projection is
withheld unless passport visibility policy permits, and then carries score and
band only.

## 20. Authorization separation

**A Trust Score of 100 grants nothing.** Every route registers on the existing
authenticated routers so the standing gates run first; the score is only ever
a payload. Tested: the agency/minor wall, blocks, suspended organisations,
grassroots radius, T&S-only surfaces and unauthenticated access all refuse
exactly as before, regardless of score. There is **no write route** — a wrong
score is fixed by correcting the evidence or the policy, then recalculating.

## 21. UI

Player: Trust Profile with score, band, the mandatory disclaimer, *"Why this
score?"* per-component explanations, "what strengthens" (✓) and "what could
strengthen it further" (○). Combine Card shows the Trust Score visually
separate from Combine results so 92 is never read as a Combine number. Club:
score, band, safe signals and the tooltip *"Evidence confidence — not football
ability."* T&S: full derivation and policy, with an explicit notice that a
score cannot be typed. No gamification, no leaderboards, no ranking, and no
default sort by Trust Score.

## 22. Tests

`scoutbox-server/scripts/m162E2E.mjs` — **111 checks, 54 negative (49%)**:
determinism, band boundaries, weights, dedupe, provenance honesty, caps,
diminishing returns, the adversarial grinding attack, performance
independence, Combine coverage/partial/invalidation/restoration, demo-provider
isolation, minor/grassroots/prestige/popularity/payment fairness, assessment
content independence, empty profiles, monotonicity, transparency, snapshots,
safe projection, HTTP journeys, the Passport separation and the full
authorization boundary.

## 23. Known limitations

- **No production Combine capability exists in this environment** (M16.1): the
  production web provider supports neither ball observation nor rep counting,
  so Combine Confidence is honestly 0 in production and the gap reads *"No
  production-supported Combine Verified result is currently available."* Only
  an explicitly simulated demo/test environment can exercise it, and the
  profile then reports `simulatedEvidenceIncluded: true` so the UI can label
  it *Demo — simulated Trust Score impact*. Simulated evidence never
  contributes to a production score.
- Identity assurance is capped by what exists: with no authoritative identity
  provider configured, the strongest real identity today is a ScoutBox
  document review, which is scored below `authoritative` on purpose.
- Recency is applied only where fact semantics justify it; historical verified
  facts never decay.
- Snapshots are architected as a DTO (`trustSnapshot`) for future Recruitment
  Rooms but are not persisted yet.
- The score is informational only: it is not a discovery gate, not a ranking
  input, and new players are never buried for lacking evidence.
