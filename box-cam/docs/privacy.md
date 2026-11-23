# Privacy and safeguarding

Many Box Cam users are minors. These rules were settled in the old implementation and its documents
(`docs/product/passport-development.md`, `docs/decisions.md`, and [`validation.md`](validation.md) §11–§12), and
they bind the rebuild.

## Recordings and frames

- **A recording is held only in object storage, and only for as long as its job.** The phone uploads it with a
  signed URL for one job's key. It is deleted when the job is finalized, cancelled or expires, and a lifecycle rule
  deletes anything left behind within 24 hours. It is never written to the database, the logs, or either app's
  disk, and the CV app reads it only through a short-lived signed URL.
- Tests must prove it: the object is gone after finalize, cancel and expiry, and no frame reached the database,
  logs or files. The old `boxCamCvProvider` battery §37/§92 proved the last part, when frames were never stored at
  all.
- A result holds no frame content and nothing derived from one pixel-wise. It holds only counts, presence,
  durations and timestamps, with a trace of at most 256 events.
- All of the CV app's job state is dropped on finalize, cancel or expiry. The app stores nothing durable and knows
  no players.
- **A recording shows no more than counting needs.** The old format was grey, at most 320×240. A format may carry
  more resolution if it shows less: for example a video rendered on the device by object tracking that shows only
  silhouettes of the player and the ball, with no face or surroundings. Each format, and any change to resolution,
  colour or what is visible, is a privacy decision recorded in the contract, not just a technical one.

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
