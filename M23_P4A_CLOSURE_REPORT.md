# M23 P4A — Zero Critical / High / Medium Final Closure

Starting tip `b29532a` (P4A architecture, D9 fixed, D1/D10/D14 open).
Closure commit: recorded in the footer of this file (the hash cannot be
known before the commit exists). No push, no PR, no deploy. P4B not
begun; the Trial Workflow, the Offer Workflow and the Box Cam CV engine are
untouched.

Governing rule: we do not knowingly carry fixable Critical, High or Medium
defects into P4B. Every item below is backed by executed evidence — the
defect register (`M23_P4A_DEFECT_REGISTER.md`), the new closure suite
(`scoutbox-server/scripts/m23P4AClosureE2E.mjs`), the full server battery,
the M22 battery, the browser/live/demo battery, the navigation regression,
the recovery bundle and a fresh clone.

## 1. Order of work

1. **Reproduce first.** D1 (`scratchpad/m23/p4aDefectProbe.mjs`), D10 and
   D14 (`scratchpad/m23/p4aReproD10D14.mjs`) were reproduced on fresh
   servers, including a SIGKILL restart for D14, before any code was read
   for a fix. The exact reproductions, routes, current-vs-expected
   behaviour, impact, root cause and why the suites missed each one are in
   the register.
2. **Fix at the root.** One Trial date module in `domain.mjs`; one
   accept-time trial writer; the child's notification re-classified in the
   existing taxonomy; a tombstone cascade that writes no lifecycle status.
3. **Prove under adversarial conditions.** A new 337-check suite (210
   negative, 62 %), including races, a SIGKILL after an acceptance, legacy
   rows injected into the store, and the privacy sentinel across fourteen
   surfaces. The SIGKILL test found D15.
4. **Regress everything**, revert artifact churn, rebuild demos, bundle,
   fresh-clone.

## 2. D1 — Trial dates

**Reproduction.** `POST /org/players/pl-adeyemi/request { type:'trial',
proposedDate:'next tuesday-ish', venue:'x'×5000 }` → 201; accept → 200; the
trial row carried `reportDueAt: null` (NaN on the wire) and the 5000-char
venue; `GET /org/trials/:id/ics` → **500**. Three readers gave the `null`
deadline three meanings.

**Root cause.** No validator anywhere; two hand-copied accept writers doing
`new Date(x).getTime() + 7d`; the calendar export formatting `NaN`.

**Fix.** `parseTrialDate` / `isTrialDate` / `trialReportDueAt` /
`validateTrialDetails` / `chooseTrialSlot` in `domain.mjs` — the accepted
syntax is a calendar day `YYYY-MM-DD` (calendar-valid, 2000–2100; empty
means "no date"; nothing is trimmed or coerced); the deadline is derived in
one place from one clock (trial day + 7 days UTC, else acceptance + 7 days;
never NaN). The request route refuses before `issueRecruitmentRequest`;
both respond routes validate the slot before recording the answer;
`issueAcceptedTrial` is the single writer; postpone re-derives; the calendar
export answers 422 `TRIAL_DATE_INVALID` for a stored non-day (never 500,
never a fabricated day), omits an unknown deadline and RFC 5545-escapes
text; feed, sweep, Dashboard, safety pack and M21 treat a non-finite
deadline as unknown. No migration.

**Regression proof.** `m23P4AClosureE2E` A1–A14, B1–B13, F0–F3, L3–L6,
L8e–L8f. `apiE2E` 130, `m12E2E` 152, `m15E2E` 185 unchanged and green.

## 3. D10 — the minor's outcome notification

**Reproduction.** Amara accepts a trial for Guni → Guni's notifications
hold no row about it; with `discovery_nudges` switched on for Tomasz, the
decline for him lands as `update` / `discovery_nudges`.

**Root cause.** The `update` type predates the M18.2 category map and was
mapped to the off-by-default nudge category; the call site was never
re-classified. Audit: type `update`, category `discovery_nudges`, default
off, recipient the child, guardian routing correct. Classification:
informational/optional, but a *request outcome* — the same class as the
club's `accepted`/`declined` rows, which live in `messages` (default on).

