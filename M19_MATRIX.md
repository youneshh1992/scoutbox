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
| P15 | Footedness comes from the org view (`view.foot`), a canonical player field, values Left/Right/Both. | Supported as a criterion. Never inferred. |
| P16 | Evidence recency exists as a 180-day boolean (`recent_full_match`) plus `lastEvidenceAt`. | M19 needs a parameterised `within_days` criterion; the facts must carry the underlying date, not only the pre-baked boolean. |
| P17 | There is no scheduler in this build. M13 has restart-safe jobs but nothing runs while the process is idle. | Watchlist membership must be **derived on read** with an explicit reconciliation step. The product must not claim background updates. This is a stated limitation, not a hidden one. |

## Severity

**P1** correctness, privacy or safety · **P2** product-visible honesty or UX ·
**P3** operational clarity.

## Requirements

| # | Requirement (mandate §) | Sev | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|---|
| 1 | One engine, not two (§3) | P1 | `m19/match.mjs` `matchPlayerToCriteria(facts, criteria)`; `playerMatchesBrief` delegates with all criteria required | m19E2E §1; unchanged m18E2E 286 | planned | |
| 2 | Canonical criteria schema, versioned (§8) | P1 | `m19/criteria.mjs`: typed criterion `{id, type, operator, values, class}`, `CRITERIA_SCHEMA_VERSION` | m19E2E §2 | planned | |
| 3 | Supported criteria v1 only (§9) | P2 | position, age range, geography, level, foot, availability, evidence flag, evidence recency, trust band, combine availability, combine threshold | m19E2E §3 | planned | No speculative criteria |
| 4 | Required vs preferred (§6) | P1 | Two classes; only required decides membership | m19E2E §4, E1 | planned | |
| 5 | No preferred score (§7) | P1 | Coverage is "2 of 3 met"; no percentage, rank, tier or overall figure anywhere | m19E2E §5, spotcheck | planned | |
| 6 | Position criterion (§10) | P2 | `in` over POSITIONS; `primaryOnly` flag using the existing reliable distinction | m19E2E §6 | planned | |
| 7 | Age from DOB, UTC-safe (§11) | P1 | M18.2 `ageOn`; boundary days tested | m19E2E §7, E8 | planned | |
| 8 | Geography without leaking location (§12) | P1 | "Within permitted recruitment area"; exact distance only where already authorised | m19E2E §8, abuse 59 | planned | Grassroots 50 km ceiling authoritative |
| 9 | Trust as evidence confidence, never default (§13) | P1 | Optional band criterion; copy fixed; never auto-added | m19E2E §9, abuse 23 | planned | |
| 10 | Combine availability and threshold (§14) | P2 | `exists` and `gte` against production-valid results only | m19E2E §10, E7, abuse 21–22 | planned | Thresholds are the club's, never recommended |
| 11 | Box Cam volume is not a criterion (§15) | P1 | Training-volume criteria refused | m19E2E abuse 24 | planned | |
| 12 | Evidence recency parameterised (§16) | P2 | `within_days` over canonical dates; missing date fails closed | m19E2E §11, E2 | planned | |
| 13 | Footedness only from canonical source (§17) | P2 | `view.foot`; never inferred | m19E2E §12 | planned | |
| 14 | Criterion validation, no silent ignore (§18) | P1 | Unknown type/operator/value refused with a specific code | m19E2E §13, abuse 16/18 | planned | |
| 15 | Protected traits refused (§19) | P1 | Reuse `PROHIBITED_BRIEF_FIELDS` at criterion level | m19E2E abuse 17 | planned | Nationality only for eligibility, never preference |
| 16 | Explanation is deterministic (§20–21, §96) | P1 | Same facts + criteria version + policy version → identical explanation | m19E2E §14 | planned | |
| 17 | Non-matches excluded, not exposed (§22) | P1 | Result sets contain matches only | m19E2E §15 | planned | Internal debug view not shipped |
| 18 | Authorization before matching (§23) | P1 | Matching reads only `playerViewForOrg`-derived facts | m19E2E §16, abuse 1–13 | planned | |
| 19 | No side-channel counts (§24, §104) | P1 | Totals over visible candidates only | m19E2E §17, abuse 40/60 | planned | |
| 20 | Deterministic neutral ordering (§25–26) | P1 | Default: recently updated evidence, then player id. Declared via `X-ScoutBox-Ordering` | m19E2E §18, abuse 27 | planned | Evidence-confidence sort only when chosen |
| 21 | Watchlist model + modes (§28–33) | P1 | `m19/watchlists.mjs`; live-linked vs snapshot, explicit | m19E2E §19–22, E9 | planned | |
| 22 | Membership derived, not stored as truth (§34) | P1 | Derived on read; snapshot fingerprints stored for change detection only | m19E2E §23 | planned | |
| 23 | Change history with reasons (§35–37) | P2 | entered/left with the criterion that changed | m19E2E §24, E3, E6 | planned | |
| 24 | Privacy-safe exit (§37–38) | P1 | Block/visibility loss says "no longer available", never why | m19E2E §25, E4, abuse 32/41 | planned | |
| 25 | Time-driven change (§39–40) | P1 | Age-out and recency expiry recompute without a player write | m19E2E §26, E8 | planned | |
| 26 | Honest refresh model (§41–42) | P1 | Derived on read + explicit reconciliation; no background claim | m19E2E §27; documented | planned | **No scheduler in this build** |
| 27 | Reconciliation + fingerprints (§43–44) | P1 | entered/left/unchanged; dedupe by fingerprint | m19E2E §28, E12, abuse 30–31 | planned | |
| 28 | Notifications via existing preferences (§45–47) | P2 | New `watchlist_changes` category; grouped on bulk change | m19E2E §29, abuse 42–43 | planned | |
| 29 | Status: active/paused/archived (§48–49) | P3 | Documented semantics; history retained | m19E2E §30 | planned | |
| 30 | Org ownership and RBAC (§50–52) | P1 | Organisation-owned; existing lead/scout roles | m19E2E §31, abuse 56 | planned | No parallel RBAC, no personal lists in v1 |
| 31 | Tenant isolation (§53) | P1 | Foreign id behaves as nonexistent | m19E2E abuse 2–4, 38 | planned | |
| 32 | Player and guardian see nothing (§54–55) | P1 | No surface, no event, no notification | m19E2E abuse 5–6; player spotcheck | planned | |
| 33 | Agency/minor/grassroots standing rules (§56–57) | P1 | Inherited from the gate | m19E2E abuse 7–9 | planned | |
| 34 | T&S has no routine access (§58) | P1 | No watchlist surface in the console | m19E2E §32 | planned | |
| 35 | Discover enhanced, not replaced (§59–60) | P2 | Criteria panel + results in the existing screen | M19-1, spotcheck | planned | |
| 36 | Match card + explanation drawer (§61–62) | P2 | Reasons on the card, full list in the drawer | M19-1, spotcheck | planned | |
| 37 | Controlled criteria editor (§63–64) | P2 | Typed controls, no JSON field | M19-2 | planned | |
| 38 | Save as watchlist (§65) | P2 | Name required, mode chosen explicitly | M19-3 | planned | |
| 39 | Watchlist page inside existing IA (§66–69) | P2 | Tab under Recruitment; no new sidebar item | M19-3, spotcheck | planned | |
| 40 | Room bridge (§70–72) | P1 | `ctx.createRoomForPlayer` with `dynamic_watchlist`/`matching` context; player stays on the list | m19E2E §33, M19-10, abuse 44–46 | planned | |
| 41 | Distinct from Nobody Missed (§73, §75) | P1 | Evaluated players are **not** excluded from matching | m19E2E E10, M19-11 | planned | |
| 42 | Distinct from Second Look (§74) | P2 | Both may hold the same player | m19E2E E11 | planned | |
| 43 | URL state and deep links (§77–79) | P2 | Serialised criteria; malformed input refused safely | m19E2E §34, abuse 52 | planned | |
| 44 | Concurrency (§80–81) | P1 | `expectedRev`, 409, shared conflict UI, dirty guard | m19E2E §35, M19-8, abuse 28/55 | planned | |
| 45 | Audit without flooding (§82) | P3 | Lifecycle in org audit; membership in watchlist history | m19E2E §36, abuse 47 | planned | |
| 46 | Events registered and minimal (§83–84) | P1 | Registry entries first; ids only | m19E2E §37, abuse 48–49 | planned | |
| 47 | Privacy-safe analytics (§85–86) | P3 | Counters only, no player labels, no quality metric | m19E2E §38 | planned | |
| 48 | Performance measured (§87–90, §148) | P2 | `m19Perf.mjs` at 100/500/1000 candidates | m19Perf | planned | Measurements, never an SLA |
| 49 | Index audit (§91–93) | P3 | Profile real matching reads; add only if measured | m19Perf; documented | planned | Snapshot store: no SQL plans |
| 50 | Criteria and brief versioning (§94–95) | P2 | History references the version it was evaluated under | m19E2E §39 | planned | |
| 51 | `MATCH_POLICY_VERSION` (§97) | P3 | Explicit constant on every result | m19E2E §40 | planned | |
| 52 | Centralised operators (§98) | P1 | Fixed table; no client-supplied evaluator | m19E2E §41, abuse 54 | planned | |
| 53 | Server authority (§99–100) | P1 | Client sends criteria only; forged results ignored | m19E2E abuse 14–15 | planned | |
| 54 | Criteria and watchlist limits (§101–102) | P2 | Extend `LIMITS`; bounded counts and radius | m19E2E §42, abuse 20/50 | planned | |
| 55 | Pagination everywhere (§103, §105) | P2 | Cursor/bounded pages; current read gate wins | m19E2E §43, abuse 51 | planned | |
| 56 | Empty and error states (§106–107) | P2 | Distinct, honest; never zero-as-fact | M19 spotcheck | planned | |
| 57 | Grassroots support (§109) | P2 | Simplified criteria within standing limits | m19E2E §44 | planned | |
| 58 | Mobile 390px (§112) | P2 | Criteria, cards, drawer, history | M19-12, spotcheck | planned | |
| 59 | Accessibility (§113) | P2 | Labels, non-colour required/preferred, readable reasons | M19-12 | planned | |
| 60 | EN + FR (§114) | P2 | No raw keys; parity asserted | m19E2E §45 | planned | |
| 61 | Migration (§155) | P1 | New schema version; clean boot, upgrade, idempotent restart | m19E2E §46 | planned | |
| 62 | Abuse floor ≥ 50% (§115–116) | P1 | All 60 named abuse cases | m19E2E | planned | |

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
