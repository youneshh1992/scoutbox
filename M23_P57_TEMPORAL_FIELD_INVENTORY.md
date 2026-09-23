# M23 P5.7 — Temporal field inventory

Every date or time field that a security, lifecycle, compliance or product
decision depends on, found by reading every `new Date(`, `Date.parse(`,
`Date.UTC(`, `toISOString(`, local-getter and string-comparison site in the
server (74 `new Date(` sites in 25 files, 15 `Date.parse(` sites in 7 files,
510 `Date.now()` sites in 72 files; no date library is used anywhere) and the
date inputs of the five client apps.

**Status vocabulary**

| Status | Meaning |
| --- | --- |
| **SAFE** | strict parse or finite-number read, fail-closed comparison, injected clock |
| **HARDENED** | was NEEDS HARDENING; fixed in P5.7 (defect id in the register) |
| **NOT SECURITY RELEVANT** | display, ordering or a server-derived stamp; no decision depends on it |
| **HISTORICAL ONLY** | football history; partial precision is legitimate (§50) and it gates nothing |

**Type vocabulary** (M23_P57_TEMPORAL_TYPE_CONTRACT.md): DATE_ONLY ·
UTC_INSTANT · LOCAL_DATETIME+IANA_ZONE · HISTORICAL_PARTIAL_DATE · DURATION.

**Boundary vocabulary**: a start is inclusive; an end/expiry is exclusive; a
DATE_ONLY end covers the whole day (its instant is the start of the next UTC
day).

---

## 1. Identity and age

| Field | File | Type | Input | Storage | Parser | TZ | Significance | Validation | Fail | Ordering | Migration risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `player.dob` | `server.mjs` sign-up 1041, guardian children 1281; `domain.mjs` | DATE_ONLY | `YYYY-MM-DD` | string as given | `parseDobStrict` → `parseStrictDateOnly` | none (UTC day) | every age gate on the platform | shape, real day, 1900–2100, not future, ≤120y | **closed** (`DOB_INVALID`) | — | none; existing rows re-read through `parseDob` | **HARDENED** (T-8/§24; F-8, F-12, F-12b regression) |
| `ageOn(dob, now)` | `domain.mjs` → `temporal.ageOnMs` | derived | — | — | one rule | UTC only | adult/minor, GB 18 / KR 19 | NaN when unreadable | closed (NaN < N is false) | — | none | **SAFE** |
| m12 eligibility age | `m12/shared.mjs:96` | derived | — | — | was `365.25`-day division over `new Date(dob)` | was local | opportunity/campaign eligibility | now `ageOrNull` | closed (null fails both bounds) | — | none | **HARDENED** (T-8) |
| m16 Combine age | `m16/combine.mjs:45` | derived | — | — | was a second division rule | was local | Combine request view | now `ageOrNull` | closed | — | none | **HARDENED** (T-8) |
| m15 Passport age | `m15/passport.mjs:189` | derived | — | — | was local getters (`getFullYear`, local `Date`) | **was local** | passport projection | now `ageOrNull` | closed | — | none | **HARDENED** (T-8, zone-dependent) |
| m13 import `dob` | `m13/imports.mjs:71` | DATE_ONLY | CSV cell | string | was shape-only regex | none | prospect age flag; platform gates use linked DOB | now `parseDobStrict` + 1940 floor | closed (row error) | — | none | **HARDENED** |
| m13 import `minor` flag | `m13/imports.mjs:152` | derived (year only) | — | — | year subtraction | local year | UI-care flag only; explicitly not a gate | — | conservative | — | none | NOT SECURITY RELEVANT |
| m13 birth-quarter lens | `m13/insight.mjs:92` | derived | — | — | was `new Date(dob).getMonth()` | **was local** (1 April → Q1 in New York) | aggregate relative-age lens | now `parseStrictDateOnly` + `getUTCMonth` | unreadable dob not counted | — | none | **HARDENED** (T-9) |
| `earliestPermittedApproachAt(dob)` | `m25/policy.mjs:284` | derived | — | — | was raw `new Date(dob)` (null → epoch; 30 Feb → 2 Mar) | UTC | minor approach timing formula | now `parseDob` | closed (`MINOR_TIMING_NOT_ENCODED`) | — | none | **HARDENED** (T-5) |
| `isRegulatoryMinor` | `m25/policy.mjs:261` | derived | — | — | `parseDob` | UTC | minors gate | tri-state (null = unknown) | closed (`SUBJECT_DOB_UNKNOWN`) | — | none | SAFE (F-8) |

