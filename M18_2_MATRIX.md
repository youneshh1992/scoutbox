# M18.2 — Final Pre-M19 Cleanup: implementation matrix

Written **before** any M18.2 code. Baseline tip `65833e1` on
`claude/desktop-project-migration-wyk3ec`, 73 commits ahead of origin,
working tree clean, nothing pushed, no PR. The full M18.1 battery was green at
this tip (recorded in `M18_1_HARDENING.md`); `testTrust 23 · m17 406 · m18 286 ·
m18.1 195` re-run green as the M18.2 preflight.

M18.2 adds **no recruitment concept**. No matching, no watchlists, no player
score, no ranking. Everything below removes an ambiguity, a hidden assumption
or a production surprise.

## Preflight findings that shape the work

- **Storage is a snapshot store, not a relational schema.** `store.mjs` keeps
  the working set in memory and writes each collection as one JSON row in a
  two-table SQLite file. There are **no SQL query patterns to index**; every
  read is an in-memory array scan. "Index audit" therefore means auditing the
  hot in-memory read paths honestly, not adding `CREATE INDEX` statements that
  would index nothing. Stated up front so nobody reads a later section as an
  evasion.
- **There is no migration framework and no schema version.** "Migrations" are
  `db.x ??= []` lines scattered across 14 files at boot. Idempotent by
  construction, but invisible to an operator and unversioned.
- **`ageOn` reads local-time getters on a UTC-parsed date.** `new
  Date('2008-03-05').getDate()` is 4 in any negative-offset timezone. The
  container runs UTC so every test passes; a production process in another
  zone would age players by one day around their birthday. Real bug.
- **The web client logs out on 403.** `App.tsx` treats a permission failure
  the same as an expired session. A scout refused one action loses their
  session.
- **Discover's ordering has no tie-break** and is by `academyPlus` then the
  profile-completeness figure. Two equal players can swap order between reads.
- **Every SSE event name is classified** (M18.1), but there is no canonical
  registry with domain, source, dedupe or notification semantics, and the
  boot assertion for unclassified events exists as a helper that nothing
  calls.
- 40 distinct notification `type` values exist across four audiences with no
  preference model at all.
- TODO/FIXME/HACK sweep: zero real hits (only the identifier `HACKNEY`).

## Severity

**P0** active security/privacy/data-corruption · **P1** authorization or
correctness · **P2** workflow/reliability · **P3** UX/polish. No P0 found.

## Findings and planned work

