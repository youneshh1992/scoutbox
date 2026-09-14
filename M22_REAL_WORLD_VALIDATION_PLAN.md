# M22 — Real-World Validation Plan

**Status: NOT STARTED. No real football video has been observed by this engine.**

This document is the plan for work that has not been done. It exists now, before
the data exists, because a validation protocol written after seeing the results
is not a protocol — it is a rationalisation. Every threshold, definition and
stopping rule below is declared in advance so that a future run can only pass or
fail against them, not negotiate with them.

Nothing in this document authorises collection. It specifies what collection
would have to look like.

---

## 1. Purpose, and the exact claim at stake

Box Cam's synthetic evaluation (`m22/evaluation.json`) and its holdout
(`m22/holdout.json`) establish real properties: the engine is deterministic, it
is invariant to resolution, frame rate, ball scale, photometry and camera
motion, it refuses what it says it will refuse, and across 56 adversarial scenes
it has never counted a touch that did not happen.

None of that is evidence for the claim production would actually be making:

> **This number is how many times this player touched this ball.**

That claim is about real football — a real ball on a real surface, a real person
in real clothing, in a real room or a real park, filmed on a real phone. The
fixtures are rendered geometry produced by the same scene model the engine was
developed against. They can show the engine is honest about its own rules. They
cannot show that its rules describe football.

The purpose of this plan is to close exactly that gap, for one protocol at a
time, or to demonstrate that it cannot be closed at acceptable quality — which
is an acceptable outcome (§168) and the current expected one.

**A protocol that has not completed this plan cannot be Combine Verified in
production.** That is enforced in code, not policy: `m22/gate.mjs` reads
`m22/validation.mjs` independently of the evaluation artefact, so a synthetic
result cannot assert its own real-world validity.

---

## 2. Scope

Three candidate protocols, validated **separately**. Passing one grants nothing
to the others — the events differ, the failure modes differ, and a juggle is not
a fast touch.

| Protocol | Event | Status |
|---|---|---|
| `combine-box-touch-60` | touch | not_completed |
| `combine-box-juggle` | juggle | not_completed |
| `combine-box-control-60` | duration | not_completed |

Out of scope, permanently and by design: player quality, potential, ceiling,
comparison between players, identity recognition, face or body biometrics,
emotion, and medical or injury inference. This plan validates **counting**.

---

## 3. Dataset staging

Three datasets, created and separated **before any of them is analysed**.

| Stage | Purpose | May be looked at | May be tuned against |
|---|---|---|---|
| **Development** | Diagnose failures, fix the engine, iterate freely | yes, repeatedly | yes |
| **Validation** | Check a candidate build before spending the holdout | yes, a small number of times | **no** |
| **Final holdout** | The single measurement that decides the gate | **once** | **never** |

Rules that make the staging real rather than nominal:

1. **Split by SESSION, never by clip.** Two clips from the same session share a
   room, a light, a ball, a phone and a person. Splitting by clip puts near-copies
   on both sides and inflates the holdout score for free.
2. **The final holdout is locked before the first development clip is analysed** —
   identified, checksummed, and stored so that its contents cannot be inspected
   during development.
3. **The final holdout is run once per candidate build.** If it fails, the
   engine may be fixed, but the holdout is then **consumed**: it becomes
   development material and a new final holdout must be collected. This is the
   same discipline the synthetic holdout already follows in `m22/holdout.mjs`,
   where generations 1 and 2 were consumed after they found defects.
4. **Constants and layer source are frozen before the holdout run**, recorded by
   `m22/freeze.mjs`, and the freeze is verified at run time. A drifted freeze
   means the result is stale, not merely unlucky.

Reusing a failed holdout until it passes is the single most likely way this
programme produces a false verification. It is prohibited, and the consumption
rule is what makes the prohibition enforceable rather than aspirational.

---

## 4. Session diversity

A dataset of forty clips of one person in one kitchen is one observation
repeated forty times. Each stage must span, and record, at minimum:

- **Surface** — carpet, hard floor, artificial grass, natural grass, concrete.
- **Location** — indoor room, garage, garden, park, sports hall.
- **Lighting** — daylight, overcast, indoor artificial, mixed, low light,
  strong directional light producing hard shadows, backlight.
- **Background** — plain wall, cluttered room, other people moving, passing
  traffic, other balls present.
- **Ball** — size 3/4/5, worn and new, light and dark, matte and glossy.
- **Footwear and clothing** — including clothing whose tone is close to the
  ball's and close to the floor's.
- **Framing** — the distances and angles the capture guidance actually asks
  for, plus the ones people will use anyway.
- **Camera support** — propped phone, held by another person, on a fence.
- **Skill level** — including attempts that are messy, interrupted, restarted
  or abandoned, because those are ordinary and the engine must handle them.

