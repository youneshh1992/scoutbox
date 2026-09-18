# M23 P5.6A — Agent Test Plan

The acceptance plan P5.6B–E implement. Groups A–S follow the mandate
(§150); the adversarial list (§151) and the race list (§155) are mapped to
concrete checks. Every suite follows the existing pattern: a fresh server
on a random port with its own data directory, `ok/neg/section` counters,
named refusals (`error === 'X'`, never `status !== 200`), a negative-check
ratio reported at the end, and a persistence twin that restarts the
server and re-reads. Target negative ratio ≥ 55 % (the M23 bar).

Suites proposed: `m24AgentE2E` (groups A–P), `m24ConflictE2E` (E, F, G,
S — pure engine plus routes), `m24MinorsE2E` (H, I, J — separated so the
safeguarding checks are reviewable in one file), `m24AgentPersistence`,
`m24BootContract`, `m24AgentPerf`, `e2e/m24AgentLive.test.mjs` (R), and
updates to `navConfig` / `navLive`. The prefix `m24` is a placeholder for
P5.6B's milestone number.

Nothing here runs at `669d060`; the one P5.6A test change is the
D-P56A-1 regression check added to `m162E2E` (defect register).

---

## Group A — identity and licence

| # | Check | Expected |
|---|---|---|
| A1 | Unverified user with `tier: licensed_agent` sends a proposal | 403 `AGENT_NOT_VERIFIED`, `state: verification_pending` |
| A2 | Licence claim `verified`, `recheckAt` in future | proposal proceeds to step 6/7 |
| A3 | Licence `verified`, `recheckAt` lapsed (clock advanced) | 403 `AGENT_LICENCE_INACTIVE`, `state: stale` |
| A4 | T&S suspends the licence claim | 403 `AGENT_LICENCE_INACTIVE`, `state: suspended`; existing agreements read `agent_licence_inactive: true` by the client |
| A5 | T&S marks `unverifiable` | 403 `AGENT_NOT_VERIFIED`, `reason: unverifiable` |
| A6 | Document upload alone (`document_submitted`) | never `verified` (M14 rule preserved) |
| A7 | Licence number appears in no org-user projection, no event, no notification text | neg, source + payload guards |
| A8 | Profile survives agency departure | `agentProfiles` row unchanged after affiliation ends |
| A9 | `honest` string on every verification state read says no register integration exists | neg |

## Group B — agency membership

| B1 | User at a club org calls an agent route | 403 `AGENCY_MEMBERSHIP_REQUIRED` (or 404 for resource routes) |
| B2 | `tier: assistant` attempts a regulated action | 403 `AGENT_NOT_VERIFIED` — and the assistant has no licence, so the message is the same as A1 (no tier leak) |
| B3 | Self-promotion to `agency_admin` | 403 `SELF_PROMOTION_BLOCKED` |
| B4 | Last admin removal | 409 `LAST_ADMIN` |
| B5 | Departure ends access: sessions revoked, SSE closed, client reads 403/404 | neg |
| B6 | `req.body.role: 'Head of Agency'` on login grants nothing | neg |
| B7 | Agency org logs into the club app with `platform` discriminator | `PLATFORM_MISMATCH` (P5.6B B7) |
| B8 | T&S approves an agent-licence claim with the shared key and **no** declared reviewer | 403 `REVIEWER_IDENTITY_REQUIRED`; claim unchanged (interim P5.6B rule; G-C0 replaces it in P5.6C) |
| B9 | Any P5.6B route that would resolve a conflict review, override a policy result, adjudicate a dispute or approve a minor pathway | does not exist (route inventory check) |

## Group C — representation agreement

| C1 | Propose to an adult: creates `proposed`, player Inbox shows it, agent gains no access | neg on Passport `private`, trials, notes |
| C2 | Player confirms → `active`; agent reads `recruitment` Passport | ok |
| C3 | Player declines → `declined`; cooldown 30 d; second proposal `REPRESENTATION_PROPOSAL_COOLDOWN` | neg |
| C4 | Term > 24 months for a player | 400 `REPRESENTATION_TERM_TOO_LONG` |
| C5 | Term open-ended for a club client | allowed |
| C6 | Second agreement same agent + same client while one is active/proposed | 409 `REPRESENTATION_ALREADY_EXISTS` |
| C7 | Legal-advice notice missing on proposal | 400 `LEGAL_ADVICE_NOTICE_REQUIRED` |
| C8 | Amendment creates version 2 requiring re-confirmation and a new acknowledgement | ok; v1 in history |
| C9 | Client withdraws → access ends immediately; history retained; agent notified | neg on next read |
| C10 | Agent terminates → same; reason code required | |
| C11 | Expiry by clock → `expired`; regulated action `REPRESENTATION_EXPIRED` | |
| C12 | Dispute → T&S queue; access suspended pending review | |
| C13 | Jurisdiction declared by agent ≠ confirmed by client | 409 `JURISDICTION_MISMATCH`, not active |
| C14 | Legacy `db.representations` row migrated with `agentUserId: null` authorises nothing | `REPRESENTATION_REQUIRED` |

