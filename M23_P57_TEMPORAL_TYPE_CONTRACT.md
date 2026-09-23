# M23 P5.7 — Temporal type contract

Frozen by P5.7. Every date or time a ScoutBox decision reads is exactly one of
the five types below, and the type decides the parser, the storage form, the
comparison rule and the rendering rule. A value that is not one of these
types is not a date: it is refused at input and treated as unreadable at
read. The implementation is `scoutbox-server/temporal.mjs`.

## The principles (A–K)

| | Principle | Where it bites |
| --- | --- | --- |
| **A** | One value, one type. A field is DATE_ONLY *or* UTC_INSTANT; a field that accepts both (`parseDateOrInstant`) says which it received and stores it as that. | licence expiry, staff-check expiry, due dates |
| **B** | Strict and round-tripped. Shape, then calendar (30 February is refused, 29 February 2000 is not), then time of day, then offset. Nothing is repaired. | every parser |
| **C** | Unreadable is a refusal, never "no bound". `null`/`undefined` may mean absent where a field is optional; `NaN`, `''`, a string, `true`, `0` never do. | `isExpiredAt`, `isEffectiveAt`, facets, affiliations, consents, handoffs |
| **D** | Starts are inclusive, ends are exclusive. An expiry instant is the first instant at which the thing no longer applies. A DATE_ONLY end covers its whole day: its instant is the start of the next UTC day. | `validUntil`, `recheckAt`, `endAt`, deadlines, brief windows |
| **E** | Intervals are ordered: `start < end` or the interval is refused. | sessions, licence periods, plan dates, policy windows |
| **F** | Every predicate takes `now`. No pure module reads a clock. | all of `temporal.mjs`, m24, m25, m23, m14, m20, m18, m27 |
| **G** | UTC throughout. No local getter (`getHours`, `getMonth`, `getFullYear`, `toLocaleDateString`) on a stored value. | age, birth quarter, period years, notifications |
| **H** | A zone is an exact IANA name this runtime knows. No folding, no alias guessing, no fallback to the server's zone. | Trial schedules, notification preferences |
| **I** | Storage is normalised: DATE_ONLY as its `YYYY-MM-DD` string, instants as integer milliseconds. Values are re-validated at read, never trusted. | every write site in the inventory |
| **J** | Historical data is not over-hardened. A year or a year-month stays at its precision and gates nothing. | Football Passport history, timeline years |
| **K** | Authorization first. A date is validated only after the caller's right to act is established, so a date error never reveals whether a record exists. | every hardened route (suite group S) |

## The five types

### DATE_ONLY

A calendar day with no time and no zone. Written and stored as
`YYYY-MM-DD`. Parsed by `parseStrictDateOnly` (year 1900–2100 unless a domain
narrows it; the Trial keeps 2000–2100). Its instant, when one is needed, is
UTC midnight of that day (`t`); as an END it is the start of the next UTC day
(`endOfDayExclusive`). Compared as strings when both sides are DATE_ONLY
(`isDayWithin`), which is exact because the shape is fixed. Rendered in every
client with `timeZone: 'UTC'`, so 30 June is 30 June in New York too.

Fields: date of birth, trial day and slots, open day, match day, friendly,
attendance, medical record, opportunity/campaign/Combine deadline, brief
window, analytics window, policy `effectiveFrom/To`, and the day form of the
licence, staff-check, plan and due-date fields.

### UTC_INSTANT

A point in time. Input is ISO 8601 with an explicit offset or `Z`
(`2026-03-01T10:00:00+05:30`, `…Z`) or an integer millisecond timestamp.
Stored as an integer. Read back through `readInstant`, which accepts a finite
number and nothing else. A bare local time (`2026-03-01T10:00`), a date-only
string, a numeric string and a fraction are refused as input; `Infinity`,
`NaN`, strings and booleans are unreadable at read.

Fields: every `…At` the server stamps; contact `occurredAt`; trial session
`startsAt/endsAt`; facet `recheckAt`; agreement `startAt/endAt`; affiliation
`startedAt/endedAt`; consent `grantedAt`; handoff `invitedAt`; document
`expiresAt`; licence `validFrom/validUntil`; evidence `observedAt`.

