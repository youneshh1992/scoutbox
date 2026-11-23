# Box Cam domain

What the product measures, independent of how. The full definitions, including player-facing copy, are in
[`../spec/combineShared.json`](../spec/combineShared.json), [`../spec/drills.json`](../spec/drills.json) and
[`../spec/shared.json`](../spec/shared.json).

## Two separate claims

- **Box Cam observed** (a Box Session). "Box Cam observed activity consistent with this drill for the recorded
  duration." This is evidence of recorded training, not of ability.
- **Combine Verified** (a Combine Attempt). A standardised measurement from a versioned protocol, taken in a live
  Box Cam session by a supported detector, which passed the integrity checks. It is reachable only when a
  real-world validation record exists for that protocol and matches the running engine, policy and freeze versions.

Keep these separate. The old server had two capability lists, one for observation and one for Combine, and a
result that is fine for the first can still be refused for the second.

## Combine protocols

Each has an `id@version`, a metric type and unit, a direction, a precision, a 60 s window, start and finish rules,
and setup, camera, space and equipment requirements. Capture contexts: `at_home`, `club`, `event`.

| Protocol | Measures | Camera | Space |
| --- | --- | --- | --- |
| `combine-box-touch-60` (Box Touch 60) | Verified, de-duplicated touches on top of the ball in 60 s (count, integer) | Portrait, about 2.5 m, whole body and ball visible | 2 × 2 m, level |
| `combine-box-juggle` (Box Juggle) | Total verified juggles in 60 s (count, integer). The maximum consecutive run is **not** measured: no reliable detector | Portrait, about 3 m, high ceiling or outdoors | 2 × 2 m |
| `combine-box-control-60` (Box Control 60) | Active close-control seconds while the ball is visible, inside 60 s (duration, tenths) | Landscape, about 4 m, whole area visible | 3 × 3 m, level |
| `combine-box-footwork`, `combine-box-strength-60` | Defined, but the CV engine has no rule for them | | |
| 5-10-5 agility, 10 m acceleration, broad jump, passing target | Future. They need `spatial_scale`, `timing_gate` or `target_zone` capabilities, which nothing provides, plus probably a physical Box Marker | | |

Attempt rules:

- At most **3 verified attempts per 24 hours** per protocol. Practice attempts are allowed and never count as
  verified.
- A window that wasn't fully observed is `partially_measured`. A value is **never projected or estimated**.
- An attempt is bound to a Box Session and inherits that session's liveness and integrity.
- Combine states: `not_started`, `setup_required`, `ready`, `attempt_in_progress`, `processing`,
  `combine_verified`, `partially_measured`, `measurement_unavailable`, `protocol_invalid`, `integrity_review`,
  `invalidated`, `cancelled`.
- Only a production-valid Combine result can satisfy a development-plan target. Box Cam sessions and
  assessments cannot.

## Event definitions

These are for human annotators, so they define the ground truth the engine is measured against. They come from
[`validation.md`](validation.md) §7, which is binding.

- **Touch.** Foot or lower-leg contact that changes the ball's motion and is separable from the previous touch.
  Continuous contact counts once.
- **Juggle.** The ball is airborne before and after the contact. Foot, thigh or head. A ground touch ends the
  attempt.
- **Control.** Time during which the player is in close control of a visible ball. There are no events, only
  active time.

How the old engine operationalised these:

- A touch was a contact state machine. The ball enters contact range (a distance measured relative to the
  player), stays in range for a minimum time, then shows a velocity impulse. That emits **exactly one** event.
  The ball must then move a minimum distance away from the point where it was struck before another touch
  counts, followed by a refractory period. So prolonged contact counts once, rapid touches stay distinct, and a
  dropped frame can't double-count.
- A juggle was a vertical reversal of the ball (falling in, rising out) followed by a minimum flight. It was
  explicitly **not** a count of vertical peaks.

The values are in [`starting-values.md`](starting-values.md).

## Drills and Box Sessions

There are 8 versioned drills: `box-touches`, `box-control`, `box-juggles`, `box-wall`, `box-footwork`,
`box-mobility`, `box-strength`, `box-interval`. Each declares the capabilities it can verify, its setup, and a
minimum gap between reps (touches 180 ms, juggles 300 ms, strength 900 ms). Rep counting for wall passes is
declared unreliable from a single camera angle.

How a session runs:

- The server mints a session, a nonce and a **liveness challenge**: `raise_right_hand`, `show_ball`,
  `left_foot_touch` or `step_into_zone`. Liveness proves presence, not identity.
- Observation batches arrive in sequence: `active`, `presence`, `ball`, `rep`, `set`, `pause`, `interruption`,
  `multi_person`.
- The result is derived on the server:
  - `verified`, `partially_verified`, `unable_to_verify` or `completed_unverified`;
  - also `cancelled`, and `invalidated` (by Trust & Safety, who can restore it).
- Session quality is `good` when at least 75% of the duration was observed, and `degraded` from 20%.

The providers:

- `production_cv`: the real CV.
- `web_client`: presence and activity inferred from the camera stream being available and the app being in the
  foreground. It cannot count reps.
- `local_test`: test only, always labelled simulated.

There is no silent fallback from `production_cv` to `web_client`.

## Capabilities

- The engine could offer `player_presence`, `ball_presence`, `active_motion`, `active_duration` and `rep_count`.
- It declared these as **not** offered:
  - foot or limb classification
  - technique signals
  - work/rest interval structure
  - timing gates
  - real-world distance from camera geometry
  - target zones

Declaring what you can't do is part of the contract. Keep it.

## Copy rules

- A refusal describes the observation, not the player: "Could not verify this attempt — …", never "you failed".
  The approved strings are in `spec/cv/policy.json` and the `STATE_COPY` blocks.
- Confidence is model certainty. It is **never** shown as a player-quality figure. The old suite scanned UI copy
  for phrasings like "player confidence" or "80% ability".
