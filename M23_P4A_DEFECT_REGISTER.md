# M23 P4A — Defect Register

Defects uncovered while auditing the Trial / Box Cam integration (P4A) and
during the P4A **closure pass** that followed it. The architecture milestone's
fix policy (§140) allowed only high-severity, privacy/safeguarding or
audit-blocking fixes, so P4A itself fixed one entry (P4A-D9) and left the rest
recorded. The closure pass ran under a different rule — *we do not knowingly
carry fixable Critical, High or Medium defects into P4B* — reproduced every
open Medium on a live server before touching code, fixed every Medium and
every Low that was cheap and safe to close alongside, and found one further
defect (P4A-D15) while proving the fixes under a process crash.

Severity vocabulary (closure mandate §30): **Critical** major
security/privacy/safeguarding/data-integrity compromise; **High** significant
auth/privacy/safeguarding/integrity failure or broken core workflow;
**Medium** real correctness/availability/privacy/lifecycle/data-quality
defect that should reasonably be fixed before P4B; **Low** hygiene,
cosmetic, documentation. The P4A rows were originally graded S1/S2/S3; the
mapping is S1 → High (P4A-D9, fixed in P4A), S2 → Medium, S3 → Low, and
nothing was relabelled downward.

Every entry records: ID · severity · area · reproduction · root cause ·
impact · why tests missed it · fix · regression · commit · status.

Regression suites named below: `m23P4AClosureE2E` =
`scoutbox-server/scripts/m23P4AClosureE2E.mjs` (337 checks, 210 negative,
62 %); `m12E2E` = the M12 suite (152 checks).

---

## P4A-D1 — Medium — Trial dates (request → accept → calendar) — **CLOSED**

**Reproduction** (fresh server, `scratchpad/m23/p4aDefectProbe.mjs`):
`POST /org/players/pl-adeyemi/request { type:'trial', proposedDate:'next tuesday-ish', venue:'x'×5000 }`
→ **201**; player `POST /player/requests/:id/respond { accept:true }` → 200;
`GET /org/trials` row `{ status:'awaiting_report', proposedDate:'next tuesday-ish', reportDueAt:null, venue: 5000 chars }`
(`new Date('next tuesday-ish').getTime()` is `NaN`, serialised as `null`);
`GET /org/trials/:id/ics` → **500** (`new Date(NaN).toISOString()` throws).
After a restart the `null` deadline read as "due now" in the feed
(`t.reportDueAt ?? Date.now()`), as "not overdue" in the operations sweep
(`t.reportDueAt &&`) and as "overdue since 1970" in the Director Dashboard
(`Number(null) < now`) — three readers, three meanings for one stored value.

**Route / module:** `server.mjs` request route (`/org/players/:id/request`),
both respond routes (`/guardian/requests/:id/respond`,
`/player/requests/:id/respond`), `/org/trials/:id/ics`, `/org/feed`, the
`/org/trials/:trialId/report` gate; `m12/journeys.mjs` postpone; readers in
`m12/operations.mjs`, `m20/timeSeries.mjs`, `m21/evidence.mjs`,
`m15/shared.mjs`.

**Root cause:** no Trial date validator existed. The request route stored
`proposedDate || null` and `altSlots.slice(0,2)` unchecked; the two
hand-copied accept writers computed `new Date(trialDate).getTime() + 7d`
with no validity check; the postpone route did `String(newDate).slice(0,10)`;
the calendar export formatted `reportDueAt` without guarding `NaN`. Every
reader then interpreted `null` its own way.

**Impact:** an org-authenticated club could persist a trial with no usable
day and a `null` deadline; the mandatory-report machinery (feed reminder,
overdue escalation, Director Dashboard) disagreed about it; the calendar
export was a raw 500; the venue was unbounded. No privacy or safeguarding
exposure; org-authenticated input only.

**Why tests missed it:** every suite (`apiE2E`, `m12E2E`, `m15E2E`) sent
well-formed `YYYY-MM-DD` dates shaped like the clients' `<input type="date">`;
no suite sent a malformed date, a non-array `altSlots`, an over-long venue
or an un-offered `chosenSlot`, and none exported the calendar for a bad row.

