# Football Passport, verification, Trust, Development Hub, Box Cam and Combine

The player's evidence layer (Passport, verification, provenance, Trust) and the development tools that feed it (Development Hub, Box Cam, At-Home Combine, computer vision), with what each is allowed to claim.

Founder decisions for this area are in [`../decisions.md`](../decisions.md).

## How it works

**Verification**
- Verification proves facts, not accounts: no account-level "verified" boolean, no AI in any decision. Uploaded documents are evidence, never truth. Verification never loosens authorization (`visibleToOrg`, guardian routing, radius, blocks).
- Evidence records (the player's evidence passport): a claim's value is a number or a short text; a label, units, season, note, method or reason that is not text, or longer than its limit, is refused (`400 FIELD_INVALID`, field named, with `max`), as is a field the request does not take (a claim cannot name its own tier, source or time). A coach affiliation's start must be a calendar day, and a squad-invitation answer and a dispute's `downgrade` must be true or false. A correction and the record it supersedes are written together. Records and squad invitations stay after an account deletion (retention is an open question, `decisions.md` Q6).
- Claims are independent and per-fact (identity, org, domain, admin, affiliation, role, licence). Nobody can confirm their own claim.
- Claim states: unverified → collecting_evidence/pending → automated_checks_passed/requires_human_review → verified/rejected; verified → expired/suspended/revoked/disputed/superseded; expired → pending; suspended/disputed → verified/revoked; revoked → verified (T&S only). Server-only; `document_submitted` never reaches verified.
- A badge's effective status is computed at read time: claim verified and in date, org not suspended/revoked, account not removed. Historical claims stay as history; a fraud-revoked org stops lending even historical badges.
- Root org bootstrap always needs T&S human review. Root approval never links an applicant to an account by name, only by a verified work-email match or an explicit T&S choice. Org-admin confirmation is authoritative for staff claims; root grants need dual control and MFA.
- Revoking an admin stops new approvals; claims they already approved keep their provenance until acted on individually.
- Only `authoritative` licences render "Licence verified"; a T&S document review renders "Credential reviewed".
- References need a current verified role and snapshot the coach's verification at submission. They are corrected only by versioned supersession, never edited. Squad invites are recipient-bound and guardian-accepted for minors. A club relationship comes from a squad row only: a club's shadow list (players it is considering) never counts as a relationship on the passport or the Trust score.
- Verification requests refuse malformed input with `400 FIELD_INVALID` / `DATE_INVALID` naming the field instead of storing it: a requested start date that is not a date, application declarations other than `{ authorised: true|false }`, a reference year outside 1900–2100, an unknown dispute resolution, text fields sent as anything but text. Over-long text is shortened. A refused licence file leaves no claim behind.

**Football Passport**
- The Passport is a server-side projection over existing records. It is not a store, rating, badge or endorsement, and it never contains a numeric score.
- `projectPassport` is the only viewer filter (self, guardian, pro, grassroots, agency, other_player, public, trust_safety). It grants no new access.
- **Provenance ranking** (least to most authoritative; used only for per-field display precedence, never shown as a score): player_submitted < guardian_submitted < system_recorded < historical_migration < box_cam_observed < scoutbox_reviewed < verified_coach_confirmed < verified_club_confirmed < authoritative_registry. Source badges `combine_verified` and `simulated_demo` sit beside it.
- In a current-club conflict the authoritative record displays; the self view gets `CURRENT_CLUB_CONFLICT` and a correction path (flags visible to player and T&S only). Impossible chronology raises a `TEMPORAL_CONFLICT` routed to correction, never a fraud accusation.
- A trial never creates a club-history row or a `club_joined` event. A suspended org confers no current relationship. Dates are never more precise than the source.
- The player owns the presentation (bio, positions, career entries, achievements, public selections), not confirmed records. Withdrawing a confirmed item returns 403 `CONFIRMED_RECORD`; corrections go to T&S, which records a reason. New achievements are always player/guardian-submitted; a verified org that can see the player may confirm one.
- Visibility comes from source policy; public selections only narrow. Public view: age (never DOB), city (none for minors), confirmed current club, selected items, evidence counts.
- Share tokens are stored only as SHA-256 hashes, expire in 1–90 days and can be revoked by the owner, guardian or T&S. Invalid tokens are indistinguishable 404s; a recruitment link locates, never authorises. Minors get `GUARDIAN_MANAGED` on share routes.
- Passport input is refused with `400 FIELD_INVALID` / `DATE_INVALID` naming the field instead of being stored: positions outside the position codes or more than three secondary ones, a date that is not a year, month or day (achievement, availability), non-text names, roles or notes, a public-selection list that is not a list of ids, a share lifetime outside 1–90 days. Dates are stored in the precision given (an epoch becomes its day). Reading a Passport never creates a preferences record. The T&S correction queue and share list page by cursor (the admin app reads the first 50). An account deletion leaves the player's Passport records under the old id (retention, `decisions.md` Q6).

**Box Cam, truth boundary**
- The strongest permitted claim: *"ScoutBox Box Cam observed activity consistent with this supported drill for X active minutes/repetitions during a live capture session."* Observation is not evaluation: Box Cam never claims perfect execution, improvement or talent.
- `box_cam_observed` can be minted only by the live session flow (server nonce, liveness, monotonic seq, bounded clock). Uploads, client fields or T&S can never produce it. It is never an authoritative current-club source, and Trust gives it no weight for affiliation.
- A session verifies only the intersection of drill and provider capabilities. Rep targets return null where `rep_count` is unsupported. Client-supplied `verifiedActiveMs`/`verifiedReps`/`verificationState`/`provenance` are ignored.
- Session results: verified, partially_verified (kept, never erased), unable_to_verify, completed_unverified (no liveness/provider), plus cancelled/invalidated.
- No raw video route and no audio. The server stores no frames (CV frames are processed and dropped). Liveness proves presence, not identity; there is no facial recognition anywhere.
- Coaches (verified, non-agency, gate-passing orgs) assign drills and receive results, never footage. Copy is non-punitive. Streaks count weeks; no leaderboard.
- Session detail is self/guardian only. Clubs see an aggregate Development Activity summary only on opt-in. The public view shows no Box Cam detail. T&S can invalidate or restore a session (with history) but never fabricate values.
- Box Cam is typed tables written in one unit of work per route (`repositories/boxCam.mjs`). The session nonce is stored only as a hash. Input the engine cannot read is refused naming the field instead of being dropped or coerced: an observation event without its timestamps, with an unknown quality or a confidence outside 0–1 (`400 EVENT_INVALID`); a target, total or frequency written as text or out of range; an assignment due date that is not a real day (`DATE_INVALID`); a challenge's `days` outside 1–60 or a `cap` below 1; a non-boolean `adultOnly` or `retainClips`. Reading the preferences never creates a row. The ScoutBox challenges are inserted by the migration. The club's assignment and challenge lists and the T&S dispute queue page by cursor (the apps read the first page).

**At-Home Combine**
- A measurement layer over Box Cam: every attempt binds a server-minted Box Cam session. Combine Verified requires a live session, the correct protocol@version, liveness, calibration, a provider that genuinely supports the metric, a server-derived value and the full window observed at good quality. Short captures are `partially_measured` and never extrapolated.
- Protocols are static versioned code, pinned per attempt; clubs cannot alter them. Practice attempts never become verified. Verified attempts are limited to 3 per 24 hours per protocol.
- `isProductionValidCombine` = live Combine Verified + measured value + non-test provider. It is the single definition, shared by the Combine and the Development Hub. Invalidating the bound session drops Combine Verified everywhere immediately.
- The Combine Card is not an overall rating. Club Combine completion does not mean selection.
- Requests and attempts are typed rows (`repositories/boxCam.mjs`): a request's protocols and an attempt's reasons and calibration checks are ordered rows; the checks a protocol requires come from its pinned version. A protocol or player id or a title that is not text, more than ten calibration checks, or a deadline that is not a real day (also through a Room) is refused. The club's request list pages by cursor.

**Trust Score**
- A 0–100 measure of evidence confidence, "not football ability or recruitment suitability". It is recomputed on every read, never stored, has no write route, and grants no access.
- Weights (policy v1): identity 15, history 20, relationships 20, evidence 20, Combine 15, references 10. Boot refuses if they don't total 100.
- Authority is weighed per fact type. Canonical sources are deduplicated. Box Cam has a diminishing curve and a sub-cap; volume, streaks and reps are not inputs. Combine counts distinct protocols. Invalidation is removal, not penalty. Prestige, popularity, recruitment outcomes, payment and simulated evidence are not inputs.
- The Trust Score is served from its own endpoint, never inside the Passport. Clubs see score, band and levels only; public sees score and band only where allowed. It is never a sort key, ranking input or leaderboard.

**Development Hub**
- No Development/Potential/Readiness or similar score, and no field to hold one. `assertDevelopmentVocabulary()` stops the server at boot if labels drift. No AI coaching or generated plans.
- Owner is a player or an org and never changes. Visibility is explicit: player plans are private/player_guardian/shared_with_org; org plans are org_private/player_guardian. A minor's "private" plan still includes the guardian. Narrowing visibility withdraws shares.
- Plan: draft→active/archived; active→paused/completed/archived; paused→active/completed/archived; completed→active/archived. A draft may have zero goals; an active plan needs at least one. Goal: not_started→in_progress/blocked/stopped (never directly to achieved); achieved→in_progress. Action: todo/in_progress/blocked/done/cancelled; done→in_progress (undo).
- "Achieved" is a human judgement, not verified ability. Completing an action never completes a goal. Meeting a target never marks a goal achieved. Progress is shown as counts ("3 of 5"), never a ratio or bar. Overdue is a date fact.
- Evidence links hold ids only, resolve live, and show "unavailable" (no content) to unauthorised viewers. Access is checked before existence.
- Objective targets: one Combine metric, one operator and a value, pinned to a protocol version. Only a production-valid Combine result can satisfy one. Box Cam and assessments cannot. States: target_met / target_not_met / no_current_valid_measurement.
- Reviews are append-only. A correction supersedes once and only by the original author. Internal notes never reach the player payload.
- Minors read but cannot write (the guardian manages). Agencies have no access at all. Room notes and tasks are never copied in. Hub data never enters the Passport, matching, analytics, Trust or Second Look triggers. SSE events are org-private and ids-only.
- The Hub's records are typed tables written in one unit of work per route (`repositories/development.mjs`). A title, description, note or summary that is not text is refused with `400 FIELD_INVALID`. The plan list pages by cursor, newest change first, with `total` still counting every plan the viewer may read; a limit over 100 or a made-up cursor is refused (the club apps read the first page).

**Development objectives and drill guidance**
- An objective grows only from feedback a club published: one or two items, each with up to four exercise references and the player's own baseline evidence. Junk is refused naming the field: an item that is not text, a fifth exercise reference, evidence that is not the player's (`EVIDENCE_INVALID`), a `reviewAt` that is not a date (`DATE_INVALID`; it is stored as an instant), progress naming an item of another objective, a non-boolean `enabled` when sharing, and reassessment-outcome evidence that is not the player's. Over-long objective, progress and outcome text is shortened.
- Drill guidance: the recording instructions are the same for every combine drill. A drill reads as reviewed only once a named person reviewed it through the T&S route; a reviewer name that is not text is refused.

**CV provider and Combine gate**
- Governing rule: *"A refused measurement is acceptable. A falsely verified measurement is not."*
- Production inference runs server-side over frames the server receives. On-device or signed-client counts are rejected. The engine is deterministic, with no third-party weights. Frames are gray8 (160×120–320×240), nonce/seq-bound on the authenticated player router; client timestamps are never used.
- The observation capability list and the Combine capability list are separate. Combine eligibility comes only from a per-protocol real-world validation record matching the current engine, policy and freeze. The `production_cv` provider reports `configured`, but every protocol's validation is `not_completed`, so `combineVerifiedProtocols = []` and a production_cv Combine attempt returns 422 `REAL_WORLD_VALIDATION_NOT_COMPLETED`. Unvalidated counts travel as `experimental.exactCount` (`experimental_unvalidated`) and never reach Trust, matching facts or development targets.
- Refusal is a typed reason code (e.g. ball_not_detected, insufficient_visibility, liveness_failed), never a zero and never blame. Multiple people or balls means refusal. No silent fallback to web_client.
- A CV result is recorded once as typed rows. A trial's linked Box Cam session shows the outcome of the CV result recorded for it (observed, or its refusal reason).
- Enablement needs all of: a configured, healthy provider; the required capabilities; a passing measured evaluation; and a current passing validation record. Then independent and T&S review, a named recorded decision, and a separate config change.
- Never: biometrics, faces, audio, medical inference, player comparison, demographics. CV events are player_private, carry no counts.

## Server contracts

- Clubs never receive `dob`, `location`, `password`, `guardianId`, `notificationPrefs`,
  `programme`, `activityLog`, `drillResults`, `externalIds`, attendance GPS fixes or
  another club's trial reports.
- Agencies and unverified clubs are walled off from minors. Grassroots clubs get their
  own surface.
- Admin guardian and ID-review views never carry password hashes or e-mail codes.
- `400 PLAYER_INVALID` / `GUARDIAN_INVALID` name the field. Values the schema refuses (for
  example a `foot` other than left/right, or a `position` outside the list) are rejected
  at the door.
- The Founder's rule: a minor with no guardian link is invalid data.
- `trialReports` on a player is derived from that player's trials, ordered by `filedAt`.
  It is never stored independently.
- Account deletion (`DELETE /player/account`, `DELETE /guardian/children/:id`) happens
  in one unit:
  - revokes sessions and the pairing code;
  - queues media files for removal (a removed file's `/media/:id` returns 404
    immediately);
  - tombstones requests and trials; nulls names on cases, assessments, contacts and open
    trials;
  - deletes the player's threads and player-audience notifications.
- The player row is **retained**, holding only `id`, `deleted_at`, `birth_date` and
  `country`, with name "Deleted player" and everything else null. The retained row is
  served by nothing that serves accounts, cannot be re-created as a live account, and is
  only ever added to, never edited.
- Audit and recruitment rows that name a deleted player keep the id unchanged.
- The media-removal queue never deletes a file that any live player references. A
  conflict is quarantined: the URL serves 404 and the file is kept.
- There is no route to delete a guardian and no retention period.

## Open questions and deferred work

- Real-world CV validation has not started: no datasets, annotators or consent process. Thresholds are pre-registered (0 false verifications, ≥95% within tolerance, ≤20% refusals, ≥200 valid attempts, adults only).
- Replay via a virtual camera remains unsolved in the browser and must be disclosed. Only Chromium tested. There is no native capture.
- Future athletic Combine protocols (5-10-5, sprint, jumps) need spatial/timing detectors that don't exist, plus a Box Marker.
- No production identity provider, licence register, email transport, DNS probe, malware scanner or retention-deletion engine. On verification decisions the T&S reviewer is declared on the request, not authenticated (shared admin key).
- Passport share and Trust snapshots are not persisted.
- Development Hub: no scheduler or reminders; days are UTC; actions are last-write-wins.

## Also worth knowing

- [`../reference/combine-real-world-validation-plan.md`](../reference/combine-real-world-validation-plan.md): pre-registered thresholds, event definitions and consent rules; the binding protocol for ever enabling Combine.
- No third-party vision model: the npm `ultralytics` package is not YOLO, and real YOLO is AGPL.
