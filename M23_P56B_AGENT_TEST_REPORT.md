# M23 P5.6B — Test Report

Every suite named in the mandate's §94–§95, run against the tree the final
report names, with its exact count as printed. Nothing here is a claim
about a run that did not happen; where a run failed first and passed after
a fix, the defect register says which fix.

Environment: Node 22.22.2 (`node:sqlite` store), Chromium at
`/opt/pw-browsers/chromium`, one sandbox, suites run sequentially unless
noted. Server suites boot their own server on a throwaway `DATA_DIR`; the
browser suites build their own bundles and own their ports.

---

## 1. New suites (P5.6B)

| Suite | Command | Result | Negative share |
|---|---|---|---|
| `m23AgentE2E` | `node scoutbox-server/scripts/m23AgentE2E.mjs` | **407 checks passed** | 250 (61 %) |
| `m23AgentPersistence` | `node scoutbox-server/scripts/m23AgentPersistence.mjs` | **68 checks passed** | 24 (35 %) |
| `m23AgentLive` | `node e2e/m23AgentLive.test.mjs` | **82 checks passed**, 0 page errors | 25 (30 %) |
| `m23AgentDemoSpotcheck` | `node e2e/m23AgentDemoSpotcheck.test.mjs` | **12 checks passed**, 0 page errors | — |
| `navConfig` (agent block added) | `node e2e/navConfig.test.mjs` | **339 checks passed** (was 297 before the agent block) | — |
| `demoFreshness` (agent bundle added) | `node e2e/demoFreshness.test.mjs` | **16 checks passed** | — |

### `m23AgentE2E` groups (as the mandate's §94 lettering, mapped)

| Group | What it proves | Checks (approx.) |
|---|---|---|
| A verification engine | six states, three facets, STALE decay, unknown state → manual review, provider abstraction (no flag → `MANUAL_REVIEW_REQUIRED`, provenance `none`, G-C0 note; flag → synthetic provider named), required facets per jurisdiction, `minors_authorisation` required by nothing, every gap state | 29 |
| B permission matrix | 5 tiers × 16 capabilities complete; regulated and client capabilities `licensed_agent` only; admin-only writes; null-prototype (`constructor`, `__proto__`…); no verify/resolve/override/approve capability exists; roles combine by union | 40 |
| C affiliation invariants | windows, self-promotion, last admin (demote and end), ended admins do not count, admin may add `licensed_agent` to self | 10 |
| D agreement engine | seven P5.6A statuses, no signed/approved/resolved, scope/term normalisation and refusals, derived expiry, **the access predicate** (9 negative cells), transitions terminal for both sides, cooldown/retryAt, dispute blocks re-request, projections withhold the dispute reason, error table null-prototype, public error fields | 41 |
| T1 registry/policy | 9 events registered org_private/org_internal ids-only, no resolution/admin-verify/offer event, notification categories, 5 rate policies, 3 migration-guaranteed stores, exactly one 2305 step, no agent auth DB / offers / transactions store | 40 |
| E platform gating | agent login lists agencies only; club and grassroots refused (`PLATFORM_MISMATCH`); no anonymous session; player token 401 | 9 |
| F membership | migration bootstrap (Director → `agency_admin`, not licensed); club session 403; stranger `AGENCY_MEMBERSHIP_REQUIRED`; Home notice | 8 |
| I team | add (validation, idempotency, collision, duplicate), analyst/agent cannot change roles, last admin, stale/malformed rev, unknown member, promote, self-add licensed, end membership (session dead, login refused, not undone), settings validation and moderation, agency overview honest line | 32 |
| G/H profile & verification | declaration ≠ verification, team row shows state not number, facet/reference/MA validation, real-looking number → manual review with G-C0, request refused, synthetic VERIFIED with provenance and recheck, FIFA ≠ FA facet, ENG request names the missing facet, minors facet recorded and activates nothing, INACTIVE recorded, history without references, stale rev, changing the declared number resets the facet, colleague sees no profile, compliance informational and number-free | 27 |
| J lookup | admin cannot look up; short query; adult found with a public row only; minors never; broad query adults ≤ 20; markup query harmless | 7 |
| K request | profile required before subject; no capability; term/scope/jurisdiction refusals; uniform 404 for missing / minor / org id; created proposed with pending identity and nothing private; second request 409; key replay; key collision; list, Home, inbox; proposed opens no board; detail says access false | 20 |
| L the client's answer | player sees agent name, agency, licence state with caveat, no reference; notified "nothing is active until YOU confirm"; wrong player 404; minor 403; agent/nobody 401; stale rev; terminate a proposal refused; **confirm** with dates and rev; SSE `representation_confirmed` without the name; replay; re-confirm/decline refused; agent notified; audit row attributed to "Player" with no key; agent cannot read the audit | 20 |
| M access basis | active grants; the client's board equals the player's own board; colleagues 404; aggregate board empty; client shares a summary (no scope/history/data/access); summary opens no board and cannot end; unshare; dispute (moderated reason refused; reason private; access suspended; no board; neither side can end or re-confirm; no re-request; Home alert; honest notice); client termination (access ends, cooldown, notifications); agent withdrawal and end (idempotent, collision, history); decline (cooldown, notice) | 42 |
| N privacy sweep | club user 403; other player 404 on read/share/dispute; minor empty with `minor: true` and 403 on act; unknown/`__proto__`/`constructor` 404; club player view carries no agent data; Trust projection has no agent term | 12 |
| O blocks | blocked player vanishes from lookup; request uniform 404; confirm through a block refused and explained; decline still works; record shows the client as unavailable without a name | 6 |
| P concurrency | five parallel confirmations → one wins, four 409, one history row, rev 2; three parallel requests → one 201, two 409; player has one request | 5 |
| Q rate limits | lookup limit fires at 120/h with the policy name; per actor; other routes unaffected | 3 |
| R Trust & Safety | read-only list with the dispute and no reason; profiles without references/numbers; **17 adjudication probes → 404**; disputed row and profile byte-identical; agent facets absent from the M14 queue; no key → 401; agent session ≠ key | 27 |
| S subsystems untouched | no signing, no offer/signed ledger row, `db.representations` unwritten, no trial/case for the agency, no M14 claim, no agent field on the player, no offer/sign/passport/box-cam/trust/contact/transactions/fees/apply route | 14 |
| T2 audit | three domains merged into `/org/audit`; no reason/reference/number; dispute row `hadReason` only; cursor pagination; bad cursor 400 | 5 |
| U tombstones | deletion after a dispute: id-only record, no name, no access, reason nulled, player attributions nulled, player gone | 6 |
| W restart | membership, profile provenance, active access, dispute suspension, both idempotency keys, ended member still out, tombstone, schema 2305 not re-run, one migration record | 10 |
| E2 error contract | every refusal carried a code; no stack/internal field; no dispute reason in any refusal | 3 |