**Fix.** New type `guardian_decision` → `messages` in `TYPE_CATEGORY`, used
at both call sites. No new category, no mandatory category, no migration,
no silent opt-in: an existing "Messages and requests" preference keeps its
meaning. `update` still means a nudge for the badge/level sites. Own-key
checks (`Object.hasOwn`) in the preference reader/writer close a prototype
key weakness found alongside. The player demo mock mirrors the type.

**Regression proof.** `m23P4AClosureE2E` C0–C5c: taxonomy; exactly one row
for the child and none for the guardian/club/adult; muted → not created;
on → created (contact wording); prototype-named categories refused;
sentinel `PRIVATE_TRIAL_INTERNAL_SENTINEL_8472` absent from the child's
inbox/notifications/export/Passport/trials, the guardian's
inbox/notifications/export, the foreign club's trials/journey/
notifications, the public directory, the T&S outbox and push log, with the
club's own Room as the control. `m182E2E` green.

## 4. D14 — deletion cascade

**Reproduction.** Room + accepted trial → `DELETE /player/account` → the
trial row vanished (also after a SIGKILL restart) while the case stayed;
cases, assessments, contacts and open-day registrations kept the person's
name or reply text. Full inventory in the register.

**Root cause.** A cascade written before M17/M23 that filtered rows out.

**Fix.** Id-only tombstones for trials and requests (ids, states, times,
the club's own filed numbers and staff records; no name, notes, emergency
contact, arrival, consent identity or feedback text); cases lose the stored
name and gain `subjectRemovedAt` with **no status write, no history entry,
no rev change**; assessments, registrations and contact replies lose the
person-shaped text; one `persistNow()`. Report filing and every trial-day
write on a tombstone → 409 `TRIAL_SUBJECT_REMOVED`; reads still answer with
nothing person-shaped; the report gate, feed reminder, escalation sweep and
Director Dashboard skip tombstones; Room search and notifications tolerate
a missing name.

**Regression proof.** `m23P4AClosureE2E` D1–D8i, F5–F8b (races), L6m–L8m
(matrix at nine lifecycle positions incl. `trial_completed`, `offer_made`,
`signed`; signing survives; byte-identical after restart). `apiE2E`,
`m13E2E`, `m141E2E` green.

## 5. Additional defects

- **Critical found: 0. High found: 0.**
- **Medium found: 1** — P4A-D15, the accepted request was saved before its
  trial row existed (crash window). **Fixed**: one save at the end of each
  respond route. Proof: L2c (SIGKILL immediately after an acceptance).
- **Also fixed:** D2 (report date), D4 (one writer), D5 (finalize rate
  limit), D12 (un-offered slot), D13 (`respondedBy`), the prototype-key
  weakness in notification preferences, the `p.trialReports` crash path for
  a report filed against a missing player.
- **Left open, Low, each with a P4B owner and a stated reason:** D3 (demo
  fixtures, P4B-7), D6 (`refusedClientFields` — an M22 contract decision,
  P4B-5), D7 (docs), D8 (dead state read, P4B-6), D11 (open-day invite
  writer, P4B-2). None is a correctness, privacy, availability or
  lifecycle defect in a production path.

**Final counts: Critical 0 · High 0 · Medium 0 · Low 5 open.**

**Legal-review items (separate, not defects):** Trial-specific footage
acknowledgement for minors; whether event-consent language should name
Box Cam.

## 6. Sweep results

