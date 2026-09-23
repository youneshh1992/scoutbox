# M23 P5.7 — Date parser contract

The behaviour of every parser in `scoutbox-server/temporal.mjs`, as a table
of inputs and answers. Every row is asserted by `m23TemporalIntegrityE2E`
(group letter in the last column). A domain module that keeps its own error
code (Trial, Contact, Development Hub) wraps one of these parsers; it never
parses on its own.

## `parseStrictDateOnly(input, { yearMin = 1900, yearMax = 2100 })`

Returns `{ ok: true, value, t }` (the canonical string and UTC midnight) or
`{ ok: false, error: 'DATE_INVALID', why, expected: 'YYYY-MM-DD' }`.

| Input | Answer | Why | Group |
| --- | --- | --- | --- |
| `'2000-02-29'`, `'2020-02-29'`, `'2024-02-29'` | ok | real leap days | B2 |
| `'1900-01-01'`, `'2100-12-31'` | ok | bounds inclusive | B2 |
| `'2010-02-30'`, `'2011-04-31'` | refused | no such day in that month | B1 |
| `'2019-02-29'` | refused | 2019 is not a leap year | B1 |
| `'1900-02-29'` | refused | 1900 is not a leap year (century rule) | B4 |
| `'2023-13-01'`, `'2023-00-10'` | refused | no such month | B1 |
| `'2023-01-00'`, `'2023-01-32'` | refused | no such day | B1 |
| `'02/03/2010'`, `'2023-1-5'`, `'20230105'`, `' 2023-01-05'` | refused | wrong shape | B1 |
| `'2023-01-05T00:00:00Z'` | refused | wrong shape (an instant is not a day) | B1 |
| `'1899-12-31'`, `'2101-01-01'` | refused | year outside bounds | B1 |
| `''`, `null`, `undefined` | refused | callers decide absence before parsing | B1 |
| `20230105`, `NaN`, `{}`, `[]`, `true` | refused | not text | B1 |

Property (B4): for the years 1900, 2000, 2023 and 2024 and every month 0–13
and day 0–32, the parser agrees with an independent days-in-month table on
all 1848 triples.

## `parseInstant(v, { yearMin = 1900, yearMax = 2100 })`

Returns `{ ok: true, ms }` or `{ ok: false, error: 'TIMESTAMP_INVALID', why }`.

| Input | Answer | Why | Group |
| --- | --- | --- | --- |
| `'2026-03-01T10:00Z'` | ok, `Date.UTC(2026,2,1,10)` | Z | D2 |
| `'2026-03-01T10:00:00+05:30'` | ok, 04:30Z | explicit offset | D2b |
| `'2026-03-01T10:00:00.250-04:00'` | ok, 14:00:00.250Z | milliseconds and a negative offset | D2c |
| integer ms (`0`, `-1`, `T0`) | ok, passed through | an integer is an instant | D3 |
| `'2026-03-01T10:00'` | refused | wrong shape — a bare local time depends on the server's zone | D1 |
| `'2026-03-01 10:00'`, `'March 1 2026'`, `'02/03/2026 10:00'` | refused | wrong shape | D1 |
| `'2026-03-01'` | refused | wrong shape — a DATE_ONLY is not an instant | D1 |
| `'1700000000000'` | refused | wrong shape — a numeric string is text | D1 |
| `'2026-02-30T10:00Z'` | refused | no such calendar day | D1 |
| `'2026-03-01T24:00Z'`, `'…T10:60Z'`, `'…T10:00:60Z'` | refused | no such time of day | D1 |
| `'2026-03-01T10:00+15:00'`, `'…+05:60'` | refused | no such offset | D1 |
| `'1899-12-31T23:59Z'`, `'2101-01-01T00:00Z'` | refused | year outside bounds | D1 |
| `1.5`, `NaN`, `±Infinity` | refused | not a whole number | D1 |
| `''`, `null`, `undefined`, `{}`, `[]`, `true` | refused | not a date-time | D1 |

## `parseDateOrInstant(v, { dayEdge = 'start' | 'end' })`

For a field a form may fill from `<input type="date">` or from an instant.
Returns `{ ok: true, ms, precision: 'day' | 'instant', value }` or
`{ ok: false, error: 'DATE_INVALID', why }`.

| Input | Answer | Group |
| --- | --- | --- |
| `'2026-03-01'` (start) | `ms = Date.UTC(2026,2,1)`, precision day | E1 |
| `'2026-03-01'` (end) | `ms = Date.UTC(2026,2,2)` — the first instant after the day | E2 |
| `'2026-03-01T10:00Z'`, integer ms | precision instant | E3 |
| `'2026-02-30'`, `'2026-03-01T10:00'`, `'soon'`, `'1700000000000'`, `1.5`, `null` | refused, `DATE_INVALID` | E4 |

Storage rule (principle I): a day is stored as its string; an instant as its
integer. The staff-check expiry keeps the day string or the canonical ISO
form so the club app's `string` type is preserved.

## `parseDobStrict(dob, nowMs)`

`parseStrictDateOnly` plus §24: refuses `DOB_INVALID` when the day is after
`now` ("in the future") or more than 120 years before it ("implausibly old").
Born today is accepted; a 119-year-old is accepted (C7–C7d). `parseDob` (the
domain name, no `now`) is the same syntactic and calendar rule and is what
stored rows are read through, so an existing row is never re-refused at read.

## `validateIanaZone(tz)`

