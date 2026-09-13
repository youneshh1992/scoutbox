# M19 — Explainable Matching + Dynamic Watchlists: implementation matrix

Written **before** any M19 code, from a pre-flight read of the existing
system. Every row is a requirement, the implementation it will get, the test
that proves it, its status, and the limitation that will remain.

Baseline at the time of writing: branch `claude/desktop-project-migration-wyk3ec`,
tip `69338c8`, clean tree, 85 commits ahead of origin. Full server battery
green: trust 23 · apiE2E 130 · connectedE2E 43 · m12 143 · m13 212 · m14 193 ·
m14.1 94 · m15 185 · m16 115 · m16.1 79 · m16.2 124 · m17 406 · m18 286 ·
m18.1 195 · m18.2 313.

## What M19 answers

- **Explainable Matching** — which visible players satisfy this club's explicit
  criteria, and exactly why.
- **Dynamic Watchlists** — can ScoutBox keep that list current as facts change.

Neither decides who is best, most talented, or worth signing. The club writes
the rules; ScoutBox evaluates them; recruiters make football decisions.

## Pre-flight findings that shape the work

| # | Finding | Consequence for M19 |
|---|---|---|
| P1 | `playerMatchesBrief(facts, criteria)` (m18/shared.mjs) is boolean-only and treats **every** criterion as required — `matched = reasons.every(r => r.met)`. | M19 needs required *and* preferred. To avoid a second engine, M19 builds the general engine and `playerMatchesBrief` **delegates** to it with every criterion in `required`. M18 semantics stay bit-identical, proven by the unchanged m18E2E. |
| P2 | The lightweight projection `matchFacts(player, org)` is a **closure** inside `registerNobodyMissed`, not exported. | Extract it onto the shared context (the pattern `ctx.secondLookItemsFor` already uses) so Matching and Nobody Missed read the *same* facts. No parallel projection. |
| P3 | `playerViewForOrg(player, org)` is the single authorization gate: it applies `visibleToOrg` (minor/agency/verification/grassroots level), `isBlocked`, and strips medical, guardian id and date of birth. `matchFacts` already starts from it and returns `null` when the view is null. | Matching inherits authorization-first for free **provided** it never reads `db.players` directly. The suite must assert the order, not assume it. |
| P4 | The store is a snapshot store: `collections(name, value JSON)` in SQLite, working set in memory. There are no SQL query plans and no indexes to add. | "Index audit" is again an audit of in-memory read paths. M18.2 measured `findPlayer` (~0.1 µs at seeded size, ~14 µs at 3 000 players) and deliberately deferred an id index. M19 re-measures with real matching queries and adds an index only if the measurement justifies it. |
| P5 | `SOURCE_CONTEXTS` (m17/shared.mjs) already contains `search` and `watchlist`, plus `nobody_missed` and `second_look`. | Add `matching` and `dynamic_watchlist` to the same list. No parallel context vocabulary, no second Room-creation path — `ctx.createRoomForPlayer` is the bridge. |
| P6 | Briefs carry `rev` (M18.1 concurrency), a `version` counter, `history`, and `activeFrom`/`activeUntil` evaluated by `briefIsLiveOn` in inclusive UTC calendar days (M18.2). | Live-linked watchlists reference `briefId` + the brief's current `version`; an inactive or out-of-window brief must make the live-linked list say so rather than silently matching nobody. |
| P7 | `PROHIBITED_BRIEF_FIELDS` already refuses 22 protected-trait keys at brief validation, by exact match and substring. | M19 criteria validation reuses the same list, at criterion `type` level, and must refuse a protected trait even when it arrives as a criterion object rather than a brief field. |
| P8 | Combine facts already exclude test providers and invalidated sessions (`combineState === 'combine_verified' && !PROVIDERS[a.provider]?.testOnly`). | Production matching inherits that. M19 adds measurement thresholds, which must read the same filtered set. |
| P9 | Trust band is available as `trust?.band` with `TRUST_BANDS` ranked; the brief already supports `minTrustBand`. | M19 keeps it optional and never a default, and the copy stays "evidence confidence". |
| P10 | Notification categories (m182/notificationPrefs.mjs) are a closed table of 12; `categoryOf` fails to `null` for an unknown type, which is *delivered* and counted. | Add one category rather than a new preference system. A new notify type that is not classified would silently bypass preferences, so the classification is asserted. |
| P11 | The event registry (m182/eventRegistry.mjs) refuses to boot in development if a broadcast name is unregistered, and strips payload keys not on the allowlist. | Every M19 event must be registered with an audience, privacy class and payload allowlist before it is emitted. |
| P12 | `LIMITS` (m18/shared.mjs) already bounds page size (25/100), briefs per org (40) and `maxCandidateScan` (2000). | M19 limits extend the same table rather than inventing a second policy. |
| P13 | Discover's ordering is declared on the wire (`X-ScoutBox-Ordering`) and stated on screen (M18.2). | Matching declares its own ordering the same way. No "best match" default. |
| P14 | Position taxonomy is `POSITIONS` (13 values) with `POSITION_GROUP_OF`; facts carry `position` (primary, from passport prefs) and `secondaryPositions`. The distinction is reliable. | The position criterion can honestly offer primary-only vs any recorded position. |
| P15 | Footedness comes from the org view (`view.foot`), a canonical player field. **Corrected during implementation:** the criterion vocabulary is written `Left`/`Right`/`Both`, but the stored fact has always been lowercase (`right`), so a literal comparison — which is what M18 did — made the foot criterion unsatisfiable for every real player while passing every synthetic test. | Supported as a criterion, compared case-insensitively. Never inferred. Found by m19E2E §4; the fix is in `m19/match.mjs`, so M18 briefs get it too. |
| P16 | Evidence recency exists as a 180-day boolean (`recent_full_match`) plus `lastEvidenceAt`. | M19 needs a parameterised `within_days` criterion; the facts must carry the underlying date, not only the pre-baked boolean. |
| P17 | There is no scheduler in this build. M13 has restart-safe jobs but nothing runs while the process is idle. | Watchlist membership must be **derived on read** with an explicit reconciliation step. The product must not claim background updates. This is a stated limitation, not a hidden one. |

