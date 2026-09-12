# M18.1 — Production Hardening & UX Cleanup: implementation matrix

Written **before** any M18.1 code, from an inspection of the M18 report's honest
limitations plus a fresh read of the concurrency-sensitive mutations, the
Passport source architecture, the SSE delivery rule, every rate limiter, the
Express configuration and all four clients. Baseline tip `01de385`, branch
`claude/desktop-project-migration-wyk3ec`, nothing pushed.

M18.1 adds **no new recruitment concept**. Everything below is a correctness,
privacy, honesty, reliability or clarity fix to what already exists.

## Baseline regression (measured, all green before any change)

trust 23 · connectedE2E 43 · m12E2E 143 · m13E2E 212 · m14E2E 193 · m141E2E 94 ·
m15E2E 185 · m16E2E 115 · m161E2E 79 · m162E2E 124 · m17E2E 406 · m18E2E 286.
(apiE2E 129 needs a server on :4000 and is run separately; it was green at the
M18 tip and is re-run in the M18.1 battery.)

## Severity scale

**P0** active security/privacy/data-corruption · **P1** authorization or
correctness risk · **P2** workflow/reliability · **P3** UX/polish.
Nothing here is inflated: no P0 was found during preflight.

## Findings and outcomes

| # | Problem | Sev | Implementation | Test | Result | Remaining limitation |
|---|---|---|---|---|---|---|
| 1 | **Lost update on Recruitment Briefs.** `PATCH /org/recruitment-briefs/:id` takes the last write; two scouts editing the same brief silently overwrite each other. | P1 | `expectedVersion` on brief writes; mismatch → `409 BRIEF_VERSION_CONFLICT` with safe current metadata (version, updatedAt, updatedBy name). | m181E2E §1, m181Live H1 | **closed** — 409 `BRIEF_VERSION_CONFLICT` with `currentRev`, `updatedBy`; both web clients send `expectedRev` |  |
| 2 | **Lost update on workflow-critical Room mutations.** Status transition, archive/reopen, lead/owner reassignment, priority and decision submit all take the last write. | P1 | Room gains a monotonic `version`; the mutations that change workflow state or decision history require `expectedVersion` → `409 ROOM_VERSION_CONFLICT`. Trivial mutations (tags, notes) stay unversioned. | m181E2E §2, m181Live H2 | **closed** — `rev` on Room; status, priority, lead, owner and restriction guarded; tags/comments deliberately not |  |
| 3 | **Concurrent decisions could both land.** Append-only history plus no version check means two "current" decisions can be written back to back with no defined winner. | P1 | The decision write is pinned to the room version, so exactly one of two concurrent submissions is accepted and the other conflicts. Append-only is unchanged — nothing edits an old decision. | m181E2E §3 | **closed** — of two simultaneous decisions exactly one lands; at most one non-superseded decision remains |  |
| 4 | **Two different numbers are both called "Trust".** The legacy safeguarding/profile score (`computeTrustScore`: identity flag + attendance + trial reports + media count + profile completeness) renders as "Trust NN" and a `TrustBar` across Discover, search cards, comparison and squad views, beside M16.2's Trust Score, which means something else entirely. | P1 | Rename the legacy concept in every user-facing surface to what it measures — **Profile completeness** — and ship it as `profileSignal` alongside the deprecated `trustScore` field. The words "Trust Score" are reserved for M16.2 evidence confidence, everywhere. | m181E2E §38/§39, demo spotcheck | **closed** — `profileSignal` on the wire, "Profile completeness" in all three apps EN+FR; "Trust Score" reserved for M16.2 | The wire keeps `trustScore` as a deprecated alias so no external consumer breaks. |
| 5 | **Discover ordering is by that legacy score.** Search results sort by profile activity while the product states it does not rank players. | P2 | The ordering is stated honestly in the UI ("ordered by profile completeness — not ability") rather than silently applied. Changing the ordering itself is a product decision, not a hardening fix. | demo spotcheck | **not changed, stated** — the ordering is named in the UI rather than silently applied | Ordering unchanged; it is a product decision, flagged for a product milestone. |
| 6 | **`shouldDeliver` infers the audience from payload shape**, and its final line is `return true` — an event with neither `orgId` nor `playerId` is delivered to every connected identity, including players and rival clubs. Today's such events are harmless cache pings, but the default is "broadcast to all". | P1 (latent) | Explicit audience classification for every event name (`player_private`, `guardian_private`, `org_private`, `org_member`, `public_safe`, `trust_safety_only`), with the payload rules kept as a compatibility layer. Unknown/unclassified events **fail closed** to the club-and-player-safe default rather than being delivered to everyone. | m181E2E §17–20, SSE matrix | **closed** — `EVENT_AUDIENCE` classifies every event; `audienceFor` returns `org_private` for anything unknown |  |
| 7 | **`passportVersion` is the schema constant `1`**, so a decision snapshot cannot say which Passport truth it saw. | P2 | Add a deterministic **`passportRevision`** — a stable hash over canonical Passport inputs (club-history rows, timeline entry identities and provenance, references, achievements, evidence identities and verification state, identity assurance, current club, position). It changes when passport truth changes and **never on a read**. `passportVersion` stays the schema version. | m181E2E §7/§8 | **closed** — `passportRevision` is a content hash; identical a year later, moves on any truth change | `passportVersion` stays the schema constant, as intended. |
| 8 | **`current_club_confirmed` never emitted** — declared in M18, no clock. | P2 | Derive it from the rows that already carry an honest clock: a signing (`ts`), a squad membership (`addedAt`), a verified affiliation claim (`verifiedAt`). Fingerprinted per source row, so it is one change, not one per read. | m181E2E §9, §11 | **closed** — derived from a signing `ts`, a squad `addedAt` or a claim `verifiedAt`, fingerprinted per source row | A club that confirms a current club with none of those rows behind it still emits nothing. |
| 9 | **`position_changed` never emitted**, and the available clocks are wrong: `positionHistory.from` is the *football* date the player started playing the position, and `prefs.updatedAt` is bumped by any preference edit. | P2 | Add a real write clock: `recordedAt` on new position-history rows, and an append-only canonical `db.sourceChanges` entry when `positions.primary` actually changes value. Rows written before M18.1 have no clock and deliberately emit nothing. | m181E2E §10, §11 | **closed** — `db.sourceChanges` written at the preference site, value-triggered; three writes produce one change (§21) | Position rows written before M18.1 have no clock and deliberately emit nothing. |
| 10 | **Combine invalidation is detected by exclusion**, and restoring a session sets `invalidatedAt = null`, destroying the only clock. | P2 | Keep an append-only integrity history on the Box Cam session (`integrityEvents`: invalidated/restored with their own timestamps), and emit `combine_invalidated` / `combine_restored` as first-class material changes with honest copy. | m181E2E §12–14 | **closed** — append-only `integrityEvents` on the Box Cam session; invalidated and restored are first-class change types |  |
| 11 | **One invalidation must stay one change** across the Combine projection, the Passport timeline and Trust. | P2 | Fingerprint on the canonical session id, not the projection. | m181E2E §14 | **closed** — fingerprinted on the canonical session id, not the projection |  |
| 12 | **Six independent in-memory rate limiters** (one adapter + five copy-pasted module helpers), with limits written inline at call sites. | P2 | One `RateLimitProvider` abstraction with a `memory` provider and a central policy table naming every limited action. The distributed provider reports **`distributed_rate_limit: not_configured`** — no false claim of multi-instance enforcement. | m181E2E §15/§16 | **architecturally closed, honestly incomplete** — one policy table of 13 actions, one provider interface; a non-memory provider is refused loudly | Single-instance only until a shared backend exists. `/capabilities` reports `distributed_rate_limit: not_configured`. |
| 13 | **Adult date of birth ships in every org player projection** although no club surface uses it (age is what is displayed). | P2 | Drop raw `dob` from the org projection; keep `age`. Minors already had it removed. | m181E2E §21 | **closed** — `dob` gone from the org player projection; `age` retained |  |
| 14 | **Trust unavailable renders as "—"**, which reads like "nothing" rather than "not available right now". | P2 | Explicit "Evidence confidence temporarily unavailable" state; never `0`, never a stale value. | m181E2E §22, H4 | **closed** — "Not available" / "Player withheld" with their own notes; never `0`, never a bare dash |  |
| 15 | **Double-click can repeat high-risk actions** — room reopen, Nobody Missed add-to-room, Second Look review/dismiss have no idempotency (decisions and uploads already do). | P2 | Idempotency at the state level: the second identical action returns the same result instead of creating a second transition. | m181E2E §4–6 | **closed** — add-to-room returns the same room with `idempotent: true`; a repeated review appends no second history entry |  |
| 16 | **CORS is `app.use(cors())`** (any origin) and no security headers are set. | P2 | Origin allowlist from configuration with a documented development default; baseline security headers; explicit body-size limits. | m181E2E §46 | **closed** — `SCOUTBOX_ALLOWED_ORIGINS` allowlist, five security headers, stated 20 MB body limit, typed 413/400/415 errors | With no allowlist set, development keeps its permissive behaviour (§74) and the capability report says so. |
| 17 | **No operator capability report.** `/healthz` returns uptime only, so a deployment cannot tell whether CV, a distributed limiter, an identity provider or email are configured. | P2 | A capability report listing each provider's honest state; nothing sensitive in it. | m181E2E §50 | **closed** — `GET /capabilities`, states only, deliberately hard to inflate |  |
| 18 | **Boot does not refuse dangerous configuration** (a test provider marked production, missing signing secret in production mode). | P2 | Explicit boot assertions that fail loudly in production mode and leave development untouched. | m181E2E §48 | **closed** — boot assertions for the test provider, media secret and dev login in production; Trust weights fatal in every mode |  |
| 19 | **T&S has no M18 access path at all** — correct by default, but undocumented, so a future reader might "fix" it by granting blanket access. | P3 | Document the boundary and the shape a scoped, reasoned, time-bound, audited grant would take. **Not implemented**: building it properly is its own milestone, and blanket access is worse than none. | doc | **deferred, documented** — the boundary and the shape of a scoped grant are written up in M18_1_HARDENING.md; `m181E2E §19b` asserts the admin key opens none of the three | Deliberately not built: a blanket support role over private recruitment decisions is worse than none. |
| 20 | Empty/error/unavailable states are inconsistent across Second Look, Nobody Missed, Room tabs, Combine and Passport. | P3 | Explicit states per surface; a failing source must not blank a whole Room. | m181E2E §23–26, H4/H5 | **closed** — retryable `role="alert"` failures across five surfaces; per-tab Second Look empty states; combine states differentiated |  |
| 21 | Notifications state what happened but not what to do about it, and one underlying event can produce several near-identical messages. | P3 | Actionable copy with a destination, and dedupe on the canonical fingerprint. | m181E2E, spotcheck | **closed** — unread duplicates coalesce with a `repeatCount` and no second push; rows with a known destination are buttons | No notification preference system in M18.1 — a person cannot yet choose which of these they want. |
| 22 | Mobile and keyboard behaviour of the M17/M18 surfaces is unverified. | P3 | Responsive and keyboard passes with real browser checks at phone/tablet/desktop. | H6–H9 | **closed** — H7 and the demo spotcheck both measure 0px overflow at 390px on four surfaces; H8 covers keyboard operation and visible focus |  |
| 23 | Provenance labels and date formats vary between surfaces. | P3 | One canonical provenance vocabulary and one date formatter, not colour-only. | m181E2E §40, spotcheck | **closed** — `box_cam_observed` labelled correctly (it was rendering as "Player-provided"); unknown reads "Source not classified"; 25 dates moved onto the app helpers |  |

