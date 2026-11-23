# Lessons

What the first implementation got wrong or found out the hard way. Paths refer to the tag `box-cam-ts-final`.

## Camera zoom manufactures touches

This is the most valuable finding. Two holdout generations were used up on it, and the record is in
[`../fixtures/holdout.json`](../fixtures/holdout.json) under `generations`.

1. **Generation 1** found a P0 false touch: case HT05, an 18% zoom pulse.
   - The cause: the tracker differenced player-relative positions in pixels and divided by a single ball
     diameter, so a global scale change left a residual velocity.
   - The fix: normalise each sample by its own ball diameter before differencing.
2. **Generation 2** pushed harder on the same axis and found three more P0 false touches: HT13 (step zoom in),
   HT14 (step zoom out) and HT15 (repeated pulses).
   - A step zoom also clips the player region at the frame edge. That moves the origin in a way no global
     transform describes.
   - The generation 1 fix had also quietly cost accuracy. Dividing by each sample's own diameter amplifies the
     diameter estimate's noise by `|rel|/d`, about 3.5×. At the smallest frame size that manufactured two extra
     touches and broke resolution invariance.
3. **The fix that held** was structural: a derived per-sample bound on how much the player region may change size
   (4%; the derivation is in [`starting-values.md`](starting-values.md)). One test catches camera zoom, a player
   walking toward the camera, and edge clipping, without touching the velocity computation.

Lessons for the rebuild:

- Any motion measured relative to a detected region inherits that region's instability. Bound it explicitly.
- A fix that makes one invariance exact can break another. Re-run the whole invariance suite on every fix.
- A holdout case used for diagnosis is now development material. Replace it, don't reuse it.

## Pace and the refractory window

Fast toe-taps are the hard case. A spatial separation threshold that is too large latches the state machine: at
1.2 diameters, a 14-touch attempt counted 1. A refractory that is too long silently under-counts.

The old engine measured where accuracy fails: correct to 340 ms between touches, under-counting at 260 ms. It
declared that limit, and it **refused** attempts above it (when more than 25% of impulses were suppressed) rather
than reporting a low count. Publish the supported envelope; refuse outside it.

## Don't trust the client's clock

The documented rule was "client timestamps are never used", but the engine ran on the client-supplied `atMs`
(`frames.mjs:71`). The server recorded `clientClockAnomalies` and still used the client's timeline. A tampered
clock can stretch or compress a window.

With direct upload, the CV app should timestamp frames on arrival or check client time against the arrival
cadence. It must declare in the contract which one it does.

## The app and the server disagreed on the frame envelope

The Player app's `captureFrame` (`scoutbox-player/src/data/m22client.ts`) never sent `atMs`, which `decodeFrame`
required. So every real frame from the app was refused, and the CV path only ever ran from test batteries. Pin the
envelope in one shared definition, with a conformance test run by both the client and the CV app.

## "Box Cam observed" was effectively self-attested

The Player app uses the `web_client` provider:

- It echoes the server's liveness challenge back without the player doing anything; the server only
  string-compares it.
- It posts "presence good / active good" intervals from a 3-second timer.
- That is enough for a session to be `verified`. The Passport and Trust read that state, and completed challenges
  reach recruiters labelled `box_cam_observed`.

The CV result was stored separately, and only the trial panel read it; it never fed the session's `verifiedReps`
(`sessions.mjs:430`). This contradicts the rule that client data can never produce `box_cam_observed`.

How non-CV sessions should be labelled (self-reported?) is an open product decision for the Founder.

## The freeze hash missed code

The freeze hashed the constants and layer source before a holdout run, so a result could be tied to exact code.
Its comment stripper dropped every line starting with `*`, including code lines (`freeze.mjs`, `strippedSource`).

Hash the built artefact, or the source unmodified. Don't hash a "normalised" source.

## Synthetic results say little about real video

The synthetic evaluation got 0 false verifications with a 57% refusal rate (14 golden fixtures, 39 family
variants, 20 false-touch stress cases). That shows determinism and refusal behaviour, and says nothing about real
counting accuracy. The evaluation file says so itself.

The synthetic suite is still worth keeping as a regression suite for refusal behaviour and invariance: no ball,
no person, two balls, a static image, frozen frames, duplicates, shake and zoom. Real-world accuracy comes only
from [`validation.md`](validation.md).

## Platform gaps

- **Web only, Chromium only.** There is no native capture.
- **Virtual-camera replay** can't be detected in a browser and must be disclosed. Native capture is the
  mitigation.
- **Determinism.** The old engine was byte-for-byte deterministic. OpenCV results can vary across CPUs, SIMD
  paths, IPP and thread counts. Either pin the build, run single-threaded and disable IPP/OpenCL in the
  measuring path, or move the conformance suite to tolerances and state that in the policy version.