## Group D — scope

| D1 | `scope: [commercial]` agreement; agent expresses employment interest | 403 `REPRESENTATION_SCOPE_INSUFFICIENT`, `required: employment\|transfer` |
| D2 | England-only agreement; French transaction | `REPRESENTATION_SCOPE_INSUFFICIENT` (jurisdiction) |
| D3 | Scope covers → proceeds |

## Group E — Conflict Engine (pure)

E1–E15 from `M23_P56A_CONFLICT_ENGINE_CONTRACT.md` §7, plus: E16 severity
ordering when several rules fire; E17 `inputHash` stable under key order;
E18 `suspended` rule contributes a reason and never blocks; E19
`UNKNOWN` and `UNDER_LEGAL_REVIEW` yield review (never allow/block); E20 reasons carry codes only (regex: no name,
no email, no org name in any reason).

## Group F — dual representation

| F1 | England, individual + engaging, no consents | 422 `DUAL_REPRESENTATION_CONSENT_REQUIRED`, roles listed, no names |
| F2 | Both consents recorded in advance with particulars + legal advice → action proceeds | |
| F3 | Consent after first act | still required (`CONSENT_NOT_IN_ADVANCE`) |
| F4 | Consent revoked → next mutation re-evaluates → required again | |
| F5 | Consent from a club user not marked signatory | insufficient (`SIGNATORY_REQUIRED`) |
| F6 | FIFA-only / international-dimension jurisdiction; individual + engaging | 422 `REGULATORY_REVIEW_REQUIRED` (`RULE_STATUS_UNCERTAIN`, `FIFA-12.8`), queue item created; **never** `CLEAR`, never consent-required |
| F7 | England national; individual + engaging + a second individual (multiple representation), all four safeguards recorded | proceeds (`ENG-6.3`, `DUAL_CONSENTED`) — England's table, not FIFA's |
| F8 | England national; consent recorded without `fullParticularsProvided` / `legalAdviceOffered` | still required (`PARTICULARS_MISSING` / `LEGAL_ADVICE_NOT_OFFERED`) |
| F9 | `jp-fifa-2025-2` published with 12(8)–(10) `ACTIVE` (test fixture) → F6 re-run | consent-required; earlier evaluation rows unchanged |
| F10 | England national; agreement `agencyParty: true`; colleague performs under an `agency_performance` consent from all parties | proceeds with `AGENCY_PERFORMANCE_CONSENTED`; performer recorded on the transaction |
| F11 | F10 without the consent, or with a consent from only some parties, or performer not FA-registered, or not affiliated, or international dimension | 403 `REPRESENTATION_REQUIRED` / review; never proceeds |
| F12 | F10 while the route's production flag is off (pre-L-9) | 403 `REPRESENTATION_REQUIRED` with reason `ROUTE_DISABLED_PENDING_REVIEW` |

## Group G — prohibited representation

| G1 | releasing + individual, England national | 403 `TRANSACTION_CONFLICT` (`ENG-6.4`) |
| G2 | releasing + engaging, England national | `ENG-6.4` |
| G3 | all three, England national | `ENG-6.4` |
| G3b | releasing + individual, international dimension (FIFA set) | 422 `REGULATORY_REVIEW_REQUIRED` (`RULE_STATUS_UNCERTAIN`, `FIFA-12.9`) — **not** `TRANSACTION_CONFLICT` while the FIFA status is `UNDER_LEGAL_REVIEW` |
| G4 | Connected colleague creates the conflict | same codes + `CONNECTED_AGENT_ATTRIBUTION` |
| G5 | Prohibition never reveals the colleague's client | neg |

## Group H — minors

