# Privacy and safeguarding

Many Box Cam users are minors. These rules were settled in the old implementation and its documents
(`docs/product/passport-development.md`, `docs/decisions.md`, and [`validation.md`](validation.md) §11–§12), and
they bind the rebuild.

## Frames

- **Frames are never persisted or logged.** They are analysed and dropped. A test must prove it for the database,
  logs and files: the old `boxCamCvProvider` battery §37/§92 did.
- A result holds no frame content and nothing derived from one pixel-wise. It holds only counts, presence,
  durations and timestamps, with a trace of at most 256 events.
- All of the CV app's job state is dropped on finalize, cancel or expiry. The app stores nothing durable and knows
  no players.
- Keep frames minimal. The old format was grey, at most 320×240. A higher resolution or colour is a privacy
  decision, not just a technical one.

## Never inferred

The following are never inferred:

- faces or identity
- biometrics
- audio (none is captured)
- emotion
- medical or injury state
- demographics
- comparisons between players

The engine **declares** these absences, and so should the new app. Liveness proves presence, not identity.

## Minors and consent

- A minor's Box Cam preferences are controlled by their guardian. The defaults are `private` and
  `retainClips: false`.
- Club assignments carry results, never footage. A guardian accepts them on a minor's behalf.
- A trial's Box Cam footage is referenced by the trial, not promoted to the Passport.
- **Open:** legal review of consent for trial footage and for observing minors, and whether event consent should
  name Box Cam. It is needed before Box Cam is used at trials with minors (`docs/decisions.md`, open questions).
- CV live events are private to the player and carry no counts.

## Validation data

From [`validation.md`](validation.md):

- adults only
- no production footage
- written consent, with deletion on withdrawal
- video kept for at most 12 months
- diversity is recorded per session as capture conditions, never as demographics

## Copy

- A refusal describes the observation, never the player.
- Confidence is model certainty, never a quality, talent or ability figure.
- "This is evidence of recorded training activity. It is not proof of player ability."