| # | Issue | Sev | Implementation | Test | Status | Remaining limitation |
|---|---|---|---|---|---|---|
| 1 | No canonical event registry; audience table only | P2 | `m182/eventRegistry.mjs`: every emitted event with `domain, sourceSystem, audience, privacyClass, dedupeStrategy, replayPolicy, notificationEligible, analyticsEligible`. `audienceFor` reads from it. | m182E2E §1–2 | planned | |
| 2 | Nothing asserts at boot that every emitted event is registered | P1 (latent) | Boot assertion over the emitted-name list: dev/test throws, production logs and the unregistered event fails closed to `org_private` (M18.1 rule kept). | m182E2E §2, clean-boot smoke | planned | |
| 3 | Event payloads not audited for private content | P1 | Audit every `broadcast` payload; `recruitment_room_archived` and `player_development_evidence_changed` reduced to ids + type; a registry-level `payloadAllowlist` enforced at broadcast time. | m182E2E §3–4 | planned | |
| 4 | Dedupe is per-consumer (M18 fingerprint, notification coalesce) with no shared contract | P2 | Registry `dedupeStrategy` per event; one `eventFingerprint()` helper used by notifications and Second Look. | m182E2E §5–6 | planned | |
| 5 | Terminology: residual `trustScore` alias, `verified` wording, "potential/ranking" copy | P2 | Repository sweep of the mandated terms; fix any user-facing hit; keep the deprecated wire alias. | m182E2E §7–8, spotcheck | planned | Wire alias `trustScore` stays for external consumers. |
| 6 | Provenance labels hard-coded in three places per app | P2 | One `provenance.ts` per web app (identical by test) mapping canonical type → label/tone/icon; Passport, Room, Second Look, Combine all import it. Player app keeps its map but gains the same unknown-fallback. | m182E2E §9, J4 | planned | Two web apps are separate packages; identity enforced by a test, not by a shared package. |
| 7 | No document of how any player list is ordered | P2 | `M18_2_SORTING_AUDIT.md`: every surface, default/secondary/user sorts, numeric?, quality implication?, auth changes set? | m182E2E §10–12 | planned | |
| 8 | Discover sort has no tie-break; ordered by completeness silently | P2 | Deterministic tie-break `playerId`; ordering **kept** and **labelled** in the UI (option A) — changing it is a product call, not cleanup. | m182E2E §11–12, spotcheck | planned | Ordering itself unchanged by design. |
| 9 | No notification preferences | P2 | Server-side `db.notificationPrefs` per (audienceKind, audienceId); categories mapped from the 40 types; enforced in `notify()` before creation; `security_account` mandatory. Routes `GET/PUT /{org,player,guardian}/notification-preferences`. | m182E2E §13–17, J1 | planned | Email remains local outbox; preference is in-app + email-intent only. |
| 10 | Repeated updates to one object still produce one row per update once read | P3 | Group unread rows by `(type, refId)` into "N changes in …" with the newest text. | m182E2E §18 | planned | |
| 11 | Conflict UX exists in two shapes (Room panel, Brief form message) | P2 | One `ConflictNotice` component + one `conflictOf(error)` contract; used by Room status/archive/reopen/decision/owner/lead and Brief edit. Human copy first; code available in `title`. | m182E2E §19, §23, J2 | planned | |
| 12 | Brief editor has no unsaved-change protection | P2 | Dirty-state guard on hash change, tab change and `beforeunload`; cleared on successful save. | m182E2E §20–21, J3 | planned | |
| 13 | A conflict discards the scout's typed edits | P2 | ConflictNotice keeps the form state; "Reload latest" re-reads, "Keep my changes" leaves the draft in place with the new rev. | m182E2E §22, J2 | planned | No three-way merge; the scout re-applies. |
| 14 | No organisation audit view | P3 | `GET /org/audit` (lead/director only, cursor pagination, max 50) over Room history, Brief audit, staff removal; **no note bodies**. Client screen under Organisation. | m182E2E §24–27, J5 | planned | |
| 15 | Destructive actions confirm inconsistently | P3 | Inventory; classify reversible/archive/tombstone/irreversible; shared `confirmDestructive()` with explicit consequence copy; none on harmless actions. | m182E2E §28–30 | planned | |
| 16 | No way to simulate slow/failed sources | P2 | `SCOUTBOX_FAULTS` (refused in production) middleware: delay/unavailable/timeout/retryable/non-retryable per path pattern. | m182E2E §31–35, J6–J7 | planned | |
| 17 | Client logs out on 403 | P1 | 401 only ends the session; 403 renders a permission message. Shared `httpState(error)` mapper for 401/403/404/409/413/429/5xx; `Retry-After` honoured. | m182E2E §50–56, J8 | planned | |
| 18 | `findPlayer` and similar are O(n) scans on every request | P3 | Audit hot read paths; add an in-memory id index for players (rebuilt on load/mutation) only where measured. | m182E2E §36–38, m182Perf | planned | No SQL indexes exist to add; documented. |
| 19 | Integrity invariants enforced only in handlers | P2 | Boot-time integrity check: one active Room per org/player, unique brief ids, Second Look fingerprint uniqueness per item; reports (never silently repairs) violations. | m182E2E §39 | planned | |
| 20 | No schema version; migrations unversioned | P2 | `meta.schemaVersion`; `m182/migrations.mjs` registry with ordered idempotent steps recorded in `meta.migrations`; `/capabilities` reports it. | m182E2E §40–42, J10 | planned | Migrations run inside the existing atomic save; a failed step aborts boot rather than half-applying. |
| 21 | `ageOn` local/UTC mismatch | P1 | UTC getters throughout; boundary tests incl. leap day and GB/KR majority. | m182E2E §43–44 | planned | |
| 22 | Brief active window semantics undocumented | P2 | Document: inclusive UTC calendar days at both ends; tests at start/end/overnight/DST. | m182E2E §45–47 | planned | |
| 23 | Second Look expiry/cooldown boundaries untested at the edge | P2 | Exact 120-day and 30-day boundary tests against server ms arithmetic. | m182E2E §48–49 | planned | |
| 24 | PII in logs unaudited | P1 | Sweep every `console.*` and request-log field for DOB, guardian email, notes, tokens, documents; fix any hit; test. | m182E2E §57 | planned | |
| 25 | Correlation ids exist; untested | P3 | Assert `requestId` on error bodies and the response header. | m182E2E §50–55 | planned | |
| 26 | `email_transport` capability could read as real delivery | P3 | Report `local_outbox` when no SMTP URL is set. | m182E2E §15 | planned | |
| 27 | New surfaces need EN/FR, 390px and keyboard coverage | P3 | Parity sweep; spotcheck + J9 at 390px; focus/labels on new dialogs. | m182E2E §58–60, J9, spotcheck | planned | |

## Explicit non-goals

Explainable Matching · Dynamic Watchlists · AI recommendations · player
ranking · match score · new Trust policy · new Combine protocols · Box Cam CV ·
billing · federation expansion · director analytics · new sidebar items.

## How this file is used

Every row is updated with its measured result as the work lands. A row that
cannot be honestly closed is marked with the limitation that remains.