| H1 | Agency search / discovery returns no minor (unchanged) | neg (existing suites stay green) |
| H2 | Add a minor as prospect | 403 `MINOR_APPROACH_NOT_PERMITTED`, identical body for a non-existent id |
| H3 | Approach request without minors authorisation | 403 `AGENT_MINOR_ACCREDITATION_REQUIRED` |
| H4 | With authorisation but before `earliestPermittedApproachAt` (England, FA 2026-27 reg. 5.1: before 1 Sep of the Academic Year in which they reach 16; fixture: a minor reaching 16 on 15 Mar 2027 is approachable from 1 Sep 2026, one reaching 16 on 15 Sep 2027 only from 1 Sep 2027) | 403 `MINOR_APPROACH_NOT_PERMITTED`, `reason: timing`, **no date in the body** |
| H4b | Same fixture evaluated under a non-England jurisdiction with no encoded first-contract age | 422 `REGULATORY_REVIEW_REQUIRED` (`INSUFFICIENT_DATA`); the England formula is **not** applied |
| H5 | On/after the date → guardian consent request created; agent still sees nothing about the minor | neg |
| H6 | Jurisdiction with `UNKNOWN` timing parameter | 422 `REGULATORY_REVIEW_REQUIRED`, nothing created |
| H7 | Minor turns 18 mid-agreement → `isRegulatoryMinor` false; guardian controls hand over per existing majority logic | |
| H8 | Minors-pathway read never returns DOB or location | neg |
| H9 | `visibleToOrg(minor, agency)` remains false throughout (testTrust check) | neg |

## Group I — guardian consent

| I1 | Consent by an unverified guardian (no ID / no disclaimer) | 403 `GUARDIAN_VERIFICATION_REQUIRED` |
| I2 | Consent by a guardian not listing the child | 404 |
| I3 | Guardian refuses → pathway ends; block offered; 90 d cooldown for that agent | |
| I4 | Consent recorded with policy version; visible to guardian in full, to agent as state only | |
| I5 | Agreement for a minor confirmed by the **player** account | 403 (guardian-managed only) |
| I6 | Minor's inbox shows contentless summary | neg on content |

## Group J — jurisdiction

| J1 | Policy set resolved from client MA; recorded on the agreement | |
| J2 | Contradictory rules across two MAs | `MANUAL_REGULATORY_REVIEW_REQUIRED` `POLICY_CONTRADICTION` |
| J3 | New policy version published → affected transactions flagged `re_evaluation_pending`; old evaluations untouched | |
| J4 | Publishing needs dual control | 403 on single reviewer |
| J5 | Every evaluation names its versions | |

## Group K — blocks

| K1 | Player blocks the agency mid-agreement → every agent read 403 `NOT_VISIBLE`; agreement ledger unchanged | |
| K2 | Blocked agency proposes | `NOT_VISIBLE`, same as a non-existent player |
| K3 | T&S lifts → access resumes only if agreement still active | |
| K4 | Urgent report against an agent → agency blocked, agent's regulated actions suspended | |

## Group L — tenant and privacy (the matrix's invariants)

| L1 | Other agency reads an agreement id | 404 |
| L2 | Same-agency colleague reads client Passport | 403/404 unless `shareWithAgencyStaff` and matrix allows |
| L3 | Agency admin reads fee terms (allowed) but not Passport `private` (refused) | |
| L4 | Finance reads invoices, not notes | |
| L5 | Engaging club in a Transaction reads agent verification state, not agreement fee terms | |
| L6 | **No route returns an assessment or a decision to an agent** — a sentinel like `m23DecisionE2E` T4: create a private assessment and a finalized decision for the client's player at a club, then crawl every agent route and assert neither `assessment`, `decision`, `outcome`, `rating` nor the assessor's name appears | neg |
| L7 | Audit projection never carries fee terms or note bodies | source guard on `safeDetail` |
| L8 | Event payloads pass `assertEventRegistry`; none `analyticsEligible` | |
| L9 | Notification texts carry no fee, no licence number, no minor name for an org audience | |

## Group M — transaction

| M1 | Open with an unknown type | `INSUFFICIENT_DATA` |
| M2 | Add party → re-evaluation runs, `conflict_evaluated` emitted | |
| M3 | Terms recorded as data; no cap validation; `policyState` recorded | |
| M4 | Party lane projection: club sees its lane + shared tabs only | neg on other side's agents |
| M5 | Link a club Case id one-way; agent read of the transaction shows no Case content | neg |
| M6 | Close / withdraw keeps history | |

## Group N — regulatory-provider failure

| N1 | Provider adapter (when one exists) throws → 503 `REGULATORY_PROVIDER_UNAVAILABLE`; nothing written | neg |
| N2 | Cached `verified` usable until `recheckAt`, then stale | |
| N3 | Capability endpoint reports `provider: none` honestly | |