### LOCAL_DATETIME + IANA_ZONE

A wall-clock time that means nothing until a zone resolves it. Never stored.
`parseLocalDateTimeWithZone(local, zone)` returns the one instant it names,
refuses a time that does not occur (DST gap, `LOCAL_TIME_NONEXISTENT`) and a
time that occurs twice (DST overlap, `LOCAL_TIME_AMBIGUOUS`) unless the
caller states `resolve: 'earlier' | 'later'`. The Trial client converts the
organiser's wall clock to an instant before sending; the server stores
instants and derives wall clocks (`localParts`, `icsLocal`, `localDay`) for
display and the calendar export.

Also: notification quiet hours (`HH:MM` in the person's zone, else
Europe/London).

### HISTORICAL_PARTIAL_DATE

A year (`2024`) or a year-month (`2024-03`) from football history. Kept as
`{ t, precision, y, m?, d? }` by `normWhen`; a full day inside it is a
DATE_ONLY and is round-tripped; an impossible month or day becomes `null`,
never a clamped or invented date. Display only. Never a gate.

### DURATION

A length of time as integer milliseconds (`DAY_MS`, `RECHECK_MS`,
`HANDOFF_TTL_MS`, `cooldownMs`, session `min/maxSessionMs`). Added to an
instant, never to a wall clock. A session that spans a DST change keeps its
elapsed duration (one hour is one hour) and its wall clocks are derived.

## Error taxonomy

| Code | Raised by | Meaning |
| --- | --- | --- |
| `DATE_INVALID` | `parseStrictDateOnly`, `parseDateOrInstant` | not a calendar day (or, for a day-or-instant field, neither) |
| `DOB_INVALID` | `parseDobStrict`, sign-up, guardian children | not a real day, in the future, or older than 120 years |
| `TIMESTAMP_INVALID` | `parseInstant`, `parseLocalDateTimeWithZone` | not an instant / not a wall-clock time |
| `TIMEZONE_INVALID` | `validateIanaZone` | not an exact, known IANA zone |
| `INTERVAL_INVALID` | licence period, affiliation period | end not after start |
| `LOCAL_TIME_NONEXISTENT` / `LOCAL_TIME_AMBIGUOUS` | `parseLocalDateTimeWithZone` | DST gap / overlap |
| `TIME_INVALID` | notification preferences | `HH:MM` malformed |

Frozen domain codes are kept at their edges and are produced by the same
parsers: `TRIAL_DATE_INVALID`, `TRIAL_SCHEDULE_INVALID`,
`TRIAL_TIMEZONE_INVALID`, `CONTACT_OCCURRED_AT_INVALID`, m21 `DATE_INVALID` /
`DATE_INTERVAL_INVALID`, m20 `WINDOW_INVALID`, m18 `BRIEF_INVALID` (with
`DATE_INVALID` in its details), m25 `POLICY_INPUT_INVALID`, m26
`DOCUMENT_INPUT_INVALID`.

## Boundary semantics, stated once

| Question | Answer |
| --- | --- |
| Is a thing valid at exactly its `validUntil` / `recheckAt` / `endAt`? | No. Ends are exclusive. |
| Is it in force at exactly its `effectiveFrom` / `startAt`? | Yes. Starts are inclusive. |
| A licence "valid until 2028-06-30"? | Valid through the whole of 30 June UTC; expired from 2028-07-01T00:00Z. |
| A brief "active until 2026-09-30"? | Live on the 30th everywhere; not live from the first UTC instant of 1 October. |
| A trial "on 2026-06-01"? | The day; the report is due 7 days after UTC midnight of that day. |
| A 72-hour cooldown from `deliveredAt`? | Clear at exactly `deliveredAt + 72h`. |
| Turning 18? | At 00:00 UTC on the birthday; a 29 February birthday counts on 1 March in a non-leap year. |
| KR? | 19. GB and the default: 18. |