**Fix (this closure):**
- `domain.mjs` gains the **one** Trial date module: `parseTrialDate`
  (accepted syntax is a calendar day `YYYY-MM-DD`, calendar-valid, year
  2000–2100; `''`/`null`/`undefined` = "no date"; everything else refused
  `TRIAL_DATE_INVALID` with the expected syntax — no time-of-day, no
  timezone, no trimming, no coercion), `isTrialDate`, `trialReportDueAt`
  (the one deadline derivation: trial day UTC midnight + 7 days, or the
  caller's acceptance instant + 7 days; never `NaN`, `null` when nothing
  finite exists), `validateTrialDetails` (dates, `altSlots` list of ≤ 2
  distinct days, venue ≤ 200 one-line text, notes ≤ 500 text — refused over
  the limit, never truncated) and `chooseTrialSlot` (absent = proposed day;
  anything else must be an offered day — P4A-D12; a legacy stored day that
  no longer parses yields no date rather than a fabricated one).
- The request route validates before `issueRecruitmentRequest` (400, field
  named). Both respond routes validate the slot **before** the answer is
  recorded, so a refused slot leaves the request pending.
- One accept-time writer `issueAcceptedTrial` replaces the two copies
  (closes P4A-D4 and P4A-D13: `acceptedBy`, `guardianApproved`,
  `respondedBy` on both paths, `acceptedAt === respondedAt` — one clock).
- Postpone validates `newDate` through the same parser and re-derives the
  deadline through the same derivation.
- Read side: the calendar export answers **422 `TRIAL_DATE_INVALID`** for a
  stored day that is not a calendar day (never 500, never an invented day),
  omits the deadline sentence when none is finite, and RFC 5545-escapes
  stored text so no venue or note can begin a calendar line. Feed,
  operations sweep, Director Dashboard, safety pack and M21 evidence treat a
  non-finite deadline as *unknown*, not "now" and not "1970".
- No migration: legacy rows are handled on read; a postponement to a real
  day repairs them through the validator.

**Regression:** `m23P4AClosureE2E` A1–A14 (pure: the mandate's malformed
list — `''`, `not-a-date`, `2026-13-99`, `2026-02-31`, `null`, `{}`, `[]`,
`0`, `NaN`, whitespace, datetime, 1999/2101, leap days, prototype keys,
year/month/DST boundaries), B1–B13 (HTTP: refusals before persistence,
canonical details, un-offered slot 400 with the request still pending,
deadline = day + 7 d exactly, calendar export and escaping, postpone
validation and re-derivation, feed, guardian path through the same writer),
F0–F3 (calendar fuzz: non-ASCII, notes at the limit, cancelled trial,
unknown/prototype/newline ids), L3–L6 and L8e–L8f (legacy garbage/NaN/null/
out-of-range rows: 422 not 500, no fabricated deadline, not counted overdue,
legacy invitation still acceptable with no date, repair by postponement,
identical after restart). `apiE2E`, `m12E2E`, `m15E2E` unchanged and green.

**Commit:** the P4A closure commit (footer). **Status: CLOSED.**

---

## P4A-D2 — Low — Passport org-viewer timeline — **CLOSED**

**Reproduction:** file a trial report; the report carries `filedAt` and no
`at`; `m15/shared.mjs` built the `trial_outcome` event from
`t.report.at ?? proposedDate ?? acceptedAt`, so the outcome date was never
the filing date. **Root cause:** field-name drift between the M12 writer
and the M15 projector. **Impact:** cosmetic; the event is `private_own_org`.
**Why tests missed it:** `m15E2E` fixtures wrote `report: { at }` by hand.
**Fix:** `normWhen(t.report.filedAt ?? t.report.at ?? …)` — the writer's
name first, the fixture name kept for old rows. **Regression:** `m15E2E`
unchanged and green. **Status: CLOSED.**

---

## P4A-D3 — Low — Room demo fixtures — **OPEN (P4B-7), documented**

Demo fixtures (`roomsDemo.ts`) show a trial `status: 'scheduled'` and a
five-value label set that production cannot produce. Demo mode only; no
production path reads it. **Why left open:** P4B-7 rewrites these fixtures
against the P4B schedule vocabulary; rewriting them now against the M12
vocabulary is churn P4B undoes. Not a correctness, privacy or availability
defect in any production path. **Status: OPEN, Low, P4B-7.**

---

## P4A-D4 — Low — adult-accept trial writer — **CLOSED**