## Group O — history, rev, idempotency

| O1 | Every mutation with `expectedRev` mismatch → 409 with `currentRev` | |
| O2 | Same client key + same payload → `idempotent: true`, one record | |
| O3 | Same key + different payload → `*_IDEMPOTENCY_CONFLICT` | |
| O4 | History entries append-only; `versions[]` never rewritten | |
| O5 | Consent ledger rows never edited; revocation is a new row | |

## Group P — client / account removal

| P1 | Client deletes account → agreement tombstoned; agent sees no name; ids/states/policy versions remain | |
| P2 | Agent removed from agency → sessions dead; agreements personal; agency loses client access | |
| P3 | Export includes agreements and consents for the client | |

## Group Q — Player / Club integration

| Q1 | Existing suites in `M23_P56A_EXISTING_AGENT_SURFACE_AUDIT.md` §6 stay green | |
| Q2 | `navConfig` counts updated when the club-app `representation` item moves (C1) | |
| Q3 | `player.agentName` labelled self-reported until replaced | |
| Q4 | Player shares a trial with the agent → agent sees family view, not `private` details | |

## Group R — browser / live

`m24AgentLive`: R1 agent onboarding to `verification_pending`; R2 T&S
verifies; R3 proposal → player Inbox → confirm; R4 client workspace shows
Passport at `recruitment`; R5 dual consent flow in a Transaction Room;
R6 minors pathway: guardian consent then proposal; R7 refusal copy at
390/360 px; R8 EN/FR keys present; R9 keyboard-only navigation of the
Transaction Room tabs; R10 block ends access live (SSE).

## Group S — corruption and historical policy

| S1 | Agreement row with `status: active` but no `confirmedAt` (corrupt) | treated as not active (`REPRESENTATION_REQUIRED`), T&S flagged |
| S2 | Evaluation recorded under `jp-eng-2026-27-1`; policy `jp-eng-2026-27-2` published; read shows both, verdict unchanged until re-run | |
| S3 | Consent referencing a policy version that never existed | insufficient |
| S4 | `jurisdictionPolicies` row missing at boot | boot contract fails loudly (M23-D2 rule) |

## §151 adversarial list → checks

| § | Attack | Check |
|---|---|---|
| 1 | Agency staff performs a regulated action | B2 |
| 2 | Verified agent acts without an agreement | C1 (proposal-only), D1, step-6 checks |
| 3 | Agent claims representation without confirmation | C1 neg |
| 4 | CRM add = private access | C1 neg, L2 |
| 5 | Agency discovers a minor | H1, H2 |
| 6 | Approach a minor before timing | H4 |
| 7 | Approach without accreditation | H3 |
| 8 | Guardian consent by a non-guardian | I1, I2 |
| 9 | Dual representation without consent | F1 |
| 10 | Consent after the fact | F3 |
| 11 | Releasing-club combination | G1–G3 |
| 12 | Same-agency colleague evades the conflict | G4 |
| 13 | Enumerate minors / blocks / other agencies' clients via refusals | H2, K2, L1 (identical bodies) |
| 14 | Read club assessment / decision through any agent route | L6 |
| 15 | Stale licence continues acting | A3 |
| 16 | Provider outage lets an action through | N1 |
| 17 | Policy update silently changes a past verdict | S2 |
| 18 | Fee terms leak through audit / events / notifications | L7–L9 |
| 19 | Agent edits Passport / Trust Score | route absence + neg |
| 20 | Departed agent keeps access | B5, P2 |

## §155 races

| Race | Check |
|---|---|
| Two proposals to the same client from the same agent in parallel | exactly one `proposed` (C6 under `Promise.all`) |
| Client withdraws while agent records terms | rev conflict or refusal; never terms on a withdrawn agreement |
| Consent revoked while the transaction mutation is in flight | the mutation's re-evaluation sees the revocation (evaluate inside the same synchronous tick as the write, as M23 does) |
| Block lands during a proposal | proposal refused or, if already written, access predicate false on the next read |
| Policy version published mid-evaluation | evaluation names the version it read; the sweep flags the record |
| Agent removed from agency while opening a transaction | affiliation check happens at step 3 on the write, not on the earlier read |

## Perf (`m24AgentPerf`)

Conflict evaluation over 500 transactions with 3 parties and 4
representations each: one pass, no N² over `db.users` (connectedness
resolved through an index built per call). Agency client list at 2 000
agreements: one filter, no per-row `db` scans. Report p95 like
`m23DecisionPerf`.
