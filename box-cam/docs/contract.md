# The API ↔ CV contract

This page describes the contract **as the old server had it**. Frames came through the API, which ran the engine
in-process. In the new design the phone uploads a recording to object storage and the CV app reads it from there
(see [`architecture.md`](architecture.md)), so the transport changes. The result, the refusal vocabulary, the
version triple and the security properties carry over.

The source files are at the tag `box-cam-ts-final`, under `scoutbox-server/domains/development/boxcam/cv/`:
`routes.mjs`, `provider.mjs`, `frames.mjs` and `policy.mjs`.

## Routes on the API today

All are on the authenticated player router. Every one is nonce-bound and rate-limited, and refuses
client-supplied result fields.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /player/box-cam/sessions/:id/cv/begin` | `{nonce, protocolId}` | `201 {providerSessionId, state, protocolId, frameLimits, encoding, combineVerifiedEligible: false, combineDisabledReason}` |
| `POST …/cv/frames` | `{nonce, providerSessionId, frames: [{encoding, seq, atMs, w, h, data, capturedAtMs?}]}` | `{accepted, lastSeq, framesAccepted, droppedByServer, queueDepth}` |
| `POST …/cv/finalize` | `{nonce, providerSessionId?, protocolWindowMs?}` | `{result, alreadyFinalized, boxCamObserved, provenance, combine, combineDisabledReason}`. Single-shot and idempotent: a second call returns the **same** result |
| `POST …/cv/cancel` | `{nonce, providerSessionId}` | `{cancelled: true, result: null}` |
| `POST /player/box-cam/cv/ready-check` | device and capture facts | Structured checks, `observationReady`, `combineVerificationAvailable` (reported separately) |
| `GET /admin/box-cam/cv/results/:psid` | | Trust & Safety diagnostics only |

Preconditions for `begin`:

- The Box Session is `recording` and not expired.
- Liveness has passed.
- The session is bound to `production_cv`.
- The protocol is one the engine has a rule for. There is no fallback for an unsupported protocol.

In the Gleam server these routes keep every check above. They then answer `503 provider_unavailable`, and the
Ready Check reports the provider as unavailable
(`scoutbox-gleam/scoutbox-server/src/scoutbox/development/cv_stub.gleam`).

## Frames

- **Encoding:** `gray8` only. A raw 8-bit luminance plane, `w × h` bytes, row-major, base64 in transit. With no
  image parser there is nothing to attack, and a malformed payload is just a length mismatch.
- **Sizes:** 160×120 up to 320×240 (at most 76,800 bytes per frame).
- **Limits:**
  - at most 12 frames per batch
  - a bounded queue of 24 frames; frames beyond it are dropped, not buffered
  - 120 batches per session
- **Sequencing:** `seq` is at least 1 and strictly increasing. Duplicates are caught by a sha256 of the bytes.
  There is no reorder window.
- **Capture requirements, checked at Ready Check:**
  - 6–30 fps nominal, and at least 12 fps sustained
  - at most 20% of the attempt below 12 fps; an interval counts as low only if it is more than 15% over nominal,
    so integer-millisecond jitter is tolerated
  - landscape or portrait
  - web only

The frame format is the first thing the new app should reconsider. 320×240 grey leaves the ball only a few pixels
wide at 2.5–3 m, and throws colour away. Changing it is a bandwidth and privacy decision as well as a technical one.

## Provider session state machine

`created → ready → running → finalizing → accepted | refused`. It can also end as `cancelled`, `expired` or
`failed` from any non-final state. The TTL is 5 minutes, with at most 16 concurrent sessions per provider.
State is dropped on finalize, cancel or expiry.

## Errors

From `spec/cv/provider.json`, with their HTTP statuses:

| Code | HTTP | | Code | HTTP |
| --- | --- | --- | --- | --- |
| `frame_too_large` | 413 | | `queue_overflow` | 429 |
| `unsupported_frame_format` | 415 | | `rate_limited` | 429 |
| `invalid_frame_dimensions` | 422 | | `session_not_found` | 404 |
| `duplicate_frame` | 409 | | `invalid_state` | 409 |
| `out_of_order_frame` | 409 | | `already_finalized` | 409 |
| `session_expired` | 410 | | `unsupported_protocol` | 422 |
| `nonce_invalid` | 403 | | `client_field_refused` | 422 |
| `provider_unavailable` | 503 | | `provider_busy` | 503 |
| `engine_failure` | 500 | | | |

A client that sends any measurement-shaped field is refused with `422 client_field_refused`, by name, so that an
attempt to self-report shows up in a log. The fields are `touches`, `count`, `confidence`, `verified`, `score`
and the rest of `FORBIDDEN_CLIENT_FIELDS` in `spec/cv/policy.json`. Keep this on the CV app's frame endpoint too.

## The result

The CV app returns exactly this, and the API stores it as one row of `box_cam_cv_results`. The table's DDL is in
`scoutbox-gleam/scoutbox-server/priv/migrations/0031_box_cam.sql`.

```
sessionId, providerSessionId, protocolId, providerId,
providerVersion, engineVersion, cvPolicyVersion          // the version triple (plus freeze hashes; see below)
outcome: accepted | refused
refusalReason, refusalDetail                             // one primary reason, chosen by the engine's precedence
observationQuality: { sufficient, state, aggregateConfidence, coverage,
                      reasons: [{code, value, threshold}], secondaryDiagnostics: [code] }