## Explicit non-goals (§108)

Explainable Matching · Dynamic Watchlists · AI recommendations · any new player
score · new Trust policy · new Combine protocols · a Box Cam CV model ·
federation expansion · billing · analytics dashboards · new top-level
navigation. None of these appear in M18.1.

## How this file is used

Every row is updated with its measured result as the work lands. A row that
cannot be honestly closed is marked with the limitation that remains, not
quietly dropped.

## Outcome (measured)

Twenty of twenty-three rows are closed. Row 5 (Discover ordering) was
deliberately not changed — it is a product decision, and the ordering is now
stated rather than silently applied. Row 12 (rate limiting) is
architecturally closed and honestly incomplete: one policy table and one
provider interface, but no shared backend, and `/capabilities` says so rather
than implying protection that does not exist. Row 19 (Trust & Safety access)
was deliberately not built, and the shape a proper grant would take is written
up instead.

Two defects found while writing the tests, not before: `box_cam_observed` was
rendering as "Player-provided" in both web apps and as a raw identifier in the
player app (row 23); and the clients were not sending `expectedRev` at all, so
rows 1 and 2 were server-side theatre until `m181Live H2` caught it by reading
what the client actually put on the wire.

Final regression: server trust 23 · apiE2E 130 · connected 43 · m12 143 ·
m13 212 · m14 193 · m14.1 94 · m15 185 · m16 115 · m16.1 79 · m16.2 124 ·
m17 406 · m18 286 · m18.1 195 (53% negative). Browser: navConfig 155 ·
navLive 30 · m15Live 21 · m16Live 10 · m16.2Live 11 · m17Live 25 · m18Live 60 ·
m18.1Live 37, plus every demo spotcheck and the offline/crosstab suites. All
green; four apps typecheck and build.