| area | result |
|---|---|
| Trial lifecycle integrity | No path other than `ctx.applyLifecycleTransition` writes a case status (direct-writer sweep: `m17/rooms.mjs` adoption at creation only, unchanged). Deletion writes none. `signed` still requires a signing (L7). |
| Safeguarding | Agencies and unverified clubs still cannot invite minors (`VERIFIED_CLUBS_ONLY` observed during reproduction); a minor cannot self-delete (D1); `isAdult()` is recomputed per request (`req.playerIsMinor`), no stale boolean persisted. |
| Guardian | Routing unchanged; the guardian decides, the child is told (`guardian_decision`); a guardian cannot delete another's child (D8c); the guardian path uses the same trial writer (B13d). |
| Block | Unchanged and re-proved by `m12E2E` §9 (D9) and `m23ContactE2E` B; blocks are evaluated on every read and every accept. |
| Foreign org | Same 404 for a trial's calendar, day view and the case as for an unknown id (B8e, D7–D7c); neither tombstone visible; sentinel absent from its trials/journey/notifications. |
| Assessment privacy | Publication boundary unchanged: `publishedFeedback` remains the only door; sentinel in a decision note never reaches player/guardian surfaces (C5). |
| Box Cam truth / gates | Only the finalize rate guard changed. `m22E2E`, `m22Blocker`, `m22CvEval`, `m22Holdout`, `m22Robustness`, `m22Perf` green; artifacts regenerated byte-identical except timestamps/timings, reverted. Refusal semantics, Combine Verified refusal, client-field ignore and no raw video are unchanged. |
| Notifications | One taxonomy, no parallel system; required categories unchanged (`security_account` only mandatory); own-key preference handling. |
| Deletion / cascade | Tombstones; no lifecycle write; idempotent by refusal (401/404 on a second delete); races leave no partial state (F6–F8). |
| Error contract | Every new refusal is an explicit code: `TRIAL_DATE_INVALID`, `TRIAL_SLOTS_INVALID`, `TRIAL_VENUE_INVALID`, `TRIAL_NOTES_INVALID`, `TRIAL_SLOT_INVALID`, `TRIAL_SUBJECT_REMOVED`, `rate_limited`; invalid types (`{}`, `[]`, `0`, `true`, `NaN`, whitespace) and prototype keys never 500. |
| Persistence / restart | Schema stays 2303 (clean boot, no migration); tombstones and derived deadlines byte-identical after restart; legacy garbage/NaN/null/out-of-range rows survive and are refused or interpreted honestly. |
| Concurrency | Two deletes, delete vs report, delete vs lifecycle advance (F6–F8). |
| Idempotency | Second delete 401/404; postpone without a new day changes nothing; lifecycle replay untouched. |
| One clock | `acceptedAt === respondedAt`; the deadline derives from the trial day or that instant. |
| Failure injection | The M18.2 fault layer targets outbound sources, not the store; the multi-object acceptance is one SQLite transaction and is proved by the SIGKILL test instead (L2c). |

## 7. Regression totals

**Full server battery (owned :4000, 40 scripts, all exit 0):** testTrust 23;
apiE2E 130; connectedE2E 43; m12E2E 152; m13E2E 212; m14E2E 193; m141E2E 94;
m15E2E 185; m16E2E 118; m161E2E; m162E2E; m17E2E; m18E2E; m181E2E; m182E2E;
m19E2E; m20E2E; m21E2E; m22E2E; m22Blocker; m23E2E; m23Persistence 67;
m23BootContract; m23ContactE2E; m23ContactPersistence; **m23P4AClosureE2E
337 (210 negative, 62 %)**; m22CvEval; m22Holdout; m22Robustness 48;
m22Perf; m23Perf; m23ContactPerf; m17Perf; m18Perf; m181Perf; m182Perf;
m19Perf; m20Perf; m21Perf.

**M22 battery:** eval, holdout, robustness, blocker, E2E green;
`evaluation.json` / `holdout.json` differ only in `generatedAt`, `perf.json`
only in timings — reverted with `git checkout`.

**Browser / live / demo battery** (demos rebuilt first, `buildDemos` exit 0):
36 scripts, all exit 0, zero ✗ lines: navConfig 282; demoFreshness 13;
uiSpotcheck; demoOffline; crosstab; demoHostOrdering 15; demo spotchecks
m12, m13, m14, m162 (21), m17 (47), m18, m181, m182, m19, m20, m21 (zero
page errors each); liveIntegration; **navLive 64 (N1–N17)**; live journeys
m12, m13, m14 (L1–L7), m15 (21), m16 (10), m162 (11), m17 (25), m18 (60),
m181 (37), m182 (37), m19 (17), m20 (59), m21 (68), m22, m23 (39),
m23Contact (82, 33 negative). No M22 artifact churn from the browser run.