## Severity

**P1** correctness, privacy or safety · **P2** product-visible honesty or UX ·
**P3** operational clarity.

## Requirements

| # | Requirement (mandate §) | Sev | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|---|
| 1 | One engine, not two (§3) | P1 | `m19/match.mjs` `matchPlayerToCriteria(facts, criteria)`; `playerMatchesBrief` delegates with all criteria required | m19E2E §5 (byte-identical output, no second evaluator in m18/shared.mjs); m18E2E 286 unchanged | **done** |  |
| 2 | Canonical criteria schema, versioned (§8) | P1 | `m19/criteria.mjs`: typed criterion `{id, type, operator, values, class}`, `CRITERIA_SCHEMA_VERSION` | m19E2E §1, §3 (identity, version token, order-independence) | **done** |  |
| 3 | Supported criteria v1 only (§9) | P2 | position, age range, geography, level, foot, availability, evidence flag, evidence recency, trust band, combine availability, combine threshold | m19E2E §1 (11 types, closed operator table) | **done** | No speculative criteria |
| 4 | Required vs preferred (§6) | P1 | Two classes; only required decides membership | m19E2E §4, E5 — a preferred criterion changes the explanation, never the membership | **done** |  |
| 5 | No preferred score (§7) | P1 | Coverage is "2 of 3 met"; no percentage, rank, tier or overall figure anywhere | m19E2E §4 A38/A39, §8 A52 source sweep, m19Live M19-3, spotcheck | **done** | A count is shown; nothing normalises it |
| 6 | Position criterion (§10) | P2 | `in` over POSITIONS; `primaryOnly` flag using the existing reliable distinction | m19E2E §4 (primary, secondary, primaryOnly) | **done** |  |
| 7 | Age from DOB, UTC-safe (§11) | P1 | M18.2 `ageOn`; boundary days tested | m19E2E §9b (birthday boundary in UTC, and the age-out it causes) | **done** |  |
| 8 | Geography without leaking location (§12) | P1 | "Within permitted recruitment area"; exact distance only where already authorised | m19E2E §4 A35 (no number in the explanation), §13 (distance withheld and its ordering refused for a Pro club) | **done** | Grassroots 50 km ceiling authoritative (A32) |
| 9 | Trust as evidence confidence, never default (§13) | P1 | Optional band criterion; copy fixed; never auto-added | m19E2E §4, §14; the copy stays 'evidence confidence' | **done** | Never auto-added, never a default |
| 10 | Combine availability and threshold (§14) | P2 | `exists` and `gte` against production-valid results only | m19E2E §4, §2 A20–A22 (protocol and threshold refusals) | **done** | Thresholds are the club's, never recommended |
| 11 | Box Cam volume is not a criterion (§15) | P1 | Training-volume criteria refused | m19E2E §9b A11 — five spellings of training volume refused | **done** |  |
| 12 | Evidence recency parameterised (§16) | P2 | `within_days` over canonical dates; missing date fails closed | m19E2E §4 A36/A37, §9b (expiry with no player write) | **done** |  |
| 13 | Footedness only from canonical source (§17) | P2 | `view.foot`; never inferred | m19E2E §4; case-insensitive after the P15 correction | **done** |  |
| 14 | Criterion validation, no silent ignore (§18) | P1 | Unknown type/operator/value refused with a specific code | m19E2E §2 A5–A24 — every refusal path, each with its own code | **done** |  |
| 15 | Protected traits refused (§19) | P1 | Reuse `PROHIBITED_BRIEF_FIELDS` at criterion level | m19E2E §1 A2–A4, §2 A25/A26, §14 (HTTP, by name) | **done** | Nationality is not a criterion type at all in v1 |
| 16 | Explanation is deterministic (§20–21, §96) | P1 | Same facts + criteria version + policy version → identical explanation | m19E2E §4 (byte-identical explanations at the same instant), §3 (version token) | **done** |  |
| 17 | Non-matches excluded, not exposed (§22) | P1 | Result sets contain matches only | m19E2E §12 — non-matches are absent, not flagged | **done** | No internal debug view shipped |
| 18 | Authorization before matching (§23) | P1 | Matching reads only `playerViewForOrg`-derived facts | m19E2E §8 A55 (source order), §13 (three organisations, three universes) | **done** |  |
| 19 | No side-channel counts (§24, §104) | P1 | Totals over visible candidates only | m19E2E §13 A24/A60 | **done** |  |
| 20 | Deterministic neutral ordering (§25–26) | P1 | Default: recently updated evidence, then player id. Declared via `X-ScoutBox-Ordering` | m19E2E §7, §15; m19Live M19-4 | **done** | evidence_confidence only when chosen |
| 21 | Watchlist model + modes (§28–33) | P1 | `m19/watchlists.mjs`; live-linked vs snapshot, explicit | m19E2E §16, E8/E9; m19Live M19-8 | **done** |  |
| 22 | Membership derived, not stored as truth (§34) | P1 | Derived on read; snapshot fingerprints stored for change detection only | m19E2E §16 A47 (the record holds criteria, not player ids), §17 | **done** |  |
| 23 | Change history with reasons (§35–37) | P2 | entered/left with the criterion that changed | m19E2E §6, §17 E11 | **done** |  |
| 24 | Privacy-safe exit (§37–38) | P1 | Block/visibility loss says "no longer available", never why | m19E2E §6 A45/A46 | **done** |  |
| 25 | Time-driven change (§39–40) | P1 | Age-out and recency expiry recompute without a player write | m19E2E §9b A25 — age-out and recency expiry, no writes | **done** |  |
| 26 | Honest refresh model (§41–42) | P1 | Derived on read + explicit reconciliation; no background claim | m19E2E §17 (refreshNote asserted); m19Live M19-9; §13 of the M19 doc | **done** | **No scheduler in this build** — membership is correct as of the last read |
| 27 | Reconciliation + fingerprints (§43–44) | P1 | entered/left/unchanged; dedupe by fingerprint | m19E2E §6, §17 A44 (fingerprints, no duplicate transitions) | **done** |  |
| 28 | Notifications via existing preferences (§45–47) | P2 | New `watchlist_changes` category; grouped on bulk change | m19E2E §6 A48 (grouping), §9 A57 (category, not mandatory) | **done** |  |
| 29 | Status: active/paused/archived (§48–49) | P3 | Documented semantics; history retained | m19E2E §18 — paused shows membership; archived is terminal and stated | **done** |  |
| 30 | Org ownership and RBAC (§50–52) | P1 | Organisation-owned; existing lead/scout roles | m19E2E §16 (createdBy attributed), §19 | **done** | No parallel RBAC, no personal lists in v1 |
| 31 | Tenant isolation (§53) | P1 | Foreign id behaves as nonexistent | m19E2E §19 A60 — read, write, history and the Room bridge all 404 | **done** |  |
| 32 | Player and guardian see nothing (§54–55) | P1 | No surface, no event, no notification | m19E2E §22 A53; m19DemoSpotcheck player bundle | **done** |  |
| 33 | Agency/minor/grassroots standing rules (§56–57) | P1 | Inherited from the gate | m19E2E §13 (per-organisation universes), §2 A32/A33 (grassroots ceilings) | **done** |  |
| 34 | T&S has no routine access (§58) | P1 | No watchlist surface in the console | m19E2E §9b A34 — no watchlist access in the T&S modules | **done** |  |
| 35 | Discover enhanced, not replaced (§59–60) | P2 | Criteria panel + results in the existing screen | m19Live M19-1/M19-2; Discover itself left unchanged (sorting-audit appendix) | **done** | Matching is a separate destination, not a Discover rewrite |
| 36 | Match card + explanation drawer (§61–62) | P2 | Reasons on the card, full list in the drawer | m19Live M19-2/M19-2b/M19-3; spotcheck | **done** | Reasons are on the card; preferred detail expands in place rather than in a drawer |
| 37 | Controlled criteria editor (§63–64) | P2 | Typed controls, no JSON field | m19Live M19-5/M19-6 — typed controls, no JSON field | **done** |  |
| 38 | Save as watchlist (§65) | P2 | Name required, mode chosen explicitly | m19Live M19-8 — name required, mode chosen | **done** |  |
| 39 | Watchlist page inside existing IA (§66–69) | P2 | Tab under Recruitment; no new sidebar item | navConfig 195 (two destinations inside Recruitment, no new section); spotcheck | **done** |  |
| 40 | Room bridge (§70–72) | P1 | `ctx.createRoomForPlayer` with `dynamic_watchlist`/`matching` context; player stays on the list | m19E2E §20 — idempotent, canonical creator, player stays on the list | **done** |  |
| 41 | Distinct from Nobody Missed (§73, §75) | P1 | Evaluated players are **not** excluded from matching | m19E2E §9b A41 — no Second Look / Nobody Missed store is read | **done** |  |
| 42 | Distinct from Second Look (§74) | P2 | Both may hold the same player | m19E2E §9b A42 | **done** |  |
| 43 | URL state and deep links (§77–79) | P2 | Serialised criteria; malformed input refused safely | navConfig 195 (round-trip, malformed refused); m19Live M19-7 | **done** | The payload is opaque and re-validated server-side |
| 44 | Concurrency (§80–81) | P1 | `expectedRev`, 409, shared conflict UI, dirty guard | m19E2E §18; m19Live M19-11a — shared notice, colleague named, draft kept | **done** |  |
| 45 | Audit without flooding (§82) | P3 | Lifecycle in org audit; membership in watchlist history | m19E2E §9b A45 — lifecycle only in the audit projection | **done** |  |
| 46 | Events registered and minimal (§83–84) | P1 | Registry entries first; ids only | m19E2E §9 (five events registered, org_private, ids only), A58 | **done** |  |
| 47 | Privacy-safe analytics (§85–86) | P3 | Counters only, no player labels, no quality metric | m19E2E §9b A47 — constant counter names only | **done** |  |
| 48 | Performance measured (§87–90, §148) | P2 | `m19Perf.mjs` at 100/500/1000 candidates | m19Perf (engine, 100/500/1000 candidates, reconciliation, HTTP) | **done** | Measurements, never an SLA |
| 49 | Index audit (§91–93) | P3 | Profile real matching reads; add only if measured | m19Perf; §25 of the M19 doc | **done** | Snapshot store: no SQL plans. The linear scan is stated, capped, and deferred to a maintained projection |
| 50 | Criteria and brief versioning (§94–95) | P2 | History references the version it was evaluated under | m19E2E §3, §17 — history rows carry criteriaVersion and briefVersion | **done** |  |
| 51 | `MATCH_POLICY_VERSION` (§97) | P3 | Explicit constant on every result | m19E2E §12 — policyVersion on every result and every card | **done** |  |
| 52 | Centralised operators (§98) | P1 | Fixed table; no client-supplied evaluator | m19E2E §1, §2 A6/A7 — one operator table; no client-supplied evaluator | **done** |  |
| 53 | Server authority (§99–100) | P1 | Client sends criteria only; forged results ignored | m19E2E §14 — the client sends criteria; every value is re-validated | **done** |  |
| 54 | Criteria and watchlist limits (§101–102) | P2 | Extend `LIMITS`; bounded counts and radius | m19E2E §2 A27/A28, §21 (watchlist cap and rate limit) | **done** |  |
| 55 | Pagination everywhere (§103, §105) | P2 | Cursor/bounded pages; current read gate wins | m19E2E §15 (stable paging, clamped offset and limit), §17 (history cursor) | **done** |  |
| 56 | Empty and error states (§106–107) | P2 | Distinct, honest; never zero-as-fact | m19E2E §14, §18 A43 (a stated reason, never zero-as-fact); m19Live M19-9 | **done** |  |
| 57 | Grassroots support (§109) | P2 | Simplified criteria within standing limits | m19E2E §2 A32/A33, §13; the grassroots app carries the same screens with two switches | **done** | No Combine criteria; distance ordering available |
| 58 | Mobile 390px (§112) | P2 | Criteria, cards, drawer, history | m19Live M19-12b; spotcheck — both apps, both screens, 0 px overflow | **done** |  |
| 59 | Accessibility (§113) | P2 | Labels, non-colour required/preferred, readable reasons | m19Live M19-2b/M19-12c — glyph + words, named controls, keyboard | **done** |  |
| 60 | EN + FR (§114) | P2 | No raw keys; parity asserted | m19DemoSpotcheck — no raw m19 key, EN and FR, both apps | **done** | French is machine-translated, labelled as such |
| 61 | Migration (§155) | P1 | New schema version; clean boot, upgrade, idempotent restart | m19E2E §23 (restart), §24 (M18.2-shaped database upgraded, briefs kept) | **done** |  |
| 62 | Abuse floor ≥ 50% (§115–116) | P1 | All 60 named abuse cases | m19E2E — all 60 exercised, asserted by the suite itself; 373 checks, 260 negative (70%) | **done** |  |

