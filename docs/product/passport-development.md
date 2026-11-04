# Football Passport, verification, Trust, Development Hub, Box Cam and Combine

The player's evidence layer (Passport, verification, provenance, Trust) and the development tools that feed it (Development Hub, Box Cam, At-Home Combine, computer vision), with what each is allowed to claim.

> Names in brackets, like (M17_RECRUITMENT_ROOMS), are the original milestone documents. They were removed in the November 2026 cleanup; read one with `git show docs-archive-2026-11:M17_RECRUITMENT_ROOMS.md`. Founder decisions and resolved contradictions for this area are in [`../decisions.md`](../decisions.md).

## How it works

**Verification (M14)**
- Verification proves facts, not accounts: no account-level "verified" boolean, no AI in any decision. Uploaded documents are evidence, never truth. Verification never loosens authorization (`visibleToOrg`, guardian routing, radius, blocks). (M14_VERIFICATION)
- M12 evidence records (the player's evidence passport): a claim's value is a number or a short text; a label, units, season, note, method or reason that is not text is refused (`400 FIELD_INVALID`, field named), and a coach affiliation's start must be a calendar day. Over-long text is shortened. A correction and the record it supersedes are written together. Records and squad invitations stay after an account deletion, as before (retention is an open question). (S9a, 4 Nov 2026)
- Claims are independent and per-fact (identity, org, domain, admin, affiliation, role, licence). Nobody can confirm their own claim. (M14_VERIFICATION)
- Claim states: unverified → collecting_evidence/pending → automated_checks_passed/requires_human_review → verified/rejected; verified → expired/suspended/revoked/disputed/superseded; expired → pending; suspended/disputed → verified/revoked; revoked → verified (T&S only). Server-only; `document_submitted` never reaches verified. (M14_VERIFICATION)
- A badge's effective status is computed at read time: claim verified and in date, org not suspended/revoked, account not removed. Historical claims stay as history; a fraud-revoked org stops lending even historical badges. (M14_VERIFICATION)
- Root org bootstrap always needs T&S human review. Root approval never links an applicant to an account by name, only by a verified work-email match or an explicit T&S choice. Org-admin confirmation is authoritative for staff claims; root grants need dual control and MFA. (M14_VERIFICATION)
- Revoking an admin stops new approvals; claims they already approved keep their provenance until acted on individually. (M14_VERIFICATION)
- Only `authoritative` licences render "Licence verified"; a T&S document review renders "Credential reviewed". (M14_VERIFICATION)
- References need a current verified role and snapshot the coach's verification at submission. They are corrected only by versioned supersession, never edited. Squad invites are recipient-bound and guardian-accepted for minors. (M14_VERIFICATION) A club relationship comes from a squad row only: a club's shadow list (players it is considering) never counts as a relationship on the passport or the Trust score. (S9c)
- Verification requests refuse malformed input with `400 FIELD_INVALID` / `DATE_INVALID` naming the field instead of storing it: a requested start date that is not a date, application declarations other than `{ authorised: true|false }`, a reference year outside 1900–2100, an unknown dispute resolution, text fields sent as anything but text. Over-long text is still shortened. A refused licence file now leaves no claim behind. (S10a)

**Football Passport (M15)**
- The Passport is a server-side projection over existing records. It is not a store, rating, badge or endorsement, and it never contains a numeric score. (M15_FOOTBALL_PASSPORT, M16_2_TRUST_SCORE)
- `projectPassport` is the only viewer filter (self, guardian, pro, grassroots, agency, other_player, public, trust_safety). It grants no new access. (M15_FOOTBALL_PASSPORT)
- **Provenance ranking** (least to most authoritative; used only for per-field display precedence, never shown as a score): player_submitted < guardian_submitted < system_recorded < historical_migration < box_cam_observed < scoutbox_reviewed < verified_coach_confirmed < verified_club_confirmed < authoritative_registry. Source badges `combine_verified` and `simulated_demo` sit beside it. (M15, M16_BOX_CAM, M21_DEVELOPMENT_HUB; code)
- In a current-club conflict the authoritative record displays; the self view gets `CURRENT_CLUB_CONFLICT` and a correction path (flags visible to player and T&S only). Impossible chronology raises a `TEMPORAL_CONFLICT` routed to correction, never a fraud accusation. (M15)
- A trial never creates a club-history row or a `club_joined` event. A suspended org confers no current relationship. Dates are never more precise than the source. (M15)
- The player owns the presentation (bio, positions, career entries, achievements, public selections), not confirmed records. Withdrawing a confirmed item returns 403 `CONFIRMED_RECORD`; corrections go to T&S, which records a reason. New achievements are always player/guardian-submitted; a verified org that can see the player may confirm one. (M15)
- Visibility comes from source policy; public selections only narrow. Public view: age (never DOB), city (none for minors), confirmed current club, selected items, evidence counts. (M15)
- Share tokens are stored only as SHA-256 hashes, expire in 1–90 days and can be revoked by the owner, guardian or T&S. Invalid tokens are indistinguishable 404s; a recruitment link locates, never authorises. Minors get `GUARDIAN_MANAGED` on share routes. (M15)

**Box Cam (M16), truth boundary**
- The strongest permitted claim: *"ScoutBox Box Cam observed activity consistent with this supported drill for X active minutes/repetitions during a live capture session."* Observation is not evaluation: Box Cam never claims perfect execution, improvement or talent. (M16_BOX_CAM)
- `box_cam_observed` can be minted only by the live session flow (server nonce, liveness, monotonic seq, bounded clock). Uploads, client fields or T&S can never produce it. It is never an authoritative current-club source, and Trust gives it no weight for affiliation. (M16, M16_2)
- A session verifies only the intersection of drill and provider capabilities. Rep targets return null where `rep_count` is unsupported. Client-supplied `verifiedActiveMs`/`verifiedReps`/`verificationState`/`provenance` are ignored. (M16)
- Session results: verified, partially_verified (kept, never erased), unable_to_verify, completed_unverified (no liveness/provider), plus cancelled/invalidated. (M16)
- No raw video route and no audio. The server stores no frames (M22 frames are processed and dropped). Liveness proves presence, not identity; there is no facial recognition anywhere. (M16, M22_CV_THREAT_MODEL)
- Coaches (verified, non-agency, gate-passing orgs) assign drills and receive results, never footage. Copy is non-punitive. Streaks count weeks; no leaderboard. (M16)
- Session detail is self/guardian only. Clubs see an aggregate Development Activity summary only on opt-in. The public view shows no Box Cam detail. T&S can invalidate or restore a session (with history) but never fabricate values. (M16)

**At-Home Combine (M16.1)**
- A measurement layer over Box Cam: every attempt binds a server-minted Box Cam session. Combine Verified requires a live session, the correct protocol@version, liveness, calibration, a provider that genuinely supports the metric, a server-derived value and the full window observed at good quality. Short captures are `partially_measured` and never extrapolated. (M16_1)
- Protocols are static versioned code, pinned per attempt; clubs cannot alter them. Practice attempts never become verified. Verified attempts are limited to 3 per 24 hours per protocol. (M16_1)
- `isProductionValidCombine` = live Combine Verified + measured value + non-test provider. It is the single definition, shared by M16.1 and M21. Invalidating the bound session drops Combine Verified everywhere immediately. (M16_1, M21)
- The Combine Card is not an overall rating. Club Combine completion does not mean selection. (M16_1)

**Trust Score (M16.2)**
- A 0–100 measure of evidence confidence, "not football ability or recruitment suitability". It is recomputed on every read, never stored, has no write route, and grants no access. (M16_2_TRUST_SCORE)
- Weights (policy v1): identity 15, history 20, relationships 20, evidence 20, Combine 15, references 10. Boot refuses if they don't total 100. (M16_2)
- Authority is weighed per fact type. Canonical sources are deduplicated. Box Cam has a diminishing curve and a sub-cap; volume, streaks and reps are not inputs. Combine counts distinct protocols. Invalidation is removal, not penalty. Prestige, popularity, recruitment outcomes, payment and simulated evidence are not inputs. (M16_2)
- The Trust Score is served from its own endpoint, never inside the Passport. Clubs see score, band and levels only; public sees score and band only where allowed. It is never a sort key, ranking input or leaderboard. (M16_2)

**Development Hub (M21)**
- No Development/Potential/Readiness or similar score, and no field to hold one. `assertDevelopmentVocabulary()` stops the server at boot if labels drift. No AI coaching or generated plans. (M21_DEVELOPMENT_HUB)
- Owner is a player or an org and never changes. Visibility is explicit: player plans are private/player_guardian/shared_with_org; org plans are org_private/player_guardian. A minor's "private" plan still includes the guardian. Narrowing visibility withdraws shares. (M21)
- Plan: draft→active/archived; active→paused/completed/archived; paused→active/completed/archived; completed→active/archived. A draft may have zero goals; an active plan needs at least one. Goal: not_started→in_progress/blocked/stopped (never directly to achieved); achieved→in_progress. Action: todo/in_progress/blocked/done/cancelled; done→in_progress (undo). (M21; code)
- "Achieved" is a human judgement, not verified ability. Completing an action never completes a goal. Meeting a target never marks a goal achieved. Progress is shown as counts ("3 of 5"), never a ratio or bar. Overdue is a date fact. (M21)
- Evidence links hold ids only, resolve live, and show "unavailable" (no content) to unauthorised viewers. Access is checked before existence. (M21)
- Objective targets: one Combine metric, one operator and a value, pinned to a protocol version. Only a production-valid Combine result can satisfy one. Box Cam and assessments cannot. States: target_met / target_not_met / no_current_valid_measurement. (M21)
- Reviews are append-only. A correction supersedes once and only by the original author. Internal notes never reach the player payload. (M21)
- Minors read but cannot write (the guardian manages). Agencies have no access at all. Room notes and tasks are never copied in. M21 data never enters the Passport, M19 matching, M20 analytics, Trust or Second Look triggers. SSE events are org-private and ids-only. (M21)

**CV provider and Combine gate (M22)**
- Governing rule: *"A refused measurement is acceptable. A falsely verified measurement is not."* (M22_CV_THREAT_MODEL)
- Production inference runs server-side over frames the server receives. On-device or signed-client counts are rejected. The engine is deterministic, with no third-party weights. Frames are gray8 (160×120–320×240), nonce/seq-bound on the authenticated player router; client timestamps are never used. (M22_CV_THREAT_MODEL, M22_MATRIX, M22_PROVIDER_REPORT)
- The observation capability list and the Combine capability list are separate. Combine eligibility comes only from a per-protocol real-world validation record matching the current engine, policy and freeze. Every protocol is currently `not_completed`, so `combineVerifiedProtocols = []` and a production_cv Combine attempt returns 422 `REAL_WORLD_VALIDATION_NOT_COMPLETED`. Unvalidated counts travel as `experimental.exactCount` (`experimental_unvalidated`) and never reach Trust, M19 facts or M21 targets. (M22_PROVIDER_REPORT, M22_CV_EVALUATION)
- Refusal is a typed reason code (e.g. ball_not_detected, insufficient_visibility, liveness_failed), never a zero and never blame. Multiple people or balls means refusal. No silent fallback to web_client. (M22_MATRIX, M22_CV_THREAT_MODEL)
- Enablement needs all of: a configured, healthy provider; the required capabilities; a passing measured evaluation; and a current passing validation record. Then independent and T&S review, a named recorded decision, and a separate config change. (M22_REAL_WORLD_VALIDATION_PLAN)
- Never: biometrics, faces, audio, medical inference, player comparison, demographics. CV events are player_private, carry no counts. (M22 docs)

## Server contracts (from the old operations runbook)

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

- Real-world CV validation has not started: no datasets, annotators or consent process. Thresholds are pre-registered (0 false verifications, ≥95% within tolerance, ≤20% refusals, ≥200 valid attempts, adults only). (M22_REAL_WORLD_VALIDATION_PLAN)
- Replay via a virtual camera (T5) remains unsolved in the browser and must be disclosed. Only Chromium tested. There is no native capture. (M22)
- Future athletic Combine protocols (5-10-5, sprint, jumps) need spatial/timing detectors that don't exist, plus a Box Marker. (M16_1)
- No production identity provider, licence register, email transport, DNS probe, malware scanner or retention-deletion engine. T&S reviewer identity is declared, not authenticated (shared admin key). (M14)
- Passport share and Trust snapshots not persisted. (M15_MATRIX, M16_2)
- M21: no scheduler/reminders; UTC days; actions last-write-wins. (M21)

## Also worth knowing

- [`../reference/combine-real-world-validation-plan.md`](../reference/combine-real-world-validation-plan.md) (kept in the tree): pre-registered thresholds, event definitions and consent rules; the binding protocol for ever enabling Combine.
- M22_CV_THREAT_MODEL: T1–T52 security baseline for the frame endpoint.
- M22_MATRIX §C7: licence research (npm `ultralytics` is not YOLO; real YOLO is AGPL).

## Where the code enforces it

*Spot-checked against the code on 3 November 2026. ✓ enforced, ✗ not found, ≠ differs from the old docs.*

- ✓ Provenance order with box_cam_observed between historical_migration and scoutbox_reviewed: `scoutbox-server/m15/shared.mjs:20-29`.
- ≠ `production_cv` status is `configured`, with `combineVerifiedProtocols: []`: `m16/drills.mjs:119-126` (the M16 docs say not_configured).
- ✓ Test provider hidden unless enabled: `m16/drills.mjs:146`. `isProductionValidCombine` excludes testOnly: `m16/combineShared.mjs:231-235`.
- ✓ The validation gate denies unless `verdict?.pass !== true` is false: `m22/eligibility.mjs:111`. All three protocols `not_completed`: `m22/validation.mjs:54-56`.
- ✓ Share tokens stored as sha256: `domains/verification/passport/sharing.mjs:32,112`. Minor share gets `GUARDIAN_MANAGED`: `domains/verification/passport/sharing.mjs:55`.
- ✓ Trust weights must total 100 at boot: `domains/verification/trust/index.mjs:15`.
- ✓ The development vocabulary is asserted at boot: `m21/index.mjs:84`.
- ✓ The M21 transition tables match the docs: `m21/shared.mjs:127-211`.
- ✓ A trial never creates history: `domains/verification/passport/shared.mjs:196,406` (comments plus logic).