Diversity axes are **recorded per session as structured metadata** so that
results can be reported per stratum. An aggregate pass that hides a complete
failure on one surface is not a pass.

Explicitly **not** recorded, ever: any demographic attribute of the player.
Not age band beyond the consent requirement in §11, not sex, not ethnicity, not
body type. The engine detects a bright blob and a dark region; there is no
mechanism by which such a label could inform an improvement, and recording one
would create a dataset nobody should hold.

---

## 5. Device diversity, and what may be claimed

- Minimum **8 distinct device models** per stage, spanning at least three price
  tiers and both major mobile platforms, plus at least one laptop webcam.
- Record per session: device model, OS version, browser and version, capture
  resolution, nominal and achieved frame rate, and whether the capture path
  reported dropped frames.

**Platform claims follow the data and nothing else.** ScoutBox may claim
production support only for the platform, browser and capture-path combinations
actually represented in the passing holdout, and only within the resolution and
cadence envelope those sessions covered. A platform absent from the data is
unsupported — not "expected to work". If iOS Safari appears in the dataset and
Android Chrome does not, then Android Chrome is unsupported, however unlikely
that feels.

The supported envelope is published alongside the result, and the capture client
refuses to begin a production attempt outside it.

---

## 6. Ground truth

Ground truth is **human annotation of the video**, never the engine's own
output. An engine graded against its own output measures nothing.

Procedure:

1. **Two annotators, independently and blind** — blind to each other, and blind
   to any ScoutBox output for that clip. Neither may see a count before
   producing one.
2. Annotators use the definitions in §7, which are fixed before annotation
   begins and are not revised in response to disagreement about a specific clip.
3. **Agreement**: where both annotators produce the same count, that is the
   ground truth.
4. **Adjudication**: where they differ, a third annotator — who has seen neither
   prior count — adjudicates. The adjudicated value is ground truth.
5. **Exclusion**: a clip on which adjudication cannot produce a confident count
   is marked **ambiguous** and excluded from accuracy scoring. Ambiguous clips
   are counted and reported: if more than **10%** of a stage is ambiguous, the
   protocol definition itself is too vague to validate and the programme stops
   until §7 is rewritten.
6. **Inter-annotator agreement is reported** for every stage. It is the ceiling
   on any accuracy claim: an engine cannot be shown to be more accurate than the
   humans defining what accurate means, and if agreement is below **95%** on a
   protocol, that protocol is not ready for validation.

Annotation is done on the recorded video at whatever playback rate the annotator
needs, including frame stepping. The engine gets one pass in real time; the
annotators do not have to.

---

## 7. Event definitions

These are the definitions annotators apply. They are deliberately narrow, and
where they are narrower than football's ordinary usage, that narrowing is the
declared scope of the measurement.

### Touch (`combine-box-touch-60`)

A **touch** is counted when **all** hold:

- the ball and the player's foot or lower leg make contact;
- the ball's motion **changes** as a result — it starts moving, stops moving, or
  changes direction or speed visibly;
- the contact is **separable** from the previous one: the ball's state changed
  between them, rather than the foot remaining in continuous contact.

Not a touch: a foot passing near without contact; the ball rebounding off a wall,
floor or furniture; contact with any body part other than foot or lower leg; a
foot resting on a stationary ball without moving it.

**Continuous contact counts once.** A player rolling the ball under the sole in
one unbroken movement has made one touch, however long it lasts.

### Juggle (`combine-box-juggle`)

A **juggle contact** is counted when all hold:

- the ball is airborne before and after the contact;
- the contact is with foot, thigh, or head;
- the ball does not touch the ground between this contact and the previous one.

The ball touching the ground **ends the attempt**. Contacts after a ground
bounce belong to a new attempt and are not added to the first.

### Control (`combine-box-control-60`)

A **controlled interval** runs from the moment the ball is brought under control
to the moment control is lost — the ball leaves the player's immediate area, is
not recoverable in one movement, or comes to rest untouched. The measurement is
**duration**, and duration is recorded to 0.1 s.

This protocol is listed last deliberately: "control" is the hardest of the three
for two humans to agree on, and §6's 95% agreement floor is expected to be the
binding constraint. It should be validated last or not at all.

---

## 8. False verification — the definition that matters most

A **false verification** is any of these:

1. The engine returns `accepted` with a count for an attempt whose ground truth
   is "invalid, no measurable attempt" — no ball, no player, wrong activity, a
   still photograph, replayed footage, or a deliberate spoof.
2. The engine returns `accepted` with a count that differs from ground truth by
   more than the declared per-attempt tolerance.
3. The engine returns `accepted` for an attempt the annotators marked ambiguous.

