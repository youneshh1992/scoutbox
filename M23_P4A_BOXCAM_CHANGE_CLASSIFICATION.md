# M23 P4A — Box Cam Change Classification

Every Box Cam change that the Trial workflow could plausibly want, classified
before any of it is built. Three classes, and a change is in exactly one:

| class | meaning |
|---|---|
| **P4B NECESSARY** | Trial cannot integrate Box Cam evidence safely without it |
| **P4B OPTIONAL** | useful for the Trial surface; P4B may ship without it |
| **FUTURE BOX CAM MILESTONE** | CV or model capability expansion; must not block Trial |

The classification is grounded in the current state of `m16/*` and `m22/*`,
audited in `M23_P4A_TRIAL_BOXCAM_REUSE_AUDIT.md` Part B, and it changes
**no gate**. The M22 capability statement stays as written:

> Box Cam uses server-side computer vision to observe supported activity.
> Combine verification for these CV protocols remains disabled pending
> real-world validation.

---

## 1. What exists today, in one paragraph

A Box Cam session (`db.boxSessions`) is minted only by the authenticated
**player** (`m16/sessions.mjs:124`), bound to that player by the actor, never
by recognition; liveness establishes presence, not identity
(`m16/drills.mjs:150-152`). A club can *assign* a drill or *request* a Combine
(`m16/training.mjs:58`, `m16/combine.mjs:540`) but cannot start, stream or
read a session. Observations are aggregates on the session (`obs.*`,
`verifiedActiveMs`, `verifiedReps`, `verificationState`, `verificationReasons`,
`resultHash`) and, for the M22 path, a canonical CV result in
`db.boxCamCvResults` with `outcome: accepted|refused`, a single primary
`refusalReason`, `observationQuality`, `derived` counts, an `experimental`
block, `providerVersion`/`engineVersion`/`cvPolicyVersion`, a bounded
`trace[]`, and `combineVerified: false` with `combineVerifiedBlockedBy:
'REAL_WORLD_VALIDATION_NOT_COMPLETED'`. No frame is persisted; no session
carries `orgId`, `caseId`, `trialId`, `context`, `sessionType` or `purpose`
(the only context field is `captureContext ∈ {at_home, club, event}` on a
**Combine attempt**). Human review is the T&S dispute loop
(stands / invalidated / provider_bug, append-only `integrityEvents[]`); counts
are never edited by hand. The Passport already projects sessions with
provenance `box_cam_observed` and visibility `private`; M21 already resolves
`box_cam_session` and `combine_attempt` as development evidence by reference.

---

## 2. Classification

### P4B NECESSARY