derived: { personPresent, ballPresent, touchCount, juggleCount, activeDurationMs }
experimental: { exactCount, status: 'experimental_unvalidated', note }
integrity: { ok, framesAccepted, framesRejected, framesDroppedByServer, duplicatesRejected,
             outOfOrderRejected, clientClockAnomalies, framesAnalysed, duplicateFrames,
             effectiveFps, maxBallGapMs, nonceBound, serverTimeline }
trace: [{atMs, confidence}] (at most 256), traceTruncated
serverStartedAt, serverEndedAt, serverDurationMs
combineVerified: false, combineVerifiedBlockedBy: 'REAL_WORLD_VALIDATION_NOT_COMPLETED'
```

Rules attached to the result:

- **No pixels in a result:** no frame content and nothing derived from one pixel-wise. Only counts, presence,
  durations and bounded timestamps.
- `personPresent` and `ballPresent` come from the integrity counters (detected in at least 50% of analysed
  frames), not from acceptance. So a refused attempt still says what was seen.
- An unvalidated count travels only as `experimental.exactCount`. It never reaches Trust, matching facts or
  development targets.
- `combine_verified` is held at 0 by a CHECK constraint in the table. Lifting that is a migration and a named
  decision, not a config value.

## Refusal vocabulary and precedence

Failures usually come together: a dark capture has no visible ball either. So the engine reports one primary
reason, chosen by a fixed order, and lists the rest as secondary diagnostics. The order follows what a person can
act on: provider, then device, light, scene, technique.

1. `provider_unavailable`
2. `unsupported_protocol`
3. `session_invalid`
4. `liveness_failed`
5. `unsupported_device`
6. `unsupported_event_cadence`
7. `insufficient_frame_rate`
8. `insufficient_visibility`
9. `protocol_violation`: a static image, duplicates, a second ball or a second person
10. `person_not_detected`
11. `ball_not_detected`
12. `observation_discontinuity`
13. `insufficient_confidence`

Quality reason codes map onto these:

| Quality code | Refusal reason |
| --- | --- |
| `low_usable_frame_ratio` | `insufficient_visibility` |
| `low_ball_continuity` | `ball_not_detected` |
| `low_person_continuity` | `person_not_detected` |
| `high_duplicate_frame_rate` | `protocol_violation` |
| `insufficient_frame_rate`, `frame_rate_dropped_too_often` | `insufficient_frame_rate` |
| `long_occlusion`, `excessive_track_resets`, `ambiguous_contact_intervals` | `observation_discontinuity` |

## Versions and the validation gate

Every result carries `engineVersion`, `cvPolicyVersion` and `providerVersion`. The old engine also hashed its
constants and layer source (a "freeze") before a holdout run.

Combine eligibility for a protocol requires a **real-world validation record**, held in server-side release
configuration. It is never read from a client, a request or a provider payload. The record has these fields:

```
protocolId, cvPolicyVersion, providerVersion, engineVersion,
datasetId, datasetVersion, result: 'passed', approvalVersion, approvedAt
```

A record made against an older engine or policy doesn't transfer to a newer one. Enabling Combine Verified needs
all of the following:

- a configured, healthy provider
- the required capabilities
- a passing synthetic evaluation
- a current passing validation record
- independent and Trust & Safety review
- a named, recorded decision
- a separate config change

The old `combineProductionGate` battery proved the gate was real, not merely inert. It injected a test-only
passing record, showed the same stack would then mint a verified result, and checked that no environment
variable could open the gate.

## Security properties the old batteries proved

These checks were in `boxCamCvProvider.mjs` §85 at the tag. They remain requirements, now split between two
sides:

- **The API**, when it issues the upload URL and hands over the job: 1–6, 13 (as a rate limit on `begin`),
  15–19.
- **The CV app**, when it reads the recording: 7–12 (sequence and ordering apply to the frames inside it), 14 (its
  job queue), and 15–18 (it refuses an expired, closed or reused job id).
- **Both:** 20.

1. An unauthenticated frame is rejected.
2. Another player can't send frames to the session.
3. A provider session can't be attached to a different Box Session.
4. An unknown provider session id is not found.
5. Another session's nonce is rejected.
6. A forged nonce is rejected.
7. A duplicate sequence number is refused.
8. An out-of-order frame is refused.
9. A frame whose declared size doesn't match its payload is refused.
10. Unsupported dimensions are refused.
11. A malformed payload is refused.
12. An unsupported encoding is refused. A multipart body never reaches frame handling.
13. An extreme ingest rate is refused.
14. Queue saturation is refused (the batch cap).
15. An expired session is refused. Also: measurement fields are refused by name.
16. Frames for a finalized session are refused.
17. Frames for a cancelled session are refused.
18. A reused old session id is refused.
19. A session belonging to another player is refused.
20. Data from another organisation never leaks.

The same batteries also checked these:

- No raw frame is persisted anywhere: not in the database, logs or files. With recordings in object storage, this
  becomes the retention rule in [`privacy.md`](privacy.md).
- A provider crash, an engine exception, an overflow or a restart leaves no half-written result.
- The expensive endpoints are rate-limited.
- Concurrent sessions are isolated, and a pooled tracker never leaks state between sessions.
