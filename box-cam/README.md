# Box Cam

The basis for Box Cam's video analysis, which is being rebuilt as a separate application, outside the ScoutBox
API, using proper computer-vision tools (OpenCV, and possibly a learned detector).

A player props up a phone, trains a supported drill, and ScoutBox records what it observed (active time, touches,
juggles) as evidence on their Passport. This directory holds what the first implementation learned. It contains
no code yet.

**The governing rule:** a refused measurement is acceptable; a falsely verified one is not.

## Status

- The TypeScript engine (`scoutbox-server/domains/development/boxcam/cv/`) was a hand-written classical pipeline.
  It only ever ran on synthetic scenes (a bright disc and a dark rectangle on noise). **No real football video has
  ever been observed by it.** Its last version is at the git tag `box-cam-ts-final`. Read a file from there with
  `git show box-cam-ts-final:scoutbox-server/domains/development/boxcam/cv/<file>`.
- The ScoutBox API keeps everything that is data: sessions, nonces, liveness challenges, drills, assignments,
  challenges, Combine protocols and attempts, disputes, and the stored CV results. In the Gleam server the CV
  routes are a stub that answers `503 provider_unavailable`.
- Every protocol's real-world validation is `not_completed`, so nothing can be "Combine Verified".

## Decided

- The phone talks to the CV app directly, with a short-lived token the API issues. Frames don't pass through
  the API. See [`docs/architecture.md`](docs/architecture.md).
- The CV app handles pixels only. Frames go in; an observation or a typed refusal comes out. It stores nothing
  durable, knows no players, and makes no Passport or Combine decisions.

## Contents

| Path | What it holds |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | The split between the API and the CV app, the job flow, and notes on OpenCV and determinism |
| [`docs/contract.md`](docs/contract.md) | What the API expects from a CV result today: routes, states, result schema, error codes, version triple |
| [`docs/domain.md`](docs/domain.md) | Combine protocols, drills, event definitions, attempt rules, session results |
| [`docs/starting-values.md`](docs/starting-values.md) | The old engine's thresholds and the reasoning behind each. Tuned on synthetic data only |
| [`docs/lessons.md`](docs/lessons.md) | What went wrong and what was learned: zoom false touches, timestamp trust, cadence limits, known defects |
| [`docs/privacy.md`](docs/privacy.md) | Frame minimisation, minors, consent, retention, what must never be inferred |
| [`docs/validation.md`](docs/validation.md) | The pre-registered real-world validation plan: the binding protocol for ever enabling Combine Verified |
| [`spec/`](spec/) | JSON snapshots of the old server's constants: protocols, drills, states, copy, policy, provider errors |
| [`fixtures/`](fixtures/) | The synthetic evaluation and holdout results, with the case lists ([`fixtures/README.md`](fixtures/README.md)) |

`spec/` is a copy of `scoutbox-server/e2e/support/spec/development/boxcam/`, which the e2e batteries check
both servers against. Where the two disagree, the API's copy is the contract and this one is history.