| # | change | why it is necessary | shape | gate impact |
|---|---|---|---|---|
| N1 | **Trial ↔ Box Cam session link, by reference** | Without a canonical link the Trial cannot cite an observation at all, and "which session was this" would be reconstructed by date and player, which is guessing. | A link row on the **Trial side** (`trial.sessions[].evidence[] = { kind: 'box_cam_session', id, linkedAt, linkedBy }` — see the architecture §7), never a field on the Box Cam session. The session is the player's record; the Trial is the club's. Writing the club's context onto the player's session would make the player's own evidence carry a club's workflow id. | none |
| N2 | **Link authorisation: same player, session finalised, not invalidated, not test-only in production, club may see the player** | Prevents wrong-player, wrong-org, foreign, unfinished or fixture-driven sessions being cited. | Server-side check at link time using `findOwnSession`-equivalent scoping by `session.playerId === trial.playerId`, `finalizedAt`, `status ∉ {cancelled, invalidated}`, `PROVIDERS[provider].testOnly === false` unless `BOX_CAM_TEST_PROVIDER`, `orgCanSee(player, org)`, and **the player's recruitment opt-in** (`boxShareRecruitment`) or an active Combine request from that org — the existing consent rule at `m16/combine.mjs:581-586`, reused. | none |
| N3 | **Safe evidence projection for a Trial** (`trialEvidenceView`) | The club must see what was observed without receiving the player's session internals or a number that reads as ability. | A projection over the session/CV result: `{ id, drillId, protocolId, capturedAt, verificationState, observationState (accepted / the refusal code), quality band, provenance: 'box_cam_observed', simulated, experimental: { status } }`. Never `trace[]`, never `nonce`, never `obs.*` intervals, never a rendered numeric confidence. The experimental exact count is shown, if at all, exactly as the player app shows it: behind a disclosure, labelled `experimental_unvalidated`. | none |
| N4 | **Refusal semantics carried into the Trial surface** | §47–§48: a refused observation must read "no reliable observation available", never "player failed". | The projection maps `outcome: refused` to a neutral state and the existing player-facing copy table (`m22/policy.mjs:286-297`); the Trial surface renders the same copy. No new vocabulary. | none |
| N5 | **Immutable provenance on link** | §37: linking must not rewrite origin. | The link stores only the reference and the link event; every provenance field is read live from the source at projection time. A session invalidated after linking projects as `evidence_withdrawn` (the M21 rule, `m21/evidence.mjs`), and the Trial keeps the link row as history. | none |
| N6 | **`session_type` context on the Trial session, not on Box Cam** | §33–§34: a Trial has sessions (medical, training, match) and only some carry Box Cam. The interpretation context belongs to the Trial session. | `trial.sessions[].kind ∈ { onboarding, training, drill, small_sided, match, other }` on the Trial; the Box Cam session gains nothing. | none |

### P4B OPTIONAL

| # | change | value | shape | why optional |
|---|---|---|---|---|
| O1 | **"Create Box Cam session for this Trial session"** entry point in the club UI | Saves the club typing the link afterwards. | The club cannot mint a session (player-only, `m16/sessions.mjs:124`); the entry point would create a **drill assignment** (`POST /org/box-cam/assignments`, existing) carrying a `trialSessionId` hint, and the link is made when the player's resulting session finalises. | The link-after-the-fact path (N1) covers the same evidence; this is convenience. Authorisation: `contact_write`-equivalent Trial role, the org must be verified, the player must have the recruitment opt-in or an active request. |
| O2 | **Trial context shown in the player's session UI** ("This session is linked to your trial at Club X") | Transparency for the player. | Read-only note derived from the Trial link, shown on the player's session card. | The player already sees the club's assignment and the Combine request; a Trial note is a nicety. Requires the Trial to be recipient-visible (it is, once invited). |
| O3 | **Multiple sessions per Trial session** listing with `kind` grouping | Anticipates training + small-sided + match. | Data model already allows N links per Trial session (N1); this is UI. | Ordering and grouping only. |
| O4 | **`box_cam_trial_linked` audit row** | Traceability of who cited what. | Audit domain `recruitment_trial`, detail keys `sessionId`, `trialSessionId` — ids only. | The Trial's own append-only history already records the link; the audit-log row is for the T&S view. Recommended, cheap. |
| O5 | **Rate policy `box_cv_finalize` actually enforced** | Hygiene: the policy exists (`m181/rateLimit.mjs:84`) but `m22/routes.mjs` finalize never calls `limited()`. | One guard line. | Unrelated to Trial; finalize is nonce-bound and once per session, so exposure is bounded. Recorded in the defect register (P4A-D5). |
| O6 | **`refusedClientFields` invoked on the M22 routes** | The forbidden-field list (`m22/policy.mjs:304-320`) is exported and tested but not called by the routes; enforcement is structural (no handler reads those names). | Call it in `begin`/`frames`/`finalize` and answer 400. | Structural safety already holds; the explicit refusal is belt-and-braces. Defect register P4A-D6. |

### FUTURE BOX CAM MILESTONE (Box Cam 2.0 — must not block Trial)

