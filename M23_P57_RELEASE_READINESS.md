# M23 P5.7 — Release readiness

Each area: PASS, FAIL, or DEFERRED WITH REASON, with the evidence a reader
can re-run.

| # | Area | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | **Temporal principles frozen** | **PASS** | A–K in `temporal.mjs` header and M23_P57_TEMPORAL_TYPE_CONTRACT.md; asserted as a contract in suite group A |
| 2 | **Field inventory** | **PASS** | M23_P57_TEMPORAL_FIELD_INVENTORY.md — every field with type, storage, parser, zone, significance, validation, fail direction, ordering, migration risk, status |
| 3 | **Unsafe pattern search** | **PASS** | every `new Date(`, `Date.parse(`, local getter and string-comparison site read and classified; 21 defects registered, 21 fixed |
| 4 | **Canonical helpers, no duplication** | **PASS** | one module; `domain.parseDob/ageOn/parseTrialDate` and `trial.validateTimezone/parseInstant/localParts` delegate (A5–A9); four duplicate age rules removed (T-8) |
| 5 | **DOB regression** | **PASS** | the mandated invalid list refused, both leap days accepted, GB 18 / KR 19 (C1–C7); live at both sign-up doors (Q) |
| 6 | **Representation** | **PASS** | DATE_ONLY strings, integer instants; clients render a day in UTC (T-19) |
| 7 | **Licence expiry** | **PASS** | T-3: strict at every write, unreadable = expired at read (I, R1–R2b, T2) |
| 8 | **Policy windows** | **PASS** | T-4: real days only; unreadable never selected (J, R15) |
| 9 | **Consent** | **PASS** | T-15: a grant is dated by a readable instant (K9–K11) |
| 10 | **Trial scheduling** | **PASS** | start<end, 15 min–12 h, ≤20 sessions, IANA zone (M); instants stored, wall clocks derived |
| 11 | **DST (America/New_York)** | **PASS** | gap refused, overlap named, explicit resolution only (G1–G7); London likewise |
| 12 | **Contact 72 h cooldown** | **PASS** | exclusive at +72 h; answered contacts do not cool; T-13 (L4–L5b) |
| 13 | **Transaction timestamps** | **PASS** | server-derived; document expiry strict and `isExpiredAt` at read (T-16) |
| 14 | **Compliance snapshot freshness** | **PASS** | inherits T-1; `daysUntilRecheck` only from a finite clock |
| 15 | **Contract / affiliation** | **PASS** | T-14 affiliations; agreement term unchanged and re-asserted (K5–K8b); M14 periods ordered (`INTERVAL_INVALID`) |
| 16 | **Evidence dates** | **PASS** | `observedAt` strict, not future (R13) |
| 17 | **Analytics ranges** | **PASS** | real days, ordered, not future (N1–N4, R7) |
| 18 | **Notifications** | **PASS** | T-12: quiet hours in a named zone; `TIME_INVALID`/`TIMEZONE_INVALID` (R14) |
| 19 | **Audit timestamps server-derived** | **PASS** | no client `…At` accepted in M24–M27 except validated document expiry (authorization audit §3) |
| 20 | **Clock inventory / injected now** | **PASS** | authorization audit §4 |
| 21 | **Type contract** | **PASS** | five types, one boundary rule, one error taxonomy |
| 22 | **String vs number** | **PASS** | numeric strings refused as instants (D1); `readInstant` is finite-number-only |
| 23 | **Legacy / imported data** | **PASS** | M23_P57_IMPORT_LEGACY_AUDIT.md; re-validated at read, no rewrite |
| 24 | **Reasonableness bounds** | **PASS** | 1900–2100; DOB not future, ≤120 y (C7, Q1b/c) |
| 25 | **Ordering** | **PASS** | every interval site refuses inversion (H9, M2, R1d, R6e, R15b) |
| 26 | **Boundary semantics** | **PASS** | starts inclusive, ends exclusive, day ends cover the day (H2, I3, J2/J4, L4b) |
| 27 | **Date-only vs instant** | **PASS** | `parseDateOrInstant` says which it got and stores that |
| 28 | **TZ=UTC and TZ=America/New_York** | **PASS** | identical suite counts; three-zone child-process probe byte-identical (P) |
| 29 | **Error privacy** | **PASS** | authorization before dates on every hardened route (S1–S7b); the frozen AE group still green |
| 30 | **Strict input validation** | **PASS** | error taxonomy reused, domain codes kept at the edge |
| 31 | **Normalise before write / revalidate at read** | **PASS** | principle I; T3 after restart |
| 32 | **Migration decision** | **PASS — none** | schema 2307, 17 migrations; §44 cold boot and replay green |
| 33 | **Browser suites** | **PASS** | 14 suites green, zero page errors, ports released |
| 34 | **Typecheck / build ×5** | **PASS** | 5/5, 5/5 (player via `expo export`) |
| 35 | **EN/FR** | **PASS** | 2170/2170, 2048/2048 |
| 36 | **Accessibility** | **PASS** | no markup changed; frozen a11y groups green |
| 37 | **Perf** | **PASS** | six perf/robustness suites green; `m22Perf` deliberately not run (rewrites a tracked file; nothing it measures changed) |
| 38 | **Fresh clone** | see final report §45 | run from the R3 tip |
| 39 | **Offer workflow / signing** | **NOT STARTED, by mandate** | no object, route, state or vocabulary added (§51) |
| 40 | **Push** | **WITHHELD, by mandate** | four local commits, four bundles with SHA256; no push, no PR, no deploy |

**Verdict: RELEASE-READY for the temporal sweep's scope**, pending the
separate push authorization the mandate requires.