## 2. Verification, licences, affiliations (M14)

| Field | File | Type | Input | Storage | Parser | TZ | Significance | Validation | Fail | Ordering | Migration risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `verClaim.validUntil` (licence self-declared `expiry`) | `m14/review.mjs:96` | DATE_ONLY→UTC_INSTANT (end of day) | `expiry` | integer ms | was `Date.parse(x) \|\| null` (malformed → **no expiry**) | none | licence effective status | `parseDateOrInstant(dayEdge:'end')` → `DATE_INVALID` | **closed** | `issueDate < expiry` else `INTERVAL_INVALID` | none; legacy null stays null | **HARDENED** (T-3) |
| `verClaim.validFrom` (licence `issueDate`) | `m14/review.mjs:96` | DATE_ONLY→UTC_INSTANT | `issueDate` | integer ms | was stored raw in metadata only | none | period display | strict | closed | see above | none | **HARDENED** |
| registry `validUntil` | `m14/review.mjs:157` | DATE_ONLY | provider record | integer ms | was `Date.parse(x) \|\| claim.validUntil` (kept the self-declared value) | none | **verifies a licence** | strict; unreadable → `requires_human_review` + `REGISTRY_RECORD_UNREADABLE` | closed | — | none | **HARDENED** (T-3) |
| admin dispute `validUntil` correction | `m14/review.mjs:532,536` | DATE_ONLY or instant | body | integer ms | was `Number(x) \|\| null` (typo → no expiry) | none | claim expiry | strict → `DATE_INVALID` | closed | — | none | **HARDENED** (T-3) |
| org confirm `validFrom`/`validUntil` | `m14/organisations.mjs:421` | DATE_ONLY or instant | body | integer ms | was `Number(x) \|\| null` | none | staff affiliation period | strict → `DATE_INVALID`; `INTERVAL_INVALID` when both stated and inverted | closed | yes | none | **HARDENED** (T-3) |
| org `departed` `validUntil` | `m14/organisations.mjs:471` | same | body | integer ms | was `Number(x) \|\| now` | none | closes a period | strict | closed | — | none | **HARDENED** |
| `effectiveStatus` expiry test | `m14/shared.mjs:120` | comparator | — | — | was `validUntil && validUntil < now` | — | **displays a claim as verified** | `isExpiredAt` (null = no expiry; unreadable = expired; exclusive at the instant) | closed | — | none | **HARDENED** (T-3) |
| period display year | `m14/shared.mjs:414` | display | — | — | was `getFullYear()` (local) | **was local** | badge text | `getUTCFullYear` | — | — | none | NOT SECURITY RELEVANT (fixed for zone-independence) |
| expiry processor (30-day warning, verified→expired sweep) | `m14/review.mjs:620` | comparator | — | — | finite compare on a stored number | — | notifications | reads only finite values written by the routes above | closed | — | none | SAFE |

## 3. Agent, compliance, transactions, integration (M24–M27)

