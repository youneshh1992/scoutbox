# M23 P8 — Contract-status writer audit

Every writer and reader of a player's contract truth, across the whole
repository (server, clients, seeds, demos, tests), with the P8 resolution of
the route P7.1 flagged (§26, §89). Paths are under `scoutbox-server/` unless
stated.

## 1. The finding (§26)

`POST /player/availability` (`server.mjs`) let an adult player set any of six
contract words, **`under_contract` included**, on their own record: a second
authoritative writer beside the completed-signing writer, invisible to the
P7 drift guards because it assigned through a variable. A player could
declare `free_agent` the moment a signing completed (the P7.1 divergence
warning was demonstrated through exactly this), or declare `under_contract`
with no signing anywhere.

## 2. The resolution

| Rule | Where | Answer |
| --- | --- | --- |
| `under_contract` cannot be self-declared | `POST /player/availability` → 403 `CONTRACT_STATUS_NOT_SELF_DECLARABLE` | the word is written by the ONE writer only |
| while a canonical live contract stands, no self-declared word replaces it | `canonicalContractFor(playerId)` (a completed-signing row over a COMPLETED package, not cancelled, end date not passed) → 409 `CONTRACT_STATUS_CANONICAL` | the completed contract owns the truth |
| the other five words stay the player's | `expiring_summer`, `scholarship_ending`, `release_approaching`, `free_agent`, `unknown` — their intent, or their reading of a contract ScoutBox did not write | permitted when no canonical contract stands |
| availability is always the player's | `availability` unchanged | yes |
| the route persists | `persist()` added | yes |

**Independent Player route can set authoritative `under_contract`: NO.**

## 3. Every writer