## Explicit non-goals

No AI match score, talent score, potential score, recruitability score,
ScoutBox rating, "best match" or "recommended player". No hidden weighting, no
overall percentage fit, no ranking of players by quality. No player-facing
watchlist visibility ("5 clubs are watching you" is not M19). No guardian or
T&S access to private watchlists. No search engine (Elasticsearch, Algolia)
without measured evidence. No scheduler invented to fake background updates.

## How this file is used

Every row is closed by a named test before M19 is reported complete. Status
moves planned → done, or planned → "not done, measured" with the measurement
that justifies it. The Limitation column is the honest residue and is carried
into `M19_EXPLAINABLE_MATCHING_WATCHLISTS.md`.

## Closing status

All 62 requirements are **done**, each closed by the named test rather than by
assertion. Statuses were written after the suites ran, not before.

Final verification, measured:

| Suite | Result |
|---|---|
| `scoutbox-server/scripts/m19E2E.mjs` | 373 checks, 260 negative (70%), all 60 abuse cases and all 12 positive cases exercised |
| `e2e/m19Live.test.mjs` | 17 checks (M19-1…12) |
| `e2e/m19DemoSpotcheck.test.mjs` | 67 checks, zero page errors, zero external requests |
| `scoutbox-server/scripts/m18E2E.mjs` | 286 checks — unchanged, proving M18 semantics did not move |
| `e2e/navConfig.test.mjs` | 195 checks (was 168) |
| `scoutbox-server/scripts/m19Perf.mjs` | measurements only, no SLA |