| Field | File | Type | Input | Storage | Parser | TZ | Significance | Validation | Fail | Ordering | Migration risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `facet.recheckAt` | `m24/shared.mjs:66` | UTC_INSTANT | server-written | integer ms | was `typeof === 'number' && <= now` (NaN / string → VERIFIED for ever) | — | **regulated-action gate** | present-but-unreadable → STALE; absent keeps frozen P5.6B reading (no decay) | closed | — | none | **HARDENED** (T-1) |
| `facet.verifiedAt`, `submittedAt` | m24 | UTC_INSTANT | server | integer ms | — | — | display/freshness | — | — | — | none | NOT SECURITY RELEVANT |
| `affiliation.startedAt/endedAt` | `m24/shared.mjs:133` | UTC_INSTANT | server/admin | integer ms | was `typeof === 'number'` (±Infinity active) | — | **agency membership** | `readInstant`; absent end = open; unreadable either end = inactive | closed | — | none | **HARDENED** (T-14) |
| `agreement.startAt/endAt` | `m24/shared.mjs:273–330` | UTC_INSTANT | server | integer ms | `readBoundary` (F-2/F-3) | — | **private client access** | absent = open; unreadable = closed | closed | `termEndAt` | none | SAFE (P5.6F) |
| `agreement.confirmedAt` | m24 | UTC_INSTANT | server | integer ms | `== null` check | — | root of authority | — | closed | — | none | SAFE |
| `policy.effectiveFrom/effectiveTo` | `m25/policy.mjs:35`, `m25/index.mjs:200` | DATE_ONLY (or integer) | reviewer body / seed | string | was regex + `Date.parse` (30 Feb → 2 Mar) | UTC midnight | **which policy version applies** | `parseStrictDateOnly`; publish refuses unreadable and `to ≤ from` | closed (NaN never selects) | yes | none (seed dates are real days) | **HARDENED** (T-4) |
| `rule.effectiveFrom` (PENDING_IMPLEMENTATION) | `m25/policy.mjs:81` | DATE_ONLY | reviewer body | string | same | UTC | rule activation | same | closed (stays pending) | — | none | **HARDENED** (T-4) |
| `consent.grantedAt` (dual representation) | `m25/conflict.mjs:70` | UTC_INSTANT | server | integer ms | was `typeof === 'number'` (NaN passed, then passed the in-advance test) | — | **conflict-of-interest sufficiency** | `readInstant` | closed (`CONSENT_MISSING`) | `grantedAt ≤ firstActAt` | none | **HARDENED** (T-15) |
| guardian `guardian_approach.grantedAt` | `m25/policy.mjs:378` | UTC_INSTANT | server | integer ms | `typeof` + `<= now` (NaN already closed) | — | minors gate | `readInstant` | closed | — | none | SAFE (tightened) |
| `consent.revokedAt` | m25 | UTC_INSTANT | server | integer ms | `!= null` | — | revocation precedence | — | closed (any present value revokes) | — | none | SAFE |
| `transactionDocument.expiresAt` | `m26/index.mjs:1015,388,1053` | UTC_INSTANT / DATE_ONLY | body | integer ms | was `Number(x)` (numeric strings coerced); read was `typeof === 'number'` (NaN → current) | — | document availability | `parseDateOrInstant(dayEdge:'end')`, must be future; read via `isExpiredAt` | closed | — | none | **HARDENED** (T-16) |
| transaction `createdAt/updatedAt/…At` | m26 | UTC_INSTANT | server clock only | integer ms | — | — | audit/timeline | never client-supplied (grep: no `body.*At` in m24–m27 except document expiry) | — | — | none | SAFE (§13/§19) |
| `handoff.invitedAt` (30-day TTL) | `m27/integration.mjs:368` | UTC_INSTANT | server | integer ms | was `typeof === 'number'` (unreadable → standing for ever) | — | handoff lifecycle | `readInstant`; unreadable → expired | closed | — | none | **HARDENED** (T-17) |
| compliance snapshot `freshness` | `m25/index.mjs:357` | derived | — | — | `effectiveFacetState` + finite `daysUntilRecheck` | — | oversight view | inherits T-1 | closed | — | none | SAFE |

## 4. Recruitment: Contact, Trial, Decision, Rooms (M17, M23)

