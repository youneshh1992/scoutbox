# M23 P5.7 — Import and legacy data audit

What a row written before P5.7, or brought in by the M13 prospect import,
can carry in a temporal field, and how each shape reads now. The rule
(§23, §32): **nothing is migrated; everything is re-validated at read.**
Schema stays 2307 with 17 migrations.

## 1. Shapes a stored field can carry

| Shape | Example | Reads as |
| --- | --- | --- |
| absent | `null`, `undefined` | open bound (an optional end), or "unknown" (a dob, a deadline) |
| finite integer ms | `1790000000000` | an instant |
| finite fraction | `1790000000000.5` | an instant (same as the frozen `readBoundary`) |
| `NaN`, `±Infinity` | JSON turns NaN into `null` on the wire, but a live in-memory row or a fixture can hold it | **unreadable → closed** |
| ISO string where an instant is expected | `'2026-01-01T00:00:00.000Z'` (an imported row) | **unreadable → closed** (an instant field is a number) |
| numeric string | `'1790000000000'` | **unreadable → closed** |
| DATE_ONLY string where a day is expected | `'2026-09-23'` | a day |
| rolled-over day | `'2026-02-30'` | **unreadable → closed** (was 2 March) |
| free text | `'never'`, `'next week'`, `'whenever'` | **unreadable → closed** (was "no bound" or "upcoming for ever") |
| boolean / object / array | `true`, `{}`, `[]` | unreadable → closed |

## 2. Field by field

| Field | Legacy shape(s) seen or possible | Before P5.7 | Now |
| --- | --- | --- | --- |
| `player.dob` | `null` (M13 import), `'2010-02-30'` (created before F-12b), any text | F-8/F-12b closed most; a rolled-over dob still computed an age until F-12b | `parseDob` at every read; unreadable → age unknown → not adult; no migration (§50: the row keeps what it has; the person re-enters it) |
| `facet.recheckAt` | `null` on rows verified by the attributed-review path before recheck existed | VERIFIED for ever | absent → VERIFIED (frozen A8); present-but-unreadable → STALE (T-1) |
| `affiliation.startedAt/endedAt` | integers (server-written); an admin-edited row could be text | text end → inactive; `Infinity` → active | `readInstant` both ends (T-14) |
| `agreement.startAt/endAt` | integers; imported rows with ISO strings | closed since F-2/F-3 | unchanged |
| `verClaim.validUntil` | `null` (no expiry, common); integer; `Date.parse` output from a malformed `expiry` was `null`, so no legacy garbage is stored | a claim whose expiry failed to parse had NO expiry | such claims stay `null` (they cannot be told apart from "no expiry"); the person re-submits with a real day if the licence has one; new writes strict (T-3) |
| `trial.day.staff[].check.expiresAt` | ISO Z string (club app), `YYYY-MM-DD`, free text (accepted raw) | text → reviewed for ever | text → `expired`; the club or T&S re-files with a real day (T-2). Reads both stored shapes |
| `openTrial.date`, `matchday.date`, `friendly.date`, `attendance.date`, `medical.date` | `YYYY-MM-DD` from every client; free text possible via the API | text listed as upcoming / never past | new writes strict; a legacy text date is neither upcoming nor past (string compare against a real day is undefined; it was never a day). No migration: the row is the club's record |
| `opportunity/campaign.deadline`, `combineRequest.deadline` | `YYYY-MM-DD` (client `type=date`) | text → open for ever | strict at write; `endOfDayExclusive` unreadable → window closed |
| `brief.activeFrom/Until` | `YYYY-MM-DD` or `null` | text end → live for ever | `isDayWithin`: unreadable bound → not live |
| `policy.effectiveFrom/To` | seeded `'2024-01-01'`, `'2025-01-01'`, `'2026-06-01'`, `'2027-01-01'` — all real days | rollover possible via publish | strict at publish; unreadable never selected |
| `consent.grantedAt`, `handoff.invitedAt`, `document.expiresAt`, contact `deliveredAt` | server integers | `typeof` checks | `readInstant` (T-13, T-15, T-16, T-17) |
| `evidence.observedAt` | integer or `NaN` (from `new Date(text).getTime()`), serialised as `null` | `null` = not observed | `readInstant` at write; strict at the route |
| `passport history when` | `'2024'`, `'2024-03'`, `'2024-03-05'`, objects | month 13 clamped; 30 Feb rolled | precision kept; impossible → `null` (§50) |
| `journey history at` | integer ms or ISO string | ordering only | unchanged (not a decision) |
| `timeline[].year` | `'2024'` | historical | unchanged |
| `notificationPrefs.quietStart/End` | `'22:00'`, `null` | evaluated in the server zone | evaluated in `timezone` (new, optional) else Europe/London |

## 3. The M13 prospect import

`dob` is optional. When present it must be `YYYY-MM-DD`, a day that exists,
not in the future, not older than 120 years (`parseDobStrict`) and not
before 1940 (the import's own floor). A rolled-over day is now an import
row error rather than a stored date. A prospect without a dob projects
`dob: null` and every platform gate reads that as "age unknown", never
adult (F-8). The `minor` flag on the import report is a year-subtraction
UI-care hint and is documented as not a gate.

## 4. Migration decision (§33)

**None.** Every field above is re-validated at read and the closed reading
of an unreadable value is the intended product behaviour: a check nobody can
date is re-reviewed, a licence with no expiry stays a licence with no expiry,
a brief with garbage in its window is not live. A migration that rewrote or
deleted such values would turn a visible, explainable refusal into a silent
change to someone's record. The P4A read-side defence for legacy trial dates
(`trial-legacy-*` fixtures in `m23P4AClosureE2E`) is the precedent and still
passes.

## 5. Replay and boot

Cold boot on an empty store → `X-ScoutBox-Schema: 2307`; a record written
before a restart is present after it; a second boot onto the migrated store
applies nothing; `m23BootContract` (61 checks) and the seven persistence
suites are green (test report §2, §7).
