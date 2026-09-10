# M16.1 — At-Home Combine, powered by Box Cam

> **Standardised drills. Real measurable numbers. Recorded live with Box Cam.**
> **Record it. Prove it. Put a number on it.**

## 1. Product proposition

At-Home Combine lets a player perform **standardised** football and
physical-development tests at home (or any appropriate area), recorded live
through Box Cam, and turns them into structured, comparable numbers a club
can trust. It answers one club question — *"Can I trust that number?"* — with
evidence, not a claim: **this attempt used a standardised ScoutBox protocol,
was captured live through Box Cam, measured by a detector that genuinely
supports the metric, calculated by ScoutBox and passed the required integrity
checks.** That is **Combine Verified**.

## 2. Relationship to Box Cam (no second camera stack)

At-Home Combine is a **measurement layer over M16 Box Cam**, not a new capture
system. Every Combine Attempt binds a **server-minted Box Cam session**
(`ctx.boxMintSession`) and is completed through the **shared** Box Cam
completion path (`ctx.boxCompleteSession`), so it inherits every Box Cam
integrity property unchanged: server-owned identity, fresh nonce, liveness,
monotonic event sequencing, drift-bounded timestamps, server-derived values,
ignored client fields, and no upload-to-verify. The Combine measurement is
derived server-side in the shared `onSessionFinalized` hook. Modules:
`m16/combineShared.mjs` (pure engine + protocol registry) and
`m16/combine.mjs` (routes); registered after Box Cam in `m16/index.mjs`.

## 3. What "Combine Verified" means (exactly)

A result is **Combine Verified** only when all of the following hold: it
originated from a valid live Box Cam session; the correct standardised
Combine Protocol was used; liveness passed; calibration passed (where the
protocol requires it); the required observations were available; the active
detector/provider genuinely supports the metric; integrity checks passed; the
measurement was server-derived; and the full standardised measurement window
was observed at good quality. If any of these is untrue, another honest state
is used — never a decorative badge.

## 4. Standardised protocol architecture

Every Combine test is a versioned `CombineProtocol`: id, version, title,
category, description, `metricType`, `metricUnit`, `direction`, `precision`,
`protocolWindowMs`, setup/camera/space/equipment requirements,
`calibrationRequirements`, start/finish/valid-attempt rules, `scoringMethod`,
`requiredCapabilities`, `maxVerifiedPerWindow`, `measurementAlgorithmVersion`,
safety notes and status. A historical attempt pins
`protocolId@protocolVersion` **and** `measurementAlgorithmVersion` forever; a
rule change is a new version and never rewrites past measurements.

## 5. Protocol registry

Protocols are static, versioned code (`COMBINE_PROTOCOLS`), never client
input. A club selects standardised protocols by id — it can never redefine
measurement rules, thresholds, geometry or metric while still calling it the
same protocol.

## 6. Attempts

`CombineAttempt` (store `combineAttempts`) references its bound Box Cam
session, never duplicating its observations: id, playerId,
protocolId+version, boxSessionId, attemptNumber, mode
(`verified`/`practice`), captureContext, requestId?, metric fields,
measurementAlgorithmVersion, provider+version, calibrationResult,
measuredValue, measurementState, combineState, reasons, timestamps and
resultHash. States: `not_started, setup_required, ready,
attempt_in_progress, processing, combine_verified, partially_measured,
measurement_unavailable, protocol_invalid, integrity_review, invalidated,
cancelled`.

## 7. Calibration

`Box Cam Combine Setup` validates standardised geometry via the Ready Check
(camera, orientation, framing where measurable). Protocols needing physical
scale declare `calibrationRequirements` (e.g. `box_marker_5m`) satisfied by a
**Box Marker** (a printable/known-dimension marker or cones a known distance
apart). First-library protocols need geometry only; the physical-scale path
is reserved for future protocols and gates their (currently unavailable)
verification.

## 8. Measurement

Derived only from the bound session's own server-derived values:
`count` = verified de-duplicated reps; `duration` = verified active seconds
inside the window (tenths); `set` = completed intervals. Whether the bound
session's *drill target* completed is irrelevant — a Combine has its own
metric and window. Combine Verified additionally requires the **full
standardised window observed at good quality**; a short capture is
`partially_measured` with the measured value and observed window recorded —
**never projected or extrapolated**.

## 9. Capability boundaries (the honesty gate)

`measurementSupported(protocol, providerCapabilities)` is pure set
containment and is the single gate. In this environment: the production
`web_client` observes only player presence + active duration (no ball, no rep
counting), so **every first-library Combine is `not_configured` in
production** and reports *"measurement not yet supported on this device."*
The gated, always-labelled `local_test` provider supports the count/duration/
interval library for the demo and tests. Future athletic protocols require
capabilities **no provider has — not even the test one** (`spatial_scale`,
`timing_gate`, `target_zone`), so their sprint/jump/distance numbers can
**never** be Combine Verified here.

