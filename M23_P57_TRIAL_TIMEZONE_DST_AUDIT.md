# M23 P5.7 — Trial time zone and DST audit

## 1. The model, restated

A Trial has two kinds of time and they never mix:

- the **trial day** (`proposedDate`, `altSlots`, postponements) is a
  DATE_ONLY — a day the club, the family and the calendar export agree on,
  with no time and no zone. Its report deadline is derived once, in UTC.
- a **session** (`startsAt`, `endsAt`) is a UTC_INSTANT, stored as integer
  milliseconds. The schedule carries one **organiser zone** (an exact IANA
  name). Wall clocks are *derived* from the instants in that zone for
  display and for the RFC 5545 export (`DTSTART;TZID=`), never stored.

The club app types wall clocks in the organiser zone and converts them to
instants with that zone before sending (`wallToInstant`, two passes so a DST
edge lands on the right side); the browser's own zone plays no part. The
server refuses a bare local time outright (`TRIAL_SCHEDULE_INVALID`, "wrong
shape"), so a client that forgot the conversion cannot store a zone-dependent
value.

## 2. What P5.7 verified (group G, M; TZ runs)

| Case | Result |
| --- | --- |
| 8 March 2026, America/New_York, 02:30 (spring-forward gap) | `LOCAL_TIME_NONEXISTENT` — refused, not shifted |
| 01:59 vs 03:00 that night | 06:59Z vs 07:00Z — one minute apart in truth |
| 1 November 2026, America/New_York, 01:30 (fall-back overlap) | `LOCAL_TIME_AMBIGUOUS` with both candidates (05:30Z, 06:30Z); accepted only with `resolve: 'earlier' \| 'later'` and flagged `ambiguous: true` |
| 29 March / 25 October 2026, Europe/London | the same two refusals |
| an ordinary summer and winter morning in New York | 09:00 → 13:00Z / 14:00Z |
| a session 01:30→03:30 on the spring-forward night | validated as ONE elapsed hour; the ICS prints `013000` and `033000` |
| two elapsed hours from the first 01:30 on the fall-back night | prints 01:30→02:30 — the repeated hour is accounted for |
| the local day of 06:59Z / 04:59Z on 8 March in New York | 8 March / 7 March — the organiser's day, not the UTC day |
| zone names | exact case only; `europe/london`, `GMT`, `EST`, `+01:00` refused; ICU legacy aliases (Asia/Kolkata) accepted |
| the whole suite under `TZ=UTC` and `TZ=America/New_York` | identical counts (493 / 335) |
| the same computations in three child processes (UTC, New York, Tokyo) | byte-identical JSON |

## 3. Session bounds (§10)

| Rule | Value | Asserted |
| --- | --- | --- |
| start before end | `end > start` (equal refused) | M2 |
| minimum length | 15 minutes, inclusive | M3 |
| maximum length | 12 hours, inclusive | M4 |
| not entirely in the past (new session) | `end > now`; a carried session may have ended | M6 |
| sessions per revision | 1–20 | M7, M7b |
| overlap | refused | M9 |
| organiser zone | exact IANA | M8 |
| revisions | ≤ 30 (product bound) | m23TrialE2E |

## 4. Where a wall clock is still typed

Only in the clients' `datetime-local` inputs, and only with the organiser
zone beside them. The server's `parseLocalDateTimeWithZone` is the reference
resolver for any future server-side wall-clock input (none exists today); it
names gaps and overlaps instead of picking, so the product decision — which
of the two 01:30s a club meant — stays explicit.

## 5. Notification quiet hours

Quiet hours (`HH:MM`) and the minors' school-hours mute are wall-clock rules
for the *person*. They were evaluated with `getHours()` in the server's zone
(T-12). They are now evaluated in `notificationPrefs.timezone` when set
(validated IANA), else Europe/London, using the same `localParts` the Trial
export uses. The preference is optional; no migration.

## 6. The trial day and DST

A trial day has no time, so DST cannot move it or its deadline; the report
deadline is `Date.UTC(day) + 7 days` (P4A-D1). Asserted in `m23P4AClosureE2E`
A14 and re-asserted here (M12).
