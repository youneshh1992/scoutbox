# Starting values

These are the old engine's thresholds, with the reasoning recorded for each. **They were tuned on synthetic scenes
only.** Treat them as a starting point and a record of what each knob is for, not as validated values. The
sources are `policy.mjs`, `quality.mjs`, `engine.mjs`, `detect.mjs` and `track.mjs` at the tag
`box-cam-ts-final`. The machine-readable subset is in [`../spec/cv/policy.json`](../spec/cv/policy.json).

The old policy had one rule worth keeping: **every threshold lives in one versioned policy.** The evaluation
harness asserts it, so a value can't be relaxed to make a test pass without showing in a diff and in a measured
result. A rule change that could change a count bumps the engine version, and a stored result keeps the version
that produced it.

## Units

Distances are in **ball diameters** and times in **milliseconds**. With the ball as the ruler and seconds as the
clock, the same scene gives the same numbers at any resolution or frame rate.

Ball positions are taken **relative to the player's region**, which cancels camera motion. (Zoom does not cancel
this way; see [`lessons.md`](lessons.md).)

## Touch rules

| Rule | Value | Why |
| --- | --- | --- |
| Contact range (ball centre to nearest edge of the player region) | ≤ 1.2 d | About one ball width, allowing for an imprecise silhouette. At 5 d the false-touch suite counted touches on a ball nobody went near |
| Minimum impulse (change in velocity, relative to the player) | ≥ 4.5 d/s | |
| Minimum dwell in range before an impulse counts | 120 ms | A ball that jumps from far to adjacent is a detector artefact, not a strike |
| Minimum move away from where the ball was struck, before another touch | 0.35 d | The spatial half of the debounce: a ball resting against a foot outlasts any timer. At 1.2 d toe-taps latched the machine, and a 14-touch attempt counted 1. If the false-touch suite fails, narrow the supported pace rather than raise this |
| Refractory after a touch | 180 ms | The temporal half: two contacts closer than this are one contact seen twice |
| Ball distance from the frame edge | ≥ 0.5 d | A ball touching the edge has an unreliable centroid |
| Fastest supported touch pace | 340 ms between touches | Measured: within tolerance at 340 ms, under-counts at 260 ms |
| Maximum share of impulses suppressed by the refractory | 25% | Above this, refuse as `unsupported_event_cadence` rather than under-count. Counted from observed impulses, not emitted touches |

## Juggle rules

| Rule | Value | Why |
| --- | --- | --- |
| Refractory | 300 ms | |
| Minimum flight after a contact, relative to the player | ≥ 0.9 d | So a resting ball's jitter doesn't count |

## Gaps and continuity

| Rule | Value | Why |
| --- | --- | --- |
| Largest gap bridged | 4 frames **and** 400 ms | Both limits apply. The frame count is the tracker's tolerance and the ms limit the physical one (4 frames is 133 ms at 30 fps, but 500 ms at 8 fps). Over the limit, the interval is ambiguous: no interpolation |
| Total time the ball may be missing | ≤ 25% | |
| Ball-size change that resets the track | > 2.2× | |
| Change in apparent player-region size per sample | ≤ 4% | Derived. Scaling by `s` moves a stationary ball by `(s-1)·|rel|`, a fake velocity of `(s-1)·(|rel|/d)/dt` d/s. That must stay under 4.5 d/s at 30 fps with `|rel|/d ≈ 3.5`, so `s-1 < 0.043`. A one-pixel edge wobble is about 1.1%. An identity-style 1.4× test let an 18% zoom manufacture a touch |
| Jump in the player region's centre per sample | > 0.5 × box width counts as a jump | |
| Rival blob counted as a second ball | ≥ 0.6 × the primary's area | |

## Observation quality

These describe the capture, never the count or the player. The count is not an input, so it can't rescue a bad
capture.

| Check | Threshold |
| --- | --- |
| Usable frames | ≥ 80% |
| Frames with a tracked ball | ≥ 75% |
| Frames with a located player | ≥ 60% |
| Duplicate frames | ≤ 35% |
| Track resets | ≤ 3 |
| Ambiguous contact decisions (as a share of all decisions, so a short attempt isn't flattered) | ≤ 15% |
| Effective fps (median interval, with at least 3 intervals) | ≥ 12 |
| Share of the attempt below 12 fps | ≤ 20% |

## Confidence

Confidence is model certainty and is never shown as player quality.

| Check | Threshold |
| --- | --- |
| Aggregate confidence | ≥ 0.62, otherwise `insufficient_confidence` |
| Per-event confidence | ≥ 0.5, otherwise the event doesn't count |
| Frames with the ball detected at usable confidence | ≥ 70% |

## Engine hard refusals

| Condition | Reason |
| --- | --- |
| No frames analysed | `ball_not_detected` |
| Fewer than 10 distinct analysed frames | `protocol_violation`. Otherwise a still photo held to the lens reduces to one frame that passes every later check |
| More than 50% duplicate frames | `protocol_violation` |
| A static run of 6 or more frames (mean inter-frame difference < 1.2) | `protocol_violation` (a frozen stream or a photo) |
| More than 30% of frames unusable | `insufficient_visibility` |
| Player found in fewer than 50% of frames | `person_not_detected` |
| A rival ball in more than 10% of frames | `protocol_violation` |
| Mean luma < 28, or luma standard deviation < 3 | Frame unusable (too dark, or a covered lens). The deviation floor is kept low so a plain wall behind a well-lit player isn't refused |

## The old detector (throwaway, recorded for comparison)

- **Ball:**
  - Threshold at `min(250, mean + max(40, 1.6σ))`.
  - Take 4-connected components, at most 64.
  - A candidate covers 0.08–5% of the frame and has roundness of at least 0.55 (fill × aspect).
  - Confidence = `0.8·roundness + 0.2·min(1, σ/40)`.
- **Person:** the bounding box of pixels that aren't bright and deviate from the mean by at least `max(12, 0.8σ)`,
  covering at least 1% of the frame.

This works only on synthetic geometry. A real ball against a white trainer, or a player against a cluttered
room, needs real detection.