| Field | File | Type | Input | Storage | Parser | TZ | Significance | Validation | Fail | Ordering | Migration risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| external contact `occurredAt` | `m23/contact.mjs:293` | UTC_INSTANT | ISO with offset/Z or integer ms | integer ms | was `Date.parse` (bare local time read in the **server zone**; `02/03/2026` read as US; 30 Feb rolled) | — | attested recruitment evidence | `parseInstant`; not future (+skew), not older than 180 days | closed (`CONTACT_OCCURRED_AT_INVALID`) | — | none | **HARDENED** (T-6) |
| contact `deliveredAt` (72 h cooldown) | `m23/contact.mjs:318` | UTC_INSTANT | server | integer ms | was `typeof === 'number'` (`+Infinity` cooled for ever) | — | anti-spam | `readInstant`; exclusive at 72 h | fails OPEN by design (a limit protects the player; an undated delivery starts none) | — | none | **HARDENED** (T-13) |
| contact history `at` ordering | `m23/contact.mjs:339` | UTC_INSTANT | server | integer ms | numeric | — | ordering only | — | — | id tie-break | none | NOT SECURITY RELEVANT |
| journey `at` sort | `m23/journey.mjs:64` | mixed legacy | server | ms or ISO | `Date.parse \|\| Number \|\| 0` | — | ordering only | — | — | key tie-break | none | NOT SECURITY RELEVANT (documented; not a decision) |
| trial `proposedDate`, `altSlots`, postponement | `domain.mjs parseTrialDate` | DATE_ONLY | `YYYY-MM-DD` | string | `parseStrictDateOnly` (2000–2100) | UTC day | booking, report deadline | strict | closed (`TRIAL_DATE_INVALID`) | slots ≠ day | none (P4A read-side defence) | SAFE (delegated) |
| `trial.reportDueAt` | `domain.mjs trialReportDueAt` | UTC_INSTANT | derived | integer ms or null | one derivation | UTC | report obligation | finite or null | closed (null = unknown, never overdue) | — | none | SAFE |
| session `startsAt/endsAt` | `m23/trial.mjs parseInstant` | UTC_INSTANT | ISO with offset/Z or integer ms | integer ms | platform `parseInstant` (2000–2100) | organiser zone for display only | scheduling | 15 min–12 h, `end > start`, not entirely past, ≤20 sessions, no overlap | closed (`TRIAL_SCHEDULE_INVALID`) | yes | none | SAFE (delegated) |
| `schedule.timezone` | `m23/trial.mjs validateTimezone` → `validateIanaZone` | IANA_ZONE | exact name | string | one implementation | — | wall-clock rendering, ICS `TZID` | exact, known, no folding | closed (`TRIAL_TIMEZONE_INVALID`) | — | none | SAFE (delegated) |
| DST rendering (`localParts`, `icsLocal`, `localDay`) | `temporal.mjs` | render | — | — | Intl, h23 | organiser zone | calendar export | instants stored; wall clocks derived | — | — | none | SAFE (G6/G7 proven) |
| ICS `DTSTAMP` | `server.mjs:2283` | UTC_INSTANT | server | — | was `new Date(undefined)` → throw → 500 | UTC | export | first readable of confirmedAt/proposedAt/acceptedAt, else now | closed (no 500) | — | none | **HARDENED** (T-11) |
| report-due notification text | `server.mjs:2209` | display | — | — | was `toLocaleDateString()` (server locale/zone) | **was local** | notification | `utcDayOf` | — | — | none | NOT SECURITY RELEVANT (fixed) |
| `trial.day.staff[].check.expiresAt` | `m12/journeys.mjs:541,577,779` | DATE_ONLY or UTC_INSTANT | club/T&S body | `YYYY-MM-DD` or ISO Z string | was raw; read was `new Date(x) < now` (text → **reviewed for ever**) | — | **safeguarding check on a trial day** | `parseDateOrInstant(dayEdge:'end')` → `DATE_INVALID`; read: unreadable → `expired` | closed | — | none; legacy text rows now read expired (intended) | **HARDENED** (T-2) |
| room task / assignment `dueAt` | `m17/rooms.mjs:1027,1194` | DATE_ONLY or instant | body | day string or integer ms | was stored raw | — | workflow (overdue counts) | strict → `DATE_INVALID` | closed | — | none | **HARDENED** (Low) |
| decision `finalizedAt` etc. | m23 decision | UTC_INSTANT | server | integer ms | — | — | lifecycle | never client-supplied | — | — | none | SAFE |