## 10. Practice vs Official

`practice` attempts let players rehearse setup; they use Box Cam but can
**never** become Combine Verified and never enter Personal Best, the Combine
Card, the Passport or club-request completion. `verified` attempts are subject
to a per-protocol limit (default 3 per 24h) that is non-punitive — practice
remains available after the verified limit.

## 11. My Combine

The player hub: verified results, personal bests, attempt history, practice,
club requests and "how verification works." Unsupported tests are shown as
*not yet supported on this device*, never as a failure.

## 12. Combine Card

A collection of the player's standardised verified measurements (name, age,
position, per-protocol best, protocol version, date, "Captured by Box Cam").
It is explicitly **not** an overall rating — no ScoutBox Athletic Score, no
Potential Score, no averaging of unrelated metrics.

## 13. Club Combine

A verified, non-suspended, non-agency organisation selects standardised
protocols (+ deadline, eligible players, instructions) into a Club Combine
request. It reuses the standing gates exactly (`visibleToOrg` incl. the
agency/minor wall and grassroots radius, blocks, verified, not suspended); it
grants no new access and cannot modify a protocol. Completion means the
standardised tests were completed and Combine Verified within the window — it
does **not** mean the club selected, endorsed or rejected the player.

## 14. Requests

Players and (for minors) guardians see requests with per-protocol completion.
A request never widens access; completing a verified attempt for a requested
protocol advances the request and, when all are complete, notifies the
requesting organisation.

## 15. Football Passport integration

The Passport **projects** verified Combine results (best per
protocol@version), never copies them. Self/guardian always see the Combine
block; a recruiting org sees it only on the player's/guardian's explicit
recruitment opt-in (a club's own request reads results through the dedicated
Combine endpoint instead). Meaningful events only; no talent score.

## 16. Video evidence

There is no raw-video capture in Combine beyond the optional Box Clip, which
reuses the existing media pipeline (guardian-gated for minors, never public
automatically). A club sees the **result**, never raw home footage. Structured
measurement is what persists.

## 17. Privacy / minors

Combine result exposure follows Passport privacy (private / recruitment /
public-where-allowed); public never carries DOB, home location, video URLs,
integrity internals or guardian identity. For minors the guardian controls
sharing, requests and clips; the agency/minor wall, radius and blocks all
hold. No home-background analysis, no faces, no audio, no scene recognition.

## 18. Integrity / anti-cheat

Reuses Box Cam integrity in full, plus Combine-specific bindings: protocol
version binding, calibration binding, attempt-number binding,
measurement-window validation, attempt limits, and no practice→verified
upgrade. Clients cannot submit a measured value, a Combine state or a
provenance. A canonical `combineResultHash` covers player, attempt,
protocol@version, bound session, the accepted metric input, measured value,
provider/version, algorithm version, completion time and integrity state
(provenance metadata — not a blockchain).

## 19. Disputes / Trust & Safety

A Combine result is reviewed through its **bound Box Cam session** (existing
dispute → T&S invalidate/restore tooling). Combine results reflect that
**live**: an invalidated session immediately drops Combine Verified
everywhere (Personal Best, Combine Card, Passport); a restore brings it back
with history preserved. T&S can invalidate or restore — it can **never** type
a replacement number.

## 20. Future physical protocols

5-10-5 agility, 10 m acceleration, standing broad jump, vertical jump, slalom,
passing/first-touch targets are architected as versioned protocols with
`measurementCapability: not_configured` and (mostly) practice disabled. They
require a **Box Marker** and a real spatial/timing detector; until one ships,
they honestly report *not yet supported* and can never be Combine Verified.

## 21. Limitations (honest)

No production computer-vision model, no automated timing gates, no physical-
scale measurement and no target-zone detection exist in this environment. The
web provider verifies presence + active duration only. So **no first-library
Combine is production-verified here today** — all are exercised through the
clearly-labelled simulated test provider (demo) and honestly report "not yet
supported on this device" in production. Native iOS/Android capture is not
implemented or tested. At-Home Combine records standardised measurements; it
is not a talent score and implies no ScoutBox endorsement.

## Test coverage

- `scoutbox-server/scripts/m161E2E.mjs` — **79 checks, 39 negative/abuse
  (49%)**: pure-engine registry/measurement/PB/comparison fixtures, live
  journeys C1–C10, and the §76 abuse catalogue (forged value/state/provenance,
  protocol spoof, cross-player access, nonce/replay via the bound session,
  duplicate terminal, attempt limits, unsupported/incomplete measurement,
  agency/minor, blocked/suspended clubs, protocol-immutability, hash).