### `m23AgentPersistence` sections

§1 one step, three empty stores, idempotent re-run, production-required
(9); §2 upgrade from a 2304 snapshot: affiliations bootstrapped honestly
(lead → admin, other → assistant, nobody licensed, removed and club users
skipped, earliest member as admin where no lead), both F10 rows mirrored
once with correct statuses, the active legacy row grants nobody access, the
source rows and users byte-identical, re-run and re-applied step mirror
nothing twice (18); §3 a real boot over the snapshot: 2305 applied at boot,
migrated admin administers, migrated staff is an assistant, legacy rows are
summaries, read-only for everyone including a licensed agent, the player
sees the legacy row with no verification claim (14); §4 clean boot →
relationship → stop → reboot: keys, revs, history, provenance byte-faithful,
identical projections, key replays, one migration record (13); §5
corruption contained and never repaired (10).

### `m23AgentLive` journeys

A admin (7) · B agent (20) · C client (7) · D access (7) · E dispute (6) ·
N negatives: N1 platform (2), N2 analyst (5), N3 foreign deep link (2),
N4 unknown tab (1), N5 wording sweep over ten screens (2), N6 390/360
(7), N7 a11y (3), N8 FR (2), N9 player 390 (2), N10 minor (2) · no page
errors (1). Runs: the first two runs failed on test-side selector and
timing mistakes (C5 scope not ticked, `text=Confirm` substring match, card
read before data, empty board container "hidden", N5 regex catching the
honesty sentences); one run found D-P56B-11 (a real client defect); the
final run is the one reported.

## 2. The §95 regression set (final battery, current tree)

| Suite | Result |
|---|---|
| `m162E2E` | 136 checks passed, 63 negative (46 %) — includes the a3ebc7a D-P56A-1 regression |
| `m17E2E` | 515 checks passed, 210 negative (41 %) |
| `m18E2E` | 287 checks passed, 173 negative (60 %) |
| `m181E2E` | 196 checks passed, 103 negative (53 %) |
| `m182E2E` | 365 checks passed, 205 negative (56 %) — failed once on D-P56B-9 (textual broadcast audit), green after the literal call sites |
| `m22Blocker` | all 60 checks passed |
| `m23E2E` | 382 checks passed, 262 negative (69 %) |
| `m23ContactE2E` | 418 checks passed, 240 negative (57 %) |
| `m23TrialE2E` | 535 checks passed, 331 negative (62 %) — pin updated: step 2304, schema 2305 |
| `m23DecisionE2E` | 435 checks passed, 315 negative (72 %) |
| `m23P4AClosureE2E` | 337 checks passed, 210 negative (62 %) |
| `m23BootContract` | 61 checks passed, 43 negative (70 %); 127 production-read stores, 0 missing |
| `m23Persistence` | 67 checks passed, 20 negative (30 %); pre-M23 snapshot upgrades 2200 → 2305 |
| `m23ContactPersistence` | 61 checks passed, 33 negative (54 %) |
| `m23TrialPersistence` | 36 checks passed, 13 negative (36 %) — pins updated: a 2303 snapshot runs the Trial step then only the Agent step |
| `m23DecisionPersistence` | 48 checks passed, 17 negative (35 %) — pin updated: 2305, no decision step above 2304 |
| `navConfig` | 339 checks passed |
| `navLive` | 64 checks passed — N1–N17 complete (Pro, Grassroots, T&S unchanged) |
| `demoFreshness` | 16 checks passed (six bundles including the agent demo, fingerprints current) |