A **refusal is not a false verification.** Refusing a valid attempt costs recall
and is reported separately as a miss. The asymmetry is deliberate and is the
governing principle of the whole system: *a refused measurement is acceptable, a
falsely verified measurement is not.*

Any false verification in the final holdout **fails the protocol outright**,
regardless of every other number. This matches `ACCEPTANCE_CRITERIA.maxFalseVerifications = 0`
in `m22/gate.mjs`.

---

## 9. Acceptance thresholds

Declared in advance. A protocol passes the final holdout only if **every** row
holds.

| Criterion | Threshold |
|---|---|
| False verifications | **0** |
| Attempts on the adversarial group producing any count | **0** |
| Per-attempt absolute count error | ≤ **2** on every attempt |
| Mean absolute count error | ≤ **1.0** |
| Attempts within tolerance | ≥ **95%** of valid attempts |
| Refusal rate on valid attempts | ≤ **20%**, and every refusal carries a correct reason |
| Refusal with the WRONG reason | ≤ **2%** |
| Determinism: same clip, same answer | **100%** |
| Worst stratum (surface / lighting / device) within tolerance | ≥ **85%** |
| Inter-annotator agreement | ≥ **95%** |
| Ambiguous clips | ≤ **10%** |

The worst-stratum row exists because an aggregate is how a total failure on one
surface hides behind success on four others.

For `combine-box-control-60`, substitute for the count rows: absolute duration
error ≤ **1.0 s** on every attempt, mean absolute duration error ≤ **0.4 s**.

---

## 10. The adversarial group — zero tolerance

Every stage includes a deliberate adversarial set, collected as real video, in
which **no valid attempt occurs**. The engine must produce **no count** on any
of them. Any count is a P0 and fails the protocol.

At minimum:

- a still photograph held in front of the lens;
- a screen recording of someone else's attempt, replayed to the camera;
- a video of a video, at an angle;
- a person standing still beside a stationary ball;
- a person moving energetically with no ball present;
- a ball rolling, bouncing or being thrown with no foot contact;
- another person's attempt filmed while the account holder stands in frame;
- two people and two balls in frame at once;
- an attempt deliberately interrupted and resumed as if continuous;
- the same clip submitted twice;
- a clip submitted with manipulated timestamps;
- a clip in which the camera is deliberately zoomed, panned or shaken during
  otherwise static content — the failure mode the synthetic holdout caught twice.

This group is **not** balanced against the valid group and is **not** included in
accuracy percentages. It is a gate, and it is pass/fail.

---

## 11. Consent, participants, and minors

- **Written, informed, specific consent** from every participant before
  recording, covering what is recorded, what it is used for, how long it is
  kept, and how to withdraw.
- **Withdrawal is honoured by deletion**, at any time, without justification,
  and without penalty. A withdrawn session is removed from every stage. If a
  withdrawal removes sessions from a completed holdout, the holdout result is
  **invalidated**, not adjusted.
- **Adults only, wherever the data can answer the question.** The engine detects
  a bright blob and a dark region; it has no player model and no demographic
  input, so there is no technical reason validation footage must include
  children. Collecting football video of minors to validate a measurement that
  works identically on adults is not justified by need.
- Where a claim genuinely cannot be evidenced without under-18 participants,
  that claim is **not made** until a separate, documented process exists with
  guardian consent, child-appropriate explanation, the child's own assent, a
  named safeguarding lead, and independent review. That process is out of scope
  here and is not authorised by this document.
- No participant is recruited through ScoutBox's player-facing product, and no
  production user's footage is used for validation. Validation data is collected
  deliberately, for validation, from people who agreed to that specific thing.
- Participants are compensated for their time.

---

## 12. Retention, storage and minimisation

- Validation video is stored **separately from production systems**, encrypted at
  rest, with access limited to the named validation team and every access logged.
- **Production never retains raw video.** Production capture sends gray8 frames
  which are processed and discarded; the observation record contains counts,
  quality and confidence, never pixels. This plan does not change that, and
  nothing here is a precedent for retaining production footage.
- Validation video retention: **12 months maximum** from collection, or until
  the validation result it supports is superseded, whichever is sooner. Then
  deletion, evidenced.
- Annotations, metadata and the derived result may be retained beyond the video,
  because they are what the record needs and they are not footage.
- No face embeddings, no biometric templates, no identity models, no audio
  analysis. Audio is stripped at ingest; if a device cannot capture without
  audio, the audio track is discarded before storage.

---

## 13. The offline option

A participant may request that their footage never leaves their device. For
those sessions, the engine runs locally, only the derived counts and quality
metadata are returned, and the annotation is done by the participant's own
reviewer under the same blind procedure.