| # | capability | why it is out of P4B |
|---|---|---|
| F1 | Multi-player tracking, per-person attribution in shared footage | Requires identity, which is prohibited (`M22_CAPABILITIES.md` §4). Today a second person pauses observation (`obs.multiPerson`) and a rival ball is a `protocol_violation`. Trial sessions with several players are **not observable** by Box Cam; the Trial must say so, not work around it. |
| F2 | Pose estimation, technique quality signals | "not implemented; ScoutBox does not score how a touch looked" — and a technique signal is one step from a rating. |
| F3 | Tactical inference, match analytics, full-match platform | Explicitly out (§131). |
| F4 | Automated clips / evidence moments from footage | Requires retained footage; production retains none (`m22/frames.mjs:6-12`). The optional Box Clip is a player-uploaded media item with its own provenance; that path is unchanged and sufficient. |
| F5 | Live analysis during a Trial session | Live count during capture is deliberately withheld even from the player (`m22noLiveCount`). |
| F6 | New protocols, new event kinds, improved models, additional camera types, native iOS/Android capture | Capability expansion, each requiring its own evaluation, holdout and freeze; Chromium-only web capture is the current envelope. |
| F7 | Combine Verified for CV protocols | Blocked by real-world validation (`REAL_WORLD_VALIDATION` all `not_completed`). The Trial must never imply it; a Trial-linked Combine attempt projects with the same `combineVerifiedBlockedBy`. |
| F8 | Computer-generated player ratings, potential, AI recruitment score | Prohibited across the product; P4A forbids introducing them (§28, §130). |
| F9 | Real-world validation itself | A separate, documented process (`M22_REAL_WORLD_VALIDATION_PLAN.md`); Trial footage of production users is **not** validation data (plan §11). |

---

## 3. Changes considered and rejected

| proposal | verdict | reason |
|---|---|---|
| `trialId` on `db.boxSessions` | rejected | The session is the player's record and the reference direction must not make the player's evidence carry a club workflow id; two-sided arrays would drift. Link lives on the Trial (N1). |
| a `boxCamAssessment` / `trialRating` derived from observations | rejected | Observation ≠ assessment (§25). Nothing in Box Cam is a football judgement. |
| copying `derived` counts or `trace[]` onto the Trial | rejected | No copy-paste evidence (§38); provenance stays with the source. |
| retaining frames for Trial "history" | rejected | Data minimisation (§44–§45); linkage does not change retention. |
| loosening `orgCanSee`, the recruitment opt-in, or the test-provider exclusion for Trial links | rejected | A Trial is not consent; the existing Combine consent rule is the model (`m16/combine.mjs:587-589`). |
| a Trial-specific "confidence %" display | rejected | Confidence is model certainty, never quality (`m22/policy.mjs:252-266`); the player UI never renders it and neither will the Trial. |

---

## 4. Real-world validation dependency check (§132)

P4B does **not** depend on any capability blocked by real-world validation.
Trial evidence uses **observation** (`box_cam_observed`, accepted/refused,
quality), which is available under its own gate
(`boxCamObservedEligible()`), and never a Combine measurement. The one thing
P4B must do is carry the block honestly: a Trial-linked Combine attempt shows
`combineVerifiedBlockedBy: REAL_WORLD_VALIDATION_NOT_COMPLETED` exactly as My
Combine does. Nothing in this classification routes around the gate.

## 5. Current Box Cam capability report (from source, unchanged by P4A)

```
real server-side pixel CV: YES        (m22/provider.mjs; gray8 frames decoded and analysed server-side)
face recognition: NO                  (prohibited; m22/eligibility.mjs NON_CAPABILITIES; m22E2E §91 sweep)
audio analysis: NO                    (prohibited; getUserMedia audio:false)
production raw video persistence: NO  (no frame store; m22/frames.mjs; m22E2E §37/§92 scan)
client counts accepted as truth: NO   (FORBIDDEN_CLIENT_FIELDS; capability intersection; m22E2E negatives)
real-world validation complete: NO    (REAL_WORLD_VALIDATION: not_completed ×3)
Combine Verified production-capable: NO (combineVerifiedProtocols() === [])
```
