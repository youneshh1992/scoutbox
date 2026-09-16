# M23 P4B — Defect Register

Defects found while building the Trial workflow (P4B), plus the disposition of
the Low defects P4A left open for P4B. The P4B rule (mandate §191): any
Critical or High is fixed before the next phase begins; any reasonably
fixable Medium is fixed before closure; nothing is carried forward silently.

Severity vocabulary (closure mandate §30, unchanged): **Critical** major
security / privacy / safeguarding / data-integrity compromise; **High**
significant auth / privacy / safeguarding / integrity failure or a broken
core workflow; **Medium** real correctness / availability / privacy /
lifecycle / data-quality defect that should reasonably be fixed before the
milestone closes; **Low** hygiene, cosmetic, documentation.

Every entry records: ID · severity · phase · area · reproduction · root cause
· impact · fix · regression · commit · status.

How the P4B defects were found: each phase's code was written first and its
unit and HTTP checks second; the four defects below were all surfaced by
those checks *before* the phase commit that carries the code, so the fix and
the defective code share a commit. They are registered anyway, because each
one is a real fault in the design as first written, not a typo, and each one
would have shipped without the test that caught it.

Regression suites named below: `m23TrialE2E` =
`scoutbox-server/scripts/m23TrialE2E.mjs` (535 checks, 331 negative, 62 %);
`m23TrialPersistence` = `scoutbox-server/scripts/m23TrialPersistence.mjs`
(36 checks, 13 negative); `m23TrialLive` = `e2e/m23TrialLive.test.mjs`
(122 checks, 53 negative).

---

## D-P4B-1 — Medium — P4B-1 — Trial engine: organiser time zone — **CLOSED**

**Reproduction:** `validateTimezone('Asia/Kolkata')` (or `Europe/Kyiv`,
`Asia/Ho_Chi_Minh`, `Asia/Kathmandu`) on the Node 22 runtime this repository
targets → `TRIAL_TIMEZONE_INVALID`. Over HTTP: `POST /org/rooms/:id/trials
{ timezone: 'Asia/Kolkata', … }` → `400 TRIAL_TIMEZONE_INVALID` for a real
city.

**Root cause:** the validator required the name to appear verbatim in
`Intl.supportedValuesOf('timeZone')` and to survive
`Intl.DateTimeFormat(…).resolvedOptions().timeZone` unchanged. The bundled
ICU still *reports* those cities under their legacy aliases
(`Asia/Calcutta`, `Europe/Kiev`, `Asia/Saigon`, `Asia/Katmandu`) although it
formats them correctly. An exact-name check therefore refused the current
IANA name of four cities.

**Impact:** an organiser in any of those zones could not send an invitation
or propose a schedule at all. Correctness and availability for a whole
region; no privacy or safeguarding dimension. Medium.

**Fix:** `MODERN_ZONE_ALIASES` in `m23/trial.mjs` — a modern name is
accepted when the runtime resolves it to exactly its listed legacy alias
(and the alias is in the supported set); the stored value is the modern name
the organiser typed. Nothing else about the exact-match rule changed: an
unknown, lower-cased or offset-style zone is still refused.

**Regression:** `m23TrialE2E` U1 (the four names accepted alongside
`Europe/London`, `UTC`, `America/St_Johns`), U7 (calendar-day derivation in
`Asia/Kolkata` across midnight), the U group's refusals of `europe/london`,
`GMT+1`, `Etc/GMT-14`-style inputs.

**Commit:** `40a0171` (P4B-1). **Status: CLOSED.**

---

## D-P4B-2 — High — P4B-3 — Schedule revision after a session has ended — **CLOSED**

