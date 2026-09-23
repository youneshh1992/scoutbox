# M23 P5.7 — Platform temporal integrity & date validation sweep: final report

Branch `claude/desktop-project-migration-wyk3ec`, from the frozen tip
`d5f5db7` (P5.6F second review + F-12b). Four local commits, four bundles,
**no push, no PR, no deploy, no migration, no Offer work** — as mandated.

The defect class P5.6F exposed five times (F-2, F-3, F-8, F-12, F-12b) was
one thing: a temporal value that could not be read was treated as absent or
as valid, and the decision that depended on it failed open. P5.7 closed
that class platform-wide: one temporal layer, every decision-bearing field
re-audited against it, 21 defects found and fixed, a 493-check suite that
enumerates the class, and a full battery under two server zones.

## The mandate, section by section

| § | Requirement | Done | Where |
| --- | --- | --- | --- |
| 1 | freeze principles A–K | yes | `temporal.mjs` header; type contract |
| 2 | field inventory | yes | M23_P57_TEMPORAL_FIELD_INVENTORY.md (8 tables, every field with 13 columns) |
| 3 | unsafe pattern search & classification | yes | 74 `new Date(`, 15 `Date.parse(`, every local getter and string compare read; classified in the inventory |
| 4 | canonical helpers, no duplication | yes | `parseStrictDateOnly`, `parseInstant`, `parseDateOrInstant`, `parseLocalDateTimeWithZone`, `validateIanaZone`, `isOrderedInterval`, `isActiveAt`, `isExpiredAt`, `isEffectiveAt`, `isDayWithin`, `readInstant`, `ageOnMs`; domain and Trial delegate; four duplicate age rules removed |
| 5 | DOB regression | yes | C1–C7 pure, Q live; both leap days accepted; GB 18 / KR 19 |
| 6 | representation | yes | DATE_ONLY strings, integer instants; clients render a day in UTC (T-19) |
| 7 | licence expiry | yes | T-3 |
| 8 | policy windows | yes | T-4 |
| 9 | consent | yes | T-15 |
| 10 | trial scheduling bounds | yes | M1–M9 |
| 11 | DST America/New_York | yes | G1–G7; DST audit |
| 12 | Contact 72 h cooldown | yes | L4–L5b; T-13 |
| 13 | transaction timestamps | yes | server-derived; T-16 |
| 14 | compliance snapshot freshness | yes | inherits T-1 |
| 15 | contract / affiliation | yes | T-14; M14 periods |
| 16 | evidence dates | yes | R13 |
| 17 | analytics ranges | yes | N1–N4, R7 |
| 18 | notifications | yes | T-12, R14 |
| 19 | audit timestamps server-derived | yes | authorization audit §3 |
| 20 | clock inventory / injected now | yes | inventory §7; authorization audit §4 |
| 21 | type contract | yes | M23_P57_TEMPORAL_TYPE_CONTRACT.md |
| 22 | string vs number | yes | D1, D4b |
| 23 | legacy / imported | yes | M23_P57_IMPORT_LEGACY_AUDIT.md |
| 24 | reasonableness bounds | yes | 1900–2100; DOB not future, ≤120 y (T-21) |
| 25 | ordering | yes | every interval site |
| 26 | boundary semantics | yes | type contract, one table |
| 27 | date-only vs instant | yes | `parseDateOrInstant` |
| 28 | TZ=UTC and TZ=America/New_York | yes | identical counts; three-zone probe |
| 29 | error privacy | yes | group S |
| 30 | strict input validation | yes | taxonomy reused |
| 31 | normalise before write | yes | principle I |
| 32 | revalidate at read | yes | `readInstant`, `isDayWithin`, T3 after restart |
| 33 | migration decision | none | schema 2307 |
| 34 | `m23TemporalIntegrityE2E` A–T | yes | 493 / 335 |
| 35 | property-style, no unseeded randomness | yes | 1848 calendar triples; 14 fixed shapes |
| 36 | 22 adversarial cases | yes | group O, all EXPECT NO; #16 explicit resolution only |
| 37 | full server battery | yes | 38 suites green |
| 38 | apiE2E | yes | 130/130 |
| 39 | browser suites | yes | 14 green, zero page errors |
| 40 | five typecheck/build | yes | 5/5, 5/5 |
| 41 | EN/FR | yes | 2170/2170, 2048/2048 |
| 42 | accessibility | yes | no markup changed; frozen groups green |
| 43 | perf | yes | six suites green |
| 44 | clean boot / persistence / replay | yes | 2307; 0 migrations on re-boot; persisted across restart |
| 45 | fresh clone | see below | |
| 46 | bundles R1–R4 | yes | below |
| 47 | ten docs | yes | below |
| 48 | register fields | yes | 14 columns per row |
| 49 | fix all Critical/High/… | yes | 21/21 fixed; 3 High, 8 Medium, 10 Low |
| 50 | do not over-harden history | honoured | year/month history untouched; only impossible values become null |
| 51 | no Offer | honoured | nothing added |
| 52–53 | final report + truth block | this document | |
| 54 | success lines | below | |
| 55–56 | bundle, STOP | yes | |