**Typechecks:** scoutbox-player `tsc --noEmit` exit 0 (the only client whose
source changed; Pro, Grassroots and Admin sources untouched).
**Builds:** the player demo export (`expo export --platform web`) via
`buildDemos` exit 0; `demoFreshness` 13 checks.

## 8. Recovery

Bundle `/home/user/scoutbox-m23-p4a-final.bundle`, created from the final
tip after the closure commits. Its byte count, SHA-256, `git bundle verify`
result and the fresh-clone results (HEAD/tree equality, boot, the closure
suite, the core M23 suites, `m12E2E`, `apiE2E`, the M22 critical suites and
the Contact live journey from the clone) are reported in the closure
message rather than here: the bundle is made from the commit that contains
this file, so its hash cannot be written into it. The scratchpad log
`bundle-p4a.log` holds the verbatim output.

## 9. D1 / D10 / D14 closure checks

```
Malformed Trial date accepted: NO
Malformed Trial date persisted: NO
Invalid report deadline possible from normal writer: NO
ICS/calendar raw 500 from malformed Trial date: NO
Legacy malformed row fabricates date: NO
Pre/post restart semantic drift remains: NO
```

```
Required minor/guardian outcome can be suppressed by optional category default: NO
Minor direct-routing bypass introduced: NO
Guardian re-authorization skipped: NO
Internal recruitment content leaks in outcome notification: NO
Preference migration silently opts unrelated notifications in: NO
```

```
Case can remain trial_completed with no valid supporting lifecycle evidence after deletion/cascade: NO
Deletion bypasses canonical lifecycle writer: NO
Deletion erases honest historical audit: NO
Deletion corrupts later offer/signing truth: NO
Repeated deletion duplicates lifecycle history: NO
Delete/restart produces different lifecycle meaning: NO
```

## 10. Global final audit

```
Open Critical defects: 0
Open High defects: 0
Open Medium defects reasonably fixable before P4B: 0

Known Critical left unresolved: NO
Known High left unresolved: NO
Known reasonably-fixable Medium left unresolved: NO

Trial direct lifecycle writer bypass remains: NO
Assessment privacy leak remains: NO
Minor safeguarding bypass remains: NO
Agency minor bypass remains: NO
Unverified club minor bypass remains: NO
Blocked-org sensitive Trial data leak remains: NO
Foreign-org Trial enumeration remains: NO
Unsafe malformed date path remains: NO
Known Trial domain error raw-500 path remains: NO
Notification required/optional taxonomy bug remains: NO
Deletion/cascade lifecycle corruption remains: NO
Box Cam CV refusal is treated as poor performance: NO
Box Cam capability overclaim introduced: NO
Combine Verified incorrectly enabled: NO
Private Trial/assessment content leaks to Passport: NO
P2 lifecycle widened unnecessarily: NO
Trial Workflow implemented: NO
Offer Workflow implemented: NO
Box Cam CV engine expanded: NO

Full server regression green: YES
M22 regression green: YES
P2.5 navigation regression green: YES
Affected browser/live regression green: YES
Affected typechecks green: YES
Affected builds green: YES
Fresh clone closure tests green: YES
Recovery bundle verifies: YES
Tree clean: YES
PR created: NO
Deployment performed: NO
```

## 11. Final defect inventory

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
Low open: 5
Informational: 0
Legal-review items: 2 (separate)
```

## 12. Success condition

```
M23 P4A FINAL HARDENING COMPLETE
D1 CLOSED
D10 CLOSED
D14 CLOSED
ZERO KNOWN CRITICAL DEFECTS
ZERO KNOWN HIGH DEFECTS
ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS
TRIAL + BOX CAM ARCHITECTURE FROZEN
READY FOR M23 P4B TRIAL WORKFLOW IMPLEMENTATION
```

---

Closure commit: `7683247` — "M23 P4A closure: close D1, D10, D14 (+D2, D4, D5, D12, D13, D15)".
This footer was written by the follow-up commit that records the hash; the bundle is created from that follow-up tip.