| Input | Answer | Group |
| --- | --- | --- |
| `'Europe/London'`, `'America/New_York'`, `'Asia/Kolkata'`, `'UTC'`, `'America/Argentina/Buenos_Aires'` | ok, exact name returned | F1 |
| `'europe/london'`, `'EUROPE/LONDON'` | refused | F2 |
| `'London'`, `'GMT+1'`, `'+01:00'`, `'EST'`, `'Mars/Olympus'` | refused | F2 |
| `''`, `null`, `5`, `{}`, `'Europe/London '`, 65 characters | refused | F2 |

Modern names that older ICU builds report under a legacy alias
(`Asia/Kolkata` → `Asia/Calcutta`) are accepted by an explicit table.

## `parseLocalDateTimeWithZone(local, zone, { resolve })`

| Input | Answer | Group |
| --- | --- | --- |
| `'2026-06-01T09:00'`, New York | ok, 13:00Z, `ambiguous: false` | G3 |
| `'2026-01-15T09:00'`, New York | ok, 14:00Z | G3b |
| `'2026-03-08T02:30'`, New York | `LOCAL_TIME_NONEXISTENT` (clocks went 01:59 → 03:00) | G1 |
| `'2026-03-08T01:59'` / `'03:00'`, New York | 06:59Z / 07:00Z — one minute apart in truth | G1b |
| `'2026-11-01T01:30'`, New York | `LOCAL_TIME_AMBIGUOUS`, `candidates: [05:30Z, 06:30Z]` | G2 |
| same, `resolve: 'earlier'` | ok, 05:30Z, offset −240, `ambiguous: true` | G2b |
| same, `resolve: 'later'` | ok, 06:30Z, offset −300, `ambiguous: true` | G2c |
| `'2026-03-29T01:30'`, London | `LOCAL_TIME_NONEXISTENT` | G4 |
| `'2026-10-25T01:30'`, London | `LOCAL_TIME_AMBIGUOUS` | G4b |
| any local, `'europe/london'` | `TIMEZONE_INVALID` before any arithmetic | G5 |
| `'2026-02-30T09:00'`, `'2026-06-01T25:00'` | `TIMESTAMP_INVALID` | G5b |

## Readers and predicates

| Function | Rule | Group |
| --- | --- | --- |
| `readInstant(v)` | a finite number, else `null` (NaN, ±Infinity, strings, booleans, objects are `null`) | D4, D4b |
| `readDateOnly(v)` | a parseable DATE_ONLY string, else `null` | B5 |
| `endOfDayExclusive(day)` | `t + DAY_MS`, else `null` | B6 |
| `isExpiredAt(until, now)` | `null`/`undefined` → false; unreadable → **true**; else `now >= until` | H1–H3 |
| `isEffectiveAt(from, to, now)` | start must be readable and ≤ now; end absent → open; end unreadable → **false**; else `now < to` | H4–H7 |
| `isActiveAt({startsAt, endsAt}, now)` | `isEffectiveAt` over a record | H8 |
| `isOrderedInterval(s, e, {allowEqual})` | both readable and `s < e` (or `≤`) | H9–H10 |
| `isDayWithin(day, from, to)` | inclusive DATE_ONLY window; an unreadable bound or day → **false** | H11–H13 |
| `ageOnMs(dob, now)` | completed UTC years; NaN when unreadable | C3–C6 |
| `ageOrNull(dob, now)` | finite age or `null` — for JSON | C1 |

## Domain wrappers (unchanged codes, shared parsing)

| Wrapper | Parser | Code | Extra |
| --- | --- | --- | --- |
| `domain.parseDob` | `parseStrictDateOnly` | returns string/null | — |
| `domain.parseTrialDate` | `parseStrictDateOnly` (2000–2100) | `TRIAL_DATE_INVALID` | `''`/`null` = no date |
| `trial.parseInstant` | `parseInstant` (2000–2100) | `TRIAL_SCHEDULE_INVALID` | — |
| `trial.validateTimezone` | `validateIanaZone` | `TRIAL_TIMEZONE_INVALID` | — |
| `contact.validateExternalRecord` | `parseInstant` | `CONTACT_OCCURRED_AT_INVALID` | skew + 180-day window |
| `m21.parseDate` | `parseDateOrInstant` (start) | `DATE_INVALID` / `DATE_INTERVAL_INVALID` | `''`/`null` = absent |
| `m20.resolveWindow` | `parseStrictDateOnly` | `WINDOW_INVALID` | `from ≤ to ≤ today` |
| `m18.validateRecruitmentBrief` | `parseStrictDateOnly` | `BRIEF_INVALID` + `{field, error:'DATE_INVALID'}` | `from ≤ to` |
| `m25.validatePolicyBody` | `parseStrictDateOnly` | `POLICY_INPUT_INVALID` | `from < to` |
| `m26` document `expiresAt` | `parseDateOrInstant` (end) | `DOCUMENT_INPUT_INVALID` | must be future |
| `m14` licence / affiliation periods | `parseDateOrInstant` | `DATE_INVALID` / `INTERVAL_INVALID` | issue < expiry |
| `m12` staff check, evidence, deadlines; `server.mjs` grassroots dates | `parseDateOrInstant` / `parseStrictDateOnly` | `DATE_INVALID` | evidence not future |
| `server.mjs` preferences | `HH:MM` regex, `validateIanaZone` | `TIME_INVALID` / `TIMEZONE_INVALID` | — |