| Site | Route / function | Fields | Who | Class | P8 |
| --- | --- | --- | --- | --- | --- |
| `m29/index.mjs` `recordCompletedSigning` | called by the two routes below | `db.signings` row (with `contract {startDate,endDate}` for canonical rows), ledger, invoice, `level`, grassroots squad row, `contractStatus = 'under_contract'`, `availability = 'not_seeking'`, timeline | — | **canonical (the ONE writer)** | unchanged |
| `m29/index.mjs` `POST /org/signings/:id/complete` | canonical completion | as above, inside a unit of work with rollback | recruitment lead | canonical | rollback now restores the case through `ctx.restoreLifecycle` |
| `server.mjs` `POST /org/players/:id/signing` | legacy recording | as above, `method: 'LEGACY_RECORDED'` | **was:** any user of any org, agencies included. **P8:** clubs and grassroots clubs only (403 `SIGNING_NOT_PERMITTED` for an agency), leads only (403 `LEAD_REQUIRED`); still refused beside an accepted Offer or a package (`legacyRecordingBlocker`) | legacy caller of the writer | narrowed |
| `server.mjs` `POST /player/availability` | self-service | `contractStatus` (five words), `availability` | adult player, own record | self-declared, **non-authoritative** | fixed (above) |
| `server.mjs` `POST /org/squad/:entryId/release` | grassroots squad release | `availability = 'available_now'`, `contractStatus = 'free_agent'`, squad row removed, optional reference | grassroots org user | club-declared housekeeping | **P8:** the contract words are left alone when ANOTHER club holds a canonical live contract on the player (`canonicalContractFor(…, { exceptOrgId })`); the squad row still goes |
| `server.mjs` `POST /org/squad` (with `playerId`), `m12/scouting.mjs` `POST /org/squad/shadow` | squad rows (`source: manual` / `shadow`) | any org user | legacy | untouched (not contract truth; see §5) |
| `m12/passport.mjs` squad-invite respond; `m14/organisations.mjs` `acceptInvite` | consented squad / invite rows | player or guardian | consented | untouched |
| `m12/operations.mjs` `POST /org/followups/:id/report` | outcome report `registrationStatus` (`released` / `left` ends the Passport's club row) | org user of the signing club | club-declared outcome | untouched (documented: it does not flip `contractStatus`; the Passport reads it) |
| `m15/passport.mjs` career entries, `prefs.availability` | self-reported club history, a separate prefs store | player, guardian | self-declared | untouched (the Passport ranks authoritative sources above self-declared) |
| `server.mjs` signup, guardian child creation | `contractStatus: 'unknown'`, `contractUntil: null` | — | default | untouched |
| `server.mjs` `POST /guardian/children/:id/availability` | `availability` only | guardian | — | untouched (no contract word) |
| `m13/transitions.mjs` level review | `level` only | admin | admin | untouched |
| `seed.mjs` | seeded `contractStatus`, `contractUntil` | — | seed | untouched |
| suites (`m23SigningPersistence`, `m23SigningHardeningE2E`, `m23P4AClosureE2E`, P8 journey suites) | offline `under_contract` / signing rows | — | test | the hardening P2–P4 checks now plant the divergence offline and assert the route's two refusals |
| `scoutbox-club/src/demo.ts`, `scoutbox-grassroots/src/demo.ts`, `scoutbox-player/src/data/mockClient.ts` | demo values | — | demo | the player mock mirrors the two refusals |

No admin, agent (M24–M27), import (M13) or matching route writes a contract
word. `contractUntil` is written only at signup (null) and by the seed; the
canonical contract end lives on the signing row and `pkg.completion.contract`
(documented in M23_P7_CONTRACT_STATUS_SEMANTICS.md §2; unchanged in P8).

## 4. Readers

| Reader | What it reads |
| --- | --- |
| `playerViewForOrg` (org views) | `contractStatus`; `contractUntil` withheld from grassroots |
| `m29 consistencyOf` | `PLAYER_CONTRACT_STATUS_DIVERGED` (warning) when a completed signing's player is not `under_contract` — still detected, never repaired; the route can no longer create it |
| `m15/passport.mjs` `assemble`, `m15/shared.mjs` `clubHistory` / `currentStatus` | current club from squad rows, accepted invites, signing rows, outcome reports, career entries, ranked by provenance |
| `m18/secondLook.mjs`, `m12/scouting.mjs` (squad planner), `m12/operations.mjs` (follow-ups) | `contractStatus`, `contractUntil`, signings |
| `m17/shared.mjs`, `m24/index.mjs` | `player.currentClub` / `view.club` — fields that do not exist on any record; always null (documented, harmless) |
| clients | club/grassroots screens, `m12screens`, player `profile.tsx` (the picker no longer offers `under_contract`; the row shows the word read-only with a note when a ScoutBox contract stands) |

## 5. Affiliation (§28)

There is no `affiliation`, `currentClub` or `clubId` field on a player. The
factual club relationship is DERIVED by the Football Passport
(`m15/passport.mjs assemble`) from: grassroots squad rows (a signing writes
one with `source: 'signing'`), accepted invites, completed-signing rows
(`contract.startDate` / `endDate`), outcome reports (`released` / `left`) and
self-reported career entries — ranked so an authoritative source outranks a
self-declared one.

| Question | Answer |
| --- | --- |
| One authoritative writer? | the completed-signing row is the only authoritative "joined" fact; the squad row a signing writes is a projection of it for grassroots clubs |
| Dates | `contract.startDate` (a future start is a contract that starts later; the Passport's `currentStatus` reads the dates) and `endDate` on the row |
| Club / player consistency | the row carries `orgId`, `playerId`, `signingPackageId`; `supportingSigningRow` and `signingSupports` require the package to name the case and the row back |
| History | rows are never deleted; a T&S void marks the package, the row stays with `voidedAt` |
| Retries | `recordCompletedSigning` refuses a second row per package and per Offer; the unit of work rolls back everything on failure |
| Duplication by the journey | the journey projection reads the row; it writes no affiliation |
| Open, documented, not P8 | the Passport's squad-row read does not filter by `source`, so a `manual` or `shadow` row can read as a current club; a contract's end never flips `under_contract` back on its own (P7.1 §2). Both are recorded in the defect register as Low, product decisions outside P8's scope, with no change to authoritative contract truth |

## 6. Drift guards

The P7 guards grep for the literal `contractStatus = 'under_contract'`. P8's
journey E2E adds a guard that lists every assignment to `contractStatus` in
the server and asserts the only value-bearing sites are the ONE writer, the
self-service route (which cannot write `under_contract`) and the grassroots
release (which cannot override another club's canonical contract).

**Canonical completed contract owns authoritative contract state: YES.**