**Reproduction:** adult accept omitted `guardianApproved`; the guardian
accept set it `true`; the Pro `TrialsScreen` pill read `undefined` for every
adult trial. **Root cause:** two hand-maintained object literals. **Fix:**
one writer `issueAcceptedTrial` stamps `guardianApproved: by === 'guardian'`
and `acceptedBy` on both paths. **Regression:** `m23P4AClosureE2E` B7d,
B13d, D8f. **Status: CLOSED.**

---

## P4A-D5 — Low — Box Cam CV finalize rate policy — **CLOSED**

**Reproduction:** `RATE_LIMIT_POLICY.box_cv_finalize` (80/h/player) existed
but `POST /player/box-cam/sessions/:id/cv/finalize` never called
`limited('box_cv_finalize', …)`; 81 calls in an hour all reached the route.
**Root cause:** the guard line was omitted when the route set was written.
**Impact:** bounded — finalize is nonce-bound and once per provider session.
**Why tests missed it:** `m22E2E` exercised the frames limit only.
**Fix:** the guard runs first in the route and answers `429 rate_limited`
like its siblings. No CV algorithm, gate, threshold or provider touched.
**Regression:** `m23P4AClosureE2E` R1–R2b. `m22E2E`, `m22Blocker`,
`m22CvEval`, `m22Holdout`, `m22Robustness` unchanged and green.
**Status: CLOSED.**

---

## P4A-D6 — Low — `refusedClientFields()` not invoked by M22 routes — **OPEN (P4B-5 O6), documented**

The structural protection holds and is asserted (`m22E2E` §107: a client
posting `touchCount:176, combineVerified:true` "changes nothing"); the
explicit 400 the policy describes does not fire. **Why left open:** turning
the ignore into a 400 changes the tested M22 client contract; that is an M22
contract decision for P4B-5, not a closure fix. No overclaim, no measurement
trusted. **Status: OPEN, Low, P4B-5.**

---

## P4A-D7 — Low — documentation drift — **OPEN, doc-only**

`M16_BOX_CAM.md` describes `production_cv` as `not_configured` where the
registry says `configured`; `M22_MATRIX.md` B6 names an identifier absent
from the tree. `M22_CAPABILITIES.md` is current and is the document of
record. **Status: OPEN, Low, doc pass (P4B-5).**

---

## P4A-D8 — Low — dead assessment state `'published'` tolerated by readers — **OPEN (P4B-6), documented**

No writer sets it; readers tolerate it. Harmless; P4B-6 declares the exact
state set. **Status: OPEN, Low, P4B-6.**

---

## P4A-D9 — High (privacy / safeguarding) — org trial-day view after a block — **CLOSED in P4A**

Reproduced and fixed in P4A (`ca3e6c9`): the org day view withholds the
family's emergency contact whenever `ctx.isBlocked(t.playerId, t.orgId)`
(`emergency: null`, `emergencyWithheld: 'BLOCKED'`), restored when T&S lifts
the block. **Regression:** `m12E2E` §9 (five assertions). **Status: CLOSED
(P4A).**

---

## P4A-D10 — Medium — minor's outcome notification — **CLOSED**