Offline sessions are **marked as such in the dataset**. They evidence the engine
on that footage; they do not contribute to any claim that requires a second
annotator the participant did not supply. If offline sessions are a material
fraction of a stage, the stage's agreement figure is reported separately for
them.

---

## 14. Sample size

Minimum per protocol, per stage, for the final holdout:

| Quantity | Minimum |
|---|---|
| Distinct participants | 20 |
| Distinct sessions | 40 |
| Valid attempts | 200 |
| Adversarial attempts | 60 |
| Distinct device models | 8 |
| Distinct locations | 10 |
| Sessions per surface category | 5 |

These are floors, not targets. The binding consideration is the false-
verification criterion: at 200 valid attempts, observing zero false
verifications is consistent with a true rate up to roughly 1.5% at 95%
confidence. That is the honest precision of a passing result at this size, and
it **must be stated in the published claim**. A tighter bound requires a larger
holdout; it cannot be obtained by reasoning about a smaller one.

Development and validation stages have no minimum — they are as large as they
need to be — but they must not overlap the holdout in any session.

---

## 15. The validation record

A pass is recorded in `m22/validation.mjs`, which `m22/gate.mjs` reads. Every
field in `REQUIRED_RECORD_FIELDS` is mandatory; a record missing any of them is
not a weak record, it is not a record.

| Field | Meaning |
|---|---|
| `protocolId` | The single protocol this record covers |
| `cvPolicyVersion` | `BOX_CAM_CV_POLICY_VERSION` at validation time |
| `providerVersion` | The production provider build validated |
| `engineVersion` | `CV_ENGINE_VERSION` at validation time |
| `datasetId` | The final holdout's identifier |
| `datasetVersion` | Its version, so a later edit is visible |
| `result` | The measured numbers, per §9, including per-stratum |
| `approvalVersion` | The version of the approval process applied |
| `approvedAt` | When |

`validateRecord()` rejects a record whose engine, policy or dataset does not
match the current build. **A record validated against an older engine does not
describe this engine's behaviour, so it does not transfer.** Any change to the
engine, the policy constants, or the layer source — anything that moves the
`m22/freeze.mjs` checksum — invalidates every existing record and requires
re-validation on a fresh holdout.

The freeze checksum at validation time is recorded inside `result`, so a reader
can verify the claim was measured against the code they are looking at.

---

## 16. Release process

A passing holdout does **not** open the gate. It makes the gate eligible to be
opened. The steps, in order:

1. The measured result is written up in full, including failures, refusals, the
   per-stratum table, the confidence bound from §14, and the supported platform
   envelope from §5.
2. Independent review by someone who did not run the validation, with authority
   to reject.
3. Trust & Safety review of the consent, retention and deletion evidence.
4. An explicit, recorded decision to enable the protocol, naming the decider.
5. The validation record is committed.
6. Production enablement is a **separate, deliberate configuration change**,
   which also requires the production provider to be configured, healthy, and to
   declare the required capabilities.

**There is no automatic path from a green number to an enabled protocol.** The
gate's `protocolProductionEnabled()` requires all of: a configured and healthy
provider, the provider declaring the required capabilities, a measured
evaluation artefact meeting `ACCEPTANCE_CRITERIA`, and a valid, current,
passing real-world validation record. Every one is necessary; none is sufficient.

---

## 17. Stopping conditions

The programme stops, and the protocol is **not** validated, if any of these
occur — these are declared now so that stopping is a rule rather than a
judgement call made while invested:

- inter-annotator agreement below 95% (§6);
- more than 10% ambiguous clips (§6);
- any false verification in the final holdout (§8);
- any count on the adversarial group (§10);
- a stratum below 85% within tolerance (§9);
- the refusal rate exceeding 20% on valid attempts, because an engine that
  refuses a fifth of real attempts is not a product even though it is honest;
- a second consecutive final holdout failure, at which point the engine's
  approach — not its thresholds — is the thing to revisit.

Stopping is an acceptable outcome. §168 of the M22 mandate says so explicitly,
and the current state of the project is already that outcome: **no Combine
protocol is production-verified, and none will be until this plan is executed
and passes.**

---

## 18. Current status

| Item | State |
|---|---|
| Development dataset | does not exist |
| Validation dataset | does not exist |
| Final holdout | does not exist |
| Annotation team | not assembled |
| Consent process | not drafted for collection |
| Production provider | not configured |
| `combine-box-touch-60` | `not_completed` |
| `combine-box-juggle` | `not_completed` |
| `combine-box-control-60` | `not_completed` |
| **Production eligibility** | **NOT ELIGIBLE — real-world validation not completed** |

This table is the true state of the world, and it is the reason M22 finishes
with no Combine protocol production-verified.