## The commits

| Commit | Content |
| --- | --- |
| `dc3d69e` R1 | `temporal.mjs`; delegation from `domain.mjs` and `m23/trial.mjs`; every server hardening (T-1…T-18, T-21); the field inventory |
| `22509f5` R2 | `m23TemporalIntegrityE2E`; type contract; defect register |
| `0e54dc7` R3 | client DATE_ONLY rendering (T-19), EN/FR refusals (T-20); parser contract, authorization audit, DST audit, import/legacy audit |
| R4 | test report, release readiness, this report (the commit that contains this file) |

40 files changed through R3: 2006 insertions, 168 deletions. No file under
`m182/migrations.mjs` touched.

## Bundles (§46)

| Bundle | Tip | SHA256 |
| --- | --- | --- |
| `scoutbox-p57-r1-dc3d69e.bundle` | dc3d69e | `b2f6b58a57434a0da05160585771f609cab77f0d6183fc58edf39151dac746db` |
| `scoutbox-p57-r2-22509f5.bundle` | 22509f5 | `4d74c97eedadbcbe97c10bb374f0f1b5449bb255db3c3cc218cb9722e83a259d` |
| `scoutbox-p57-r3-0e54dc7.bundle` | 0e54dc7 | `587757016bfa1eeda96704452a83643862bb8525defa5c7b0a76c2e2af1c8a8d` |
| `scoutbox-p57-r4-<tip>.bundle` | R4 | reported in the delivery message (a file cannot contain its own commit's hash) |

The bundles live in the session scratchpad, which a container rebuild
erases (the P5.6F lesson); they are also sent to the user as files.

## The ten documents (§47)

M23_P57_TEMPORAL_FIELD_INVENTORY · TEMPORAL_TYPE_CONTRACT ·
DATE_PARSER_CONTRACT · TEMPORAL_AUTHORIZATION_AUDIT ·
TRIAL_TIMEZONE_DST_AUDIT · IMPORT_LEGACY_AUDIT · TEST_REPORT ·
DEFECT_REGISTER · RELEASE_READINESS · FINAL_REPORT.

## The defects, in one paragraph each severity

**High (3).** A VERIFIED agent facet whose recheck clock was present but
unreadable stayed VERIFIED for ever (T-1). A reviewed safeguarding check
whose expiry was text stayed reviewed for ever on the trial day (T-2). A
licence with a malformed expiry was stored as having none, the registry's
unreadable expiry kept the self-declared one, admin corrections coerced
typos to "no end", and the effective-status test read an unreadable expiry
as verified (T-3).

**Medium (8).** Policy windows and analytics windows rolled 30 February to 2
March (T-4). The minor approach-timing formula turned a null date of birth
into 1970 (T-5). Contact `occurredAt` and every Development Hub date read a
bare local time in the server's zone and `02/03/2026` as an American date
(T-6, T-7). Four separate age computations, one zone-dependent (T-8).
Grassroots, opportunity, Combine and brief dates were free text compared as
strings, so "next week" was upcoming for ever and a brief ending "whenever"
never ended (T-10). An affiliation with an infinite bound read active
(T-14). A consent granted at NaN passed the in-advance test (T-15).

**Low (10).** Birth-quarter lens in the server's zone (T-9); ICS export 500
on a corrupt stamp (T-11); quiet hours in the server's zone (T-12); a
+Infinity delivery cooling a contact pair for ever (T-13); document expiry
coercion (T-16); an undated handoff standing for ever (T-17); history month
13 clamped to December (T-18); a calendar day rendered a day early in the
Americas (T-19); English-only refusals (T-20); a sign-up born in 2030 or
1890 (T-21).

## What was deliberately not changed

- The frozen P5.6B reading of an ABSENT facet recheck clock (legacy-safe).
- The frozen P5.6F agreement-term rule; re-asserted, not rewritten.
- The Contact cooldown's fail-open direction (a limit on the club).
- Year-only and month-only football history.
- Anything named Offer, signing, issuance, acceptance or decline.
- `m22/perf.json` (not regenerated).

## §45 Fresh clone

From the R3 tip `0e54dc7`, into an empty directory, with nothing reused
(0 carried `node_modules`, 0 `dist` directories, 0 `.db` files — counted):

| Step | Result |
| --- | --- |
| clone | tip 0e54dc7 = source tip; clean |
| install (server, e2e, five apps) | rc 0 each |
| `SCHEMA_VERSION` declared | 2307, 17 migrations |
| cold boot on an empty store | `X-ScoutBox-Schema: 2307`; `scoutbox.db` created; port 4141 released after stop |
| five typechecks | 5/5 rc 0 |
| five builds (player via `expo export`) | 5/5, `index.html` present each |
| `m23TemporalIntegrityE2E` under `TZ=UTC` | 493 checks, 335 negative, rc 0 |
| `m23TemporalIntegrityE2E` under `TZ=America/New_York` | 493 checks, 335 negative, rc 0 |
| `m23AgentFinalHardeningE2E` | all 286 green |
| one real live Trial journey (`m23TrialLive`, Chromium) | 122 checks, 53 negative, rc 0 |
| one real live Contact journey (`m23ContactLive`, Chromium) | 82 checks, 33 negative, rc 0 |
| survivors | none live (4 already-exited zombies awaiting reap, holding nothing) |

## §53 Truth block

```
branch            claude/desktop-project-migration-wyk3ec
frozen base       d5f5db7  (untouched; no amend, no rebase)
origin/main       b2eca8e  (untouched)
local commits     dc3d69e (R1)  22509f5 (R2)  0e54dc7 (R3)  R4 = this report's commit
remote tip        d5f5db7  — NOT pushed; no PR; no deploy
schema            2307, 17 migrations — none added
temporal suite    m23TemporalIntegrityE2E  493 checks / 335 negative — identical under TZ=UTC and TZ=America/New_York
server battery    38 suites, 0 failures;  apiE2E 130/130
browser battery   14 suites, 0 failures, 0 page errors, ports released
typecheck/build   5/5, 5/5
EN/FR             club 2170/2170, grassroots 2048/2048
defects           21 found, 21 fixed (3 High, 8 Medium, 10 Low); 0 open; 0 deferred
migration         none
offer workflow    not started (by mandate)
push              withheld (by mandate; separate authorization required)
bundles           R1 b2f6b58a…46db  R2 4d74c97e…259d  R3 58775701…8a8d  R4 in delivery message
```

## §54 Success lines

- The temporal layer exists once, and every decision-bearing date reads
  through it.
- An unreadable temporal value is a refusal everywhere; an absent optional
  bound is open everywhere.
- The suite gives the same answer in New York as in London.
- Nothing was migrated; nothing was pushed; nothing named Offer exists.

**STOP** (§56).