## Six defects the suites found, and what was done

These are recorded here because a matrix that only lists what was planned is
half a record.

| # | Defect | Where it was found | Fix |
|---|---|---|---|
| D1 | The `foot` criterion could never be satisfied by a real player: the vocabulary is `Right`, the stored fact is `right`. Every synthetic test passed, which is the worst shape a bug can take. | m19E2E §4 | Case-insensitive comparison in `m19/match.mjs`, so M18 briefs get the fix too |
| D2 | `criteriaVersion()` was recomputed for every candidate — 3.3 of the 5.1 µs an eight-criterion evaluation cost | m19Perf | Memoised on the criteria set (WeakMap); evaluation fell to 1.7 µs |
| D3 | The change summary was this read's diff, so a background refetch swallowed it and told the person nothing had changed when two players had left | m19Live M19-10 | The summary is read back from the recorded history: the last change, with its time, the same for every reader |
| D4 | A live refetch overwrote the name being typed into the rename field | m19Live M19-11 | The refetch leaves the draft alone |
| D5 | …and silently adopted the colleague's newer revision, so the save would have overwritten their change with no conflict shown | m19Live M19-11 | The rename pins the revision it was started from |
| D6 | The demo mirror accepted a half-written criterion and matched everyone, where the server refuses it | m19DemoSpotcheck | The demo makes the same refusals in the same shape |

D1 and D5 are the two that mattered: one made a documented feature silently
useless, the other turned a conflict into a silent overwrite of a colleague's
work.