## 5. Grassroots and player records (server.mjs)

| Field | File | Type | Input | Storage | Parser | TZ | Significance | Validation | Fail | Ordering | Migration risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openTrial.date` | `server.mjs:2505` | DATE_ONLY | body | string | was `String(date)`; compared as text against today (`'next week' >= today` → upcoming for ever; never a past day owing answers) | UTC day | **no-ghosting rule** (`OUTCOMES_OUTSTANDING`) and upcoming list | `parseStrictDateOnly` → `DATE_INVALID` | closed | — | none | **HARDENED** (T-10) |
| `matchday.date`, `attendance.date` (coach-logged) | `server.mjs:2679` | DATE_ONLY | body | string | was raw | — | verified attendance on the profile | strict | closed | — | none | **HARDENED** (T-10) |
| `friendly.date` | `server.mjs:2767` | DATE_ONLY | body | string | was raw | — | board listing | strict | closed | — | none | **HARDENED** (T-10) |
| player `attendance.date` (GPS-verified) | `server.mjs:3263` | DATE_ONLY | body | string | was raw | — | trust score input | strict | closed | — | none | **HARDENED** (T-10) |
| `medical.records[].date` | `server.mjs:3226` | DATE_ONLY | body (optional) | string | was raw | — | medical record | strict when given; today when absent | closed | — | none | **HARDENED** (T-10) |
| `timeline[].year` | `server.mjs:2447,3279` | HISTORICAL_PARTIAL_DATE | year | string | — | local year at write (server) | pathway story | — | — | — | none | HISTORICAL ONLY |
| `notificationPrefs.quietStart/quietEnd/timezone` | `server.mjs:641,3694` | LOCAL wall-clock + IANA_ZONE | `HH:MM`, zone | strings | quiet hours were evaluated with `getHours()` in the **server's zone** | **was server-local** | push deferral, minors' school-hours mute | `HH:MM` → `TIME_INVALID`; zone → `TIMEZONE_INVALID`; evaluated in the person's zone, else Europe/London | closed | — | none (zone optional) | **HARDENED** (T-12) |
| `media.uploadedAt` | `server.mjs:2190`, `m13/insight.mjs:342` | UTC_INSTANT | server | ISO string | `new Date(iso)` on a server-written value | UTC | 14-day feed / staleness | — | — | — | none | SAFE (server-derived) |
| `exportedAt`, `generatedAt` | many | UTC_INSTANT | server | ISO | — | UTC | stamps | — | — | — | none | NOT SECURITY RELEVANT |

## 6. Opportunities, campaigns, Combine, Passport, Nobody Missed, Analytics, Development (M12, M15, M16, M18, M20, M21)

| Field | File | Type | Input | Storage | Parser | TZ | Significance | Validation | Fail | Ordering | Migration risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opportunity / campaign `deadline` | `m12/journeys.mjs:25,226` | DATE_ONLY | `<input type=date>` | string | was `String(x).slice(0,10)`; compared as text (`'garbage' >= today` → open for ever) | UTC day | listing open/closed | `parseStrictDateOnly` → `DATE_INVALID` | closed | — | none | **HARDENED** (T-10) |
| Combine request `deadline` | `m16/combine.mjs:469,545` | DATE_ONLY | body | string | was `new Date(\`${d}T23:59:59Z\`)` (unreadable → NaN → window never closes) | UTC | attempt window | strict on create; `endOfDayExclusive`, unreadable → closed | closed | — | none | **HARDENED** (T-10) |
| evidence `observedAt` | `m12/passport.mjs:50,131` | DATE_ONLY or instant | body | integer ms | was `new Date(x).getTime()` (NaN stored) | — | evidence date, Second Look freshness | `parseDateOrInstant`, not future | closed (`DATE_INVALID`) | — | none (`readInstant` at write) | **HARDENED** (§16) |
| evidence `recordedAt`, `reviewedAt`, `expiresAt` (availability, 90 d) | `m12/passport.mjs:40–63` | UTC_INSTANT | server, one clock read | integer ms | — | — | upgrade detection, availability expiry | — | — | `reviewedAt === recordedAt` by construction | none | SAFE |
| Passport history `when` | `m15/shared.mjs:81` | HISTORICAL_PARTIAL_DATE | year / year-month / day / ms | `{t, precision}` | day: `parseStrictDateOnly` (30 Feb was rolled); month 13 was **clamped** to 12 | UTC | display | precision kept; impossible → null, never invented | — | — | none | **HISTORICAL ONLY** (hardened minimally, §50) |
| brief `activeFrom/activeUntil` | `m18/shared.mjs:634,815` | DATE_ONLY | `<input type=date>` | string | was text compare (`'whenever'` end → live for ever) | UTC day | Nobody Missed brief live window | `parseStrictDateOnly` → `BRIEF_INVALID{DATE_INVALID}`; read via `isDayWithin` (unreadable closes) | closed | `from ≤ to` | none; garbage legacy rows read not-live | **HARDENED** (T-10) |
| analytics `from/to` | `m20/metrics.mjs:479` | DATE_ONLY | query | — | was regex + `Date.parse` (30 Feb → 2 Mar) | UTC day | window | `parseStrictDateOnly`; `from ≤ to ≤ today` | closed (`WINDOW_INVALID`) | yes | none | **HARDENED** (T-4 class) |
| development `startDate/endDate/nextReviewAt/targetDate/dueAt` | `m21/shared.mjs:367` | DATE_ONLY or instant | body | integer ms | was `Date.parse(String(x))` (bare local → server zone; US/UK ambiguity; rollover) | — | plan lifecycle, overdue actions | `parseDateOrInstant` → `DATE_INVALID`; intervals → `DATE_INTERVAL_INVALID` (frozen) | closed | yes | none | **HARDENED** (T-7) |
| Box Cam / material change `occurredAt` | m18/m181 | UTC_INSTANT | server | integer ms | `normalizeMaterialChange` refuses a missing clock (m18E2E) | — | Second Look | — | closed | — | none | SAFE |

## 7. Clock inventory (§20)

| Clock | Where | Injected? |
| --- | --- | --- |
| `Date.now()` in routes | 510 sites, always the server's clock for `createdAt/…At` stamps | server-derived (§19); never a client timestamp except the validated fields above |
| `SCOUTBOX_TEST_CLOCK` | server boot flag | test clock for suites |
| pure predicates | `temporal.mjs`, `m24/shared.mjs`, `m25/policy.mjs`, `m23/contact.mjs`, `m23/trial.mjs`, `m14/shared.mjs`, `m20/metrics.mjs`, `m18/shared.mjs`, `m27/integration.mjs` | every one takes `now` as a parameter |
| `new Date()` local getters | `server.mjs pushDeferred` (fixed to a named zone), `timeline.year` (historical), `m13 imports minor flag` (UI care only) | the only remaining local reads are non-decisional |

## 8. Client-side date inputs (M23_P57 §6)

| App | Input | Sends |
| --- | --- | --- |
| club / grassroots trial panel | `datetime-local` + organiser zone | converted with the zone to a UTC instant (`wallToInstant`), never the browser zone |
| club / grassroots rooms (external contact) | `datetime-local` | `new Date(local).getTime()` — an integer instant computed in the **browser's** zone (the club's own clock; the server now refuses the bare string) |
| club / grassroots opportunities, campaigns, Combine, briefs, m13 forms | `type=date` | `YYYY-MM-DD` |
| player app (Expo) | text | `YYYY-MM-DD` for dob |
| agent app | none (dates displayed only) | — |

No client sends a bare local date-time string to any hardened route; the server refusal is a defence, not a break.