The §95 set was run twice: once after the server phase (all green except
the `m182E2E` textual audit, D-P56B-9) and once as the final battery on the
tree reported (all green). `m22Blocker` and the M22 evidence suites are
unchanged and unaffected.

## 3. Typechecks and builds (five apps)

| App | `tsc --noEmit` | `vite build` / `expo export` | Demo build |
|---|---|---|---|
| scoutbox-server | n/a (`node --check` on every changed module) | boots clean at 2305; `/healthz` reports it | — |
| scoutbox-club | exit 0 | exit 0 | rebuilt (`buildDemos`) |
| scoutbox-grassroots | exit 0 | exit 0 | rebuilt |
| scoutbox-admin | exit 0 | exit 0 | rebuilt |
| scoutbox-agent | exit 0 | exit 0 (301 kB js / 18 kB css) | exit 0, inlined to `e2e/dist/scoutbox-agent-demo.html` (342 kB) |
| scoutbox-player | exit 0 | `expo export` exit 0 (live bundle for the suite) | rebuilt |

## 4. What was not run, and why

- `m23DecisionPerf`, `m23TrialPerf`, `m23ContactPerf`, `m18Perf`… — the
  mandate's §95 names the acceptance and persistence suites; the perf
  suites are unaffected by P5.6B (no shared route changed) and were not
  run.
- `m162Live`, `m23ContactLive`, `m23TrialLive`, `m23DecisionLive` — not in
  §95 for P5.6B; the club/grassroots/player surfaces they drive are
  unchanged except the player's You › Clubs tab, which `m23AgentLive` and
  the M13 demo spotcheck (legacy Representation section kept) cover.
- `connectedE2E`, `apiE2E` — not in §95; the connected demo bundle was
  rebuilt by `buildDemos` and its freshness verified.

## 5. Closure audit re-run (on `d694ad5`, clean tree)

Every suite above was run again, sequentially, from the tip the final
report names, before any document was edited. Exact result lines:

| Suite | Result |
|---|---|
| `m23AgentE2E` | 407 checks passed, 250 negative (61 %) |
| `m23AgentPersistence` | 68 checks passed, 24 negative (35 %) |
| `m23BootContract` | 61 checks passed, 43 negative (70 %) |
| `m162E2E` | 136 checks passed, 63 negative (46 %) |
| `m17E2E` | 515 checks passed, 210 negative (41 %) |
| `m18E2E` | 287 checks passed, 173 negative (60 %) |
| `m181E2E` | 196 checks passed, 103 negative (53 %) |
| `m182E2E` | 365 checks passed, 205 negative (56 %) |
| `m22Blocker` | all 60 checks passed |
| `m23E2E` | 382 checks passed, 262 negative (69 %) |
| `m23ContactE2E` | 418 checks passed, 240 negative (57 %) |
| `m23TrialE2E` | 535 checks passed, 331 negative (62 %) |
| `m23DecisionE2E` | 435 checks passed, 315 negative (72 %) |
| `m23P4AClosureE2E` | 337 checks passed, 210 negative (62 %) |
| `m23Persistence` | 67 checks passed, 20 negative (30 %) |
| `m23ContactPersistence` / `m23TrialPersistence` / `m23DecisionPersistence` | all checks passed (exit 0) |
| `navConfig` | 339 checks passed |
| `m23AgentLive` | 82 checks passed (25 negative, 30 %), no page errors |
| `navLive` | 64 checks passed — N1–N17 complete |
| `m23AgentDemoSpotcheck` | OK — zero page errors |
| `demoFreshness` | 16 checks passed |

Typechecks (`tsc --noEmit`): agent, club, grassroots, admin, player — all
exit 0. Builds (`vite build`): agent, club, grassroots, admin — all exit 0.
The Expo export was not re-run in the audit; the live suite's player
bundle (`dist-live24`) was rebuilt and exercised by `m23AgentLive` (C, N9,
N10). `git status --short` was empty after every run. No suite failed, no
suite was skipped that §95 names, and no "not run" was converted to a pass.
