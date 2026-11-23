# Synthetic fixtures

These are the old engine's measured results on **synthetic rendered scenes** (a bright disc and a dark rectangle
on noise). They are not footage. Neither file evidences real-world counting accuracy, and both say so in
`realWorldValidationNote`.

Each case is a set of parameters for the scene generator, and the generator and harness are at the tag
`box-cam-ts-final` (`scoutbox-server/domains/development/boxcam/cv/`):

- the scenes are drawn by `scenes.mjs`
- the cases are defined in `fixtures.mjs`, `families.mjs` and `holdout.mjs`
- `freeze.mjs` hashes the source and constants

To reuse a case, port the generator, or render its frames from the tag once and keep them as files.

## `evaluation.json` (engine v2, policy v1)

- **14 golden fixtures (G1–G14)**: valid touch and juggle attempts, plus no ball, no person, low light,
  occlusion, two balls, two people, a static image, a frozen stream, dropped frames, camera shake and duplicate
  frames.
- **39 family variants** in 13 families: resolution, fps, ball scale, contrast, background, silhouette, camera,
  pace, texture and jitter. An invariance break is a failure.
- **20 false-touch stress cases (FT01–FT20)**: every one must give zero touches.
- Headline: 0 false verifications, 0 nondeterministic results, 57% refusal rate.

## `holdout.json`

- Seeds disjoint from development, and unseen parameters (resolutions 176–288 px, 16/22/29 fps).
- **HT01–HT20 stress cases**: zoom pulses and steps, a player walking toward the camera, clipping at the frame
  edge.
- `generations` records how generations 1 and 2 were consumed after finding P0 false touches from camera zoom.
  [`../docs/lessons.md`](../docs/lessons.md) summarises it.

## Gate criteria the old engine used

These are synthetic and come from `gate.mjs`:

- 0 false verifications
- 0 nondeterministic results
- mean count error ≤ 1, maximum ≤ 2
- 100% correct verdicts

On top of all of that, real-world validation per [`../docs/validation.md`](../docs/validation.md).