**Reproduction:** a confirmed two-session schedule; the test clock moves past
the end of session 1; the club proposes a revision that carries session 1
unchanged and moves session 2 → `400 TRIAL_SCHEDULE_INVALID` ("a session
entirely in the past"). No revision of any kind was accepted once the first
session had ended, because every revision must carry ended sessions
unchanged (mandate §56, §66) and the validator refused every past session.

**Root cause:** `validateSessionInput` applied the "must be in the future"
rule uniformly. The route's own invariant — ended sessions are history and
must be carried — and the validator's invariant — no session in the past —
were individually correct and jointly unsatisfiable.

**Impact:** a multi-day trial could not be revised after day one: the club's
only options were to leave a wrong later session in place or cancel the
whole trial. A broken core workflow. High — fixed before P4B-4 began.

**Fix:** `validateSessionInput(raw, { now, allowPast })` and
`validateScheduleInput(…, { existingIds })`: a session that carries an
existing id may lie in the past (it is being carried, not created); a new
session must still start in the future. Moving an ended session, or one with
attendance recorded, remains refused by the route (`409
TRIAL_INVALID_STATE`, `current.sessionId`), so history cannot be edited
through the loophole this opens.

**Regression:** `m23TrialE2E` U15 (a brand-new session in the past is still
refused), S10 (a revision carrying the ended session and moving the future
one is accepted), S10b / S10c (moving the ended session backwards or forwards
is refused as editing what happened), the L group's revision cap.

**Commit:** `40a0171` (engine) and `d027c73` (route). **Status: CLOSED.**

---

## D-P4B-3 — Medium — P4B-8 — M12 operations sweep crashes on an alien trial row — **CLOSED**

**Reproduction:** a persisted `db.trials` containing a `null` (or a string,
or a number) entry; boot → the P4B reminder sweep in `m12/operations.mjs`
threw on `t.subjectRemovedAt` → the server did not start.

**Root cause:** the new T-48h / completion-pending / assessment-pending
sweeps iterated `db.trials` on the boot-contract guarantee that the
*collection* exists, and assumed every *row* is an object. The migration
(`m230_005_trial_workflow`) already skips such rows; the sweep did not.

**Impact:** availability — one garbage row in the store takes the whole
server down at boot, with no route answering `TRIAL_STATE_UNKNOWN` because
no route is reached. Medium (the row has to be planted; ScoutBox never writes
one, but the store is a file).

**Fix:** `if (!t || typeof t !== 'object') continue;` on every trial loop in
the sweep; the same guard already existed in the M15 Passport reader and the
M23 journey, and now holds in all three.

**Regression:** `m23TrialPersistence` §3 — "the server boots with eleven bad
or alien entries in the trials store" (`null`, a string, a number, and eight
structurally broken rows), the list answers with `omitted: 7` and the three
alien entries are ignored.

**Commit:** `d027c73`. **Status: CLOSED.**

---

## D-P4B-4 — Medium — P4B-1 — `trialIntegrity` throws instead of naming the problem — **CLOSED**

**Reproduction:** a trial row with `schedule.sessions: 'two'` (a string where
a list belongs) → `trialIntegrity()` threw (`.map` on a string) → `GET
/org/rooms/:id/trials` answered a bare 500 with a stack, not the documented
`TRIAL_STATE_UNKNOWN`, and the *whole* list for the case was unavailable
because of one row.

**Root cause:** the integrity checker checked the *values* of `sessions`,
`attendance` and `revisions` before checking their *shapes*.

**Impact:** correctness of the corruption contract (mandate §112–§114: a
corrupt row is omitted and counted, never fatal) and availability of the list
for every other trial on the case. Medium.

**Fix:** `Array.isArray` guards on every list field, and the checker wrapped
so that anything it still cannot read answers `['unreadable']`. The row is
then omitted from lists and counted; a single `GET` of it answers `500
TRIAL_STATE_UNKNOWN` with the id logged; the evidence provider answers *not
satisfied* for the case rather than inventing a state.