**Reproduction** (fresh server, `scratchpad/m23/p4aReproD10D14.mjs`):
Eastport invites Guni (14) to a trial → routed to Amara; Amara accepts →
`GET /player/notifications` for Guni holds **one** row
(`request`/`messages`: "Eastport FC contacted your parent/guardian about a
trial.") and **no** row about the acceptance. With `discovery_nudges` turned
**on** for a second minor (Tomasz), Marek's decline lands as
`['update', 'discovery_nudges', 'Your parent/guardian declined the trial with
Eastport FC.']` — the row exists only when the *discovery nudges* switch is
on, and it is filed as a nudge.

**Route / module:** `server.mjs` guardian respond route (two `notify(…,
'update', …)` sites); `m182/notificationPrefs.mjs` `TYPE_CATEGORY`
(`update → discovery_nudges`, default **off**).

**Audit of the notification (mandate §11):** type `update`; category
`discovery_nudges`; default off; recipient the child (player audience);
guardian routing correct (the guardian decides; the child is told).
**Classification:** *informational, optional* — the guardian is the decision
maker and nothing is required of the child — but it is the **outcome of a
request**, exactly what the club-side `accepted`/`declined` rows are, and
those live in `messages` ("Messages and requests", default on). Filing it as
a discovery nudge was a taxonomy error, not a category-default error.

**Root cause:** the `update` type was chosen before the M18.2 category map
existed; when the map arrived, `update` (used elsewhere for badges/levels)
was mapped to `discovery_nudges` and this call site was never re-classified.

**Impact:** no minor was ever told in their Updates that their guardian
accepted or declined a trial or a contact (the Inbox item itself still showed
the outcome). Also affected P3 Contact outcomes for minors.

**Why tests missed it:** the guardian-path suites asserted the guardian's
and the club's notifications; nobody asserted the *child's* list after a
guardian answer, and `m182E2E` covered the category map, not this call site.

**Fix (root taxonomy, no parallel system, no force-send):** a dedicated
type `guardian_decision` → **`messages`** in `TYPE_CATEGORY`; both call
sites use it. No new category, no new mandatory category, no migration:
existing preference records keep their meaning (a person who muted
"Messages and requests" mutes this too, exactly like the club-side outcome
rows; nobody is silently opted into anything). `update` still means a
discovery nudge for the badge/level sites that use it. Hardened alongside:
`notificationPrefs` reads and writes own keys only (`Object.hasOwn`) —
`'constructor' in CATEGORIES` was true through the prototype, so a
`constructor:false` preference used to be accepted and stored. The
player-app demo mock mirrors the new type.

**Regression:** `m23P4AClosureE2E` C0a–C0e (taxonomy), C1–C1e (exactly one
`guardian_decision`/`messages` row for the child; none for the guardian, the
club or an adult who answered for themselves), C2–C2h (muted → not created,
never created-and-hidden; on → created, worded for a contact), C3–C3e
(prototype-named categories refused; mandatory still refused), C4–C5c
(sentinel `PRIVATE_TRIAL_INTERNAL_SENTINEL_8472` in a room comment and a
decision note absent from the child's inbox/notifications/export/Passport/
trials, the guardian's inbox/notifications/export, the foreign club's
trials/journey/notifications, the public directory, the T&S outbox and push
log — with the club's own Room as the control). `m182E2E` unchanged and
green.

**Commit:** the P4A closure commit. **Status: CLOSED.**

---

## P4A-D11 — Low — grassroots open-day invite bypasses `issueRecruitmentRequest` — **OPEN (P4B-2), documented**

A second `db.requests` writer (open-day `invite_trial` outcome) with its own
routing derivation and notification type. Verified in the closure pass: it
writes `proposedDate: null, altSlots: []`, so it cannot produce a malformed
Trial date, and its acceptance goes through the single accept writer. **Why
left open:** routing it through the writer changes its notification type and
guardian rule — P4B-2 owns the invitation contract. **Status: OPEN, Low,
P4B-2.**

---

## P4A-D12 — Low — unknown `chosenSlot` silently ignored — **CLOSED**

**Reproduction:** accept with an un-offered `chosenSlot` → 200, trial dated
on `proposedDate`; the recipient believed they had chosen a day the club
never offered. **Fix:** `chooseTrialSlot` refuses `400 TRIAL_SLOT_INVALID`
with the offered days listed, *before* the answer is recorded (request
stays pending, no trial row). **Regression:** `m23P4AClosureE2E` A12–A13c,
B6–B6c, B13–B13b. **Status: CLOSED.**

---

## P4A-D13 — Low — `respondedBy` written by the guardian route only — **CLOSED**

**Fix:** both respond paths stamp `respondedBy` (`'player'`/`'guardian'`)
and the trial's `acceptedAt` equals the request's `respondedAt`.
**Regression:** `m23P4AClosureE2E` B7e, B13e. **Status: CLOSED.**

---

## P4A-D14 — Medium — player deletion cascade vs lifecycle — **CLOSED**

**Reproduction** (fresh server, `scratchpad/m23/p4aReproD10D14.mjs`):
Room for Kola (`watching`) → trial invited and accepted (`awaiting_report`)
→ `DELETE /player/account` → 200 → `GET /org/trials`: the row is **gone**;
`GET /org/rooms/:id`: the case remains (200, `watching`); after a SIGKILL
restart: case still present, trial still gone; duplicate delete → 401. The
inventory (mandate §21) of what the cascade touched or left: **removed** —
`players`, player `sessions`, `requests`, `channels`, `trials`, player
`notifications`, `pairingCodes`, guardian `childIds` entries; **kept with
the person's name or text** — `recruitmentCases.playerName`,
`assessments.playerName`, `recruitmentContacts.response.message`, open-day
`registrations[].playerName`; **kept by design, ids only** — `ledger`,
`signings`, `blocks`, `roomDecisions`.

**Route / module:** `server.mjs` `deletePlayerData` (called by
`DELETE /player/account` and `DELETE /guardian/children/:id`); readers in
`server.mjs` (report route, feed, `REPORTS_OUTSTANDING` gate),
`m12/journeys.mjs` (`trialFor`), `m12/operations.mjs`, `m20/timeSeries.mjs`,
`m17/rooms.mjs` (search, notifications), `m23/contactRoutes.mjs`.

**Root cause:** the cascade was written before the M17/M23 stores existed
and filtered the trial and request rows out. A case that referenced a trial
(history, links, P4B evidence) lost the record that the trial had happened,
while the case itself — and its stored copy of the player's name — stayed.
Filing a report for a trial whose player was gone would have thrown
(`p.trialReports` on `null`) had the row survived.

**Impact:** history destroyed for the club (trial happened, report numbers
filed — gone) while names were retained on cases and assessments after the
person asked to be deleted; a case at `trial_completed` (legacy data; no
route can reach it today) would have carried a status with no evidence
behind it.

**Why tests missed it:** deletion suites (`apiE2E`, `m13E2E`) asserted only
that the player, requests and channels were gone and that the ledger stayed;
none created a trial or a Room first, and none restarted.

**Fix (tombstone per the ledger's existing rule — ids, states, times, the
club's own filed numbers; nothing person-shaped):**
- `db.trials`: `tombstoneTrial` keeps id, requestId, playerId, orgId,
  orgName, scoutName, acceptedAt, acceptedBy, guardianApproved,
  proposedDate, venue, reportDueAt (finite or null), status, reminder /
  escalation markers, the report's ids/times/six numbers, the club's own
  staff records, the fact of each consent (kind only), check-in times and
  status events; strips `playerName`, notes, `day.emergency`, `day.arrival`,
  `day.collection`, consent author ids/names, report notes/strengthNote/
  focusNote; stamps `subjectRemovedAt`.
- `db.requests`: `tombstoneRequest` keeps ids, type, status, org and scout
  identity, offered days and venue, timestamps, `respondedBy`, `routedTo`;
  strips `message`, `playerName`, trial notes, `guardianId`,
  `contactChannel`.
- `recruitmentCases`: `playerName → null`, `subjectRemovedAt` stamped —
  **no status write, no history entry, no rev change**; deletion is not a
  lifecycle event and the canonical writer is not invoked. `assessments` and
  open-day registrations lose the name; `recruitmentContacts` lose the
  family's reply text. The cascade is one `persistNow()`.
- Readers: report filing on a tombstone → `409 TRIAL_SUBJECT_REMOVED`; every
  trial-day write → `409 TRIAL_SUBJECT_REMOVED` (reads still 200 with
  nothing person-shaped); `REPORTS_OUTSTANDING`, the feed reminder, the
  operations escalation and the Director Dashboard skip tombstones (a report
  nobody can file is not an obligation); Room search and Room notifications
  tolerate a missing name.

**Regression:** `m23P4AClosureE2E` D1–D8i (minor cannot self-delete; two
adults deleted — reported and awaiting; tombstone shapes; phone number and
names absent from every club list; cases at the same status and rev; journey
still lists the trial as evidence; Room search; feed; Dashboard count −1;
gate skips the tombstone; report/arrival/postpone/cancel/staff/check-in →
409 by name; day read 200 without the contact; calendar export names nobody;
public directory aggregates intact; foreign org sees neither tombstone and
gets the same 404; guardian deletes a child after an accepted trial — same
tombstone, inbox/export cleared, second delete 404), F5–F8b (races: two
concurrent deletes → exactly one 200 and one 401; delete vs report → the
whole report tombstoned or refused by name, never half-written; delete vs
lifecycle advance → the advance applied exactly once or not at all, the
deletion moved nothing), L6m–L7n (the D14 matrix as legacy fixture cases at
`trial_requested`, `trial_scheduled`, `trial_completed`,
`offer_consideration`, `offer_made`, `offer_accepted`, `archived`,
`withdrawn`, `closed`: status and rev unchanged after deletion, name gone;
the `trial_completed` case still carries its trial evidence in the journey),
L7–L7f (signed invariant: a legacy `signed` case with its signing record
stays `signed` at the same rev; the signing survives), L8–L8m
(byte-identical tombstones and identical case statuses after a restart; the
409 still holds). `apiE2E`, `m13E2E`, `m141E2E` unchanged and green.

**Not supported today, stated rather than tested:** organisation removal
(no route exists); Trial-completion and assessment-submit races beyond the
report route (those P4B routes do not exist yet).

**Commit:** the P4A closure commit. **Status: CLOSED.**

---

## P4A-D15 — Medium — accepted request saved before its trial row existed — **CLOSED** (found in the closure pass)

**Reproduction** (`m23P4AClosureE2E` L0b→L2c, first run): a player accepts
a trial → 200; the process is `SIGKILL`ed immediately; on reboot the request
reads `accepted` with a `contactChannel` and the trial row is **absent**.

**Route / module:** both respond routes in `server.mjs`.

**Root cause:** the routes called `persistNow()` right after recording the
answer and *then* opened the channel and pushed the trial row, leaving those
to the 2-second debounced `persist()`. A crash inside that window kept the
answer and lost the trial (and the channel).

**Impact:** an accepted trial invitation with no trial — the club would
never see it, no report would ever be due, and the family believed a trial
was booked. Data integrity, crash-window only.

**Why tests missed it:** no suite killed the process immediately after an
acceptance; `m23ContactPersistence` restarts after a *contact* send, which
has no second row.

**Fix:** one `persistNow()` at the end of each respond route, after the
answer, the contact update, the channel and the trial row — the acceptance
is one save (the store's `save()` is one SQLite transaction).

**Regression:** `m23P4AClosureE2E` L2c. **Commit:** the P4A closure commit.
**Status: CLOSED.**

---

## Design gaps carried into P4B (not defects)

Unchanged from P4A and still accurate: `altSlots` are not recorded on the
trial after acceptance (the request row keeps them — now on the tombstone
too); the `REPORTS_OUTSTANDING` gate is org-wide (D-17); `/orgs/directory`
is unauthenticated aggregate counts; assessments have no `trialId` (D-9);
two live "trust" numbers (§10).

## Legal-review items (kept separate from defects, mandate §34)

1. Trial-specific footage acknowledgement for minors.
2. Whether event-consent language should explicitly name Box Cam.

Neither is resolvable from source; neither is counted as a software defect.

## Final defect inventory

| ID | severity | area | status |
|---|---|---|---|
| P4A-D1 | Medium | Trial dates / deadline / calendar | CLOSED |
| P4A-D2 | Low | Passport `trial_outcome` date | CLOSED |
| P4A-D3 | Low | Room demo fixtures (demo mode only) | OPEN — P4B-7 |
| P4A-D4 | Low | adult-accept writer fields | CLOSED |
| P4A-D5 | Low | Box Cam finalize rate policy | CLOSED |
| P4A-D6 | Low | `refusedClientFields` not invoked (contract decision) | OPEN — P4B-5 |
| P4A-D7 | Low | documentation drift | OPEN — doc pass |
| P4A-D8 | Low | dead assessment state read | OPEN — P4B-6 |
| P4A-D9 | High | blocked org read the family's emergency contact | CLOSED (P4A) |
| P4A-D10 | Medium | minor's guardian-decision notification | CLOSED |
| P4A-D11 | Low | open-day invite bypasses the request writer | OPEN — P4B-2 |
| P4A-D12 | Low | un-offered `chosenSlot` accepted | CLOSED |
| P4A-D13 | Low | `respondedBy` on one path only | CLOSED |
| P4A-D14 | Medium | deletion cascade vs lifecycle / history / PII | CLOSED |
| P4A-D15 | Medium | acceptance saved before the trial row | CLOSED |

```
Critical open: 0
High open: 0
Medium open: 0
Low open: 5 (D3, D6, D7, D8, D11 — each with a named P4B owner and a stated reason)
Informational: 0
Legal-review items: 2 (separate)
```

## Commit

P4A-D9 fixed in `ca3e6c9` ("M23 P4A: Trial + Box Cam integration
architecture"); regression `m12E2E` §9, 152 checks.

P4A-D1, D2, D4, D5, D10, D12, D13, D14, D15 fixed in `7683247` ("M23 P4A closure: close D1, D10, D14 (+D2, D4, D5, D12,
D13, D15)"); regression
`m23P4AClosureE2E`, 337 checks (210 negative).