**Regression:** `m23TrialPersistence` §3 (`trial-bad-sessions` among the
seven omitted rows; the list still answers for the sound rows on the same
case), `m23TrialE2E` U group (the integrity vocabulary: `trial/player
mismatch`, `foreign session link`, `duplicate session id`, `endsAt <
startsAt`, unknown `workflowState`).

**Commit:** `40a0171`. **Status: CLOSED.**

---

## Suite corrections that are not defects

Two `m23TrialLive` checks were wrong as first written and were corrected
without a product change:

- **N10d** read the Trial tab's text immediately after the tab click and
  raced the trial-detail fetch (it saw "Assessments in this trial (0)"). It
  now waits for the detail like every other panel check. No product code
  changed.
- **N11c** expected `403 EVIDENCE_CONSENT_REQUIRED` for a Box Cam session id
  that did not exist. The server answers `404 TRIAL_BOXCAM_INCOMPATIBLE`
  for an unknown id *by design* (the 404 band: the club cannot tell "not
  yours" from "does not exist", and consent state is not enumerable through
  guesses). The check now creates a real finalised session of the player's
  and asserts the 403 on that; a sibling check (N11d) pins the 404 for an
  unknown id.

One `m15E2E` check ("self timeline shows the trial") was re-keyed in P4B-8:
the Passport's `trial_attended` event is now derived from recorded
attendance for workflow trials (`legacy: false, attendedSessions`) and from
acceptance only for legacy rows (`legacy: true`), as the reuse audit
prescribed (D-14). The check now schedules, confirms and records attendance
before asserting the event. That is a contract change of the milestone, not
a defect.

---

## P4A Low defects left for P4B — disposition

| ID | P4A status | P4B disposition |
|---|---|---|
| P4A-D3 Room demo fixtures (a `status: 'scheduled'` trial and a five-value label set production cannot produce) | OPEN (P4B-7) | **CLOSED in P4B-7** (`fdf10e7`). `roomsDemo.ts` in both club apps now carries a demo Trial store shaped exactly like the API (`workflowState`, `schedule`, revisions, attendance, evidence, `rev`), seeded with `trl-d1` on `room-d3`, a simulated recipient that accepts after 1.5 s, and the same error codes as the server. The five-value label set is gone; labels come from `tr.state.*`. |
| P4A-D6 `refusedClientFields()` not invoked by the M22 routes | OPEN (P4B-5) | **OPEN, unchanged.** P4B-5 links Box Cam sessions by reference and never touches the M22 routes or their client contract (`m22/*` has no diff in P4B; the M22 artefact churn from running its suites was reverted). Turning the silent ignore into a 400 is an M22 contract decision and stays with a Box Cam milestone (§222). |
| P4A-D7 documentation drift (`M16_BOX_CAM.md`, `M22_MATRIX.md` B6) | OPEN, doc-only | **OPEN, unchanged.** No P4B phase edited those documents; `M22_CAPABILITIES.md` remains the document of record. |
| P4A-D8 dead assessment state `'published'` tolerated by a reader | OPEN (P4B-6) | **OPEN, unchanged.** The tolerant reader is `m162/trust.mjs:149`; P4B-6 declares and enforces the Trial *context* of an assessment in `m12/scouting.mjs` and does not touch the Trust reader. The Trial tab and `assessmentsFor` show whatever `state` the M12 routes wrote (`draft` and the submitted states) and never write one; `'published'` is not among them. |
| P4A-D11 grassroots open-day `invite_trial` bypasses `issueRecruitmentRequest` | OPEN (P4B-2) | **OPEN, unchanged.** The P4B invitation route writes through `issueRecruitmentRequest` and adds `caseId`, `recipient` and `keys` to the row; the open-day writer (`server.mjs`, `outcome === 'invite_trial'`) was not modified because it has no case, no slots and no P4B fields, and its acceptance still goes through the single accept writer (verified in the P4A closure pass). A legacy request with no `caseId` is not evidence for any case (`trial_invited` provider), so it cannot move a Room. |

No new Critical or High defect is open. No Medium is open.
